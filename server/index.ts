/**
 * Stand-alone server for production: serves the built app from dist/ and the commander API.
 * Run `npm run build`, then `npm run serve` (reads OPENAI_API_KEY and OPENAI_MODEL from the environment or .env).
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { commanderHandler, drillHandler, preventionHandler, recoveryHandler, reportHandler } from './commander'

// minimal .env loading (KEY=value lines), without overriding the real environment
if (existsSync('.env'))
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' }
const ROOT = join(process.cwd(), 'dist')
const PORT = Number(process.env.PORT ?? 8787)

createServer(async (req, res) => {
  if (req.url?.startsWith('/api/commander')) return commanderHandler(req, res)
  if (req.url?.startsWith('/api/recovery')) return recoveryHandler(req, res)
  if (req.url?.startsWith('/api/prevention')) return preventionHandler(req, res)
  if (req.url?.startsWith('/api/report')) return reportHandler(req, res)
  if (req.url?.startsWith('/api/drill')) return drillHandler(req, res)
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '')
  const file = join(ROOT, path || 'index.html')
  if (!file.startsWith(ROOT)) {
    res.statusCode = 403
    return res.end()
  }
  try {
    const data = await readFile(existsSync(file) && extname(file) ? file : join(ROOT, 'index.html'))
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'text/html; charset=utf-8')
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}).listen(PORT, () => console.log(`ForestGuard http://localhost:${PORT}`))
