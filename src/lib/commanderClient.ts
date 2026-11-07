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

/** Post-fire strategy from the AI (server/commander.ts recoveryHandler). */
export async function askRecovery(context: unknown): Promise<{ output: import('../sim/recovery').RecoveryPlan; model: string }> {
  let r: Response
  try {
    r = await fetch('/api/recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context }) })
  } catch {
    throw new Error('Strateji sunucusuna ulaşılamadı.')
  }
  const body = (await r.json().catch(() => ({}))) as { output?: import('../sim/recovery').RecoveryPlan; model?: string; error?: string }
  if (!r.ok || !body.output) throw new Error(body.error ?? `Sunucu hatası ${r.status}`)
  return { output: body.output, model: body.model ?? '' }
}

/** Tatbikat: the optimal prevention plan from the AI (server/commander.ts drillHandler). */
export async function askDrillOptimal(context: unknown): Promise<{ output: import('../sim/prevention').PreventionPlan; model: string }> {
  let r: Response
  try {
    r = await fetch('/api/drill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context }) })
  } catch {
    throw new Error('Sunucuya ulaşılamadı.')
  }
  const body = (await r.json().catch(() => ({}))) as { output?: import('../sim/prevention').PreventionPlan; model?: string; error?: string }
  if (!r.ok || !body.output) throw new Error(body.error ?? `Sunucu hatası ${r.status}`)
  return { output: body.output, model: body.model ?? '' }
}

/** Prevention package from the AI (server/commander.ts preventionHandler). */
export async function askPrevention(context: unknown): Promise<{ output: import('../sim/prevention').PreventionPlan; model: string }> {
  let r: Response
  try {
    r = await fetch('/api/prevention', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context }) })
  } catch {
    throw new Error('Önlem sunucusuna ulaşılamadı.')
  }
  const body = (await r.json().catch(() => ({}))) as { output?: import('../sim/prevention').PreventionPlan; model?: string; error?: string }
  if (!r.ok || !body.output) throw new Error(body.error ?? `Sunucu hatası ${r.status}`)
  return { output: body.output, model: body.model ?? '' }
}
