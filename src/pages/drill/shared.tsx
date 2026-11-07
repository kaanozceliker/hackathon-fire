import { AlertOctagon, AlertTriangle, CheckCircle2, Droplets, Info, Thermometer, Wind } from 'lucide-react'
import { WindArrow } from '../../components/MapStage'
import { compass } from '../../sim/geo'
import type { SimConfig } from '../../sim/types'
import type { Verdict } from '../../sim/drill'

/** Weather of the drill day as compact chips. */
export function WeatherChips({ config }: { config: SimConfig }) {
  return (
    <div className="fg-weather-chips">
      <span><Thermometer size={13} className="text-fire" /> {config.temperatureC} °C</span>
      <span><Droplets size={13} className="text-water" /> %{config.humidityPct} nem</span>
      <span><Wind size={13} /> {config.windSpeedKmh} km/sa <WindArrow fromDeg={config.windFromDeg} className="text-ink" /> {compass(config.windFromDeg)}</span>
    </div>
  )
}

const GRADE_COLOR: Record<string, string> = { A: '#3fa564', B: '#8fc46a', C: '#e3d23a', D: '#ee7a2b', F: '#e5483d' }

/** Big score with the letter grade and the score parts as bars. */
export function ScoreCard({ score, grade, parts, title }: { score: number; grade: string; parts: Verdict['parts']; title: string }) {
  return (
    <section className="fg-panel p-4">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">{title}</div>
      <div className="mt-2 flex items-center gap-4">
        <div className="flex h-[76px] w-[76px] shrink-0 flex-col items-center justify-center rounded-full border-[5px]" style={{ borderColor: GRADE_COLOR[grade] ?? 'var(--color-muted)' }}>
          <span className="text-[26px] font-bold leading-none">{grade}</span>
        </div>
        <div>
          <div className="text-[30px] font-semibold leading-none">{score}<span className="text-[15px] text-muted"> / 100</span></div>
          <div className="mt-1 text-[12px] text-muted">{score >= 85 ? 'Çok iyi' : score >= 70 ? 'İyi' : score >= 55 ? 'Orta' : score >= 40 ? 'Zayıf' : 'Başarısız'}</div>
        </div>
      </div>
      <div className="mt-3 space-y-2.5">
        {parts.map((p) => (
          <div key={p.label}>
            <div className="flex justify-between text-[12px]"><span>{p.label}</span><b className="tabular-nums">{p.score}/{p.max}</b></div>
            <div className="mt-1 h-1.5 rounded-full bg-line"><div className="h-full rounded-full" style={{ width: `${(p.score / p.max) * 100}%`, background: p.score / p.max >= 0.7 ? '#3fa564' : p.score / p.max >= 0.4 ? '#e3a23a' : '#e5483d' }} /></div>
            <div className="mt-0.5 text-[11px] leading-snug text-muted">{p.note}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

const LEVEL = {
  kritik: { icon: AlertOctagon, cls: 'text-fire', label: 'Kritik' },
  uyari: { icon: AlertTriangle, cls: 'text-amber', label: 'Uyarı' },
  bilgi: { icon: Info, cls: 'text-muted', label: 'Not' },
  iyi: { icon: CheckCircle2, cls: 'text-forest', label: 'İyi' },
} as const

/** Mistakes first, then notes, then what went well. */
export function MistakeList({ items }: { items: Verdict['mistakes'] }) {
  const order = { kritik: 0, uyari: 1, bilgi: 2, iyi: 3 }
  const sorted = [...items].sort((a, b) => order[a.level] - order[b.level])
  if (!sorted.length) return <p className="text-[12.5px] text-muted">Belirgin bir hata bulunmadı.</p>
  return (
    <ul className="space-y-1.5">
      {sorted.map((m, i) => {
        const L = LEVEL[m.level]
        return (
          <li key={i} className="flex gap-2 text-[12.5px] leading-snug">
            <L.icon size={15} className={`mt-0.5 shrink-0 ${L.cls}`} aria-label={L.label} />
            <span>{m.text}</span>
          </li>
        )
      })}
    </ul>
  )
}
