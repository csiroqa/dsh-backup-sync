import { listRemoteFiles } from '../src/webdav.js'
import { createServer } from 'node:http'

const store = new Map()
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  if (req.method === 'MKCOL') { store.set(path + '/', 1); res.writeHead(201).end(); return }
  if (req.method === 'PUT') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { store.set(path, Buffer.concat(chunks)); res.writeHead(201).end() })
    return
  }
  if (req.method === 'PROPFIND') {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const kids = [...store.keys()].filter((k) => k.startsWith(prefix) && k !== prefix)
    const hrefs = new Set()
    for (const key of kids) {
      const top = key.slice(prefix.length).split('/')[0]
      if (top) hrefs.add(prefix + top + (key.endsWith('/') ? '/' : ''))
    }
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[...hrefs].map((h) => `<d:response><d:href>${h}</d:href></d:response>`).join('')}</d:multistatus>`
    res.writeHead(207, { 'Content-Type': 'application/xml' })
    res.end(xml)
    return
  }
  if (req.method === 'GET') {
    const v = store.get(path)
    v ? res.writeHead(200).end(v) : res.writeHead(404).end()
    return
  }
  if (req.method === 'DELETE') {
    for (const k of [...store.keys()]) {
      if (k === path || k.startsWith(path.endsWith('/') ? path : `${path}/`)) store.delete(k)
    }
    res.writeHead(204).end()
    return
  }
  res.writeHead(501).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const remote = { baseUrl: `http://127.0.0.1:${port}/dav/user/backups`, username: 'u', password: 'p' }
store.set('/dav/user/backups/dsh-backup/remote-1/', 1)
store.set('/dav/user/backups/dsh-backup/remote-1/meta.json', Buffer.from('{}'))
store.set('/dav/user/backups/dsh-backup/remote-1/extra-stale.bin', Buffer.from('x'))
store.set('/dav/user/backups/dsh-backup/remote-1/sessions/proj--a--/sess-1/session.jsonl.zstd', Buffer.from('y'))
const files = await listRemoteFiles(remote, 'remote-1')
console.error('LIST:', JSON.stringify(files))
server.close()
