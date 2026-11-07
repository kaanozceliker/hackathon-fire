import L from 'leaflet'
import { cellWeather } from '../sim/weather'
import type { Grid, SimResult } from '../sim/types'

/**
 * Living fire on top of the fire field: a soft, flickering glow over the burning cells (brightest on the young,
 * flaming front) and sparks that rise and drift downwind. Drawn every frame on its own canvas with additive
 * blending; light enough not to tire the eye. Respects "reduce motion" (glow only, no flicker or sparks).
 */

interface Burning {
  x: number
  y: number
  /** 1 = just caught (flaming), 0 = about to burn out. */
  heat: number
  phase: number
  wx: number
  wy: number
  ws: number
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  size: number
}

const MAX_SPARKS = 140

export class FireFxLayer extends L.Layer {
  private canvas!: HTMLCanvasElement
  private mapRef!: L.Map
  private raf = 0
  private last = 0
  private lastDraw = 0
  private grid: Grid | null = null
  private result: SimResult | null = null
  private getStep: () => number = () => 0
  private builtFor: { result: SimResult | null; step: number } = { result: null, step: -1 }
  private burning: Burning[] = []
  private sparks: Spark[] = []
  private reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  private glow = makeGlow()
  private windHour: { result: SimResult; hour: number; w: ReturnType<typeof cellWeather> } | null = null

  onAdd(map: L.Map): this {
    this.mapRef = map
    if (!map.getPane('fgFx')) {
      const pane = map.createPane('fgFx')
      pane.style.zIndex = '445'
      pane.style.pointerEvents = 'none'
    }
    this.canvas = L.DomUtil.create('canvas', 'leaflet-zoom-hide') as HTMLCanvasElement
    this.canvas.style.position = 'absolute'
    map.getPane('fgFx')!.appendChild(this.canvas)
    map.on('move zoom viewreset resize moveend zoomend', this.reset, this)
    this.reset()
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
    return this
  }

  onRemove(map: L.Map): this {
    cancelAnimationFrame(this.raf)
    map.off('move zoom viewreset resize moveend zoomend', this.reset, this)
    this.canvas.remove()
    return this
  }

  update(grid: Grid | null, result: SimResult | null, getStep: () => number) {
    this.grid = grid
    this.result = result
    this.getStep = getStep
    if (!result) this.sparks = []
  }

  private reset = () => {
    const size = this.mapRef.getSize()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = size.x * dpr
    this.canvas.height = size.y * dpr
    this.canvas.style.width = `${size.x}px`
    this.canvas.style.height = `${size.y}px`
    L.DomUtil.setPosition(this.canvas, this.mapRef.containerPointToLayerPoint([0, 0]))
  }

  /** Burning cells at a step, with the wind that pushes their sparks. */
  private rebuild(grid: Grid, result: SimResult, s: number) {
    const ig = result.ignitionStep
    const bo = result.burnoutStep
    const hour = Math.floor((s * result.stepMin) / 60)
    if (this.windHour?.result !== result || this.windHour.hour !== hour) this.windHour = { result, hour, w: cellWeather(grid, result.config, hour) }
    const w = this.windHour.w
    const out: Burning[] = []
    for (let i = 0; i < ig.length; i++) {
      const t = ig[i]
      if (t < 0 || t > s || bo[i] <= s || grid.kind[i] === 0) continue
      const heat = 1 - (s - t) / Math.max(1, bo[i] - t)
      const to = w.windToRad[i]
      out.push({ x: (i % grid.cols) + 0.5, y: ((i / grid.cols) | 0) + 0.5, heat: grid.kind[i] === 1 ? heat * 0.5 : heat, phase: (i * 2.399) % (Math.PI * 2), wx: Math.sin(to), wy: -Math.cos(to), ws: w.windSpeedKmh[i] })
    }
    this.burning = out
    this.builtFor = { result, step: s }
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame)
    if (now - this.lastDraw < 32) return
    this.lastDraw = now
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    const ctx = this.canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const { grid, result } = this
    if (!grid || !result || document.hidden) return
    const stepF = this.getStep()
    const s = Math.floor(stepF)
    if (this.builtFor.result !== result || this.builtFor.step !== s) this.rebuild(grid, result, s)
    if (!this.burning.length && !this.sparks.length) return

    const map = this.mapRef
    const nw = map.latLngToContainerPoint([grid.lat0, grid.lon0])
    const se = map.latLngToContainerPoint([grid.lat0 - grid.rows * grid.dLat, grid.lon0 + grid.cols * grid.dLon])
    const cw = (se.x - nw.x) / grid.cols
    const ch = (se.y - nw.y) / grid.rows
    const cell = Math.min(cw, ch)
    const t = now / 1000

    ctx.globalCompositeOperation = 'lighter'
    // glow: a soft sprite per burning cell, larger and brighter on the flaming front, with a slow flicker
    const step = this.burning.length > 2500 ? Math.ceil(this.burning.length / 2500) : 1
    for (let k = 0; k < this.burning.length; k += step) {
      const b = this.burning[k]
      const flick = this.reduced ? 1 : 0.78 + 0.22 * Math.sin(t * (3.1 + (b.phase % 1.7)) + b.phase) * Math.sin(t * 1.3 + b.phase * 2)
      const a = (0.05 + 0.16 * b.heat * b.heat) * flick
      if (a < 0.02) continue
      const r = cell * (0.9 + 1.4 * b.heat)
      ctx.globalAlpha = Math.min(0.55, a)
      ctx.drawImage(this.glow, nw.x + b.x * cw - r, nw.y + b.y * ch - r, r * 2, r * 2)
    }

    // sparks: born on the flaming front, rise and drift with the wind, cool from yellow to red
    if (!this.reduced && cell > 1.2) {
      const front = this.burning.filter((b) => b.heat > 0.55)
      const rate = Math.min(50, front.length * 0.65)
      let spawn = rate * dt
      while (spawn > 0 && this.sparks.length < MAX_SPARKS && front.length) {
        if (spawn < 1 && Math.random() > spawn) break
        spawn -= 1
        const b = front[(Math.random() * front.length) | 0]
        const speed = 0.25 + b.ws / 40
        const max = 0.7 + Math.random() * 0.8
        this.sparks.push({
          x: b.x + (Math.random() - 0.5) * 0.8,
          y: b.y + (Math.random() - 0.5) * 0.8,
          vx: b.wx * speed + (Math.random() - 0.5) * 0.35,
          vy: b.wy * speed + (Math.random() - 0.5) * 0.35,
          life: 0,
          max,
          size: 0.8 + Math.random() * 1.3,
        })
      }
      const keep: Spark[] = []
      for (const p of this.sparks) {
        p.life += dt
        if (p.life >= p.max) continue
        p.x += p.vx * dt
        p.y += p.vy * dt
        const f = p.life / p.max
        const rise = f * 14 // screen pixels upward: the spark lifts as it drifts
        const X = nw.x + p.x * cw
        const Y = nw.y + p.y * ch - rise
        const flick = 0.7 + 0.3 * Math.sin(t * 20 + p.max * 40)
        ctx.globalAlpha = (1 - f) * 0.9 * flick
        ctx.fillStyle = f < 0.35 ? '#fff0b0' : f < 0.7 ? '#ffb347' : '#ff6a2a'
        ctx.beginPath()
        ctx.arc(X, Y, p.size * (1 - f * 0.4), 0, Math.PI * 2)
        ctx.fill()
        keep.push(p)
      }
      this.sparks = keep
    } else this.sparks = []
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }
}

/** A warm radial glow sprite. */
function makeGlow(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255, 220, 140, 1)')
  grad.addColorStop(0.35, 'rgba(255, 140, 50, 0.55)')
  grad.addColorStop(0.7, 'rgba(220, 60, 20, 0.15)')
  grad.addColorStop(1, 'rgba(200, 40, 10, 0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return c
}
