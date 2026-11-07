import { buildReport } from '../sim/report'
import { regionById } from '../data/regions'
import type { SimResult } from '../sim/types'

/**
 * End-of-run report written by the AI (server/commander.ts reportHandler) from the rule-based report sections.
 * Answers are cached in localStorage per run, so the same run is never sent twice.
 */

export interface AiReport {
  executive_summary: string
  key_findings: string[]
  risks: { title: string; severity: 'yuksek' | 'orta' | 'dusuk'; detail: string }[]
  recommendations: { action: string; when: string; rationale: string }[]
  public_message: string
  caveats: string
}

export interface AiReportState {
  status: 'loading' | 'done' | 'error'
  report?: AiReport
  model?: string
  cached?: boolean
  error?: string
}

export const SEVERITY_LABEL = { yuksek: 'Yüksek', orta: 'Orta', dusuk: 'Düşük' } as const

/** Short stable hash of a text (FNV-1a). */
function hashText(t: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/** Identifies a run by what it computed, not by its name. */
function cacheKey(res: SimResult): string {
  const f = res.series[res.series.length - 1]
  const r = res.response
  return `fg-ai-report:${hashText(JSON.stringify({ c: res.config, s: res.steps, ha: Math.round(f.affectedHa), d: r?.decisions.length ?? 0, x: r?.extinguishedStep ?? null }))}`
}

function readCache(key: string): { output: AiReport; model?: string } | null {
  try {
    const v = localStorage.getItem(key)
    return v ? JSON.parse(v) : null
  } catch {
    return null
  }
}

function writeCache(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage full or blocked: the next time the report is asked for again
  }
}

export async function getAiReport(name: string, res: SimResult): Promise<AiReportState> {
  const key = cacheKey(res)
  const hit = readCache(key)
  if (hit) return { status: 'done', report: hit.output, model: hit.model, cached: true }
  const context = { scenario: name, region: regionById(res.config.areaId).name, sections: buildReport(name, res) }
  let r: Response
  try {
    r = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context }) })
  } catch {
    return { status: 'error', error: 'Rapor sunucusuna ulaşılamadı.' }
  }
  const body = (await r.json().catch(() => ({}))) as { output?: AiReport; model?: string; error?: string }
  if (!r.ok || !body.output) return { status: 'error', error: body.error ?? `Sunucu hatası ${r.status}` }
  writeCache(key, { output: body.output, model: body.model })
  return { status: 'done', report: body.output, model: body.model }
}
