import { Helicopter, Plane, Tractor, Truck } from 'lucide-react'
import type { ResourceKind, ResponseRecord } from '../sim/types'
import { fmtDuration } from '../sim/geo'
import { resourceActivity } from '../lib/resourceActivity'
import { Panel } from './ui'

const KINDS: Record<ResourceKind, { Icon: typeof Truck; label: string }> = {
  crew: { Icon: Truck, label: 'Arazöz' }, dozer: { Icon: Tractor, label: 'İş makinesi' },
  heli: { Icon: Helicopter, label: 'Helikopter' }, plane: { Icon: Plane, label: 'Uçak' },
}

export function ResourcesPanel({ rec, step, stepMin }: { rec: ResponseRecord; step: number; stepMin: number }) {
  return <Panel title={<span className="flex items-center gap-2"><Truck size={14} /> Kaynak hareketleri</span>} pad={false}
    action={<span className="text-[10px] text-muted">{rec.tracks.length} araç</span>} className="fg-resources-panel">
    <ul className="fg-resource-list" aria-label="Araç varış ve dönüş süreleri">
      {rec.tracks.map((track) => {
        const activity = resourceActivity(track, step, stepMin)
        const { Icon, label } = KINDS[track.kind]
        const timeText = activity.remainingMin === null ? activity.value : `${activity.remainingMin} dk ${activity.caption}`
        return <li key={track.id} className={`fg-resource-card tone-${activity.tone}`} aria-label={`${track.name} · ${activity.label} · ${timeText}`}>
          <span className="fg-resource-icon" title={label}><Icon size={24} strokeWidth={1.5} /></span>
          <div className="fg-resource-content">
            <div className="fg-resource-top">
              <span className="fg-resource-name" title={track.name}>{track.name}</span>
              <span className="fg-resource-value" title={activity.finishMin === null ? undefined : `Model zamanı T+${fmtDuration(Math.round(activity.finishMin))}`}>
                <b>{activity.value}</b>{activity.remainingMin !== null && <small> dk</small>}
                <span>{activity.caption}</span>
              </span>
            </div>
            <p className="fg-resource-state"><i />{activity.label}</p>
            {activity.progress !== null && <div className="fg-resource-progress" role="progressbar" aria-label={`${track.name} · ${activity.label}`}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(activity.progress * 100)} aria-valuetext={timeText}>
              <span style={{ width: `${activity.progress * 100}%` }} />
            </div>}
          </div>
        </li>
      })}
    </ul>
    <p className="fg-resource-note">Yaklaşık envanter · Süreler simülasyon saatine göre hesaplanır; gerçek araç takibi değildir.</p>
  </Panel>
}
