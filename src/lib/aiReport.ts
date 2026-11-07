import { buildReport } from '../sim/report'
import { regionById } from '../data/regions'
import type { SimResult } from '../sim/types'

/**
 * End-of-run report written by the AI (server/commander.ts reportHandler) from the rule-based report sections.
 * Answers are cached in localStorage per run, so the same run is never sent twice.
 */

export type RecWhen = 'hemen' | 'ilk_6_saat' | 'yangin_suresince' | 'yangin_sonrasi' | 'gelecek_sezon'
export interface AiReport {
  headline: string
  executive_summary: string
  key_findings: { title: string; value: string; detail: string }[]
  risks: { title: string; severity: 'yuksek' | 'orta' | 'dusuk'; category: 'can' | 'saglik' | 'altyapi' | 'doga'; detail: string }[]
  recommendations: { action: string; when: RecWhen; rationale: string }[]
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
export const CATEGORY_LABEL = { can: 'Can güvenliği', saglik: 'Sağlık', altyapi: 'Altyapı', doga: 'Doğa' } as const
export const WHEN_LABEL: Record<RecWhen, string> = { hemen: 'Hemen', ilk_6_saat: 'İlk 6 saat', yangin_suresince: 'Yangın süresince', yangin_sonrasi: 'Yangın sonrası', gelecek_sezon: 'Gelecek sezon' }
export const WHEN_ORDER: RecWhen[] = ['hemen', 'ilk_6_saat', 'yangin_suresince', 'yangin_sonrasi', 'gelecek_sezon']

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
  return `fg-ai-report-v3:${hashText(JSON.stringify({ c: res.config, s: res.steps, ha: Math.round(f.affectedHa), d: r?.decisions.length ?? 0, x: r?.extinguishedStep ?? null }))}`
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
