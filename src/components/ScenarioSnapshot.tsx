import { ArrowUpRight, Clock3, MapPin, Trees } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { regionById } from '../data/regions'
import { fmtDuration } from '../sim/geo'
import type { Scenario } from '../state/store'
import { fmtHa, Panel } from './ui'

/** A lightweight SVG keeps the dashboard independent of the full charting bundle. */
export function ScenarioSnapshot({ scenario }: { scenario: Scenario }) {
  const nav = useNavigate()
  const { result } = scenario
  const final = result.series[result.series.length - 1]
  const reached = result.impacts.filter((impact) => impact.arrivalMin !== null)
  const firstArrival = reached.length ? Math.min(...reached.map((impact) => impact.arrivalMin!)) : null
  const forestShare = final.affectedHa > 0 ? Math.round(final.forestHa / final.affectedHa * 100) : 0
  const max = Math.max(1, final.affectedHa)
  const points = result.series.map((point, index) => `${(index / Math.max(1, result.series.length - 1) * 280).toFixed(1)},${(60 - point.affectedHa / max * 54).toFixed(1)}`)

  return (
    <Panel title="Seçili senaryonun etkisi" action={<span className="text-[11px] text-muted">Model çıktısı</span>}>
      <p className="truncate text-[13px] font-medium" title={scenario.name}>{scenario.name}</p>
      <p className="mt-0.5 text-[12px] text-muted">{regionById(result.config.areaId).name} · {result.steps * result.stepMin / 60} saatlik yayılım</p>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-[34px] font-semibold leading-none tracking-tight text-amber">{fmtHa(final.affectedHa)}</span>
        <span className="text-[13px] text-muted">ha etkilenen alan</span>
      </div>
      <svg viewBox="0 0 280 66" role="img" aria-label="Simülasyon boyunca etkilenen alanın artışı" className="mt-2 h-[66px] w-full overflow-visible">
        <path d={`M0,66 L${points.join(' L')} L280,66 Z`} fill="var(--color-amber)" opacity="0.1" />
        <polyline points={points.join(' ')} fill="none" stroke="var(--color-amber)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mb-3 flex justify-between text-[10.5px] text-muted"><span>Başlangıç</span><span>T+{fmtDuration(result.steps * result.stepMin)}</span></div>
      <dl className="space-y-2 border-t border-line pt-3 text-[12.5px]">
        <div className="flex justify-between gap-3"><dt className="flex items-center gap-1.5 text-muted"><MapPin size={13} /> Ulaşılan yerleşim</dt><dd className={reached.length ? 'font-semibold text-fire' : 'font-semibold text-forest'}>{reached.length} / {result.impacts.length}</dd></div>
        <div className="flex justify-between gap-3"><dt className="flex items-center gap-1.5 text-muted"><Clock3 size={13} /> İlk tahmini varış</dt><dd className="font-semibold">{firstArrival === null ? 'Süre içinde ulaşılmadı' : `T+${fmtDuration(firstArrival)}`}</dd></div>
        <div className="flex justify-between gap-3"><dt className="flex items-center gap-1.5 text-muted"><Trees size={13} /> Orman ve maki payı</dt><dd className="font-semibold">%{forestShare}</dd></div>
      </dl>
      <button onClick={() => nav('/analytics')} className="mt-3 flex w-full items-center justify-between rounded-md border border-line2 px-2.5 py-2 text-[12.5px] font-medium hover:border-forest hover:text-forest">Senaryoları karşılaştır <ArrowUpRight size={14} /></button>
    </Panel>
  )
}
