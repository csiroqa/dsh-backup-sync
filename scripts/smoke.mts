/**
 * backup-sync 核心逻辑冒烟测试（本地快照 + WebDAV 远端，纯逻辑、不依赖 dsh 实例）。
 *
 * 运行（在 harness 仓库目录，tsx 由其 node_modules 提供）：
 *   node --import tsx/esm ../dsh-plugin/scripts/smoke-backup.mts
 */
import { mkdir, writeFile, readFile, rm, mkdtemp, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import {
  createSnapshot, restoreSnapshot, listSnapshots, pruneSnapshots, snapshotDir, safeJoin,
} from '../src/snapshot.js'
import {
  pushSnapshot, pullSnapshot, listRemoteSnapshots, listRemoteFiles, removeRemoteSnapshot, peekRemoteSnapshot,
} from '../src/webdav.js'

/** 测试夹具：DSH_HOME 下的会话日志相对路径（正斜杠，与快照内路径约定一致）与内容。 */
const SESSION_REL = 'sessions/proj--a--/sess-1/session.jsonl.zstd'
const SNAPSHOT_BODY = 'fake-log-1\n'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}  ${detail}`)
  }
}

/** 最小 WebDAV 内存 mock：MKCOL / PUT / GET / PROPFIND / DELETE；failPut 使指定 PUT 返回 500。 */
function createWebDavMock(failPut?: string): Server {
  const store = new Map<string, Uint8Array>()
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    const method = req.method ?? ''
    const respond = (status: number, body: string, type = 'text/plain') => {
      res.writeHead(status, { 'Content-Type': type })
      res.end(body)
    }
    if (method === 'MKCOL') {
      if (store.has(path) || [...store.keys()].some((k) => k.startsWith(`${path}/`))) {
        respond(405, 'exists')
      } else {
        store.set(`${path}/`, new Uint8Array())
        respond(201, 'created')
      }
      return
    }
    if (method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        if (failPut !== undefined && path.includes(failPut)) {
          respond(500, 'injected failure')
          return
        }
        store.set(path, Buffer.concat(chunks))
        respond(201, 'stored')
      })
      return
    }
    if (method === 'GET') {
      const value = store.get(path)
      if (value === undefined) respond(404, 'not found')
      else {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(value)
      }
      return
    }
    if (method === 'PROPFIND') {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const kids = [...store.keys()].filter((k) => k.startsWith(prefix) && k !== prefix)
      const hrefs = new Set<string>()
      for (const key of kids) {
        const rest = key.slice(prefix.length)
        const top = rest.split('/')[0]
        if (top === '') continue
        // 深层路径聚合出的中间目录带尾斜杠，与真实 WebDAV 的目录 href 一致。
        const isDir = key.endsWith('/') || rest.includes('/')
        hrefs.add(`${prefix}${top}${isDir ? '/' : ''}`)
      }
      const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${prefix}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>${[...hrefs].map((href) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${href.endsWith('/') ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`
      respond(207, xml, 'application/xml')
      return
    }
    if (method === 'DELETE') {
      const prefix = path.endsWith('/') ? path : `${path}/`
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(prefix)) store.delete(key)
      }
      respond(204, '')
      return
    }
    respond(501, 'unsupported')
  })
  return server
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-backup-smoke-'))
  const home = join(temp, 'dsh-home')
  const backupRoot = join(temp, 'backups')
  const sessionDir = join(home, ...SESSION_REL.split('/').slice(0, -1))
  await mkdir(sessionDir, { recursive: true })
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(sessionDir, 'session.jsonl.zstd'), SNAPSHOT_BODY)
  await writeFile(join(home, 'storages', 'workspace.json'), '{"workspaces":[]}')
  await writeFile(join(home, 'settings.yaml'), 'telemetry: false\n')
  await writeFile(join(home, 'cordis.patch.yml'), '- insert:\n')

  console.log('== 本地快照 ==')
  const name = 'smoke-1'
  const { meta, warnings } = await createSnapshot(backupRoot, home, name, {
    includeAttachments: false, includeCredentials: false,
  })
  check('createSnapshot 返回 meta', meta.name === name)
  check('createSnapshot 无警告', warnings.length === 0, warnings.join('; '))
  check('快照目录含 sessions 文件', existsSync(join(snapshotDir(backupRoot, name), SESSION_REL)))
  check('快照目录含 storages', existsSync(join(snapshotDir(backupRoot, name), 'storages', 'workspace.json')))
  check('快照目录含 configs', existsSync(join(snapshotDir(backupRoot, name), 'configs', 'settings.yaml')))
  check('快照目录含 meta.json', existsSync(join(snapshotDir(backupRoot, name), 'meta.json')))
  check('meta.files 路径带分区前缀', meta.files.every((f) => f.path.includes('/')), meta.files.map((f) => f.path).join(','))

  let duplicateRejected = false
  try {
    await createSnapshot(backupRoot, home, name, { includeAttachments: false, includeCredentials: false })
  } catch {
    duplicateRejected = true
  }
  check('重名快照被拒绝', duplicateRejected)

  let invalidNameRejected = false
  try {
    await createSnapshot(backupRoot, home, 'a/b', { includeAttachments: false, includeCredentials: false })
  } catch {
    invalidNameRejected = true
  }
  check('非法快照名被拒绝', invalidNameRejected)

  const snapshots = await listSnapshots(backupRoot)
  check('listSnapshots 列出 1 个', snapshots.length === 1, `got ${snapshots.length}`)
  check('listSnapshots 摘要有效', snapshots[0]?.valid === true && snapshots[0]?.fileCount > 0)

  console.log('== 恢复 ==')
  await writeFile(join(sessionDir, 'session.jsonl.zstd'), 'corrupted-or-lost\n')
  await rm(join(home, 'storages', 'workspace.json'))
  const restored = await restoreSnapshot(backupRoot, home, name, { all: false, safeguard: true })
  check('restore 恢复 sessions+storages', restored.restored.length === 2, restored.restored.join(','))
  check('restore 保险快照已建', restored.safeguardName !== undefined && existsSync(snapshotDir(backupRoot, restored.safeguardName!)))
  check('sessions 文件内容还原', (await readFile(join(sessionDir, 'session.jsonl.zstd'), 'utf8')) === SNAPSHOT_BODY)
  check('storages 文件还原', (await readFile(join(home, 'storages', 'workspace.json'), 'utf8')) === '{"workspaces":[]}')
  check('settings.yaml 未被 --all 前覆盖', (await readFile(join(home, 'settings.yaml'), 'utf8')).includes('telemetry'))

  console.log('== restore --all ==')
  await writeFile(join(home, 'settings.yaml'), 'telemetry: true\n')
  const restoredAll = await restoreSnapshot(backupRoot, home, name, { all: true, safeguard: false })
  check('restore --all 还原 configs', restoredAll.restored.some((r) => r.startsWith('configs/')), restoredAll.restored.join(','))
  check('settings.yaml 内容还原', (await readFile(join(home, 'settings.yaml'), 'utf8')).includes('telemetry: false'))

  console.log('== 路径逃逸防护 ==')
  const guardDir = join(temp, 'guard')
  check('safeJoin 拒绝 .. 逃逸', (() => { try { safeJoin(guardDir, 'a/../../evil'); return false } catch { return true } })())
  check('safeJoin 接受正常路径', safeJoin(guardDir, 'a/b.txt') === join(guardDir, 'a', 'b.txt'))
  check('safeJoin 拒绝盘符逃逸', (() => {
    const result = safeJoin(guardDir, 'C:/evil.txt')
    return result.startsWith(join(guardDir))
  })())

  console.log('== abort 清理 ==')
  const aborted = new AbortController()
  aborted.abort()
  let abortRejected = false
  try {
    await createSnapshot(backupRoot, home, 'abort-1', {
      includeAttachments: false, includeCredentials: false,
    }, aborted.signal)
  } catch {
    abortRejected = true
  }
  check('abort 抛错', abortRejected)
  check('abort 后无半成品目录', !existsSync(snapshotDir(backupRoot, 'abort-1')))

  console.log('== 清理 ==')
  const removed = await pruneSnapshots(backupRoot, 1)
  check('prune 保留 1 删除 1', removed.length === 1 && removed[0] === name, removed.join(','))
  check('prune 后剩 1 个', (await listSnapshots(backupRoot)).length === 1)

  console.log('== WebDAV 远端 ==')
  const remote = { baseUrl: '', username: 'u', password: 'p' }
  const { meta: meta2 } = await createSnapshot(backupRoot, home, 'remote-1', {
    includeAttachments: false, includeCredentials: false,
  })

  let mock: Server
  let port: number
  mock = createWebDavMock()
  port = await listen(mock)
  remote.baseUrl = `http://127.0.0.1:${port}/dav/user/backups`
  const firstPush = await pushSnapshot(remote, 'remote-1', meta2, snapshotDir(backupRoot, 'remote-1'))
  check('push 上传全部文件', firstPush.uploaded === meta2.files.length && firstPush.skipped === 0, JSON.stringify(firstPush))

  const secondPush = await pushSnapshot(remote, 'remote-1', meta2, snapshotDir(backupRoot, 'remote-1'))
  check('push 二次全跳过（增量）', secondPush.uploaded === 0 && secondPush.skipped === meta2.files.length, JSON.stringify(secondPush))

  const remoteList = await listRemoteSnapshots(remote)
  check('listRemoteSnapshots 含 remote-1', remoteList.includes('remote-1'), remoteList.join(','))

  console.log('== push 清理远端残留 ==')
  // 模拟旧版本快照：远端存在旧清单（含一个已废弃文件）与对应的残留文件。
  const base = `http://127.0.0.1:${port}/dav/user/backups/dsh-backup/remote-1`
  const oldMeta = { ...meta2, files: [...meta2.files, { path: 'old-stale.bin', size: 5, mtimeMs: 1 }] }
  await fetch(`${base}/old-stale.bin`, { method: 'PUT', body: 'stale' })
  await fetch(`${base}/meta.json`, { method: 'PUT', body: JSON.stringify(oldMeta) })
  const staleRemote = await listRemoteFiles(remote, 'remote-1')
  check('远端存在残留文件', staleRemote.includes('old-stale.bin'), staleRemote.join(','))
  const thirdPush = await pushSnapshot(remote, 'remote-1', meta2, snapshotDir(backupRoot, 'remote-1'))
  check('push 清理远端残留', thirdPush.removed === 1 && thirdPush.uploaded === 0, JSON.stringify(thirdPush))
  check('远端残留已删除', !(await listRemoteFiles(remote, 'remote-1')).includes('old-stale.bin'))
  mock.close()

  console.log('== push 中途失败（meta 后置） ==')
  mock = createWebDavMock('workspace.json')
  port = await listen(mock)
  remote.baseUrl = `http://127.0.0.1:${port}/dav/user/backups`
  let pushFailed = false
  try {
    await pushSnapshot(remote, 'broken', meta2, snapshotDir(backupRoot, 'remote-1'))
  } catch {
    pushFailed = true
  }
  check('push 中途失败抛错', pushFailed)
  const peekBroken = await peekRemoteSnapshot(remote, 'broken')
  check('失败后远端无 meta（pull 视为不存在）', peekBroken === undefined)
  mock.close()

  console.log('== pull 增量与 --force ==')
  mock = createWebDavMock()
  port = await listen(mock)
  remote.baseUrl = `http://127.0.0.1:${port}/dav/user/backups`
  await pushSnapshot(remote, 'remote-1', meta2, snapshotDir(backupRoot, 'remote-1'))
  const pulled = await pullSnapshot(remote, 'remote-1', snapshotDir(backupRoot, 'remote-1-pulled'))
  check('pull 拉取文件数一致', pulled.meta.files.length === meta2.files.length && pulled.downloaded === meta2.files.length, JSON.stringify(pulled))
  const sessionFile = meta2.files.find((f) => f.path.endsWith('session.jsonl.zstd'))
  check('pull 内容一致', (await readFile(join(snapshotDir(backupRoot, 'remote-1-pulled'), SESSION_REL), 'utf8')) === SNAPSHOT_BODY)
  const pulledMtime = (await stat(join(snapshotDir(backupRoot, 'remote-1-pulled'), sessionFile!.path))).mtimeMs
  check('pull 恢复 mtime（容差 2ms）', sessionFile !== undefined && Math.abs(pulledMtime - sessionFile.mtimeMs) < 2, `got ${pulledMtime} vs ${sessionFile?.mtimeMs}`)

  const secondPull = await pullSnapshot(remote, 'remote-1', snapshotDir(backupRoot, 'remote-1-pulled'))
  check('pull 二次全跳过（增量）', secondPull.downloaded === 0, JSON.stringify(secondPull))

  const staleLocal = join(snapshotDir(backupRoot, 'remote-1-pulled'), 'stale-extra.txt')
  await writeFile(staleLocal, 'old leftover')
  const thirdPull = await pullSnapshot(remote, 'remote-1', snapshotDir(backupRoot, 'remote-1-pulled'))
  check('pull 清理本地残留', thirdPull.removed >= 1 && !existsSync(staleLocal), JSON.stringify(thirdPull))

  await pullSnapshot(remote, 'remote-1', snapshotDir(backupRoot, 'remote-1-pulled'), undefined, true)
  check('pull --force 内容完整', existsSync(join(snapshotDir(backupRoot, 'remote-1-pulled'), 'meta.json')))

  await removeRemoteSnapshot(remote, 'remote-1')
  check('remote-prune 后远端为空', (await listRemoteSnapshots(remote)).length === 0)
  mock.close()

  await rm(temp, { recursive: true, force: true })
  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
