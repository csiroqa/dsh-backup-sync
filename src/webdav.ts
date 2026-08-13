/**
 * WebDAV 远端：把本地快照目录逐文件 PUT 上传、按 meta.json 清单 GET 下载。
 *
 * 目录布局：<baseUrl>/dsh-backup/<snapshotName>/<相对路径>。
 * 认证：Basic；凭据取 config 或 ctx.credentials（WEBDAV_USERNAME / WEBDAV_PASSWORD 引用）。
 * 零依赖：基于全局 fetch。所有函数只接受 WebDavConfig，认证头由内部派生。
 */
import { createReadStream } from 'node:fs'
import { mkdir, writeFile, rm, lstat, stat, utimes, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { SnapshotMeta, SnapshotFile } from './snapshot.js'
import { safeJoin, errorMessage, assertSnapshotName, SNAPSHOT_NAME } from './snapshot.js'
export interface WebDavConfig {
  /** WebDAV 根地址，如 https://dav.example.com/remote.php/dav/files/user/dsh-backups。 */
  readonly baseUrl: string
  readonly username?: string
  readonly password?: string
}

export class WebDavError extends Error {
  constructor(message: string, readonly status: number | undefined) {
    super(message)
    this.name = 'WebDavError'
  }
}

/** 远端命名空间前缀（baseUrl 之下）。 */
export const REMOTE_PREFIX = 'dsh-backup'

function remoteRoot(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${REMOTE_PREFIX}`
}

function snapshotUrl(base: string, name: string): string {
  return `${remoteRoot(base)}/${encodeURIComponent(name)}/`
}

function fileUrl(base: string, name: string, rel: string): string {
  return `${snapshotUrl(base, name)}${rel.split('/').map(encodeURIComponent).join('/')}`
}

function authHeaders(config: WebDavConfig): Record<string, string> {
  const username = config.username?.trim()
  if (!username) return {}
  return { Authorization: `Basic ${Buffer.from(`${username}:${config.password ?? ''}`).toString('base64')}` }
}

/**
 * 执行 WebDAV 请求。2xx 成功；其余抛 WebDavError（附状态码与响应体片段，
 * 片段仅用于日志定位，不直通用户）。
 */
export async function request(
  method: string,
  url: string,
  config: WebDavConfig,
  body?: BodyInit,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
  streamBody = false,
): Promise<Response> {
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: {
      ...authHeaders(config),
      ...headers,
    },
    body,
    signal,
    duplex: streamBody ? 'half' : undefined,
  }
  const response = await fetch(url, init)
  if (response.ok) return response
  const detail = (await response.text().catch(() => '')).slice(0, 200)
  throw new WebDavError(
    `WebDAV ${method} 失败（HTTP ${response.status}）${detail !== '' ? `：${detail}` : ''}`,
    response.status,
  )
}

/** 逐级确保远端目录存在（MKCOL；已存在的目录常返回 405，视为成功）。 */
async function ensureDir(url: string, config: WebDavConfig, signal?: AbortSignal): Promise<void> {
  const segments = new URL(url).pathname.split('/').filter((segment) => segment.length > 0)
  let current = `${new URL(url).origin}`
  for (const segment of segments) {
    current += `/${segment}`
    try {
      await request('MKCOL', current, config, undefined, signal)
    } catch (error) {
      if (error instanceof WebDavError && error.status === 405) continue
      throw error
    }
  }
}

/** 读取远端快照 meta.json（不存在返回 undefined）。 */
export async function peekRemoteSnapshot(
  config: WebDavConfig,
  name: string,
  signal?: AbortSignal,
): Promise<SnapshotMeta | undefined> {
  let response: Response
  try {
    response = await request('GET', fileUrl(config.baseUrl, name, 'meta.json'), config, undefined, signal)
  } catch (error) {
    if (error instanceof WebDavError && (error.status === 404 || error.status === 405)) return undefined
    throw error
  }
  try {
    return JSON.parse(await response.text()) as SnapshotMeta
  } catch (error) {
    throw new Error(`远端快照 ${name} 的清单无效：${errorMessage(error)}`)
  }
}

/**
 * 把本地快照推送到远端（增量）。流程：
 *   1. 读取远端既有 meta（存在则视为该快照的权威清单）；
 *   2. 对比本地 meta：size+mtime 相同且远端已声明的文件跳过，其余 PUT 上传；
 *   3. meta.json **最后**上传——中途失败/取消时远端没有 meta（或仍是旧 meta），
 *      另一台机器不会读到半程清单；重试天然幂等；
 *   4. 清理远端旧清单中已不存在的文件（同名快照上次推送的残留；meta 差集，
 *      不依赖 PROPFIND 的目录/文件判断）。
 * 返回 { uploaded, skipped, removed }。
 */
export async function pushSnapshot(
  config: WebDavConfig,
  name: string,
  meta: SnapshotMeta,
  snapshotLocalDir: string,
  signal?: AbortSignal,
): Promise<{ uploaded: number; skipped: number; removed: number }> {
  assertSnapshotName(name)
  await ensureDir(snapshotUrl(config.baseUrl, name), config, signal)

  const remoteMeta = await peekRemoteSnapshot(config, name, signal)
  const remoteFiles = new Map<string, SnapshotFile>()
  if (remoteMeta !== undefined) {
    for (const file of remoteMeta.files) remoteFiles.set(file.path, file)
  }

  let uploaded = 0
  let skipped = 0
  for (const file of meta.files) {
    if (signal?.aborted === true) throw new Error('已取消')
    const remote = remoteFiles.get(file.path)
    if (remote !== undefined && remote.size === file.size && remote.mtimeMs === file.mtimeMs) {
      skipped += 1
      continue
    }
    const local = safeJoin(snapshotLocalDir, file.path)
    const current = await stat(local).catch(() => undefined)
    if (current === undefined) throw new Error(`快照文件已不存在，请重新创建快照：${file.path}`)
    if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) {
      throw new Error(`快照文件已变化，请重新创建快照：${file.path}`)
    }
    const stream = Readable.toWeb(createReadStream(local)) as unknown as BodyInit
    await request('PUT', fileUrl(config.baseUrl, name, file.path), config, stream, signal, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.size),
    }, true)
    uploaded += 1
  }
  await request('PUT', fileUrl(config.baseUrl, name, 'meta.json'), config,
    `${JSON.stringify(meta, null, 2)}\n`, signal, { 'Content-Type': 'application/json' })

  // 清理远端旧清单中已不存在的文件（meta 差集；meta.json 始终保留）。
  let removed = 0
  if (remoteMeta !== undefined) {
    const wanted = new Set(meta.files.map((file) => file.path))
    for (const stale of remoteMeta.files) {
      if (signal?.aborted === true) throw new Error('已取消')
      if (wanted.has(stale.path)) continue
      await request('DELETE', fileUrl(config.baseUrl, name, stale.path), config, undefined, signal)
      removed += 1
    }
  }
  return { uploaded, skipped, removed }
}

/**
 * 从远端拉取快照到本地快照目录（增量）。默认行为：
 *   - 本地无该快照 → 全量拉取；
 *   - 本地已有（meta 存在）→ 增量：仅拉取远端清单中缺失或 size+mtime 不同的文件，
 *     并删除本地多余文件；文件 mtime 恢复为快照时刻，二次同步不重复下载；
 *   - force → 清空目标目录后全量重拉。
 */
export async function pullSnapshot(
  config: WebDavConfig,
  name: string,
  snapshotLocalDir: string,
  signal?: AbortSignal,
  force = false,
): Promise<{ meta: SnapshotMeta; downloaded: number; removed: number }> {
  assertSnapshotName(name)
  const meta = await peekRemoteSnapshot(config, name, signal)
  if (meta === undefined) {
    throw new Error(`远端快照不存在：${name}（可先 /backup push ${name} 上传）`)
  }

  const localMetaPath = join(snapshotLocalDir, 'meta.json')
  let localMeta: SnapshotMeta | undefined
  if (!force) {
    localMeta = await readLocalMeta(localMetaPath)
  }
  if (force && existsSync(snapshotLocalDir)) {
    await rm(snapshotLocalDir, { recursive: true, force: true })
  }
  await mkdir(snapshotLocalDir, { recursive: true })

  const remoteFiles = new Map(meta.files.map((file) => [file.path, file]))
  let downloaded = 0
  for (const file of meta.files) {
    if (signal?.aborted === true) throw new Error('已取消')
    const local = safeJoin(snapshotLocalDir, file.path)
    const existing = await lstat(local).catch(() => undefined)
    if (existing?.isSymbolicLink()) {
      await rm(local, { force: true })
    }
    if (!force && localMeta !== undefined && existing?.isFile()) {
      const same = localMeta.files.find((f) => f.path === file.path)
      if (same !== undefined && same.size === file.size && same.mtimeMs === file.mtimeMs) {
        continue
      }
    }
    await mkdir(dirname(local), { recursive: true })
    const response = await request('GET', fileUrl(config.baseUrl, name, file.path), config, undefined, signal)
    await writeFile(local, Buffer.from(await response.arrayBuffer()))
    await utimes(local, new Date(file.mtimeMs), new Date(file.mtimeMs))
    downloaded += 1
  }

  // 删除本地多余文件（远端清单之外；增量模式下上次残留）。
  let removed = 0
  if (!force && localMeta !== undefined && existsSync(snapshotLocalDir)) {
    for (const localPath of await walkLocalFiles(snapshotLocalDir)) {
      if (signal?.aborted === true) throw new Error('已取消')
      if (remoteFiles.has(localPath)) continue
      await rm(safeJoin(snapshotLocalDir, localPath), { force: true })
      removed += 1
    }
  }

  await writeFile(localMetaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return { meta, downloaded, removed }
}

async function readLocalMeta(localMetaPath: string): Promise<SnapshotMeta | undefined> {
  try {
    return JSON.parse(await readFile(localMetaPath, 'utf8')) as SnapshotMeta
  } catch {
    return undefined
  }
}

/** 递归列出本地快照目录内的文件（相对路径，正斜杠）。 */
async function walkLocalFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'meta.json') continue
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), relPath)
      else if (entry.isFile()) files.push(relPath)
    }
  }
  await walk(root, '')
  return files
}

/**
 * 递归列出远端快照目录内的文件（相对快照根，正斜杠）。
 * PROPFIND depth=1 逐层遍历（兼容不支持 depth:infinity 的服务器）。
 */
export async function listRemoteFiles(
  config: WebDavConfig,
  name: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length > 0) {
    if (signal?.aborted === true) throw new Error('已取消')
    const relDir = queue.pop()!
    const url = `${snapshotUrl(config.baseUrl, name)}${relDir === '' ? '' : `${relDir.split('/').map(encodeURIComponent).join('/')}/`}`
    const response = await request('PROPFIND', url, config, undefined, signal, {
      Depth: '1',
      'Content-Type': 'application/xml',
    })
    const xml = await response.text()
    for (const href of xml.matchAll(/<(?:d:)?href>([^<]+)<\/(?:d:)?href>/g)) {
      const raw = href[1]
      const decoded = safeDecode(raw)
      const prefix = new URL(url).pathname
      if (!decoded.startsWith(prefix)) continue
      const rest = decoded.slice(prefix.length)
      if (rest === '' || rest === '/') continue
      const isDir = rest.endsWith('/')
      const rel = isDir ? rest.slice(0, -1) : rest
      if (rel === '') continue
      if (isDir) queue.push(rel)
      else files.push(rel)
    }
  }
  return files
}

/** 列出远端快照名（PROPFIND depth=1，从 href 提取目录名）。 */
export async function listRemoteSnapshots(
  config: WebDavConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  const root = `${remoteRoot(config.baseUrl)}/`
  const response = await request('PROPFIND', root, config, undefined, signal, {
    Depth: '1',
    'Content-Type': 'application/xml',
  })
  const xml = await response.text()
  const names = new Set<string>()
  for (const href of xml.matchAll(/<(?:d:)?href>([^<]+)<\/(?:d:)?href>/g)) {
    const raw = href[1]
    const decoded = safeDecode(raw)
    const candidate = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded
    const name = basename(candidate)
    if (name !== '' && name !== REMOTE_PREFIX && SNAPSHOT_NAME.test(name)) {
      names.add(name)
    }
  }
  return [...names].sort()
}

/** 删除远端快照目录（含全部文件）。 */
export async function removeRemoteSnapshot(
  config: WebDavConfig,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  assertSnapshotName(name)
  await request('DELETE', snapshotUrl(config.baseUrl, name), config, undefined, signal)
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
