import { Flame, Wind, MapPin, Sparkles, CircleCheck, ArrowUpRight } from 'lucide-react'
import { regionById } from '../data/regions'
import { compass, fmtDuration } from '../sim/geo'
import type { SimResult } from '../sim/types'
import { weatherAt, windShift } from '../sim/weather'

type EventKind = 'ignition' | 'wind' | 'settlement' | 'spot' | 'out'
export interface SimulationEvent { id: string; step: number; kind: EventKind; title: string; detail: string; color: string }
const ICONS = { ignition: Flame, wind: Wind, settlement: MapPin, spot: Sparkles, out: CircleCheck }

/** All event times come from the run. No synthetic alerts or operational predictions are added. */
export function simulationEvents(result: SimResult, upto = result.steps): SimulationEvent[] {
  const events: SimulationEvent[] = [{ id: 'ignition', step: 0, kind: 'ignition', title: 'Başlangıç noktası', detail: 'Senaryonun başlangıç anı', color: 'var(--color-orange)' }]
  const region = regionById(result.config.areaId)
  for (const impact of result.impacts) {
    if (impact.arrivalMin === null) continue
    const settlement = region.settlements.find((item) => item.id === impact.id)
    events.push({ id: `settlement-${impact.id}`, step: impact.arrivalMin / result.stepMin, kind: 'settlement', title: settlement?.name ?? impact.id, detail: 'Modelde yangın yerleşim sınırına ulaştı', color: 'var(--color-fire)' })
  }
  const shift = windShift(result.config)
  if (shift) {
    const weather = weatherAt(result.config, shift.hour * 60)
    events.push({ id: 'wind-shift', step: shift.hour * 60 / result.stepMin, kind: 'wind', title: 'Rüzgar yönü değişti', detail: `${compass(weather.windFromDeg)} yönünden · ${Math.round(weather.windSpeedKmh)} km/sa`, color: 'var(--color-water)' })
  }
  const spots = new Map<number, { count: number; step: number }>()
  for (const spot of result.spots ?? []) {
    if (spot.step > upto) continue
    const hour = Math.floor(spot.step * result.stepMin / 60)
    const group = spots.get(hour) ?? { count: 0, step: 0 }
    group.count++
    group.step = Math.max(group.step, spot.step)
    spots.set(hour, group)
  }
  for (const [hour, group] of spots) events.push({ id: `spot-${hour}`, step: group.step, kind: 'spot', title: `${group.count} kor sıçraması`, detail: `${hour}–${hour + 1}. saat aralığında kaydedildi`, color: 'var(--color-amber)' })
  const out = result.response?.extinguishedStep ?? result.series.findIndex((stat, i) => i > 0 && stat.burningHa === 0 && result.series[i - 1].burningHa > 0)
  if (out >= 0) events.push({ id: 'out', step: out, kind: 'out', title: 'Aktif yanma sona erdi', detail: 'Modelde yanan hücre kalmadı', color: 'var(--color-forest)' })
  return events.filter((event) => event.step <= upto).sort((a, b) => a.step - b.step)
}

export function EventFeed({ events, onSeek, compact = false, stepMin = 10 }: { events: SimulationEvent[]; onSeek: (step: number) => void; compact?: boolean; stepMin?: number }) {
  const shown = compact ? events.slice(-3).reverse() : [...events].reverse()
  return <div className={compact ? 'fg-event-strip' : 'fg-event-feed'} aria-label="Simülasyon olayları">
    {compact && <span className="fg-eyebrow shrink-0">Olay akışı</span>}
    {shown.map((event) => {
      const Icon = ICONS[event.kind]
      return <button key={event.id} onClick={() => onSeek(event.step)} className="fg-event" style={{ ['--event-color' as string]: event.color }} title={`${event.detail} · T+${fmtDuration(event.step * stepMin)}`}>
        <span className="fg-event-icon"><Icon size={14} /></span>
        <span className="min-w-0"><span className="fg-event-title">{event.title}</span>{!compact && <span className="fg-event-detail">{event.detail}</span>}</span>
        <time>T+{fmtDuration(event.step * stepMin)}</time>{!compact && <ArrowUpRight size={13} className="text-muted" />}
      </button>
    })}
  </div>
}
