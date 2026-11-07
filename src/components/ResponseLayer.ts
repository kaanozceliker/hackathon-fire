import L from 'leaflet'
import type { Grid, ResponseRecord } from '../sim/types'

/**
 * Draws the response on the map at one step of the run:
 * - safety lines: cleared cells solid in the line's colour, planned cells faint, sectors the fire crossed in red;
 * - water drops of the last half hour as spreading rings;
 * - evacuation routes in progress as moving dashes, finished ones faint.
 */

export const LINE_COLORS = ['#dfc47c', '#df9a6b', '#e67d6e', '#bd9ca5']
export const lineColor = (level: number) => LINE_COLORS[Math.min(LINE_COLORS.length, level) - 1]
const BREACH = '#ff5a4e'
const WATER = '120,190,255'

export class ResponseLayer extends L.Layer {
  private canvas!: HTMLCanvasElement
  private mapRef!: L.Map
  private grid: Grid | null = null
  private rec: ResponseRecord | null = null
  private step = 0
  private raf = 0
  private reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  onAdd(map: L.Map): this {
    this.mapRef = map
    this.canvas = L.DomUtil.create('canvas', 'fg-response leaflet-zoom-hide') as HTMLCanvasElement
    this.canvas.style.position = 'absolute'
    this.canvas.style.pointerEvents = 'none'
    map.getPane('overlayPane')!.appendChild(this.canvas)
    map.on('move zoom viewreset resize', this.reset, this)
    this.reset()
    return this
  }

  onRemove(map: L.Map): this {
    map.off('move zoom viewreset resize', this.reset, this)
    cancelAnimationFrame(this.raf)
    this.canvas.remove()
    return this
  }

  setState(grid: Grid | null, rec: ResponseRecord | null, step: number) {
    this.grid = grid
    this.rec = rec
    this.step = step
    if (this.mapRef) this.reset()
  }

  private reset = () => {
    const size = this.mapRef.getSize()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = size.x * dpr
    this.canvas.height = size.y * dpr
    this.canvas.style.width = `${size.x}px`
    this.canvas.style.height = `${size.y}px`
    L.DomUtil.setPosition(this.canvas, this.mapRef.containerPointToLayerPoint([0, 0]))
    cancelAnimationFrame(this.raf)
    const animated = !this.reduced && !!this.rec?.evacuations.some((e) => e.startStep <= this.step && this.step < e.doneStep)
    if (animated) this.raf = requestAnimationFrame(this.frame)
    else this.draw(0)
  }

  private frame = (t: number) => {
    this.draw(t)
    this.raf = requestAnimationFrame(this.frame)
  }

  private draw(t: number) {
    const ctx = this.canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const g = this.grid
    const rec = this.rec
    if (!g || !rec) return
    const map = this.mapRef
    const step = this.step
    const nw = map.latLngToContainerPoint([g.lat0, g.lon0])
    const se = map.latLngToContainerPoint([g.lat0 - g.rows * g.dLat, g.lon0 + g.cols * g.dLon])
    const cw = (se.x - nw.x) / g.cols
    const ch = (se.y - nw.y) / g.rows
    const sq = Math.max(1.5, Math.min(cw, ch) * 0.78)

    // safety lines
    for (const line of rec.lines) {
      if (line.createdStep > step) continue
      const color = lineColor(line.level)
      for (let k = 0; k < line.cells.length; k++) {
        const c = line.cells[k]
        const x = nw.x + ((c % g.cols) + 0.5) * cw
        const y = nw.y + (((c / g.cols) | 0) + 0.5) * ch
        const b = line.breachedStep[line.sectorOf[k]]
        const built = line.builtStep[k] >= 0 && line.builtStep[k] <= step
        if (b !== null && b <= step) {
          ctx.globalAlpha = built ? 0.9 : 0.45
          ctx.fillStyle = BREACH
        } else {
          ctx.globalAlpha = built ? 0.95 : 0.28
          ctx.fillStyle = color
        }
        ctx.fillRect(x - sq / 2, y - sq / 2, sq, sq)
      }
    }
    ctx.globalAlpha = 1

    // evacuation routes
    for (const e of rec.evacuations) {
      if (e.startStep > step || e.geom.length < 2) continue
      const active = step < e.doneStep
      ctx.beginPath()
      e.geom.forEach(([la, lo], i) => {
        const p = map.latLngToContainerPoint([la, lo])
        if (i) ctx.lineTo(p.x, p.y)
        else ctx.moveTo(p.x, p.y)
      })
      ctx.lineWidth = active ? 3 : 2
      ctx.strokeStyle = active ? 'rgba(236,244,240,0.95)' : 'rgba(110,200,140,0.55)'
      ctx.setLineDash(active ? [10, 8] : [2, 6])
      ctx.lineDashOffset = active ? -t / 40 : 0
      ctx.lineCap = 'round'
      ctx.stroke()
    }
    ctx.setLineDash([])

    // water drops of the last 30 minutes
    const mPerPx = (g.cellM * g.cols) / Math.max(1, se.x - nw.x)
    for (const d of rec.drops) {
      const age = step - d.step
      if (age < 0 || age > 3) continue
      const p = map.latLngToContainerPoint([d.lat, d.lon])
      const r = (220 + age * 90) / mPerPx
      ctx.beginPath()
      ctx.arc(p.x, p.y, Math.max(4, r), 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${WATER},${0.28 - age * 0.06})`
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = `rgba(${WATER},${0.8 - age * 0.18})`
      ctx.stroke()
    }
  }
}
