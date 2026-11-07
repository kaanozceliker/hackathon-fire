import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

/** Mounts the AI commander API (server/commander.ts) on the dev and preview servers. */
function commanderApi(): Plugin {
  const handler: Handler = (req, res, next) => {
    import('./server/commander').then(({ commanderHandler }) => commanderHandler(req, res, next)).catch(next)
  }
  const prevention: Handler = (req, res, next) => {
    import('./server/commander').then(({ preventionHandler }) => preventionHandler(req, res, next)).catch(next)
  }
  const recovery: Handler = (req, res, next) => {
    import('./server/commander').then(({ recoveryHandler }) => recoveryHandler(req, res, next)).catch(next)
  }
  const report: Handler = (req, res, next) => {
    import('./server/commander').then(({ reportHandler }) => reportHandler(req, res, next)).catch(next)
  }
  return {
    name: 'forestguard-commander-api',
    configureServer: (server) => {
      server.middlewares.use('/api/commander', handler)
      server.middlewares.use('/api/recovery', recovery)
      server.middlewares.use('/api/prevention', prevention)
      server.middlewares.use('/api/report', report)
    },
    configurePreviewServer: (server) => {
      server.middlewares.use('/api/commander', handler)
      server.middlewares.use('/api/recovery', recovery)
      server.middlewares.use('/api/prevention', prevention)
      server.middlewares.use('/api/report', report)
    },
  }
}

export default defineConfig(({ mode }) => {
  // server-side secrets from .env (no VITE_ prefix, so they never reach the browser bundle)
  const env = loadEnv(mode, process.cwd(), '')
  for (const k of ['OPENAI_API_KEY', 'OPENAI_MODEL']) if (env[k] && !process.env[k]) process.env[k] = env[k]
  return { plugins: [react(), tailwindcss(), commanderApi()] }
})
