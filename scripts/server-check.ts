import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { staticHandler } from '../server/static'

const directory = await mkdtemp(join(tmpdir(), 'forestguard-server-check-'))
const root = join(directory, 'dist')
const neighbor = join(directory, 'dist-neighbor')
await mkdir(root)
await mkdir(neighbor)
await writeFile(join(root, 'index.html'), '<!doctype html><title>ForestGuard</title>')
await writeFile(join(root, 'app.js'), 'export const ready = true')
await writeFile(join(neighbor, 'private.txt'), 'must never be served')

const server = createServer(staticHandler(root))
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const port = address.port
  // Use raw request paths: fetch/URL would normalize traversal before the server can inspect it.
  const get = (path: string, method = 'GET') => new Promise<{ status: number; body: string; type: string; allow: string | undefined }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), type: res.headers['content-type'] ?? '', allow: res.headers.allow }))
    })
    req.on('error', reject)
    req.end()
  })
  assert.match((await get('/')).body, /ForestGuard/)
  const asset = await get('/app.js?v=1')
  assert.equal(asset.status, 200)
  assert.match(asset.type, /javascript/)
  assert.match(asset.body, /ready/)
  const fallback = await get('/studio')
  assert.equal(fallback.status, 200)
  assert.match(fallback.type, /text\/html/)
  assert.equal((await get('/missing.js')).status, 404)
  for (const path of ['/%', '/%E0%A4%A', '/%00']) assert.equal((await get(path)).status, 400, path)
  for (const path of ['/../dist-neighbor/private.txt', '/%2e%2e%2fdist-neighbor/private.txt', '/%2e%2e%5cdist-neighbor%5cprivate.txt']) {
    assert.equal((await get(path)).status, 403, path)
  }
  const head = await get('/app.js', 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  const post = await get('/', 'POST')
  assert.equal(post.status, 405)
  assert.equal(post.allow, 'GET, HEAD')
  assert.equal((await get('/')).status, 200, 'Server must keep serving after malformed requests')
  console.log('Sunucu kapısı geçildi: dosya sunumu, MIME, HEAD, hatalı URL, kök dışına erişim ve eksik dosyalar.')
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  // Remove only the explicitly created fixtures; no recursive cleanup of a computed directory.
  await unlink(join(root, 'index.html'))
  await unlink(join(root, 'app.js'))
  await unlink(join(neighbor, 'private.txt'))
  await rmdir(root)
  await rmdir(neighbor)
  await rmdir(directory)
}
