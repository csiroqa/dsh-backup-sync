/**
 * 本地快照：创建 / 列举 / 恢复 / 清理。
 *
 * 快照是 $DSH_HOME 关键数据在某一时刻的完整复制，布局：
 *   <backupRoot>/snapshots/<name>/
 *     meta.json     —— { formatVersion, name, createdAt, hostname, includeAttachments, files }
 *     sessions/     —— $DSH_HOME/sessions（会话日志，含压缩文件原样复制）
 *     storages/     —— $DSH_HOME/storages（workspace.json 等工作区注册数据）
 *     configs/      —— settings.yaml / cordis.patch.yml / profiles/<name>/cordis.patch.yml（restore --all 才还原）
 *     attachments/  —— 仅 includeAttachments 时存在
 */
import { mkdir, cp, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

export const FORMAT_VERSION = 1

/** 快照内单个文件的相对路径、大小与快照时刻的修改时间（增量对比依据）。 */
export interface SnapshotFile {
  /** 相对快照根的路径（正斜杠分隔）。 */
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

export interface SnapshotMeta {
  readonly formatVersion: number
  readonly name: string
  readonly createdAt: string
  readonly hostname: string
  readonly includeAttachments: boolean
  readonly files: readonly SnapshotFile[]
}

export interface CreateOptions {
  readonly includeAttachments: boolean
  readonly includeCredentials: boolean
}

export interface RestoreOptions {
  /** 是否连 configs 一起还原（settings / patch 层）。默认只还原 sessions + storages。 */
  readonly all: boolean
  /** 恢复前自动快照现状（保险），不想要时置 false。 */
  readonly safeguard: boolean
}

export interface SnapshotSummary {
  readonly name: string
  readonly createdAt: string
  readonly hostname: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly valid: boolean
}

/** 严格快照名：字母或数字开头，仅含字母、数字、点、短横线、下划线，且不以点结尾。 */
export const SNAPSHOT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/

export function defaultSnapshotName(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

export function snapshotsDir(backupRoot: string): string {
  return join(backupRoot, 'snapshots')
}

export function snapshotDir(backupRoot: string, name: string): string {
  return join(snapshotsDir(backupRoot), name)
}

export function assertSnapshotName(name: string): void {
  if (!SNAPSHOT_NAME.test(name)) {
    throw new Error(`快照名 "${name}" 非法：仅允许字母、数字、点、短横线与下划线，且须以字母或数字开头`)
  }
}

/** $DSH_HOME 下按目录整备份的数据区（credentials 是单文件，单独处理）。 */
export function homeDataDirs(includeAttachments: boolean): string[] {
  const dirs = ['sessions', 'storages']
  if (includeAttachments) dirs.push('attachments')
  return dirs
}

/** 相对 $DSH_HOME 的配置文件清单（restore --all 使用）。 */
export const CONFIG_FILES = ['settings.yaml', 'cordis.patch.yml']

export function totalBytes(files: readonly SnapshotFile[]): number {
  let sum = 0
  for (const file of files) sum += file.size
  return sum
}

export function serializeMeta(meta: SnapshotMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`
}

function prefixFiles(files: SnapshotFile[], prefix: string): SnapshotFile[] {
  return files.map((file) => ({ ...file, path: `${prefix}/${file.path}` }))
}

async function collectFiles(root: string, rel = '', warnings: string[] = []): Promise<SnapshotFile[]> {
  const dir = join(root, rel)
  const entries = await readdir(dir, { withFileTypes: true })
  const files: SnapshotFile[] = []
  for (const entry of entries) {
    if (rel === '' && entry.name === 'meta.json') continue
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, relPath, warnings)))
    } else if (entry.isFile()) {
      try {
        const s = await stat(join(root, relPath))
        files.push({ path: relPath, size: s.size, mtimeMs: Math.round(s.mtimeMs) })
      } catch (error) {
        warnings.push(`跳过 ${relPath}（文件在收集时消失）：${errorMessage(error)}`)
      }
    }
  }
  return files
}

async function copyTree(src: string, dest: string, rel: string, warnings: string[]): Promise<void> {
  if (!existsSync(src)) return
  await mkdir(dest, { recursive: true })
  try {
    await cp(src, dest, { recursive: true, force: true, dereference: true })
  } catch (error) {
    // Windows 上被占用/只读文件会导致整树失败；退回逐文件复制以尽可能多恢复。
    warnings.push(`复制 ${rel} 失败，已尝试逐文件复制：${errorMessage(error)}`)
    const entries = await readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      const from = join(src, entry.name)
      const to = join(dest, entry.name)
      try {
        if (entry.isDirectory()) await copyTree(from, to, `${rel}/${entry.name}`, warnings)
        else if (entry.isFile()) {
          await mkdir(dirname(to), { recursive: true })
          await cp(from, to, { force: true, dereference: true })
        }
      } catch (perFile) {
        warnings.push(`复制 ${rel}/${entry.name} 失败：${errorMessage(perFile)}`)
      }
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 创建一次完整快照；名字冲突时抛错（用自定义名避免覆盖）。失败/取消时清理半成品目录。 */
export async function createSnapshot(
  backupRoot: string,
  dshHome: string,
  name: string,
  options: CreateOptions,
  signal?: AbortSignal,
): Promise<{ meta: SnapshotMeta; warnings: string[] }> {
  assertSnapshotName(name)
  const dir = snapshotDir(backupRoot, name)
  if (existsSync(dir)) {
    throw new Error(`快照已存在：${name}（${dir}）`)
  }
  const throwIfAborted = (): void => {
    if (signal?.aborted === true) throw new Error('已取消')
  }

  const warnings: string[] = []
  const sections: Array<{ rel: string; source: string; dest: string; files: SnapshotFile[] }> = []
  for (const rel of homeDataDirs(options.includeAttachments)) {
    const source = join(dshHome, rel)
    if (!existsSync(source)) continue
    sections.push({
      rel,
      source,
      dest: join(dir, rel),
      files: prefixFiles(await collectFiles(source, '', warnings), rel),
    })
  }
  if (options.includeCredentials) {
    const credentialsSrc = join(dshHome, '.credentials.yaml')
    if (existsSync(credentialsSrc)) {
      const s = await stat(credentialsSrc)
      sections.push({
        rel: 'credentials',
        source: credentialsSrc,
        dest: join(dir, 'credentials', '.credentials.yaml'),
        files: [{ path: 'credentials/.credentials.yaml', size: s.size, mtimeMs: Math.round(s.mtimeMs) }],
      })
    }
  }

  const configs: SnapshotFile[] = []
  for (const rel of CONFIG_FILES) {
    const src = join(dshHome, rel)
    if (existsSync(src)) {
      const s = await stat(src)
      configs.push({ path: rel, size: s.size, mtimeMs: Math.round(s.mtimeMs) })
    }
  }
  const profilesSrc = join(dshHome, 'profiles')
  if (existsSync(profilesSrc)) {
    const profiles = await readdir(profilesSrc, { withFileTypes: true })
    for (const profile of profiles) {
      if (!profile.isDirectory() || profile.name === 'node_modules') continue
      const patch = join(profilesSrc, profile.name, 'cordis.patch.yml')
      if (!existsSync(patch)) continue
      const s = await stat(patch)
      configs.push({
        path: `profiles/${profile.name}/cordis.patch.yml`,
        size: s.size,
        mtimeMs: Math.round(s.mtimeMs),
      })
    }
  }

  const files: SnapshotFile[] = []
  try {
    for (const section of sections) {
      throwIfAborted()
      await copyTree(section.source, section.dest, section.rel, warnings)
      files.push(...section.files)
    }
    for (const config of configs) {
      throwIfAborted()
      const dest = join(dir, 'configs', config.path)
      await mkdir(dirname(dest), { recursive: true })
      try {
        await cp(join(dshHome, config.path), dest, { force: true, dereference: true })
        files.push({ path: `configs/${config.path}`, size: config.size, mtimeMs: Math.round(config.mtimeMs) })
      } catch (error) {
        warnings.push(`配置复制失败 ${config.path}：${errorMessage(error)}`)
      }
    }

    const meta: SnapshotMeta = {
      formatVersion: FORMAT_VERSION,
      name,
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      includeAttachments: options.includeAttachments,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    }
    await writeFile(join(dir, 'meta.json'), serializeMeta(meta))
    return { meta, warnings }
  } catch (error) {
    // 收集/复制/写 meta 失败时清理半成品目录，避免孤儿快照；清理失败不掩盖原错误。
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (cleanupError) {
      warnings.push(`清理半成品快照失败 ${name}：${errorMessage(cleanupError)}`)
    }
    throw error
  }
}

function summarize(dir: string, meta: SnapshotMeta | undefined): SnapshotSummary {
  return {
    name: meta?.name ?? basename(dir),
    createdAt: meta?.createdAt ?? '',
    hostname: meta?.hostname ?? '',
    fileCount: meta?.files.length ?? 0,
    totalBytes: meta === undefined ? 0 : totalBytes(meta.files),
    valid: meta !== undefined,
  }
}

/** 按名称读取快照 meta；不存在/损坏返回 undefined。 */
export async function getSnapshot(backupRoot: string, name: string): Promise<SnapshotMeta | undefined> {
  try {
    return JSON.parse(await readFile(join(snapshotDir(backupRoot, name), 'meta.json'), 'utf8')) as SnapshotMeta
  } catch {
    return undefined
  }
}

/** 列出本地全部快照（按创建时间倒序）。 */
export async function listSnapshots(backupRoot: string): Promise<SnapshotSummary[]> {
  if (!existsSync(snapshotsDir(backupRoot))) return []
  const dirs = await readdir(snapshotsDir(backupRoot), { withFileTypes: true })
  const summaries: SnapshotSummary[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name === 'node_modules') continue
    summaries.push(summarize(join(snapshotsDir(backupRoot), dir.name), await getSnapshot(backupRoot, dir.name)))
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** 保留最近 keep 个快照，删除更旧的；返回被删除的名字。 */
export async function pruneSnapshots(backupRoot: string, keep: number): Promise<string[]> {
  if (keep <= 0) return []
  const snapshots = await listSnapshots(backupRoot)
  const stale = snapshots.slice(keep)
  const removed: string[] = []
  for (const snapshot of stale) {
    await rm(snapshotDir(backupRoot, snapshot.name), { recursive: true, force: true })
    removed.push(snapshot.name)
  }
  return removed
}

/**
 * 从本地快照恢复。safeguard 开启时先对现状建快照；
 * 返回 { restored, skipped, warnings, safeguardName }。
 */
export async function restoreSnapshot(
  backupRoot: string,
  dshHome: string,
  name: string,
  options: RestoreOptions,
  signal?: AbortSignal,
): Promise<{ restored: string[]; skipped: string[]; warnings: string[]; safeguardName: string | undefined }> {
  assertSnapshotName(name)
  const meta = await getSnapshot(backupRoot, name)
  if (meta === undefined) {
    throw new Error(`本地快照不存在：${name}（可用 /backup pull <name> 从远端拉取）`)
  }

  let safeguardName: string | undefined
  if (options.safeguard) {
    safeguardName = `${defaultSnapshotName()}-pre-restore`
    await createSnapshot(backupRoot, dshHome, safeguardName, {
      includeAttachments: meta.includeAttachments,
      includeCredentials: false,
    })
  }
  const warnings: string[] = []
  const restored: string[] = []
  const skipped: string[] = []
  const src = snapshotDir(backupRoot, name)

  const sections: Array<{ rel: string; dest: string; essential: boolean; file: boolean }> = [
    { rel: 'sessions', dest: join(dshHome, 'sessions'), essential: true, file: false },
    { rel: 'storages', dest: join(dshHome, 'storages'), essential: true, file: false },
  ]
  if (options.all) {
    for (const rel of CONFIG_FILES) {
      sections.push({ rel: `configs/${rel}`, dest: join(dshHome, rel), essential: false, file: true })
    }
    const profilesSrc = join(src, 'configs', 'profiles')
    if (existsSync(profilesSrc)) {
      sections.push({ rel: 'configs/profiles', dest: join(dshHome, 'profiles'), essential: false, file: false })
    }
  }

  for (const section of sections) {
    if (signal?.aborted === true) throw new Error('已取消')
    const from = join(src, section.rel)
    if (!existsSync(from)) {
      if (section.essential) skipped.push(section.rel)
      continue
    }
    const before = warnings.length
    if (section.file) {
      await mkdir(dirname(section.dest), { recursive: true })
      try {
        await cp(from, section.dest, { force: true, dereference: true })
      } catch (error) {
        warnings.push(`复制 ${section.rel} 失败：${errorMessage(error)}`)
      }
    } else {
      await copyTree(from, section.dest, section.rel, warnings)
    }
    if (warnings.length === before) {
      restored.push(section.rel)
    } else {
      skipped.push(section.rel)
    }
  }
  return { restored, skipped, warnings, safeguardName }
}

/** 相对路径逃逸防护：确保解析后的路径仍位于 dir 之下。 */
export function safeJoin(dir: string, rel: string): string {
  const joined = resolve(join(dir, ...rel.split('/')))
  const root = resolve(dir) + sep
  if (joined !== resolve(dir) && !joined.startsWith(root)) {
    throw new Error(`非法快照路径：${rel}`)
  }
  return joined
}
