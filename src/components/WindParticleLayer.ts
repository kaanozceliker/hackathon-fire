import L from 'leaflet'
import type { Grid, SimConfig } from '../sim/types'
import { cellWeather } from '../sim/weather'

/**
 * Wind as soft, slowly curling air currents over the simulation grid (not straight parallel streaks, which read as
 * rain). Particles drift with the wind field of the current simulation hour, each with its own speed, wander gently
 * with a smooth turbulence, fade in and out over their life and leave long, faint trails.
 * With prefers-reduced-motion a static arrow field is drawn instead.
 */

const MAX_COUNT = 260
/** Grid cells moved per second for 1 km/h of wind. */
const SPEED = 0.16

interface Particle {
  x: number
  y: number
  age: number
  max: number
  /** Personal speed factor and turbulence phase. */
  k: number
  ph: number
}

export class WindParticleLayer extends L.Layer {
  private canvas!: HTMLCanvasElement
  private mapRef!: L.Map
  private grid: Grid | null = null
  private u: Float32Array | null = null
  private v: Float32Array | null = null
  private key = ''
  private particles: Particle[] = []
  private raf = 0
  private reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  onAdd(map: L.Map): this {
    this.mapRef = map
    this.canvas = L.DomUtil.create('canvas', 'fg-wind leaflet-zoom-hide') as HTMLCanvasElement
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

  setField(grid: Grid | null, config: SimConfig | null, minutes: number) {
    const hour = Math.floor(minutes / 60)
    const key = grid && config ? `${grid.areaId}|${hour}|${JSON.stringify([config.weather?.startIso, config.windSpeedKmh, config.windFromDeg, config.durationH, !!config.weather])}` : ''
    if (key === this.key) return
    this.key = key
    this.grid = grid
    if (!grid || !config) {
      this.u = this.v = null
    } else {
      const w = cellWeather(grid, config, hour)
      const n = grid.cols * grid.rows
      this.u = new Float32Array(n)
      this.v = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        this.u[i] = w.windSpeedKmh[i] * Math.sin(w.windToRad[i])
        this.v[i] = w.windSpeedKmh[i] * Math.cos(w.windToRad[i])
      }
    }
    if (this.particles.length === 0 && grid) this.particles = Array.from({ length: Math.min(MAX_COUNT, Math.round((grid.cols * grid.rows) / 35)) }, () => this.spawn(true))
    if (this.mapRef) this.reset()
  }

  private spawn(randomAge = false): Particle {
    const g = this.grid!
    const max = 3 + Math.random() * 4
    return { x: Math.random() * g.cols, y: Math.random() * g.rows, age: randomAge ? Math.random() * max : 0, max, k: 0.65 + Math.random() * 0.7, ph: Math.random() * 100 }
  }

  private last = 0
  private t = 0

  private reset = () => {
    const size = this.mapRef.getSize()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = size.x * dpr
    this.canvas.height = size.y * dpr
    this.canvas.style.width = `${size.x}px`
    this.canvas.style.height = `${size.y}px`
    L.DomUtil.setPosition(this.canvas, this.mapRef.containerPointToLayerPoint([0, 0]))
    cancelAnimationFrame(this.raf)
    if (!this.grid || !this.u) return
    if (this.reduced) this.drawStatic()
    else this.raf = requestAnimationFrame(this.frame)
  }

  private frame = (now: number) => {
    const g = this.grid
    const u = this.u
    const v = this.v
    if (!g || !u || !v) return
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0.016
    this.last = now
    this.t += dt
    const map = this.mapRef
    const ctx = this.canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const nw = map.latLngToContainerPoint([g.lat0, g.lon0])
    const se = map.latLngToContainerPoint([g.lat0 - g.rows * g.dLat, g.lon0 + g.cols * g.dLon])
    const cw = (se.x - nw.x) / g.cols
    const ch = (se.y - nw.y) / g.rows

    // fade the previous trails slowly: long, faint tails
    ctx.globalCompositeOperation = 'destination-in'
    ctx.fillStyle = 'rgba(0,0,0,0.94)'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.globalCompositeOperation = 'source-over'

    // three brightness groups (fade in, full, fade out) so each particle can fade without a stroke per particle
    const groups: Path2D[] = [new Path2D(), new Path2D(), new Path2D()]
    const t = this.t
    for (let k = 0; k < this.particles.length; k++) {
      const p = this.particles[k]
      const c = Math.floor(p.x)
      const r = Math.floor(p.y)
      if (p.age > p.max || c < 0 || r < 0 || c >= g.cols || r >= g.rows) {
        this.particles[k] = this.spawn()
        continue
      }
      const i = r * g.cols + c
      // gentle turbulence: the wind direction wanders smoothly in space and time
      const a = 0.45 * Math.sin(p.x * 0.11 + t * 0.35 + p.ph) * Math.cos(p.y * 0.09 - t * 0.27)
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const ux = u[i] * ca - v[i] * sa
      const vy = u[i] * sa + v[i] * ca
      const f = SPEED * p.k * dt
      const nx = p.x + ux * f
      const ny = p.y - vy * f // rows run south
      const life = p.age / p.max
      const grp = groups[life < 0.2 || life > 0.8 ? 0 : life < 0.35 || life > 0.65 ? 1 : 2]
      grp.moveTo(nw.x + p.x * cw, nw.y + p.y * ch)
      grp.lineTo(nw.x + nx * cw, nw.y + ny * ch)
      p.x = nx
      p.y = ny
      p.age += dt
    }
    ctx.lineCap = 'round'
    ctx.lineWidth = 1.3
    ;[0.08, 0.14, 0.21].forEach((alpha, gi) => {
      ctx.strokeStyle = `rgba(214, 232, 240, ${alpha})`
      ctx.stroke(groups[gi])
    })
    this.raf = requestAnimationFrame(this.frame)
  }

  private drawStatic() {
    const g = this.grid!
    const u = this.u!
    const v = this.v!
    const map = this.mapRef
    const ctx = this.canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const nw = map.latLngToContainerPoint([g.lat0, g.lon0])
    const se = map.latLngToContainerPoint([g.lat0 - g.rows * g.dLat, g.lon0 + g.cols * g.dLon])
    const cw = (se.x - nw.x) / g.cols
    const ch = (se.y - nw.y) / g.rows
    const stepCells = Math.max(4, Math.round(36 / cw))
    ctx.strokeStyle = 'rgba(232,240,236,0.6)'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    for (let r = stepCells / 2; r < g.rows; r += stepCells)
      for (let c = stepCells / 2; c < g.cols; c += stepCells) {
        const i = Math.floor(r) * g.cols + Math.floor(c)
        const len = Math.min(14, 4 + Math.hypot(u[i], v[i]) * 0.3)
        const ang = Math.atan2(u[i], v[i])
        const x = nw.x + c * cw
        const y = nw.y + r * ch
        const dx = Math.sin(ang) * len
        const dy = -Math.cos(ang) * len
        ctx.moveTo(x - dx, y - dy)
        ctx.lineTo(x + dx, y + dy)
        ctx.lineTo(x + dx - Math.sin(ang - 0.5) * 4, y + dy + Math.cos(ang - 0.5) * 4)
        ctx.moveTo(x + dx, y + dy)
        ctx.lineTo(x + dx - Math.sin(ang + 0.5) * 4, y + dy + Math.cos(ang + 0.5) * 4)
      }
    ctx.stroke()
  }
}
