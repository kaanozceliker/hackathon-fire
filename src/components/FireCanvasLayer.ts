import L from 'leaflet'
import type { Grid, SimResult } from '../sim/types'

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

  private draw() {
    const { grid, result, resultB, step, mode, perimeter, opacity = 1 } = this.props
    const map = this.mapRef
    const ctx = this.canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (!grid || mode === 'none') return

    const nw = map.latLngToContainerPoint([grid.lat0, grid.lon0])
    const se = map.latLngToContainerPoint([grid.lat0 - grid.rows * grid.dLat, grid.lon0 + grid.cols * grid.dLon])
    const cw = (se.x - nw.x) / grid.cols
    const ch = (se.y - nw.y) / grid.rows
    const xs = (c: number) => Math.round(nw.x + c * cw)
    const ys = (r: number) => Math.round(nw.y + r * ch)
    const size = map.getSize()
    const { cols, rows } = grid
    ctx.globalAlpha = opacity

    const c0 = Math.max(0, Math.floor(-nw.x / cw))
    const c1 = Math.min(cols, Math.ceil((size.x - nw.x) / cw))
    const r0 = Math.max(0, Math.floor(-nw.y / ch))
    const r1 = Math.min(rows, Math.ceil((size.y - nw.y) / ch))

    const rect = (c: number, r: number, color: string) => {
      ctx.fillStyle = color
      ctx.fillRect(xs(c), ys(r), xs(c + 1) - xs(c), ys(r + 1) - ys(r))
    }

    if (mode === 'fuel') {
      for (let r = r0; r < r1; r++)
        for (let c = c0; c < c1; c++) {
          const i = r * cols + c
          const k = grid.kind[i]
          if (k === 0) rect(c, r, 'rgba(40,90,140,0.30)')
          else if (k === 1) rect(c, r, 'rgba(160,170,175,0.28)')
          else if (k === 2) rect(c, r, 'rgba(190,180,90,0.16)')
          else if (k === 3) rect(c, r, `rgba(86,170,95,${0.16 + 0.3 * grid.veg[i]})`)
          else rect(c, r, `rgba(30,130,70,${0.25 + 0.4 * grid.veg[i]})`)
        }
    } else if (mode === 'fire' && result) {
      for (let r = r0; r < r1; r++)
        for (let c = c0; c < c1; c++) {
          const i = r * cols + c
          const t = result.ignitionStep[i]
          if (t < 0 || t > step) continue
          const end = result.burnoutStep[i]
          if (step >= end) rect(c, r, 'rgba(70,24,22,0.72)')
          else {
            const age = (step - t) / Math.max(1, end - t)
            rect(c, r, FIRE_RAMP[Math.min(FIRE_RAMP.length - 1, Math.floor(age * FIRE_RAMP.length))])
          }
        }
    } else if (mode === 'arrival' && result) {
      for (let r = r0; r < r1; r++)
        for (let c = c0; c < c1; c++) {
          const t = result.ignitionStep[r * cols + c]
          if (t < 0) continue
          const m = t * result.stepMin
          const band = ARRIVAL_BANDS.find((b) => m <= b.max)!
          ctx.globalAlpha = 0.55 * opacity
          rect(c, r, band.color)
        }
      ctx.globalAlpha = opacity
    } else if (mode === 'diff' && result && resultB) {
      for (let r = r0; r < r1; r++)
        for (let c = c0; c < c1; c++) {
          const i = r * cols + c
          const a = result.ignitionStep[i] >= 0 && result.ignitionStep[i] <= step
          const b = resultB.ignitionStep[i] >= 0 && resultB.ignitionStep[i] <= step
          if (a && b) rect(c, r, 'rgba(235,235,225,0.55)')
          else if (a) rect(c, r, 'rgba(57,135,229,0.8)')
          else if (b) rect(c, r, 'rgba(217,89,38,0.85)')
        }
    }

    // fire perimeter: edges between cells already ignited at this step and cells not (yet) ignited
    if (perimeter && (mode === 'fire' || mode === 'diff') && result) {
      const src = mode === 'diff' ? [result, resultB] : [result]
      src.forEach((res, idx) => {
        if (!res) return
        const ig = res.ignitionStep
        ctx.beginPath()
        for (let r = r0; r < r1; r++)
          for (let c = c0; c < c1; c++) {
            const i = r * cols + c
            const t = ig[i]
            if (t < 0 || t > step) continue
            const open = (j: number) => grid.kind[j] !== 0 && (ig[j] < 0 || ig[j] > step)
            if (c > 0 && open(i - 1)) { ctx.moveTo(xs(c), ys(r)); ctx.lineTo(xs(c), ys(r + 1)) }
            if (c < cols - 1 && open(i + 1)) { ctx.moveTo(xs(c + 1), ys(r)); ctx.lineTo(xs(c + 1), ys(r + 1)) }
            if (r > 0 && open(i - cols)) { ctx.moveTo(xs(c), ys(r)); ctx.lineTo(xs(c + 1), ys(r)) }
            if (r < rows - 1 && open(i + cols)) { ctx.moveTo(xs(c), ys(r + 1)); ctx.lineTo(xs(c + 1), ys(r + 1)) }
          }
        ctx.lineWidth = 1.6
        ctx.strokeStyle = mode === 'diff' ? (idx === 0 ? '#7fb6f5' : '#f4a27a') : '#ffe9b0'
        ctx.stroke()
      })
    }
    ctx.globalAlpha = 1
  }
}
