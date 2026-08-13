/**
 * WebDAV 远端：把本地快照目录逐文件 PUT 上传、按 meta.json 清单 GET 下载。
 *
 * 目录布局：<baseUrl>/dsh-backup/<snapshotName>/<相对路径>。
 * 认证：Basic；凭据取 config 或 ctx.credentials（WEBDAV_USERNAME / WEBDAV_PASSWORD 引用）。
 * 零依赖：基于全局 fetch。所有函数只接受 WebDavConfig，认证头由内部派生。
 */
import { createReadStream } from 'node:fs'
import { mkdir, writeFile, rm, lstat, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { SnapshotMeta } from './snapshot.js'
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
 * 把本地快照推送到远端。meta.json **最后**上传：中途失败/取消时远端
 * 没有 meta，另一台机器 pull 会识别为"快照不存在"而不是读到半程清单；
 * 重试时同名 PUT 覆盖，天然幂等。返回上传文件数。
 */
export async function pushSnapshot(
  config: WebDavConfig,
  name: string,
  meta: SnapshotMeta,
  snapshotLocalDir: string,
  signal?: AbortSignal,
): Promise<number> {
  assertSnapshotName(name)
  await ensureDir(snapshotUrl(config.baseUrl, name), config, signal)

  let uploaded = 0
  for (const file of meta.files) {
    if (signal?.aborted === true) throw new Error('已取消')
    const local = safeJoin(snapshotLocalDir, file.path)
    const current = await stat(local).catch(() => undefined)
    if (current === undefined) throw new Error(`快照文件已不存在，请重新创建快照：${file.path}`)
    if (current.size !== file.size) {
      throw new Error(`快照文件大小已变化，请重新创建快照：${file.path}（${file.size} → ${current.size}）`)
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
  return uploaded
}

/**
 * 从远端拉取快照到本地快照目录。已存在同名时抛错（force 覆盖，
 * force 会先清空目标目录，避免残留旧文件在 restore 时复活）。
 */
export async function pullSnapshot(
  config: WebDavConfig,
  name: string,
  snapshotLocalDir: string,
  signal?: AbortSignal,
  force = false,
): Promise<SnapshotMeta> {
  assertSnapshotName(name)
  const meta = await peekRemoteSnapshot(config, name, signal)
  if (meta === undefined) {
    throw new Error(`远端快照不存在：${name}（可先 /backup push ${name} 上传）`)
  }
  if (existsSync(snapshotLocalDir)) {
    if (force || !existsSync(join(snapshotLocalDir, 'meta.json'))) {
      // force：整目录重拉；无 meta（上次拉取中断的残留）：清掉再拉，避免旧文件残留。
      await rm(snapshotLocalDir, { recursive: true, force: true })
    } else {
      throw new Error(`本地已存在同名快照：${name}（加 --force 覆盖）`)
    }
  }
  await mkdir(snapshotLocalDir, { recursive: true })
  let downloaded = 0
  for (const file of meta.files) {
    if (signal?.aborted === true) throw new Error('已取消')
    const local = safeJoin(snapshotLocalDir, file.path)
    await mkdir(dirname(local), { recursive: true })
    const existing = await lstat(local).catch(() => undefined)
    if (existing?.isSymbolicLink()) {
      await rm(local, { force: true })
    }
    const response = await request('GET', fileUrl(config.baseUrl, name, file.path), config, undefined, signal)
    await writeFile(local, Buffer.from(await response.arrayBuffer()))
    downloaded += 1
  }
  await writeFile(join(snapshotLocalDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return meta
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
