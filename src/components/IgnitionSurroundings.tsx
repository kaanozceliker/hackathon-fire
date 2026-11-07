import { useMemo } from 'react'
import { Circle, ImageOverlay } from 'react-leaflet'
import { Droplets, Eye, Flame, Info, Milestone, Mountain, Route, ScanLine, ShieldCheck, Trees } from 'lucide-react'
import { haversineM, type LatLon } from '../sim/geo'
import { cellCenter, cellOf, gridBounds } from '../sim/terrain'
import { speciesById } from '../data/vegetation'
import { existingFor, lineCells, towerSeeing } from '../sim/existing'
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
  /** Existing protection: tower that sees the point, ponds within 5 km, fire breaks within 5 km, burn scars and roads within the radius. */
  existing: { tower: string | null; ponds: number; breakKm: number; scarHa: number; scarYears: number[]; roadPct: number }
}

export function surroundings(grid: Grid, at: LatLon, year: number, radiusM = RADIUS_M): Surroundings {
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
  const ex = existingFor(grid.areaId)
  let scar = 0
  let road = 0
  const years = new Set<number>()
  for (const i of cells) {
    const y = ex.burnYear?.[i] ?? 0
    if (y && 2000 + y < year) {
      scar++
      years.add(2000 + y)
    }
    if (ex.roads?.[i]) road++
  }
  let breakCells = 0
  for (const fb of ex.firebreaks) breakCells += lineCells(grid, fb.geom).filter((c) => haversineM(cellCenter(grid, c), at) <= 5000).length
  const existing = {
    tower: towerSeeing(grid.areaId, at)?.name ?? null,
    ponds: ex.ponds.filter((p) => haversineM(p.pos, at) <= 5000).length,
    breakKm: (breakCells * grid.cellM) / 1000,
    scarHa: scar * haC,
    scarYears: [...years].sort(),
    roadPct: cells.length ? road / cells.length : 0,
  }
  const top = [...sp.entries()].sort((a, b) => b[1] - a[1])[0]
  return { cells, ha, totalHa, treeShare: totalHa ? ha[4] / totalHa : 0, meanElev: land ? elev / land : 0, mainSpecies: top ? speciesById(top[0]).name : null, existing }
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

      <div className="border-b border-line py-3">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold"><ShieldCheck size={14} className="text-forest" /> Mevcut önlemler</div>
        <dl className="space-y-1.5 text-[12px]">
          <div className="flex justify-between gap-2"><dt className="flex shrink-0 items-center gap-1.5 text-muted"><Eye size={13} /> Gözetleme kulesi</dt><dd className="text-right font-semibold">{s.existing.tower ?? <span className="font-normal text-muted">görmüyor</span>}</dd></div>
          <div className="flex justify-between"><dt className="flex items-center gap-1.5 text-muted"><Droplets size={13} /> Yangın havuzu (5 km)</dt><dd className="font-semibold">{s.existing.ponds}</dd></div>
          <div className="flex justify-between"><dt className="flex items-center gap-1.5 text-muted"><Milestone size={13} /> Emniyet şeridi (5 km)</dt><dd className="font-semibold">{s.existing.breakKm.toFixed(1)} km</dd></div>
          <div className="flex justify-between"><dt className="flex items-center gap-1.5 text-muted"><Route size={13} /> Yol geçen hücre</dt><dd className="font-semibold">%{Math.round(s.existing.roadPct * 100)}</dd></div>
          <div className="flex justify-between gap-2"><dt className="flex shrink-0 items-center gap-1.5 text-muted"><Flame size={13} /> Son yıllarda yanmış</dt><dd className="text-right font-semibold">{s.existing.scarHa ? `${s.existing.scarHa.toFixed(0)} ha (${s.existing.scarYears.join(', ')})` : <span className="font-normal text-muted">yok</span>}</dd></div>
        </dl>
      </div>

      <p className="mt-3 flex gap-1.5 text-[10.5px] leading-snug text-muted">
        <Info size={12} className="mt-px shrink-0" />
        <span>Her model hücresi, içindeki 10 m'lik WorldCover piksellerinin baskın sınıfını alır. Yükseklik Copernicus DEM'den gelir; komşu hücreler arasındaki yükseklik farkı yayılımı etkiler. Tür tahmini bölge kuşaklarına dayanır, saha envanteri değildir. Mevcut önlemler: yollar, kuleler, havuzlar ve şeritler OpenStreetMap ile src/data/existingMeasures.json'dan, yanık alanlar 2018–2025 Sentinel-2 görüntülerinden.</span>
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
