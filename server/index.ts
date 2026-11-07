/**
 * Stand-alone server for production: serves the built app from dist/ and the commander API.
 * Run `npm run build`, then `npm run serve` (reads OPENAI_API_KEY and OPENAI_MODEL from the environment or .env).
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assetHandler, commanderHandler, drillHandler, preventionHandler, recoveryHandler, reportHandler } from './commander'
import { staticHandler } from './static'

// minimal .env loading (KEY=value lines), without overriding the real environment
if (existsSync('.env'))
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }

const ROOT = join(process.cwd(), 'dist')
const PORT = Number(process.env.PORT ?? 8787)
const serveStatic = staticHandler(ROOT)

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/api/commander' || path === '/api/commander/health') return commanderHandler(req, res)
  if (path === '/api/recovery') return recoveryHandler(req, res)
  if (path === '/api/prevention') return preventionHandler(req, res)
  if (path === '/api/report') return reportHandler(req, res)
  if (path === '/api/drill') return drillHandler(req, res)
  if (path === '/api/asset') return assetHandler(req, res)
  if (path === '/api' || path.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'not found' }))
    return
  }
  await serveStatic(req, res)
}).listen(PORT, () => console.log(`ForestGuard http://localhost:${PORT}`))
