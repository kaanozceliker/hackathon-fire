import type { CommanderOutput } from '../sim/types'
import type { CommanderContext } from '../sim/response'

/** Browser side of the AI commander: talks to /api/commander (server/commander.ts), never to OpenAI directly. */

export interface AiHealth {
  ai: boolean
  model: string
}

export async function aiHealth(): Promise<AiHealth | null> {
  try {
    const r = await fetch('/api/commander/health')
    if (!r.ok) return null
    return (await r.json()) as AiHealth
  } catch {
    return null
  }
}

export async function askCommander(context: CommanderContext, signal?: AbortSignal): Promise<CommanderOutput> {
  let r: Response
  try {
    r = await fetch('/api/commander', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context }), signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new Error('Komutan sunucusuna ulaşılamadı.')
  }
  const body = (await r.json().catch(() => ({}))) as { output?: CommanderOutput; error?: string }
  if (!r.ok || !body.output) throw new Error(body.error ?? `Sunucu hatası ${r.status}`)
  return body.output
}
