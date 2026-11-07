import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
}

/** Static delivery stays independent of the AI handlers, so it can be checked without credentials or API calls. */
export function staticHandler(directory: string) {
  const root = resolve(directory)
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end('method not allowed')
      return
    }
    let path: string
    try {
      // Interpret URL separators consistently on Windows and Linux before checking the root boundary.
      path = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/\\/g, '/')
      if (path.includes('\0')) throw new Error('invalid path')
    } catch {
      res.writeHead(400).end('bad request')
      return
    }
    const file = resolve(root, path.replace(/^[/\\]+/, '') || 'index.html')
    const withinRoot = relative(root, file)
    if (isAbsolute(withinRoot) || withinRoot === '..' || withinRoot.startsWith(`..${sep}`)) {
      res.writeHead(403).end('forbidden')
      return
    }
    // HashRouter needs no asset fallback: missing JS/CSS must return 404, not an HTML page with an asset MIME type.
    const served = extname(file) ? file : resolve(root, 'index.html')
    try {
      const data = await readFile(served)
      res.setHeader('Content-Type', TYPES[extname(served)] ?? 'application/octet-stream')
      res.setHeader('Content-Length', data.length)
      res.setHeader('Cache-Control', extname(served) === '.html' ? 'no-cache' : 'public, max-age=3600')
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : data)
    } catch {
      res.writeHead(404).end('not found')
    }
  }
}
