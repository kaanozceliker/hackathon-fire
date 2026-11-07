import * as THREE from 'three'
import * as maptilersdk from '@maptiler/sdk'
import { cellCenter } from '../sim/terrain'
import { speciesById } from '../data/vegetation'
import { hash3 } from '../sim/rng'
import type { Grid, SimResult } from '../sim/types'

/**
 * 3D trees for the MapTiler 3D view: a Three.js custom layer drawing low-poly trees with instancing. Trees are
 * placed on the forest and maquis cells of the grid (density from the vegetation share, shape from the estimated
 * species: pines as cones, oaks and sweetgum as round crowns, maquis as low shrubs) and sit on the map's own terrain.
 * Only the cells in view are planted, when zoomed in. Individual tree positions are illustrative: the data gives
 * cover, density and species per 110 m cell, not single trees. With the fire, trees glow while their cell burns and
 * turn to charred trunks once it has burned.
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
/** Fire state of a cell: 0 untouched, 1–3 burning (young → old), 4 burned. */
const BURN_COLORS = [null, new THREE.Color(1, 0.62, 0.16), new THREE.Color(0.95, 0.42, 0.12), new THREE.Color(0.75, 0.22, 0.1), new THREE.Color(0x2a2220)]
const CHAR_TRUNK = new THREE.Color(0x1d1715)

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
  private meshes: Record<Shape, { crown: THREE.InstancedMesh; trunk: THREE.InstancedMesh; trunkColor: THREE.Color }> | null = null
  /** Per shape: cell of each instance, its green, and the instances of each cell. */
  private inst: Record<Shape, { cell: Int32Array; base: THREE.Color[]; state: Uint8Array }> = { pine: { cell: new Int32Array(0), base: [], state: new Uint8Array(0) }, round: { cell: new Int32Array(0), base: [], state: new Uint8Array(0) }, shrub: { cell: new Int32Array(0), base: [], state: new Uint8Array(0) } }
  private grid: Grid
  private getState: () => { result: SimResult | null; step: number }
  private builtKey = ''
  private lastStep = -1
  private lastResult: SimResult | null = null
  private timer = 0
  /** Terrain height at grid cell corners (exaggerated, as the map draws it), filled lazily. */
  private cornerZ = new Map<number, number>()

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
    this.meshes = {
      pine: { crown: make(new THREE.ConeGeometry(2.6, 9, 6).translate(0, 3 + 4.5, 0)), trunk: make(trunk(3.2, 0.35)), trunkColor: new THREE.Color(0x5a3d24) },
      round: { crown: make(new THREE.DodecahedronGeometry(3.4, 0).scale(1, 0.9, 1).translate(0, 3 + 2.8, 0)), trunk: make(trunk(3.4, 0.4)), trunkColor: new THREE.Color(0x5f4128) },
      shrub: { crown: make(new THREE.DodecahedronGeometry(1.7, 0).scale(1.2, 0.7, 1.2).translate(0, 1, 0)), trunk: make(trunk(0.6, 0.2)), trunkColor: new THREE.Color(0x5f4a30) },
    }
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
      z = this.map.queryTerrainElevation([g.lon0 + col * g.dLon, g.lat0 - row * g.dLat]) ?? 0
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
      for (const k of SHAPES) this.meshes[k].crown.count = this.meshes[k].trunk.count = 0
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
          bases[shape].push(shades[shape][Math.floor(hash3(i, t, 16) * shades[shape].length)])
        }
      }
    for (const k of SHAPES) {
      const { crown, trunk } = this.meshes[k]
      crown.count = trunk.count = counts[k]
      crown.instanceMatrix.needsUpdate = trunk.instanceMatrix.needsUpdate = true
      this.inst[k] = { cell: Int32Array.from(cells[k]), base: bases[k], state: new Uint8Array(counts[k]) }
      for (let idx = 0; idx < counts[k]; idx++) {
        crown.setColorAt(idx, bases[k][idx])
        trunk.setColorAt(idx, this.meshes[k].trunkColor)
      }
      crown.instanceColor!.needsUpdate = trunk.instanceColor!.needsUpdate = true
    }
    this.lastStep = -1
    map.triggerRepaint()
  }

  /** Recolours only the trees whose cell changed fire state since the last call. */
  private recolor() {
    if (!this.meshes) return
    const { result, step } = this.getState()
    const s = Math.floor(step)
    if (s === this.lastStep && result === this.lastResult) return
    this.lastStep = s
    this.lastResult = result
    for (const k of SHAPES) {
      const { crown, trunk, trunkColor } = this.meshes[k]
      const { cell, base, state } = this.inst[k]
      let changed = false
      for (let idx = 0; idx < cell.length; idx++) {
        const c = cell[idx]
        const t = result ? result.ignitionStep[c] : -1
        let st = 0
        if (result && t >= 0 && t <= s) {
          const end = result.burnoutStep[c]
          st = s >= end ? 4 : 1 + Math.min(2, Math.floor(((s - t) / Math.max(1, end - t)) * 3))
        }
        if (state[idx] === st) continue
        state[idx] = st
        crown.setColorAt(idx, st === 0 ? base[idx] : BURN_COLORS[st]!)
        trunk.setColorAt(idx, st === 0 ? trunkColor : CHAR_TRUNK)
        changed = true
      }
      if (changed) crown.instanceColor!.needsUpdate = trunk.instanceColor!.needsUpdate = true
    }
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: maptilersdk.CustomRenderMethodInput) {
    if (!this.meshes) return
    const z = this.map.getZoom()
    if (z < MIN_ZOOM) return
    this.recolor()
    const close = z >= TRUNK_ZOOM
    for (const k of SHAPES) this.meshes[k].trunk.visible = close
    this.proj.fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(this.local)
    this.camera.projectionMatrix.copy(this.proj)
    this.renderer.resetState()
    this.renderer.render(this.scene, this.camera)
  }
}
