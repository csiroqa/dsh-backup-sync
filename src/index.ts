/**
 * 备份/恢复 + 跨机同步插件 —— host 半区（@dsh-plugin/backup-sync）
 *
 * 命令组 /backup：
 *   /backup [name]                    —— 创建本地快照（默认时间戳名）
 *   /backup list                      —— 列出本地 + 远端（WebDAV）快照
 *   /backup push <name>               —— 推送本地快照到 WebDAV 远端（覆盖远端同名）
 *   /backup pull <name> [--force]     —— 从远端拉取快照到本地（不自动恢复）
 *   /backup restore <name> [--all]    —— 从本地快照恢复（默认仅 sessions+storages；
 *                                        --all 连 settings/配置一起还原，需重启生效）
 *   /backup prune [keep]              —— 保留最近 keep 个本地快照
 *   /backup remote-prune <name>       —— 删除远端同名快照
 *
 * 自动备份：autoIntervalMinutes > 0 时定时创建快照并按 autoKeep 清理；
 * 备份范围：$DSH_HOME 的 sessions（会话日志）、storages（工作区注册表等），
 * 可选 attachments；配置层只随 restore --all 还原（默认不覆盖运行中配置）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session'
// timer 插件的类型增补（ctx.interval）依赖此导入生效。
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { credentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { join } from 'node:path'
import {
  createSnapshot, listSnapshots, getSnapshot, restoreSnapshot, pruneSnapshots,
  defaultSnapshotName, snapshotDir, errorMessage, totalBytes, assertSnapshotName,
  type SnapshotSummary,
} from './snapshot.js'
import {
  pushSnapshot, pullSnapshot, listRemoteSnapshots, removeRemoteSnapshot,
  WebDavError, type WebDavConfig,
} from './webdav.js'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

export const name = 'backup-sync'

export const inject = ['commands', 'credentials', 'timer', 'workspaceRegistry', 'sessionPersistence', 'sessions']

/** WebDAV 远端配置。username/password 留空时从凭据引用 WEBDAV_USERNAME / WEBDAV_PASSWORD 解析。 */
export interface RemoteConfig {
  /** WebDAV 根地址，如 https://dav.example.com/remote.php/dav/files/user/dsh-backups。 */
  readonly baseUrl?: string
  readonly username?: string
  readonly password?: string
}

export interface Config {
  /** 本地快照根目录；空 = $DSH_HOME/backups。 */
  readonly backupRoot?: string
  /** 是否备份 $DSH_HOME/attachments（体积大，默认关）。 */
  readonly includeAttachments?: boolean
  /** 是否备份 $DSH_HOME/.credentials.yaml（含明文密钥，默认关）。 */
  readonly includeCredentials?: boolean
  /** 自动备份间隔（分钟）；0 = 关闭。 */
  readonly autoIntervalMinutes?: number
  /** 备份后保留的最近快照数；0 = 从不清理。 */
  readonly autoKeep?: number
  readonly remote?: RemoteConfig
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${SIZE_UNITS[unit]}`
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 快照内部节名 → 用户可读的中文标签。 */
const SECTION_LABELS: Record<string, string> = {
  sessions: '会话日志',
  storages: '工作区数据',
  'configs/settings.yaml': '设置',
  'configs/cordis.patch.yml': '全局配置',
  'configs/profiles': '各 profile 配置',
}

function sectionLabel(rel: string): string {
  return SECTION_LABELS[rel] ?? rel
}

function summarizeLine(snapshot: SnapshotSummary): string {
  const stamp = snapshot.valid
    ? `${formatTime(snapshot.createdAt)}  ${snapshot.hostname}  ${snapshot.fileCount} 文件 / ${formatBytes(snapshot.totalBytes)}`
    : '元数据缺失，无法显示详情（可重新创建）'
  return `  ${snapshot.name}  ${stamp}`
}

/** 已知子命令；其余输入一律视为自定义快照名。 */
const SUBCOMMANDS = new Set(['create', 'list', 'push', 'pull', 'restore', 'prune', 'remote-prune', 'sweep-archives'])

function tokens(rawInput: string): string[] {
  return rawInput.trim().split(/\s+/).filter((token) => token.length > 0)
}

export function apply(ctx: Context, config: Config = {}): void {
  const home = resolveDshHome()
  const backupRoot = (config.backupRoot?.trim() ?? '') === '' ? join(home, 'backups') : config.backupRoot!
  const includeAttachments = config.includeAttachments ?? false
  const includeCredentials = config.includeCredentials ?? false
  const autoKeep = config.autoKeep ?? 10
  const remote = config.remote

  const credentialValue = async (refName: string, fallback: string | undefined): Promise<string | undefined> => {
    if (fallback !== undefined && fallback !== '') return fallback
    const resolved: ResolvedCredential | undefined = await ctx.credentials.resolve(credentialRef(refName))
    return resolved?.value
  }

  const remoteConfigured = remote?.baseUrl !== undefined && remote.baseUrl.trim() !== ''

  const remoteAuth = async (): Promise<WebDavConfig> => {
    if (!remoteConfigured || remote === undefined) {
      throw new Error('未配置远端：请先在配置中设置 remote.baseUrl（WebDAV 地址）')
    }
    const username = (await credentialValue('WEBDAV_USERNAME', remote.username)) ?? ''
    const password = (await credentialValue('WEBDAV_PASSWORD', remote.password)) ?? ''
    return { baseUrl: remote.baseUrl, username, password }
  }

  const createBackup = async (name: string, signal?: AbortSignal): Promise<string> => {
    const { meta, warnings } = await createSnapshot(backupRoot, home, name, {
      includeAttachments,
      includeCredentials,
    }, signal)
    const lines = [
      `已创建快照 ${meta.name}：${meta.files.length} 文件 / ${formatBytes(totalBytes(meta.files))}`,
      `  位置：${snapshotDir(backupRoot, meta.name)}`,
    ]
    for (const warning of warnings) lines.push(`  警告：${warning}`)
    const pruned = await pruneSnapshots(backupRoot, autoKeep)
    if (pruned.length > 0) lines.push(`  已清理 ${pruned.length} 个旧快照（按保留策略）`)
    return lines.join('\n')
  }

  /**
   * 清理失效归档：归档列表（archivedSessionIds）不校验会话日志是否存在，
   * 会话日志被删除/恢复覆盖后会产生"幽灵归档"。逐个校验，缺失则取消归档。
   * 返回清理数量；任何会话存在性校验失败都保守跳过（不误删）。
   */
  const sweepArchives = async (): Promise<number> => {
    const archived = [...ctx.workspaceRegistry.archivedSessionIds]
    if (archived.length === 0) return 0
    // 旧版 dsh（如 npm 0.1.0-rc.x）的 registry 没有 unarchiveSession，跳过并提示。
    const registry = ctx.workspaceRegistry as WorkspaceRegistry & { unarchiveSession?(sessionId: string): Promise<void> }
    if (typeof registry.unarchiveSession !== 'function') {
      throw new Error('当前 dsh 版本不支持取消归档（需要含 workspace.unarchiveSession 的版本）')
    }
    let known: Set<string> | undefined
    let removed = 0
    for (const id of archived) {
      let exists = ctx.sessions.get(id) !== undefined
      if (!exists) {
        if (known === undefined) {
          try {
            const headers = await ctx.sessionPersistence.list()
            known = new Set(headers.map((header) => header.id))
          } catch (error) {
            ctx.logger.warn('backup-sync: 校验归档会话失败，跳过：%s', errorMessage(error))
            return 0
          }
        }
        exists = known.has(id)
      }
      if (!exists) {
        await registry.unarchiveSession(id)
        removed += 1
      }
    }
    return removed
  }

  const command = async (invocation: CommandInvocation): Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }> => {
    try {
      const args = tokens(invocation.rawInput)
      const sub = args[0] ?? ''
      const signal = invocation.signal

      if (sub === '' || sub === 'create') {
        const name = args[1] ?? defaultSnapshotName()
        return { kind: 'success', text: await createBackup(name, signal) }
      }
      if (!SUBCOMMANDS.has(sub)) {
        // 未匹配子命令的输入视为自定义快照名：/backup test → 创建快照 test。
        return { kind: 'success', text: await createBackup(sub, signal) }
      }

      if (sub === 'list') {
        const lines: string[] = []
        const local = await listSnapshots(backupRoot)
        if (local.length === 0) {
          lines.push('本地快照：无（发送 /backup 即可创建）')
        } else {
          lines.push(`本地快照（${local.length}）：`)
          for (const snapshot of local) lines.push(summarizeLine(snapshot))
        }
        if (remoteConfigured) {
          try {
            const config = await remoteAuth()
            const names = await listRemoteSnapshots(config, signal)
            lines.push(names.length === 0
              ? '远端快照：无'
              : `远端快照（${names.length}）：\n${names.map((n) => `  ${n}`).join('\n')}`)
          } catch (error) {
            lines.push(`远端快照：读取失败（${userFacing(error)}）`)
          }
        } else {
          lines.push('远端：未配置（推送前需在配置中设置 remote.baseUrl）')
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      if (sub === 'push') {
        const name = args[1] ?? ''
        if (name === '') return { kind: 'error', text: '用法：/backup push <快照名>' }
        assertSnapshotName(name)
        const meta = await getSnapshot(backupRoot, name)
        if (meta === undefined) return { kind: 'error', text: `本地快照不存在：${name}（可用 /backup list 查看）` }
        const config = await remoteAuth()
        const { uploaded, skipped, removed } = await pushSnapshot(config, name, meta, snapshotDir(backupRoot, name), signal)
        const parts = [`已推送快照 ${name} 到远端：${uploaded} 文件上传`]
        if (skipped > 0) parts.push(`${skipped} 文件跳过（未变化）`)
        if (removed > 0) parts.push(`清理远端残留 ${removed} 个`)
        return { kind: 'success', text: parts.join('，') }
      }

      if (sub === 'pull') {
        const name = args[1] ?? ''
        if (name === '') return { kind: 'error', text: '用法：/backup pull <快照名> [--force]' }
        assertSnapshotName(name)
        const force = args.includes('--force')
        const config = await remoteAuth()
        const { meta, downloaded, removed } = await pullSnapshot(config, name, snapshotDir(backupRoot, name), signal, force)
        const lines = [
          `已同步快照 ${name}：${downloaded} 文件下载 / ${removed} 文件清理（共 ${meta.files.length} 文件 / ${formatBytes(totalBytes(meta.files))}）`,
          `  位置：${snapshotDir(backupRoot, name)}`,
          '下一步：/backup restore <快照名> 恢复数据',
        ]
        return { kind: 'success', text: lines.join('\n') }
      }

      if (sub === 'restore') {
        const name = args[1] ?? ''
        if (name === '') return { kind: 'error', text: '用法：/backup restore <快照名> [--all]' }
        assertSnapshotName(name)
        const all = args.includes('--all')
        const { restored, skipped, warnings, safeguardName } = await restoreSnapshot(backupRoot, home, name, {
          all,
          safeguard: true,
        }, signal)
        const lines: string[] = []
        if (safeguardName !== undefined) {
          lines.push(`恢复前已对现状建保险快照：${safeguardName}`)
        }
        lines.push(`已恢复：${restored.map(sectionLabel).join('、')}`)
        if (skipped.length > 0) lines.push(`未恢复：${skipped.map(sectionLabel).join('、')}`)
        for (const warning of warnings) lines.push(`  警告：${warning}`)
        if (all) {
          lines.push('配置层已还原（设置与各 profile 配置将回退为快照时的状态），请重启 dsh 生效')
        }
        // 会话日志可能被恢复覆盖而归档列表未同步，自动清理失效归档。
        try {
          const swept = await sweepArchives()
          if (swept > 0) lines.push(`已清理 ${swept} 个失效归档（会话日志已不存在）`)
        } catch (error) {
          lines.push(`  警告：清理失效归档失败（${errorMessage(error)}）`)
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      if (sub === 'sweep-archives') {
        const swept = await sweepArchives()
        const total = ctx.workspaceRegistry.archivedSessionIds.length
        return { kind: 'success', text: swept === 0
          ? `归档列表正常（${total} 个会话，无失效条目）`
          : `已清理 ${swept} 个失效归档（剩余 ${total} 个）` }
      }

      if (sub === 'prune') {
        const keepArg = args[1]
        if (keepArg !== undefined && !/^\d+$/.test(keepArg)) {
          return { kind: 'error', text: `保留数非法：${keepArg}` }
        }
        const keep = keepArg !== undefined ? parseInt(keepArg, 10) : autoKeep
        const removed = await pruneSnapshots(backupRoot, keep)
        const remaining = (await listSnapshots(backupRoot)).length
        return { kind: 'success', text: removed.length === 0
          ? `无需清理（保留 ${keep} 个，当前共 ${remaining} 个）`
          : `已清理 ${removed.length} 个旧快照（剩余 ${remaining} 个，可用 /backup list 查看）` }
      }

      if (sub === 'remote-prune') {
        const name = args[1] ?? ''
        if (name === '') return { kind: 'error', text: '用法：/backup remote-prune <快照名>' }
        assertSnapshotName(name)
        const config = await remoteAuth()
        await removeRemoteSnapshot(config, name, signal)
        return { kind: 'success', text: `已删除远端快照：${name}` }
      }

      return { kind: 'error', text: `未知子命令：${sub}\n用法：\n  /backup [快照名]        创建快照（默认时间戳名，也可自定义）\n  /backup list             列出本地与远端快照\n  /backup push <快照名>    推送本地快照到远端\n  /backup pull <快照名> [--force]  从远端同步快照\n  /backup restore <快照名> [--all] 从快照恢复数据\n  /backup prune [保留数]   清理旧快照\n  /backup remote-prune <快照名>   删除远端快照\n  /backup sweep-archives   清理失效的会话归档` }
    } catch (error) {
      return { kind: 'error', text: userFacing(error) }
    }
  }

  /** 把底层错误翻译成用户可读信息：WebDAV 按状态码映射，其余给简短指引。 */
  const userFacing = (error: unknown): string => {
    if (error instanceof WebDavError) {
      const code = error.status
      if (code === 401 || code === 403) {
        return '远端认证失败：请检查用户名/密码（或 WEBDAV_USERNAME / WEBDAV_PASSWORD 凭据）'
      }
      if (code === 404) return '远端路径不存在：请检查配置中的 WebDAV 地址'
      if (code === 413) return '远端拒绝上传（可能空间不足），请清理远端空间后重试'
      return `远端请求失败（HTTP ${code ?? '未知'}）`
    }
    const raw = errorMessage(error)
    if (raw.includes('ENOENT')) return `本地文件读取失败（路径不存在或已被移动）：${raw.slice(0, 120)}`
    return `操作失败：${raw}`
  }

  ctx.effect(() => ctx.commands.register({
    name: 'backup',
    description: '备份/恢复与跨机同步：创建本地快照、WebDAV 推送拉取、恢复与保留清理',
    input: { hint: '[<快照名>|list|push <快照名>|pull <快照名> [--force]|restore <快照名> [--all]|prune [保留数]|sweep-archives]' },
    handler: command,
  }), 'backup-sync: /backup')

  const autoMinutes = config.autoIntervalMinutes ?? 0
  if (autoMinutes > 0) {
    let running = false
    ctx.effect(() => ctx.interval(async () => {
      if (running) return
      running = true
      try {
        const name = defaultSnapshotName()
        await createSnapshot(backupRoot, home, name, { includeAttachments, includeCredentials })
        await pruneSnapshots(backupRoot, autoKeep)
        ctx.logger.info('backup-sync: 自动快照 %s 完成', name)
      } catch (error) {
        ctx.logger.warn('backup-sync: 自动快照失败：%s', errorMessage(error))
      } finally {
        running = false
      }
    }, autoMinutes * 60 * 1000), 'backup-sync: auto-backup')
    ctx.logger.info('backup-sync: 自动备份已启用（每 %d 分钟，保留 %d 个）', autoMinutes, autoKeep)
  }
}
