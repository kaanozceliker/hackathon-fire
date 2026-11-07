import L from 'leaflet'
import type { Grid, SimResult } from '../sim/types'
import { cellWeather } from '../sim/weather'

export type FireMode = 'fire' | 'fuel' | 'arrival' | 'diff' | 'none'

export interface FireLayerProps {
  grid: Grid | null
  result: SimResult | null
  resultB: SimResult | null
  step: number
  mode: FireMode
  perimeter: boolean
  /** Dim factor for cells (0–1), used for compare maps. */
  opacity?: number
}

export interface CellInfo {
  lat: number
  lon: number
  elev: number
  kind: number
  veg: number
  igniteMin: number | null
}

const FIRE_RAMP = ['#fff2a8', '#ffd24a', '#ffa530', '#f77a25', '#e5502a', '#c93426', '#a52a22']
const ARRIVAL_BANDS = [
  { max: 60, color: '#e5483d' },
  { max: 180, color: '#ee7a2b' },
  { max: 360, color: '#e3a72f' },
  { max: 720, color: '#d8cf5a' },
  { max: Infinity, color: '#9cc39a' },
]
export const ARRIVAL_LEGEND = [
  { color: '#e5483d', label: '1 saat içinde' },
  { color: '#ee7a2b', label: '1–3 sa' },
  { color: '#e3a72f', label: '3–6 sa' },
  { color: '#d8cf5a', label: '6–12 sa' },
  { color: '#9cc39a', label: '12 saatten sonra' },
]

export class FireCanvasLayer extends L.Layer {
  private canvas!: HTMLCanvasElement
  private props: FireLayerProps = { grid: null, result: null, resultB: null, step: 0, mode: 'none', perimeter: true }
  private mapRef!: L.Map

  onAdd(map: L.Map): this {
    this.mapRef = map
    this.canvas = L.DomUtil.create('canvas', 'fg-canvas leaflet-zoom-hide') as HTMLCanvasElement
    this.canvas.style.position = 'absolute'
    map.getPane('overlayPane')!.appendChild(this.canvas)
    map.on('move zoom viewreset resize moveend zoomend', this.reset, this)
    this.reset()
    return this
  }

  onRemove(map: L.Map): this {
    map.off('move zoom viewreset resize moveend zoomend', this.reset, this)
    this.canvas.remove()
    return this
  }

  update(p: FireLayerProps) {
    this.props = p
    if (this.mapRef) this.draw()
  }

  private reset = () => {
    const size = this.mapRef.getSize()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = size.x * dpr
    this.canvas.height = size.y * dpr
    this.canvas.style.width = `${size.x}px`
    this.canvas.style.height = `${size.y}px`
    L.DomUtil.setPosition(this.canvas, this.mapRef.containerPointToLayerPoint([0, 0]))
    this.draw()
  }

  cellAt(latlng: L.LatLng): CellInfo | null {
    const { grid, result } = this.props
    if (!grid) return null
    const col = Math.floor((latlng.lng - grid.lon0) / grid.dLon)
    const row = Math.floor((grid.lat0 - latlng.lat) / grid.dLat)
    if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null
    const i = row * grid.cols + col
    const ig = result ? result.ignitionStep[i] : -1
    return {
      lat: latlng.lat,
      lon: latlng.lng,
      elev: grid.elev[i],
      kind: grid.kind[i],
      veg: grid.veg[i],
      igniteMin: ig >= 0 && result ? ig * result.stepMin : null,
    }
  }

  /**
   * Cells are written one pixel per cell into a small offscreen canvas, then scaled up with smoothing and a light blur,
   * so the 110 m grid reads as a soft field instead of hard squares. Anything that bleeds over open water is erased
   * with a water mask, and the perimeter is traced as a smoothed contour (marching squares) instead of cell edges.
   */
  private draw() {
    const { grid, result, resultB, step, mode, perimeter, opacity = 1 } = this.props
    const map = this.mapRef
    const ctx = this.canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (!grid || mode === 'none') return

    const { cols, rows } = grid
    const nw = map.latLngToContainerPoint([grid.lat0, grid.lon0])
    const se = map.latLngToContainerPoint([grid.lat0 - rows * grid.dLat, grid.lon0 + cols * grid.dLon])
    const cw = (se.x - nw.x) / cols
    const ch = (se.y - nw.y) / rows
    const blur = Math.min(10, Math.max(0, Math.min(cw, ch) * 0.35))

    // --- 1. colour field, one pixel per cell ---
    const field = this.fieldCanvas(cols, rows)
    const fctx = field.getContext('2d')!
    const img = fctx.createImageData(cols, rows)
    const px = img.data
    const put = (i: number, c: RGBA) => {
      px[i * 4] = c[0]
      px[i * 4 + 1] = c[1]
      px[i * 4 + 2] = c[2]
      px[i * 4 + 3] = c[3]
    }
    const n = cols * rows
    if (mode === 'fuel') {
      for (let i = 0; i < n; i++) {
        const k = grid.kind[i]
        if (k === 0) put(i, [40, 90, 140, 77])
        else if (k === 1) put(i, [160, 170, 175, 72])
        else if (k === 2) put(i, [190, 180, 90, 41])
        else if (k === 3) put(i, [86, 170, 95, Math.round(255 * (0.16 + 0.3 * grid.veg[i]))])
        else put(i, [30, 130, 70, Math.round(255 * (0.25 + 0.4 * grid.veg[i]))])
      }
    } else if (mode === 'fire' && result) {
      for (let i = 0; i < n; i++) {
        const t = result.ignitionStep[i]
        // with a fractional step a cell fades in over the 10 minutes in which it catches
        const f = t < 0 ? 0 : Math.min(1, step - (t - 1))
        if (f <= 0) continue
        const end = result.burnoutStep[i]
        let c: RGBA
        if (step >= end) c = grid.kind[i] === 1 ? BURNED_URBAN : BURNED
        else {
          const age = Math.max(0, step - t) / Math.max(1, end - t)
          c = FIRE_RAMP_RGBA[Math.min(FIRE_RAMP_RGBA.length - 1, Math.floor(age * FIRE_RAMP_RGBA.length))]
        }
        put(i, f < 1 ? [c[0], c[1], c[2], Math.round(c[3] * f)] : c)
      }
    } else if (mode === 'arrival' && result) {
      for (let i = 0; i < n; i++) {
        const t = result.ignitionStep[i]
        if (t < 0) continue
        const m = t * result.stepMin
        put(i, ARRIVAL_RGBA[ARRIVAL_BANDS.findIndex((b) => m <= b.max)])
      }
    } else if (mode === 'diff' && result && resultB) {
      for (let i = 0; i < n; i++) {
        const a = result.ignitionStep[i] >= 0 && result.ignitionStep[i] <= step
        const b = resultB.ignitionStep[i] >= 0 && resultB.ignitionStep[i] <= step
        if (a && b) put(i, [235, 235, 225, 140])
        else if (a) put(i, [57, 135, 229, 204])
        else if (b) put(i, [217, 89, 38, 217])
      }
    }
    fctx.putImageData(img, 0, 0)

    ctx.globalAlpha = opacity
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`
    ctx.drawImage(field, 0, 0, cols, rows, nw.x, nw.y, cols * cw, rows * ch)
    ctx.filter = 'none'

    // --- 2. perimeter contour ---
    if (perimeter && (mode === 'fire' || mode === 'diff') && result) {
      const src = mode === 'diff' ? [result, resultB] : [result]
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      src.forEach((res, idx) => {
        if (!res) return
        ctx.beginPath()
        traceContour(ctx, grid, res.ignitionStep, step, nw.x, nw.y, cw, ch)
        ctx.lineWidth = 1.6
        ctx.strokeStyle = mode === 'diff' ? (idx === 0 ? '#7fb6f5' : '#f4a27a') : '#ffe9b0'
        ctx.stroke()
      })
    }

    // --- 2b. embers: where they may land next (downwind of the burning edge) and the spot fires they just started ---
    if (mode === 'fire' && result) this.drawEmbers(ctx, grid, result, step, nw.x, nw.y, cw, ch)

    // --- 3. erase whatever bled over open water (fuel mode draws water on purpose) ---
    if (mode !== 'fuel') {
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'destination-out'
      if (blur > 0.5) ctx.filter = `blur(${(blur * 0.5).toFixed(1)}px)`
      ctx.drawImage(this.waterMask(grid), 0, 0, cols, rows, nw.x, nw.y, cols * cw, rows * ch)
      ctx.filter = 'none'
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.globalAlpha = 1
  }

  private windCache?: { result: SimResult; hour: number; w: ReturnType<typeof cellWeather> }

  private drawEmbers(ctx: CanvasRenderingContext2D, grid: Grid, result: SimResult, stepF: number, ox: number, oy: number, cw: number, ch: number) {
    const { cols, rows, kind } = grid
    const s = Math.floor(stepF)
    const hour = Math.floor((s * result.stepMin) / 60)
    if (this.windCache?.result !== result || this.windCache.hour !== hour) this.windCache = { result, hour, w: cellWeather(grid, result.config, hour) }
    const w = this.windCache.w
    const ig = result.ignitionStep
    const bo = result.burnoutStep
    const X = (c: number) => ox + ((c % cols) + 0.5) * cw
    const Y = (c: number) => oy + (((c / cols) | 0) + 0.5) * ch
    // risk: from each burning edge cell, embers carried ~(3 + wind/7) cells downwind, ±0.3 rad
    const risk = new Map<number, number>()
    for (let i = 0; i < ig.length; i++) {
      const t = ig[i]
      if (t < 0 || t > s || bo[i] <= s || kind[i] === 1) continue
      const ws = w.windSpeedKmh[i]
      if (ws <= 14) continue
      const cx = i % cols
      const cy = (i / cols) | 0
      let edge = false
      for (let dy = -1; dy <= 1 && !edge; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x >= 0 && y >= 0 && x < cols && y < rows && ig[y * cols + x] < 0) { edge = true; break }
        }
      if (!edge) continue
      const d = 3 + ws / 7
      for (const a of [-0.3, 0, 0.3]) {
        const ang = w.windToRad[i] + a
        const x = Math.round(cx + Math.sin(ang) * d)
        const y = Math.round(cy - Math.cos(ang) * d)
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue
        const j = y * cols + x
        if (kind[j] === 0 || (ig[j] >= 0 && ig[j] <= s)) continue
        risk.set(j, (risk.get(j) ?? 0) + 1)
      }
    }
    const r = Math.max(1.6, Math.min(4, Math.min(cw, ch) * 0.28))
    for (const [j, n] of risk) {
      ctx.globalAlpha = Math.min(0.9, 0.35 + n * 0.12)
      ctx.fillStyle = '#ffa53a'
      ctx.beginPath()
      ctx.arc(X(j), Y(j), r, 0, Math.PI * 2)
      ctx.fill()
    }
    // spot fires of the last 30 minutes: a fading trail from the source and a bright landing point
    for (const sp of result.spots ?? []) {
      const age = stepF - sp.step
      if (age < -1 || age > 3) continue
      const a = age < 0 ? age + 1 : 1 - age / 3
      ctx.globalAlpha = Math.max(0, a) * 0.6
      ctx.strokeStyle = '#ffd24a'
      ctx.lineWidth = 1.2
      ctx.setLineDash([3, 4])
      ctx.beginPath()
      ctx.moveTo(X(sp.from), Y(sp.from))
      ctx.lineTo(X(sp.to), Y(sp.to))
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = Math.max(0, a)
      ctx.fillStyle = '#fff1a6'
      ctx.beginPath()
      ctx.arc(X(sp.to), Y(sp.to), r * 1.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#ff7a2b'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  private field?: HTMLCanvasElement
  private fieldCanvas(cols: number, rows: number) {
    if (!this.field) this.field = document.createElement('canvas')
    if (this.field.width !== cols || this.field.height !== rows) {
      this.field.width = cols
      this.field.height = rows
    }
    return this.field
  }

  private mask?: { grid: Grid; canvas: HTMLCanvasElement }
  private waterMask(grid: Grid) {
    if (this.mask?.grid === grid) return this.mask.canvas
    const c = document.createElement('canvas')
    c.width = grid.cols
    c.height = grid.rows
    const x = c.getContext('2d')!
    const img = x.createImageData(grid.cols, grid.rows)
    for (let i = 0; i < grid.kind.length; i++) if (grid.kind[i] === 0) img.data[i * 4 + 3] = 255
    x.putImageData(img, 0, 0)
    this.mask = { grid, canvas: c }
    return c
  }
}

type RGBA = [number, number, number, number]
const hexRGBA = (hex: string, a: number): RGBA => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), Math.round(a * 255)]
const FIRE_RAMP_RGBA = FIRE_RAMP.map((h) => hexRGBA(h, 0.92))
const ARRIVAL_RGBA = ARRIVAL_BANDS.map((b) => hexRGBA(b.color, 0.55))
const BURNED: RGBA = [70, 24, 22, 184]
/** Burned-out built-up land: grey ash rather than charred forest. */
const BURNED_URBAN: RGBA = [96, 84, 80, 150]

/**
 * Marching squares over cell centres on a 3×3-smoothed "burned" field, threshold 0.5.
 * Water next to the fire counts as inside, so the contour runs out over the water and is erased by the water mask
 * instead of tracing the coastline.
 */
function traceContour(ctx: CanvasRenderingContext2D, grid: Grid, ig: Int16Array, step: number, ox: number, oy: number, cw: number, ch: number) {
  const { cols, rows, kind } = grid
  const on = new Uint8Array(cols * rows)
  for (let i = 0; i < on.length; i++) on[i] = ig[i] >= 0 && ig[i] <= step ? 1 : 0
  const raw = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (kind[i] === 0) {
        let near = 0
        for (let dy = -1; dy <= 1 && !near; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const y = r + dy
            const x = c + dx
            if (x >= 0 && y >= 0 && x < cols && y < rows && on[y * cols + x]) { near = 1; break }
          }
        raw[i] = near
      } else raw[i] = on[i]
    }
  const v = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let s = 0
      let w = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const y = r + dy
          const x = c + dx
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue
          const k = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1
          s += raw[y * cols + x] * k
          w += k
        }
      v[r * cols + c] = s / w
    }

  const T = 0.5
  const X = (c: number) => ox + (c + 0.5) * cw
  const Y = (r: number) => oy + (r + 0.5) * ch
  const lerp = (a: number, b: number) => (a === b ? 0.5 : (T - a) / (b - a))
  for (let r = 0; r < rows - 1; r++)
    for (let c = 0; c < cols - 1; c++) {
      const a = v[r * cols + c] // top-left
      const b = v[r * cols + c + 1] // top-right
      const d = v[(r + 1) * cols + c] // bottom-left
      const e = v[(r + 1) * cols + c + 1] // bottom-right
      const code = (a >= T ? 8 : 0) | (b >= T ? 4 : 0) | (e >= T ? 2 : 0) | (d >= T ? 1 : 0)
      if (code === 0 || code === 15) continue
      const top: [number, number] = [X(c + lerp(a, b)), Y(r)]
      const right: [number, number] = [X(c + 1), Y(r + lerp(b, e))]
      const bottom: [number, number] = [X(c + lerp(d, e)), Y(r + 1)]
      const left: [number, number] = [X(c), Y(r + lerp(a, d))]
      const seg = (p: [number, number], q: [number, number]) => {
        ctx.moveTo(p[0], p[1])
        ctx.lineTo(q[0], q[1])
      }
      switch (code) {
        case 1: case 14: seg(left, bottom); break
        case 2: case 13: seg(bottom, right); break
        case 3: case 12: seg(left, right); break
        case 4: case 11: seg(top, right); break
        case 6: case 9: seg(top, bottom); break
        case 7: case 8: seg(left, top); break
        case 5: seg(left, top); seg(bottom, right); break
        case 10: seg(top, right); seg(left, bottom); break
      }
    }
}
