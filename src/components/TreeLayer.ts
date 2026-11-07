import * as THREE from 'three'
import * as maptilersdk from '@maptiler/sdk'
import { cellCenter } from '../sim/terrain'
import { speciesById } from '../data/vegetation'
import { hash3 } from '../sim/rng'
import { flameMaterial } from '../lib/flameMaterial'
import type { Grid, SimResult } from '../sim/types'

/**
 * 3D trees for the MapTiler 3D view: a Three.js custom layer drawing low-poly trees with instancing. Trees are
 * placed on the forest and maquis cells of the grid (density from the vegetation share, shape from the estimated
 * species: pines as cones, oaks and sweetgum as round crowns, maquis as low shrubs) and sit on the map's own terrain.
 * Only the cells in view are planted, when zoomed in. Individual tree positions are illustrative: the data gives
 * cover, density and species per 110 m cell, not single trees. With the fire: trees just ahead of the front dry and
 * brown, burning trees carry flickering flames and darken, burned trees lose their crown and stand as black snags.
 *
 * Kept light: per frame only the camera matrix is set; colours change only for the cells whose fire state changed;
 * terrain heights are read once per cell corner and reused; trunks are drawn only close up.
 */

type Shape = 'pine' | 'round' | 'shrub'
const SHAPES: Shape[] = ['pine', 'round', 'shrub']
const MAX_TREES = 22000
const MIN_ZOOM = 12.6
const TRUNK_ZOOM = 14.2
const SIZE = 1.9 // visual size factor: real-size trees are hard to see from the usual camera height

const GREENS: Record<Shape, number[]> = {
  pine: [0x2f6b3a, 0x2a5f34, 0x37763f, 0x2d6638],
  round: [0x4c8a3c, 0x568f42, 0x467f37, 0x5f9a48],
  shrub: [0x6b8f3e, 0x7a9a45, 0x5f8538],
}
/** Fire state of a cell: 0 untouched, 1–3 burning (young → old), 4 burned, 5 scorched (the front reaches it soon). */
const BURN_COLORS = [null, new THREE.Color(0x7a5a2e), new THREE.Color(0x4a3524), new THREE.Color(0x2b211c), null, null]
const SCORCH = new THREE.Color(0xb08a48)
/** Steps ahead of the front in which trees already show heat (dry, brown crowns). */
const SCORCH_STEPS = 3
const CHAR_TRUNK = new THREE.Color(0x1d1715)
/** Tree height in model units (before the instance scale) and the flames of each burning stage: [height share, size share]. */
const HEIGHT: Record<Shape, number> = { pine: 12, round: 8.9, shrub: 2.2 }
const FLAMES: [number, number][][] = [[], [[0.15, 0.85], [0.5, 0.8], [0.85, 0.6]], [[0.05, 0.7], [0.4, 0.55]], [[0.0, 0.45], [0.25, 0.3]]]
const MAX_FLAMES = 12000
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)
const WHITE = new THREE.Color(1, 1, 1)

export class TreeLayer implements maptilersdk.CustomLayerInterface {
  id = 'fg-trees'
  type = 'custom' as const
  renderingMode = '3d' as const
  private map!: maptilersdk.Map
  private renderer!: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.Camera()
  private origin!: maptilersdk.MercatorCoordinate
  private scale = 1
  private local = new THREE.Matrix4()
  private proj = new THREE.Matrix4()
  private meshes: Record<Shape, { crown: THREE.InstancedMesh; trunk: THREE.InstancedMesh; snag: THREE.InstancedMesh; trunkColor: THREE.Color }> | null = null
  /** Per shape: cell, green, fire state, placement matrix and [x, ground, z, height] of each instance. */
  private inst: Record<Shape, Inst> = { pine: emptyInst(), round: emptyInst(), shrub: emptyInst() }
  private flames!: THREE.Points
  private flameMat!: THREE.ShaderMaterial
  private grid: Grid
  private getState: () => { result: SimResult | null; step: number }
  private builtKey = ''
  private lastStep = -1
  private lastResult: SimResult | null = null
  private timer = 0
  /** Terrain height at grid cell corners (exaggerated, as the map draws it), filled lazily. */
  private cornerZ = new Map<number, number>()
  private missing = false
  private retries = 0

  constructor(grid: Grid, getState: () => { result: SimResult | null; step: number }) {
    this.grid = grid
    this.getState = getState
  }

  onAdd(map: maptilersdk.Map, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map
    const g = this.grid
    const c = cellCenter(g, Math.floor(g.rows / 2) * g.cols + Math.floor(g.cols / 2))
    this.origin = maptilersdk.MercatorCoordinate.fromLngLat([c[1], c[0]], 0)
    this.scale = this.origin.meterInMercatorCoordinateUnits()
    this.local
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(this.scale, -this.scale, this.scale))
      .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2))
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.25))
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6)
    sun.position.set(-0.6, 1, 0.4)
    this.scene.add(sun)
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl })
    this.renderer.autoClear = false
    const make = (geo: THREE.BufferGeometry) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_TREES)
      m.count = 0
      m.frustumCulled = false
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TREES * 3), 3)
      m.instanceColor.setUsage(THREE.DynamicDrawUsage)
      this.scene.add(m)
      return m
    }
    // few faces: 6-sided cones, 12-face crowns, 4-sided trunks without caps
    const trunk = (h: number, r: number) => new THREE.CylinderGeometry(r * 0.7, r, h, 4, 1, true).translate(0, h / 2, 0)
    // a burned tree: the bare black stem (pines keep their full height, broadleaves a forked stump)
    const snag = (geo: THREE.BufferGeometry) => {
      const m = make(geo)
      ;(m.material as THREE.MeshLambertMaterial).color.set(0x15100e)
      return m
    }
    const fork = () => {
      const a = trunk(5.4, 0.42)
      const b = new THREE.CylinderGeometry(0.06, 0.2, 2.6, 4, 1, true).translate(0, 1.3, 0).rotateZ(0.55).translate(0.3, 4.6, 0)
      const c = new THREE.CylinderGeometry(0.06, 0.18, 2.2, 4, 1, true).translate(0, 1.1, 0).rotateZ(-0.6).translate(-0.25, 4.1, 0)
      return mergeGeos([a, b, c])
    }
    this.meshes = {
      pine: { crown: make(new THREE.ConeGeometry(2.6, 9, 6).translate(0, 3 + 4.5, 0)), trunk: make(trunk(3.2, 0.35)), snag: snag(new THREE.CylinderGeometry(0.05, 0.36, 11.4, 4, 1, true).translate(0, 5.7, 0)), trunkColor: new THREE.Color(0x5a3d24) },
      round: { crown: make(new THREE.DodecahedronGeometry(3.4, 0).scale(1, 0.9, 1).translate(0, 3 + 2.8, 0)), trunk: make(trunk(3.4, 0.4)), snag: snag(fork()), trunkColor: new THREE.Color(0x5f4128) },
      shrub: { crown: make(new THREE.DodecahedronGeometry(1.7, 0).scale(1.2, 0.7, 1.2).translate(0, 1, 0)), trunk: make(trunk(0.6, 0.2)), snag: snag(new THREE.CylinderGeometry(0.05, 0.2, 1.1, 4, 1, true).translate(0, 0.55, 0)), trunkColor: new THREE.Color(0x5f4a30) },
    }
    const fg = new THREE.BufferGeometry()
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_FLAMES * 3), 3).setUsage(THREE.DynamicDrawUsage))
    fg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAX_FLAMES), 1).setUsage(THREE.DynamicDrawUsage))
    fg.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(MAX_FLAMES), 1).setUsage(THREE.DynamicDrawUsage))
    fg.setDrawRange(0, 0)
    this.flameMat = flameMaterial()
    this.flames = new THREE.Points(fg, this.flameMat)
    this.flames.frustumCulled = false
    this.flames.renderOrder = 5
    this.scene.add(this.flames)
    map.on('moveend', this.schedule)
    map.on('terrain', this.resetHeights)
    this.schedule()
  }

  onRemove() {
    this.map.off('moveend', this.schedule)
    this.map.off('terrain', this.resetHeights)
    window.clearTimeout(this.timer)
    this.scene.clear()
    this.renderer.dispose()
  }

  private resetHeights = () => {
    this.cornerZ.clear()
    this.builtKey = ''
    this.schedule()
  }

  private schedule = () => {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.plant(), 300)
  }

  /** Terrain height at a cell corner (col, row), read from the map once. */
  private corner(col: number, row: number): number {
    const k = row * (this.grid.cols + 1) + col
    let z = this.cornerZ.get(k)
    if (z === undefined) {
      const g = this.grid
      const v = this.map.queryTerrainElevation([g.lon0 + col * g.dLon, g.lat0 - row * g.dLat])
      // terrain not loaded here yet: do not remember a wrong height, plant again shortly
      if (v === null || v === undefined) {
        this.missing = true
        return 0
      }
      z = v
      this.cornerZ.set(k, z)
    }
    return z
  }

  /** Trees for the cells in view: a few per forest cell, fewer per maquis cell, spread by a hash. */
  private plant() {
    if (!this.meshes) return
    const map = this.map
    const g = this.grid
    if (map.getZoom() < MIN_ZOOM) {
      for (const k of SHAPES) this.meshes[k].crown.count = this.meshes[k].trunk.count = this.meshes[k].snag.count = 0
      this.flames.geometry.setDrawRange(0, 0)
      this.builtKey = ''
      map.triggerRepaint()
      return
    }
    const b = map.getBounds()
    const c0 = Math.max(0, Math.floor((b.getWest() - g.lon0) / g.dLon))
    const c1 = Math.min(g.cols - 1, Math.ceil((b.getEast() - g.lon0) / g.dLon))
    const r0 = Math.max(0, Math.floor((g.lat0 - b.getNorth()) / g.dLat))
    const r1 = Math.min(g.rows - 1, Math.ceil((g.lat0 - b.getSouth()) / g.dLat))
    const key = `${c0},${c1},${r0},${r1}`
    if (key === this.builtKey) return
    this.builtKey = key
    this.missing = false
    let forest = 0
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (g.kind[r * g.cols + c] >= 3) forest++
    const per = Math.max(1, Math.min(6, Math.floor(MAX_TREES / Math.max(1, forest))))
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const pos = new THREE.Vector3()
    const scl = new THREE.Vector3()
    const counts: Record<Shape, number> = { pine: 0, round: 0, shrub: 0 }
    const cells: Record<Shape, number[]> = { pine: [], round: [], shrub: [] }
    const bases: Record<Shape, THREE.Color[]> = { pine: [], round: [], shrub: [] }
    const places: Record<Shape, number[]> = { pine: [], round: [], shrub: [] }
    const shades: Record<Shape, THREE.Color[]> = { pine: GREENS.pine.map((h) => new THREE.Color(h)), round: GREENS.round.map((h) => new THREE.Color(h)), shrub: GREENS.shrub.map((h) => new THREE.Color(h)) }
    // mercator of the grid's corner and of one cell step, so tree positions need no per-tree projection
    const m0 = maptilersdk.MercatorCoordinate.fromLngLat([g.lon0, g.lat0], 0)
    const m1 = maptilersdk.MercatorCoordinate.fromLngLat([g.lon0 + g.dLon, g.lat0 - g.dLat], 0)
    const dx = (m1.x - m0.x) / this.scale
    const dz = (m1.y - m0.y) / this.scale
    const ox = (m0.x - this.origin.x) / this.scale
    const oz = (m0.y - this.origin.y) / this.scale
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const i = r * g.cols + c
        const k = g.kind[i]
        if (k < 3) continue
        const sp = speciesById(g.species?.[i] ?? 0)
        const shape: Shape = k === 3 || sp.shrub ? 'shrub' : /çam|ardıç|sedir|göknar/i.test(sp.name) ? 'pine' : 'round'
        const n = Math.max(1, Math.round(per * (0.35 + 0.65 * g.veg[i]) * (shape === 'shrub' ? 1.3 : 1)))
        // the cell's four corner heights; each tree is placed between them
        const z00 = this.corner(c, r)
        const z10 = this.corner(c + 1, r)
        const z01 = this.corner(c, r + 1)
        const z11 = this.corner(c + 1, r + 1)
        for (let t = 0; t < n; t++) {
          if (counts[shape] >= MAX_TREES) break
          const fx = hash3(i, t, 11)
          const fy = hash3(i, t, 12)
          const ground = z00 * (1 - fx) * (1 - fy) + z10 * fx * (1 - fy) + z01 * (1 - fx) * fy + z11 * fx * fy
          const s = SIZE * (0.75 + 0.5 * hash3(i, t, 13)) * (0.7 + 0.5 * g.veg[i])
          q.setFromAxisAngle(up, hash3(i, t, 14) * Math.PI * 2)
          pos.set(ox + (c + fx) * dx, ground, oz + (r + fy) * dz)
          scl.set(s, s * (0.85 + 0.3 * hash3(i, t, 15)), s)
          m4.compose(pos, q, scl)
          const idx = counts[shape]++
          this.meshes[shape].crown.setMatrixAt(idx, m4)
          this.meshes[shape].trunk.setMatrixAt(idx, m4)
          cells[shape].push(i)
          places[shape].push(pos.x, pos.y, pos.z, HEIGHT[shape] * scl.y)
          bases[shape].push(shades[shape][Math.floor(hash3(i, t, 16) * shades[shape].length)])
        }
      }
    for (const k of SHAPES) {
      const { crown, trunk, snag } = this.meshes[k]
      crown.count = trunk.count = snag.count = counts[k]
      for (let idx = 0; idx < counts[k]; idx++) snag.setMatrixAt(idx, ZERO)
      crown.instanceMatrix.needsUpdate = trunk.instanceMatrix.needsUpdate = snag.instanceMatrix.needsUpdate = true
      this.inst[k] = { cell: Int32Array.from(cells[k]), base: bases[k], state: new Uint8Array(counts[k]), mats: Float32Array.from(crown.instanceMatrix.array.subarray(0, counts[k] * 16)), place: Float32Array.from(places[k]) }
      for (let idx = 0; idx < counts[k]; idx++) {
        crown.setColorAt(idx, bases[k][idx])
        trunk.setColorAt(idx, this.meshes[k].trunkColor)
        snag.setColorAt(idx, WHITE)
      }
      crown.instanceColor!.needsUpdate = trunk.instanceColor!.needsUpdate = snag.instanceColor!.needsUpdate = true
    }
    this.lastStep = -1
    map.triggerRepaint()
    // some heights were not available yet (terrain still loading): try again in a moment
    if (this.missing && this.retries < 20) {
      this.retries++
      this.builtKey = ''
      window.clearTimeout(this.timer)
      this.timer = window.setTimeout(() => this.plant(), 600)
    } else if (!this.missing) this.retries = 0
  }

  /** Fire state of a cell at step s (see BURN_COLORS). */
  private stateOf(result: SimResult | null, c: number, s: number): number {
    if (!result) return 0
    const t = result.ignitionStep[c]
    if (t < 0 || t > s) {
      // not burning yet: dried by the heat when the front is next to it (or reaches it within a few steps)
      if (t > s && t <= s + SCORCH_STEPS) return 5
      const g = this.grid
      const x = c % g.cols
      const y = (c / g.cols) | 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < g.cols && yy < g.rows) {
            const tn = result.ignitionStep[yy * g.cols + xx]
            if (tn >= 0 && tn <= s) return 5
          }
        }
      return 0
    }
    const end = result.burnoutStep[c]
    return s >= end ? 4 : 1 + Math.min(2, Math.floor(((s - t) / Math.max(1, end - t)) * 3))
  }

  /** Updates only the trees whose cell changed fire state since the last call, then the flames. */
  private recolor() {
    if (!this.meshes) return
    const { result, step } = this.getState()
    const s = Math.floor(step)
    if (s === this.lastStep && result === this.lastResult) return
    this.lastStep = s
    this.lastResult = result
    const m4 = new THREE.Matrix4()
    const tmp = new THREE.Color()
    let anyChange = false
    for (const k of SHAPES) {
      const { crown, trunk, snag, trunkColor } = this.meshes[k]
      const { cell, base, state, mats } = this.inst[k]
      let colors = false
      let matrices = false
      for (let idx = 0; idx < cell.length; idx++) {
        const st = this.stateOf(result, cell[idx], s)
        const was = state[idx]
        if (was === st) continue
        state[idx] = st
        colors = true
        // burned: the crown goes, the black stem stays; back from burned (seeking): the crown returns
        if (st === 4 || was === 4) {
          m4.fromArray(mats, idx * 16)
          crown.setMatrixAt(idx, st === 4 ? ZERO : m4)
          trunk.setMatrixAt(idx, st === 4 ? ZERO : m4)
          snag.setMatrixAt(idx, st === 4 ? m4 : ZERO)
          matrices = true
        }
        if (st !== 4) crown.setColorAt(idx, st === 0 ? base[idx] : st === 5 ? tmp.copy(base[idx]).lerp(SCORCH, 0.6) : BURN_COLORS[st]!)
        trunk.setColorAt(idx, st === 0 || st === 5 ? trunkColor : CHAR_TRUNK)
      }
      if (colors) crown.instanceColor!.needsUpdate = trunk.instanceColor!.needsUpdate = true
      if (matrices) crown.instanceMatrix.needsUpdate = trunk.instanceMatrix.needsUpdate = snag.instanceMatrix.needsUpdate = true
      anyChange ||= colors
    }
    if (anyChange) this.placeFlames()
  }

  /** Flames on the burning trees: tall ones in the young fire, low ones as it dies down. */
  private placeFlames() {
    const geo = this.flames.geometry
    const P = geo.getAttribute('position') as THREE.BufferAttribute
    const S = geo.getAttribute('aSize') as THREE.BufferAttribute
    const D = geo.getAttribute('aSeed') as THREE.BufferAttribute
    let n = 0
    for (const k of SHAPES) {
      const { state, place } = this.inst[k]
      for (let idx = 0; idx < state.length && n < MAX_FLAMES; idx++) {
        const st = state[idx]
        if (st < 1 || st > 3) continue
        const x = place[idx * 4]
        const y = place[idx * 4 + 1]
        const z = place[idx * 4 + 2]
        const h = place[idx * 4 + 3]
        FLAMES[st].forEach(([at, size], f) => {
          if (n >= MAX_FLAMES) return
          const seed = hash3(idx, f, k.length * 7 + st)
          P.setXYZ(n, x + (seed - 0.5) * 2.4, y + h * at, z + (hash3(idx, f, 3) - 0.5) * 2.4)
          S.setX(n, h * size * (0.8 + 0.4 * seed))
          D.setX(n, seed)
          n++
        })
      }
    }
    P.needsUpdate = S.needsUpdate = D.needsUpdate = true
    geo.setDrawRange(0, n)
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: maptilersdk.CustomRenderMethodInput) {
    if (!this.meshes) return
    const z = this.map.getZoom()
    if (z < MIN_ZOOM) return
    this.recolor()
    const close = z >= TRUNK_ZOOM
    for (const k of SHAPES) this.meshes[k].trunk.visible = close
    const flaming = this.flames.geometry.drawRange.count > 0
    this.flameMat.uniforms.uTime.value = performance.now() / 1000
    this.flameMat.uniforms.uViewH.value = _gl.drawingBufferHeight
    this.proj.fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(this.local)
    this.camera.projectionMatrix.copy(this.proj)
    this.renderer.resetState()
    this.renderer.render(this.scene, this.camera)
    // flames flicker: keep drawing while any burn
    if (flaming) this.map.triggerRepaint()
  }
}

interface Inst { cell: Int32Array; base: THREE.Color[]; state: Uint8Array; mats: Float32Array; place: Float32Array }
function emptyInst(): Inst {
  return { cell: new Int32Array(0), base: [], state: new Uint8Array(0), mats: new Float32Array(0), place: new Float32Array(0) }
}

/** Merges non-indexed geometries with position and normal only. */
function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g))
  const total = parts.reduce((a, g) => a + g.getAttribute('position').count, 0)
  const pos = new Float32Array(total * 3)
  const nor = new Float32Array(total * 3)
  let o = 0
  for (const g of parts) {
    pos.set(g.getAttribute('position').array as Float32Array, o * 3)
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3)
    o += g.getAttribute('position').count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  return out
}
