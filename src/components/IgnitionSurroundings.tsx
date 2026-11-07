import { useMemo } from 'react'
import { Circle, ImageOverlay } from 'react-leaflet'
import { Info, Mountain, ScanLine, Trees } from 'lucide-react'
import { haversineM, type LatLon } from '../sim/geo'
import { cellCenter, cellOf, gridBounds } from '../sim/terrain'
import { speciesById } from '../data/vegetation'
import type { Grid } from '../sim/types'

/**
 * Land around the ignition point: share of each land-cover class within a radius, mean elevation and the main
 * species. Classes are the dominant ESA WorldCover class of each model cell (baked into the grid), so this is
 * cover area, not a tree count.
 */

const RADIUS_M = 1000

const CLASSES = [
  { kind: 4, label: 'Ağaç örtüsü', color: '#6fbf8a' },
  { kind: 3, label: 'Çalılık (maki)', color: '#a9b98a' },
  { kind: 2, label: 'Otlak / tarım / seyrek', color: '#c9bf86' },
  { kind: 1, label: 'Yerleşim', color: '#9aa4a8' },
  { kind: 0, label: 'Su', color: '#4f8fc0' },
] as const

export interface Surroundings {
  cells: number[]
  ha: Record<number, number>
  totalHa: number
  treeShare: number
  meanElev: number
  mainSpecies: string | null
}

export function surroundings(grid: Grid, at: LatLon, radiusM = RADIUS_M): Surroundings {
  const c0 = cellOf(grid, at[0], at[1])
  const haC = (grid.cellM * grid.cellM) / 10000
  const ha: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }
  const cells: number[] = []
  const sp = new Map<number, number>()
  let elev = 0
  let land = 0
  if (c0 >= 0) {
    const R = Math.ceil(radiusM / grid.cellM) + 1
    const x0 = c0 % grid.cols
    const y0 = (c0 / grid.cols) | 0
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const x = x0 + dx
        const y = y0 + dy
        if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue
        const i = y * grid.cols + x
        if (haversineM(cellCenter(grid, i), at) > radiusM) continue
        const k = grid.kind[i]
        ha[k] += haC
        cells.push(i)
        if (k !== 0) {
          elev += grid.elev[i]
          land++
        }
        if (grid.species[i]) sp.set(grid.species[i], (sp.get(grid.species[i]) ?? 0) + 1)
      }
  }
  const totalHa = cells.length * haC
  const top = [...sp.entries()].sort((a, b) => b[1] - a[1])[0]
  return { cells, ha, totalHa, treeShare: totalHa ? ha[4] / totalHa : 0, meanElev: land ? elev / land : 0, mainSpecies: top ? speciesById(top[0]).name : null }
}

export function SurroundingsPanel({ s, cellM, showTrees, setShowTrees }: { s: Surroundings; cellM: number; showTrees: boolean; setShowTrees: (v: boolean) => void }) {
  const max = Math.max(...CLASSES.map((c) => s.ha[c.kind]), 1)
  return (
    <section className="border border-line bg-panel p-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Arazi</div>
      <h3 className="mt-0.5 text-[17px] font-semibold leading-tight">Başlangıcın çevresini tanı.</h3>
      <p className="mt-2 text-[12px] leading-snug text-muted">Tutuşma noktasının {RADIUS_M / 1000} km çevresindeki arazi dağılımı. Ağaç örtüsü alan payıdır, tek tek ağaç sayısı değildir.</p>

      <div className="mt-3 border border-line2 bg-bg p-3">
        <div className="flex items-start justify-between">
          <div className="text-[34px] font-light leading-none text-forest">%{Math.round(s.treeShare * 100)}</div>
          <Trees size={22} className="text-forest/70" />
        </div>
        <div className="mt-2 text-[12.5px]">Ağaç örtüsünün alan payı</div>
        <div className="mt-1 text-[10.5px] text-muted">ESA WorldCover · 2021</div>
      </div>

      <label className="mt-3 flex cursor-pointer items-center justify-between border-b border-line pb-3 text-[12.5px]">
        <span className="flex items-center gap-1.5"><Trees size={14} className="text-muted" /> Ağaç dağılımını haritada göster</span>
        <input type="checkbox" checked={showTrees} onChange={(e) => setShowTrees(e.target.checked)} className="h-4 w-4 accent-[#e8a35c]" />
      </label>

      <div className="space-y-2.5 border-b border-line py-3">
        {CLASSES.filter((c) => s.ha[c.kind] > 0).map((c) => (
          <div key={c.kind}>
            <div className="flex justify-between text-[12px]">
              <span>{c.label}</span>
              <span className="font-semibold tabular-nums">{s.ha[c.kind].toFixed(1)} ha</span>
            </div>
            <div className="mt-1 h-[3px] rounded-full" style={{ width: `${(s.ha[c.kind] / max) * 100}%`, background: c.color }} />
          </div>
        ))}
      </div>

      <dl className="space-y-2 border-b border-line py-3 text-[12px]">
        <div className="flex justify-between"><dt className="flex items-center gap-1.5 text-muted"><Mountain size={14} /> Ortalama yükseklik</dt><dd className="font-semibold">{Math.round(s.meanElev)} m</dd></div>
        {s.mainSpecies && <div className="flex justify-between gap-2"><dt className="flex shrink-0 items-center gap-1.5 text-muted"><Trees size={14} /> Baskın tür (tahmini)</dt><dd className="text-right font-semibold">{s.mainSpecies}</dd></div>}
        <div className="flex justify-between"><dt className="flex items-center gap-1.5 text-muted"><ScanLine size={14} /> Model hücresi</dt><dd className="font-semibold">{cellM} m</dd></div>
      </dl>

      <p className="mt-3 flex gap-1.5 text-[10.5px] leading-snug text-muted">
        <Info size={12} className="mt-px shrink-0" />
        <span>Her model hücresi, içindeki 10 m'lik WorldCover piksellerinin baskın sınıfını alır. Yükseklik Copernicus DEM'den gelir; komşu hücreler arasındaki yükseklik farkı yayılımı etkiler. Tür tahmini bölge kuşaklarına dayanır, saha envanteri değildir.</span>
      </p>
    </section>
  )
}

/** Tree-covered cells around the ignition point (drawn above the fire layer) and the radius circle. */
export function TreeCoverOverlay({ grid, s, at }: { grid: Grid; s: Surroundings; at: LatLon }) {
  const url = useMemo(() => {
    const cv = document.createElement('canvas')
    cv.width = grid.cols
    cv.height = grid.rows
    const ctx = cv.getContext('2d')!
    for (const i of s.cells) {
      if (grid.kind[i] !== 4) continue
      ctx.fillStyle = `rgba(79,209,122,${(0.45 + grid.veg[i] * 0.45).toFixed(2)})`
      ctx.fillRect(i % grid.cols, (i / grid.cols) | 0, 1, 1)
    }
    return cv.toDataURL()
  }, [grid, s])
  return (
    <>
      <ImageOverlay url={url} bounds={gridBounds(grid)} zIndex={460} className="fg-pixelated" />
      <Circle center={at} radius={RADIUS_M} interactive={false} pathOptions={{ color: '#e8a35c', weight: 1.5, dashArray: '5 5', fill: false }} />
    </>
  )
}
