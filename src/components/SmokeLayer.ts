import L from 'leaflet'
import type { SmokeResult } from '../sim/smoke'

/**
 * Animated smoke. The ground-level PM2.5 field of the current step sets where smoke is and how thick it looks
 * (log scale: thin haze from ~10 µg/m³, opaque brown-grey around 600 µg/m³). Two soft noise textures drift with
 * the wind and are cut out of it, so the smoke billows and flows downwind instead of sitting as a flat stain.
 * With prefers-reduced-motion the field is drawn without the moving texture.
 */

const LOW = 8
const HIGH = 600
const NOISE = 256

export class SmokeLayer extends L.Layer {
  private canvas!: HTMLCanvasElement
  private mapRef!: L.Map
  private smoke: SmokeResult | null = null
  private step = 0
  private windPx: [number, number] = [0, 0]
  private field = document.createElement('canvas')
  private fieldKey = ''
  private noiseA = makeNoise(24, 1)
  private noiseB = makeNoise(10, 2)
  private offA: [number, number] = [0, 0]
  private offB: [number, number] = [0, 0]
  private raf = 0
  private reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  onAdd(map: L.Map): this {
    this.mapRef = map
    this.canvas = L.DomUtil.create('canvas', 'fg-smoke leaflet-zoom-hide') as HTMLCanvasElement
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

  /** windKmh: [east, north] wind at the grid centre. */
  setState(smoke: SmokeResult | null, step: number, windKmh: [number, number]) {
    if (smoke !== this.smoke) this.fieldKey = ''
    this.smoke = smoke
    this.step = step
    // texture drift in screen px per frame; north is up
    this.windPx = [windKmh[0] * 0.03, -windKmh[1] * 0.03]
    if (this.mapRef) this.reset()
  }

  private paintField() {
    const sm = this.smoke!
    const key = `${sm.cols}x${sm.rows}|${this.step}|${sm.pm.length}`
    if (key === this.fieldKey) return
    this.fieldKey = key
    const f = sm.pm[Math.min(this.step, sm.pm.length - 1)]
    this.field.width = sm.cols
    this.field.height = sm.rows
    const ctx = this.field.getContext('2d')!
    const img = ctx.createImageData(sm.cols, sm.rows)
    const span = Math.log(1 + HIGH / LOW)
    for (let k = 0; k < f.length; k++) {
      const t = Math.min(1, Math.log(1 + f[k] / LOW) / span)
      if (t <= 0.02) continue
      // thin smoke is pale grey, thick smoke brown-grey
      img.data[k * 4] = 210 - 100 * t
      img.data[k * 4 + 1] = 205 - 110 * t
      img.data[k * 4 + 2] = 198 - 112 * t
      img.data[k * 4 + 3] = Math.round(255 * Math.min(0.88, 0.12 + 0.8 * t))
    }
    ctx.putImageData(img, 0, 0)
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
    if (!this.smoke) {
      this.canvas.getContext('2d')!.clearRect(0, 0, this.canvas.width, this.canvas.height)
      return
    }
    this.paintField()
    if (this.reduced) this.draw()
    else this.raf = requestAnimationFrame(this.frame)
  }

  private frame = () => {
    this.offA = [this.offA[0] + this.windPx[0], this.offA[1] + this.windPx[1]]
    this.offB = [this.offB[0] + this.windPx[0] * 1.6, this.offB[1] + this.windPx[1] * 1.6]
    this.draw()
    this.raf = requestAnimationFrame(this.frame)
  }

  private draw() {
    const sm = this.smoke
    if (!sm) return
    const map = this.mapRef
    const ctx = this.canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const nw = map.latLngToContainerPoint([sm.lat0, sm.lon0])
    const se = map.latLngToContainerPoint([sm.lat0 - sm.rows * sm.dLat, sm.lon0 + sm.cols * sm.dLon])
    const cw = (se.x - nw.x) / sm.cols
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.filter = `blur(${Math.min(24, Math.max(1, cw * 0.7)).toFixed(1)}px)`
    ctx.drawImage(this.field, nw.x, nw.y, se.x - nw.x, se.y - nw.y)
    ctx.filter = 'none'
    if (this.reduced) return
    // cut drifting holes out of the smoke so it billows downwind
    ctx.globalCompositeOperation = 'destination-out'
    for (const [tex, off, alpha] of [[this.noiseA, this.offA, 0.55], [this.noiseB, this.offB, 0.35]] as const) {
      const pat = ctx.createPattern(tex, 'repeat')!
      pat.setTransform(new DOMMatrix().translate(off[0] % NOISE, off[1] % NOISE))
      ctx.globalAlpha = alpha
      ctx.fillStyle = pat
      ctx.fillRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }
}

/** Soft, tileable blob texture: a small random grid scaled up with smoothing. */
function makeNoise(cells: number, seed: number): HTMLCanvasElement {
  const small = document.createElement('canvas')
  small.width = cells
  small.height = cells
  const sctx = small.getContext('2d')!
  const img = sctx.createImageData(cells, cells)
  let x = seed * 9301 + 49297
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280)
  for (let i = 0; i < cells * cells; i++) img.data[i * 4 + 3] = Math.round(255 * Math.pow(rnd(), 1.6))
  sctx.putImageData(img, 0, 0)
  const big = document.createElement('canvas')
  big.width = NOISE
  big.height = NOISE
  const bctx = big.getContext('2d')!
  bctx.imageSmoothingEnabled = true
  bctx.imageSmoothingQuality = 'high'
  bctx.filter = `blur(${(NOISE / cells / 2).toFixed(1)}px)`
  // draw 3×3 copies so the blur wraps and the tile repeats without seams
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) bctx.drawImage(small, dx * NOISE, dy * NOISE, NOISE, NOISE)
  return big
}
