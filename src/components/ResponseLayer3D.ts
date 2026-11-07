import * as THREE from 'three'
import * as maptilersdk from '@maptiler/sdk'
import { cellCenter } from '../sim/terrain'
import { hash3 } from '../sim/rng'
import { activeMove, trackPosition } from '../lib/tracks'
import { MODEL_LENGTH, buildVehicle } from '../lib/vehicleModels'
import type { Grid, ResourceKind, ResponseRecord } from '../sim/types'

/**
 * The response in the 3D view: every resource as a 3D model (fire engine, dozer, helicopter, water bomber) moving
 * along its recorded trips on the terrain, aircraft climbing, cruising and diving to drop, and what they do as
 * particles: the water curtain of each drop, the spray of scooping, the hose stream of engines in direct attack,
 * steam where they cool the ground, dust behind dozers cutting a line. Driven by the playback clock, in sync with
 * the fire. Models are drawn at least a few dozen pixels long so they stay visible when zoomed out.
 */

const CRUISE: Record<'heli' | 'plane', number> = { heli: 110, plane: 160 }
const MIN_PX = 30
const MAX_PARTICLES = 9000

function waterMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uViewH: { value: 800 } },
    vertexShader: /* glsl */ `
      uniform float uViewH;
      attribute float aSize;
      attribute vec4 aColor;
      varying vec4 vColor;
      void main() {
        vec4 p = projectionMatrix * vec4(position, 1.0);
        vec4 q = projectionMatrix * vec4(position + vec3(0.0, aSize, 0.0), 1.0);
        vec4 r = projectionMatrix * vec4(position + vec3(aSize, 0.0, 0.0), 1.0);
        float px = max(length(q.xy / q.w - p.xy / p.w), length(r.xy / r.w - p.xy / p.w)) * 0.5 * uViewH;
        gl_PointSize = clamp(px, 1.5, 120.0);
        gl_Position = p;
        vColor = aColor;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec4 vColor;
      void main() {
        float d = length(gl_PointCoord * 2.0 - 1.0);
        float a = (1.0 - smoothstep(0.35, 1.0, d)) * vColor.a;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor.rgb, a);
      }
    `,
    transparent: true,
    depthWrite: false,
  })
}

interface Unit { g: THREE.Group; kind: ResourceKind; heading: number; ground: number; parts: { rotor?: THREE.Object3D; tail?: THREE.Object3D; props: THREE.Object3D[]; beacon?: THREE.Object3D; bucket?: THREE.Object3D } }

export class ResponseLayer3D implements maptilersdk.CustomLayerInterface {
  id = 'fg-response-3d'
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
  private units = new Map<string, Unit>()
  private points!: THREE.Points
  private pmat!: THREE.ShaderMaterial
  private grid: Grid
  private getState: () => { rec: ResponseRecord | null; step: number }
  private lastStep = -1

  constructor(grid: Grid, getState: () => { rec: ResponseRecord | null; step: number }) {
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
    // the same light as the 3D trees, so models and trees read as one scene
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.25))
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6)
    sun.position.set(-0.6, 1, 0.4)
    this.scene.add(sun)
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true })
    this.renderer.autoClear = false
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES), 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 4), 4).setUsage(THREE.DynamicDrawUsage))
    geo.setDrawRange(0, 0)
    this.pmat = waterMaterial()
    this.points = new THREE.Points(geo, this.pmat)
    this.points.frustumCulled = false
    this.points.renderOrder = 6
    this.scene.add(this.points)
  }

  onRemove() {
    this.scene.clear()
    this.renderer.dispose()
  }

  /** Local metres (x east, z south) of a lat/lon. */
  private toLocal(lat: number, lon: number): [number, number] {
    const m = maptilersdk.MercatorCoordinate.fromLngLat([lon, lat], 0)
    return [(m.x - this.origin.x) / this.scale, (m.y - this.origin.y) / this.scale]
  }

  private groundAt(lat: number, lon: number, fallback: number): number {
    const h = this.map.queryTerrainElevation([lon, lat])
    return h === null || h === undefined ? fallback : h
  }

  private unit(id: string, kind: ResourceKind): Unit {
    let u = this.units.get(id)
    if (!u) {
      const g = buildVehicle(kind)
      const props: THREE.Object3D[] = []
      const parts: Unit['parts'] = { props }
      g.traverse((o) => {
        if (o.name === 'rotor') parts.rotor = o
        else if (o.name === 'tailRotor') parts.tail = o
        else if (o.name === 'prop') props.push(o)
        else if (o.name === 'beacon') parts.beacon = o
        else if (o.name === 'bucket') parts.bucket = o
      })
      u = { g, kind, heading: 0, ground: 0, parts }
      this.units.set(id, u)
      this.scene.add(g)
    }
    return u
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: maptilersdk.CustomRenderMethodInput) {
    const { rec, step } = this.getState()
    const t = performance.now() / 1000
    const zoom = this.map.getZoom()
    const center = this.map.getCenter()
    // metres per screen pixel here: models are kept at least MIN_PX long
    const mpp = (40075016.686 * Math.cos((center.lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom))
    const seen = new Set<string>()
    const P = this.points.geometry.getAttribute('position') as THREE.BufferAttribute
    const S = this.points.geometry.getAttribute('aSize') as THREE.BufferAttribute
    const C = this.points.geometry.getAttribute('aColor') as THREE.BufferAttribute
    let n = 0
    const emit = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number) => {
      if (n >= MAX_PARTICLES) return
      P.setXYZ(n, x, y, z)
      S.setX(n, size)
      C.setXYZW(n, r, g, b, a)
      n++
    }
    let flying = false

    for (const tr of rec?.tracks ?? []) {
      const pos = trackPosition(tr, step)
      if (!pos) continue
      seen.add(tr.id)
      const u = this.unit(tr.id, tr.kind)
      const [x, z] = this.toLocal(pos.ll[0], pos.ll[1])
      u.ground = this.groundAt(pos.ll[0], pos.ll[1], u.ground)
      // heading from where the unit is a moment later; kept while it stands still
      const ahead = trackPosition(tr, step + 0.04)
      if (ahead) {
        const [x2, z2] = this.toLocal(ahead.ll[0], ahead.ll[1])
        if (Math.hypot(x2 - x, z2 - z) > 0.4) u.heading = Math.atan2(-(z2 - z), x2 - x)
      }
      const air = tr.kind === 'heli' || tr.kind === 'plane'
      const vs = Math.max(1.6, (MIN_PX * mpp) / MODEL_LENGTH[tr.kind])
      const fx = vs / 1.6
      let alt = 0
      const mv = activeMove(tr.moves, step)
      if (air) {
        const cruise = CRUISE[tr.kind as 'heli' | 'plane']
        const low = tr.kind === 'heli' ? 12 : 2
        const f = mv ? (step - mv.fromStep) / Math.max(1e-6, mv.toStep - mv.fromStep) : 0
        const ease = (a: number, b: number, v: number) => Math.min(1, Math.max(0, (v - a) / (b - a)))
        if (!mv) alt = pos.status === 'grounded' || pos.status === 'idle' ? 0 : cruise
        else if (mv.purpose === 'refill') alt = low
        else if (mv.purpose === 'water') {
          // from the drop (low over the fire) up to cruise, then down onto the water
          const a1 = 45 + (cruise - 45) * ease(0, 0.25, f)
          alt = a1 + (low - a1) * ease(0.7, 1, f)
        } else if (mv.purpose === 'drop') {
          // off the water up to cruise, then the dive to drop height over the fire
          const a1 = low + (cruise - low) * ease(0, 0.25, f)
          alt = a1 + (45 - a1) * ease(0.65, 1, f)
        }
        else if (mv.purpose === 'return') alt = cruise * (1 - ease(0.85, 1, f))
        else alt = cruise * ease(0, 0.12, f)
        if (alt > 1) flying = true
      }
      u.g.position.set(x, u.ground + alt, z)
      u.g.rotation.set(0, u.heading, 0)
      // a little bank and nose-down on the dive for aircraft
      if (air && mv?.purpose === 'drop') u.g.rotation.z = -0.08
      u.g.scale.setScalar(vs)
      u.g.visible = true
      const moving = !!mv || pos.status === 'attacking' || pos.status === 'mopping' || pos.status === 'building' || pos.status === 'dropping'
      if (u.parts.rotor) u.parts.rotor.rotation.y = alt > 0.5 ? t * 24 : t * 0.3
      if (u.parts.tail) u.parts.tail.rotation.z = alt > 0.5 ? t * 40 : 0
      for (const p of u.parts.props) p.rotation.x = alt > 0.5 ? t * 30 : 0
      if (u.parts.beacon) u.parts.beacon.visible = moving ? (t * 2.5) % 1 < 0.55 : false
      if (u.parts.bucket) u.parts.bucket.visible = alt > 0.5

      // ground engines in direct attack or cooling: a hose stream ahead, steam where it lands
      if (tr.kind === 'crew' && (pos.status === 'attacking' || pos.status === 'mopping')) {
        const dx = Math.cos(u.heading)
        const dz = -Math.sin(u.heading)
        const y0 = u.ground + 3 * fx
        for (let i = 0; i < 26; i++) {
          const q = (i / 26 + t * 1.3) % 1
          const reach = 24 * fx
          emit(x + dx * (4 * fx + q * reach) + (hash3(i, 1, 7) - 0.5) * 0.8 * fx, y0 + Math.sin(q * Math.PI) * 6 * fx - q * 3 * fx, z + dz * (4 * fx + q * reach) + (hash3(i, 2, 7) - 0.5) * 0.8 * fx, (1.4 + q * 2.6) * fx, 0.82, 0.92, 1, 0.75 - 0.35 * q)
        }
        const tx = x + dx * 28 * fx
        const tz = z + dz * 28 * fx
        const n0 = pos.status === 'mopping' ? 16 : 7
        for (let i = 0; i < n0; i++) {
          const q = (hash3(i, 3, 9) + t * 0.35) % 1
          emit(tx + (hash3(i, 4, 9) - 0.5) * 10 * fx, u.ground + 1 + q * 16 * fx, tz + (hash3(i, 5, 9) - 0.5) * 10 * fx, (4 + q * 9) * fx, 0.86, 0.86, 0.84, 0.32 * (1 - q))
        }
      }
      // dozers cutting a line: dust behind the blade
      if (tr.kind === 'dozer' && pos.status === 'building') {
        const dx = Math.cos(u.heading)
        const dz = -Math.sin(u.heading)
        for (let i = 0; i < 14; i++) {
          const q = (hash3(i, 6, 3) + t * 0.5) % 1
          emit(x - dx * (2 + q * 9) * fx + (hash3(i, 7, 3) - 0.5) * 5 * fx, u.ground + 0.5 + q * 5 * fx, z - dz * (2 + q * 9) * fx + (hash3(i, 8, 3) - 0.5) * 5 * fx, (2.5 + q * 4) * fx, 0.6, 0.5, 0.36, 0.45 * (1 - q))
        }
      }
    }
    for (const [id, u] of this.units) if (!seen.has(id)) u.g.visible = false

    const fxAll = Math.max(1, (MIN_PX * mpp) / 14 / 1.6)
    // water drops: a falling curtain released along a line, then a wet mist on the ground
    for (const d of rec?.drops ?? []) {
      if (step < d.step - 0.04 || step > d.step + 0.6) continue
      const p = (step - (d.step - 0.04)) / 0.64
      const [x, z] = this.toLocal(d.lat, d.lon)
      const ground = this.groundAt(d.lat, d.lon, 0)
      const ang = hash3(Math.round(d.step * 10), Math.round(d.lat * 1e4), 5) * Math.PI * 2
      const ax = Math.cos(ang)
      const az = Math.sin(ang)
      for (let i = 0; i < 150; i++) {
        const v = (i / 150) * 2 - 1
        const age = (p - ((v + 1) / 2) * 0.22) / 0.42
        if (age < 0) continue
        const j1 = hash3(i, Math.round(d.step), 1) - 0.5
        const j2 = hash3(i, Math.round(d.step), 2) - 0.5
        if (age <= 1) {
          const spread = (2 + 9 * age) * fxAll
          emit(x + ax * v * 32 * fxAll + j1 * spread, ground + 45 * fxAll * (1 - age * age), z + az * v * 32 * fxAll + j2 * spread, (3 + 5 * age) * fxAll, 0.88, 0.94, 1, 0.6)
        } else if (age <= 2.2) {
          const k = (age - 1) / 1.2
          const spread = (10 + 16 * k) * fxAll
          emit(x + ax * v * 34 * fxAll + j1 * spread, ground + 1.5 + k * 3 * fxAll, z + az * v * 34 * fxAll + j2 * spread, (7 + 6 * k) * fxAll, 0.9, 0.94, 0.98, 0.42 * (1 - k))
        }
      }
    }
    // scooping: spray on the water while an aircraft fills up
    for (const sc of rec?.scoops ?? []) {
      if (step < sc.step || step > sc.untilStep) continue
      const [x, z] = this.toLocal(sc.lat, sc.lon)
      const ground = this.groundAt(sc.lat, sc.lon, 0)
      const big = sc.kind === 'plane'
      for (let i = 0; i < (big ? 70 : 36); i++) {
        const q = (hash3(i, 9, 2) + t * 0.9) % 1
        const a = hash3(i, 10, 2) * Math.PI * 2
        const r = (3 + q * (big ? 20 : 9)) * fxAll
        emit(x + Math.cos(a) * r, ground + 0.5 + Math.sin(q * Math.PI) * (big ? 7 : 3) * fxAll, z + Math.sin(a) * r, (2 + q * 3) * fxAll, 0.92, 0.96, 1, 0.65 * (1 - q))
      }
    }
    const geo = this.points.geometry
    P.needsUpdate = S.needsUpdate = C.needsUpdate = true
    geo.setDrawRange(0, n)

    this.pmat.uniforms.uViewH.value = gl.drawingBufferHeight
    this.proj.fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(this.local)
    this.camera.projectionMatrix.copy(this.proj)
    this.renderer.resetState()
    this.renderer.render(this.scene, this.camera)
    // keep animating while something moves on its own (rotors, sprays) or the clock runs
    if (n > 0 || flying || step !== this.lastStep) this.map.triggerRepaint()
    this.lastStep = step
  }
}
