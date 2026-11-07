import { useMemo } from 'react'
import L from 'leaflet'
import { Circle, CircleMarker, ImageOverlay, Marker, Polyline, Tooltip } from 'react-leaflet'
import { existingFor } from '../sim/existing'
import { gridBounds } from '../sim/terrain'
import type { Grid } from '../sim/types'

/** Colour of a burn scar by its age in years (recent = dark, regrown = faint). */
const scarColor = (age: number) => `rgba(${age <= 1 ? '150,60,40' : age <= 3 ? '170,95,55' : '170,130,90'},${Math.max(0.25, 0.75 - age * 0.07).toFixed(2)})`

export const EXISTING_LEGEND = [
  { color: 'rgba(150,60,40,.75)', label: 'Son 1–3 yılda yanmış alan (az yakıt)' },
  { color: 'rgba(170,130,90,.5)', label: 'Daha eski yanık, toparlanıyor' },
  { color: '#f2d03b', label: 'Yangın emniyet yolu / şeridi', kind: 'line' as const },
  { color: '#ffffff', label: 'Gözetleme kulesi (görüş alanı)', kind: 'dot' as const },
  { color: '#3b9be0', label: 'Yangın havuzu / su deposu', kind: 'dot' as const },
  { color: '#ff8a65', label: 'Ön konuşlanma noktası', kind: 'dot' as const },
]

const towerIcon = L.divIcon({
  html: '<svg width="20" height="22" viewBox="0 0 20 22"><path d="M10 1 L15 6 L13 6 L15 21 L5 21 L7 6 L5 6 Z" fill="#ffffff" stroke="#0a1014" stroke-width="1.4"/></svg>',
  className: 'fg-icon',
  iconSize: [20, 22],
  iconAnchor: [10, 21],
})

/** Existing protection on the map: burn scars, fire breaks, towers, ponds and summer bases. */
export function ExistingOverlay({ grid, year }: { grid: Grid; year: number }) {
  const ex = existingFor(grid.areaId)
  const url = useMemo(() => {
    if (!ex.burnYear) return null
    const cv = document.createElement('canvas')
    cv.width = grid.cols
    cv.height = grid.rows
    const ctx = cv.getContext('2d')!
    let any = false
    ex.burnYear.forEach((y, i) => {
      if (!y || 2000 + y >= year) return
      any = true
      ctx.fillStyle = scarColor(year - 2000 - y)
      ctx.fillRect(i % grid.cols, (i / grid.cols) | 0, 1, 1)
    })
    return any ? cv.toDataURL() : null
  }, [grid, ex, year])
  return (
    <>
      {url && <ImageOverlay url={url} bounds={gridBounds(grid)} zIndex={455} className="fg-pixelated" />}
      {ex.firebreaks.map((f, i) => (
        <Polyline key={`fb${i}`} positions={f.geom} pathOptions={{ color: '#f2d03b', weight: 3, opacity: 0.9 }}>
          <Tooltip sticky>{f.name} · {f.widthM} m · {f.source}</Tooltip>
        </Polyline>
      ))}
      {ex.towers.map((t, i) => (
        <span key={`tw${i}`}>
          <Circle center={t.pos} radius={t.rangeKm * 1000} interactive={false} pathOptions={{ color: '#ffffff', weight: 1, opacity: 0.5, dashArray: '3 6', fill: false }} />
          <Marker position={t.pos} icon={towerIcon}>
            <Tooltip direction="top" offset={[0, -18]}>{t.name} · görüş ~{t.rangeKm} km · {t.source}</Tooltip>
          </Marker>
        </span>
      ))}
      {ex.ponds.map((p, i) => (
        <CircleMarker key={`pd${i}`} center={p.pos} radius={6} pathOptions={{ color: '#0a1014', weight: 1.5, fillColor: '#3b9be0', fillOpacity: 1 }}>
          <Tooltip direction="top">{p.name} · {p.source}</Tooltip>
        </CircleMarker>
      ))}
      {ex.bases.map((b, i) => (
        <CircleMarker key={`bs${i}`} center={b.pos} radius={7} pathOptions={{ color: '#0a1014', weight: 1.5, fillColor: '#ff8a65', fillOpacity: 1 }}>
          <Tooltip direction="top">{b.name} · {b.crews} arazöz, {b.dozers} iş makinesi · {b.source}</Tooltip>
        </CircleMarker>
      ))}
    </>
  )
}
