import * as THREE from 'three'
import type { AssetKind } from '../sim/asset'

/**
 * Procedural 3D models of an asset, fitted to the area the user drew: a factory, a solar farm (GES), a mine site
 * or a private property. Everything is built in local metres around the area's centre (x east, y up, z south) and
 * sized to the oriented rectangle that best fits the drawn polygon, so the model fills the drawn area at its true
 * size and turned the same way.
 */

export type Pt = [number, number] // x east, z south (metres)

export interface FitBox {
  cx: number
  cz: number
  /** Long side and short side, metres. */
  w: number
  d: number
  /** Rotation of the long side from east, radians (about the up axis). */
  angle: number
}

/** The smallest-area rectangle around the polygon (tried every degree). */
export function fitBox(poly: Pt[]): FitBox {
  let best: FitBox | null = null
  let bestArea = Infinity
  for (let deg = 0; deg < 90; deg++) {
    const a = (deg * Math.PI) / 180
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const [x, z] of poly) {
      const u = x * ca + z * sa
      const v = -x * sa + z * ca
      x0 = Math.min(x0, u); x1 = Math.max(x1, u); z0 = Math.min(z0, v); z1 = Math.max(z1, v)
    }
    const area = (x1 - x0) * (z1 - z0)
    if (area < bestArea) {
      bestArea = area
      const mu = (x0 + x1) / 2
      const mv = (z0 + z1) / 2
      const w = x1 - x0
      const d = z1 - z0
      const long = w >= d
      best = { cx: mu * ca - mv * sa, cz: mu * sa + mv * ca, w: long ? w : d, d: long ? d : w, angle: long ? a : a + Math.PI / 2 }
    }
  }
  return best!
}

export function inside(poly: Pt[], x: number, z: number): boolean {
  let s = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]
    const [xj, zj] = poly[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) s = !s
  }
  return s
}

const mat = (color: number, opts: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, ...opts })

/** A box standing on the ground at (x, z) of the box frame, w along its x, d along its z. */
function block(w: number, h: number, d: number, m: THREE.Material, x = 0, z = 0, y = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
  mesh.position.set(x, y + h / 2, z)
  return mesh
}

/** Pitched roof (a prism) over a w × d footprint at height h0. */
function roof(w: number, d: number, rise: number, m: THREE.Material, x = 0, z = 0, h0 = 0): THREE.Mesh {
  const s = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, rise)])
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false })
  g.translate(0, 0, -w / 2)
  g.rotateY(Math.PI / 2)
  const mesh = new THREE.Mesh(g, m)
  mesh.position.set(x, h0, z)
  return mesh
}

/**
 * The model for an asset. `poly` in local metres; `ground(x, z)` gives the terrain height there (metres, relative to
 * the centre's height) so wide sites follow the slope.
 */
export function buildAssetModel(kind: AssetKind, poly: Pt[], ground: (x: number, z: number) => number): THREE.Group {
  const box = fitBox(poly)
  const root = new THREE.Group()
  if (kind === 'ges') {
    root.add(solarFarm(poly, box, ground))
    return root
  }
  // the box frame: turned to the area's long side, at the area's centre
  // on a slope, buildings stand on the highest ground under them with a plinth down to the lowest
  const ca = Math.cos(box.angle)
  const sa = Math.sin(box.angle)
  const hs: number[] = []
  for (const [u, v] of [[0, 0], [-0.22, -0.22], [0.22, -0.22], [0.22, 0.22], [-0.22, 0.22]]) {
    const x = box.cx + (u * box.w) * ca - (v * box.d) * sa
    const z = box.cz + (u * box.w) * sa + (v * box.d) * ca
    hs.push(ground(x, z))
  }
  const top = Math.max(...hs)
  const low = Math.min(...hs)
  const frame = new THREE.Group()
  frame.position.set(box.cx, kind === 'maden' ? hs[0] : top, box.cz)
  frame.rotation.y = -box.angle
  const estate = kind === 'ozel' && box.w * box.d >= 6000
  if (kind !== 'maden' && !estate && top - low > 0.8) frame.add(block(Math.min(box.w * 0.5, kind === 'ozel' ? 26 : 280), top - low + 0.6, Math.min(box.d * 0.5, kind === 'ozel' ? 18 : 150), mat(0xb9b4aa), kind === 'ozel' ? 0 : -box.w * 0.08, 0, low - top - 0.6))
  if (kind === 'fabrika') factory(frame, box)
  else if (kind === 'maden') mine(frame, box)
  else {
    // houses on a wide plot follow the ground one by one
    const fy = frame.position.y
    property(frame, box, poly, (u, v) => ground(box.cx + u * ca - v * sa, box.cz + u * sa + v * ca) - fy)
  }
  root.add(frame)
  return root
}

/** Main hall with a saw-tooth roof, an office block, silos, chimneys and a yard. */
function factory(g: THREE.Group, b: FitBox) {
  const W = Math.min(b.w * 0.62, 260)
  const D = Math.min(b.d * 0.55, 140)
  const H = THREE.MathUtils.clamp(Math.min(W, D) * 0.18, 8, 18)
  const wall = mat(0xc9c6bd)
  const roofM = mat(0x5b6670, { metalness: 0.3, roughness: 0.55 })
  const hx = -b.w * 0.08
  g.add(block(W, H, D, wall, hx, 0))
  // saw-tooth roof across the hall
  const teeth = Math.max(3, Math.round(D / 12))
  for (let k = 0; k < teeth; k++) {
    const z = -D / 2 + (k + 0.5) * (D / teeth)
    const tooth = roof(W, D / teeth, H * 0.25, roofM, hx, z, H)
    g.add(tooth)
  }
  // office block at the front
  const oW = Math.min(W * 0.35, 50)
  g.add(block(oW, H * 0.8, Math.min(18, b.d * 0.15), mat(0xe4e1d8), hx - W / 2 + oW / 2 + 4, D / 2 + Math.min(9, b.d * 0.08)))
  // silos and chimneys beside the hall
  const sx = hx + W / 2 + Math.min(18, b.w * 0.1)
  const siloM = mat(0xd9dcdf, { metalness: 0.5, roughness: 0.35 })
  for (let k = 0; k < 3; k++) {
    const silo = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, H * 1.6, 16), siloM)
    silo.position.set(sx, H * 0.8, -D / 3 + k * (D / 3))
    g.add(silo)
  }
  const chimM = mat(0xa04a3a)
  for (let k = 0; k < 2; k++) {
    const ch = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2, H * 3, 12), chimM)
    ch.position.set(hx + W / 4 - k * 14, H * 1.5, -D / 2 + 6)
    g.add(ch)
  }
  // storage tanks and a loading yard
  const tankM = mat(0xeeeeee, { metalness: 0.4, roughness: 0.4 })
  for (let k = 0; k < 2; k++) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 8, 18), tankM)
    t.position.set(sx + 16, 4, D / 4 - k * 18)
    g.add(t)
  }
  // paved yard around the buildings
  g.add(block(Math.min(b.w * 0.85, W + 50), 0.3, Math.min(b.d * 0.85, D + 40), mat(0x6c7175), 0, 0, 0.05))
}

/** Rows of tilted panels facing south over the whole area, with inverter stations. */
function solarFarm(poly: Pt[], b: FitBox, ground: (x: number, z: number) => number): THREE.Group {
  const g = new THREE.Group()
  const ROW = 7.5 // row pitch, metres (north–south)
  const SEG = 10 // table length, metres (east–west)
  const DEPTH = 4.2
  const TILT = (25 * Math.PI) / 180
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const [x, z] of poly) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z)
  }
  const spots: [number, number][] = []
  for (let z = z0 + ROW / 2; z < z1; z += ROW)
    for (let x = x0 + SEG / 2; x < x1; x += SEG + 0.6) if (inside(poly, x, z) && inside(poly, x - SEG / 2, z) && inside(poly, x + SEG / 2, z)) spots.push([x, z])
  const n = Math.min(spots.length, 30000)
  const panel = new THREE.InstancedMesh(new THREE.BoxGeometry(SEG, 0.12, DEPTH), mat(0x1d3557, { metalness: 0.6, roughness: 0.25 }), Math.max(1, n))
  const legs = new THREE.InstancedMesh(new THREE.BoxGeometry(SEG * 0.9, 1.6, 0.15), mat(0x9aa0a6, { metalness: 0.6 }), Math.max(1, n))
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), TILT) // low edge to the south: panels face south
  const qi = new THREE.Quaternion()
  const one = new THREE.Vector3(1, 1, 1)
  for (let k = 0; k < n; k++) {
    const [x, z] = spots[k]
    const y = ground(x, z)
    m4.compose(new THREE.Vector3(x, y + 1.9, z), q, one)
    panel.setMatrixAt(k, m4)
    m4.compose(new THREE.Vector3(x, y + 0.8, z), qi, one)
    legs.setMatrixAt(k, m4)
  }
  panel.count = legs.count = n
  g.add(panel, legs)
  // inverter and transformer stations along the middle, and a service road
  const inv = mat(0xf2f2f2)
  const stations = Math.max(1, Math.round((b.w * b.d) / 40000))
  for (let k = 0; k < stations; k++) {
    const t = (k + 0.5) / stations - 0.5
    const x = b.cx + Math.cos(b.angle) * t * b.w * 0.8
    const z = b.cz + Math.sin(b.angle) * t * b.w * 0.8
    if (!inside(poly, x, z)) continue
    g.add(block(6, 3, 3, inv, x, z, ground(x, z)))
  }
  return g
}

/**
 * Open pit: stepped benches going down into the ground (drawn over the terrain surface so the pit can be seen),
 * spoil heaps, a crusher plant with a conveyor, haul trucks.
 */
function mine(g: THREE.Group, b: FitBox) {
  const R = Math.min(b.w, b.d) * 0.4
  const rx = Math.min(b.w * 0.34, R * 1.7)
  const benches = 6
  const step = 7
  // profile from the rim down: a flat bench, then a wall, each bench a little narrower
  const prof: THREE.Vector2[] = [new THREE.Vector2(1, 0)]
  for (let k = 0; k < benches; k++) {
    const r = 1 - (k + 1) / (benches + 1)
    prof.push(new THREE.Vector2(r + 0.06, -k * step), new THREE.Vector2(r, -(k + 1) * step))
  }
  prof.push(new THREE.Vector2(0, -benches * step))
  const pitGeo = new THREE.LatheGeometry(prof.reverse(), 64)
  pitGeo.computeVertexNormals()
  const pit = new THREE.Mesh(pitGeo, new THREE.MeshStandardMaterial({ color: 0x9c7f55, roughness: 0.95, side: THREE.DoubleSide, flatShading: true, depthTest: false }))
  pit.scale.set(rx, 1, R)
  pit.position.set(-b.w * 0.1, 0.5, 0)
  pit.renderOrder = 10
  g.add(pit)
  // haul trucks on the benches (drawn with the pit)
  const truck = new THREE.MeshStandardMaterial({ color: 0xf2b31b, roughness: 0.6, depthTest: false })
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4
    const lvl = 1 + (k % 3)
    const f = 1 - (lvl + 0.5) / (benches + 1)
    const t = block(9, 4.5, 5, truck, -b.w * 0.1 + Math.cos(a) * rx * f, Math.sin(a) * R * f, -lvl * step + 0.5)
    t.rotation.y = -a
    t.renderOrder = 11
    g.add(t)
  }
  // spoil heaps: stepped mounds beside the pit
  const heapM = mat(0xa3916f, { flatShading: true })
  for (let k = 0; k < 2; k++) {
    for (let s2 = 0; s2 < 4; s2++) {
      const r = R * 0.42 * (1 - s2 * 0.22)
      const h = 4
      const tier = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.9, r, h, 20), heapM)
      tier.position.set(b.w * 0.3, h / 2 + s2 * h, (k === 0 ? -1 : 1) * b.d * 0.24)
      g.add(tier)
    }
  }
  // crusher plant with a conveyor towards the pit
  g.add(block(28, 14, 18, mat(0xd4c7a1), b.w * 0.38, 0))
  const conv = block(Math.max(10, b.w * 0.22), 1.2, 2, mat(0x5b5b5b), b.w * 0.2, 0, 10)
  conv.rotation.z = -0.12
  g.add(conv)
  g.add(block(14, 6, 10, mat(0xe9e4d8), b.w * 0.38, b.d * 0.3))
}

/**
 * Private property: a house with a pitched roof, a terrace and a pool, garden trees; on a large plot more houses
 * spread over it (a villa estate), so the model fills the drawn area at its scale.
 */
function property(g: THREE.Group, b: FitBox, poly: Pt[], h: (u: number, v: number) => number) {
  const wall = mat(0xf1ebe0)
  const tile = mat(0xb5532f, { roughness: 0.7 })
  const crown = mat(0x3f7a35, { flatShading: true })
  const trunk = mat(0x6b4a2b)
  const ca = Math.cos(b.angle)
  const sa = Math.sin(b.angle)
  // frame (u along the long side, v across) to local metres, to keep everything inside the drawn edge
  const inPlot = (u: number, v: number, pad = 0) => {
    const x = b.cx + u * ca - v * sa
    const z = b.cz + u * sa + v * ca
    return inside(poly, x, z) && (pad === 0 || (inside(poly, x + pad, z) && inside(poly, x - pad, z) && inside(poly, x, z + pad) && inside(poly, x, z - pad)))
  }
  const W = THREE.MathUtils.clamp(b.w * 0.32, 8, 18)
  const D = THREE.MathUtils.clamp(b.d * 0.32, 7, 12)
  const lots: [number, number][] = []
  if (b.w * b.d < 6000) lots.push([0, 0])
  else {
    // one house per ~45 m lot, up to 30
    const step = 45
    const all: [number, number][] = []
    for (let u = -b.w / 2 + step / 2; u < b.w / 2; u += step)
      for (let v = -b.d / 2 + step / 2; v < b.d / 2; v += step) if (inPlot(u, v, 14)) all.push([u, v])
    // at most 30, spread over the whole plot
    const every = Math.max(1, all.length / 30)
    for (let k = 0; k < all.length && lots.length < 30; k += every) lots.push(all[Math.floor(k)])
    if (!lots.length) lots.push([0, 0])
  }
  lots.forEach(([u, v], k) => {
    const turn = ((k * 37) % 4) * (Math.PI / 2) * 0.0 + (k % 2 ? 0.08 : -0.06)
    const house = new THREE.Group()
    house.position.set(u, lots.length > 1 ? h(u, v) : 0, v)
    house.rotation.y = turn
    house.add(block(W, 6, D, wall))
    house.add(roof(W, D, 3.2, tile, 0, 0, 6))
    house.add(block(W * 0.8, 0.3, D * 0.5, mat(0xc9b38e), 0, D * 0.75))
    if (k % 2 === 0) house.add(block(Math.min(9, W * 0.6), 0.25, 4, mat(0x3fb0d8, { metalness: 0.1, roughness: 0.15 }), W * 0.55, D * 1.0))
    g.add(house)
  })
  // garden trees between the houses
  const trees = Math.min(80, Math.max(4, Math.round((b.w * b.d) / 700)))
  for (let k = 0; k < trees; k++) {
    const u = (((k * 0.618) % 1) - 0.5) * b.w * 0.9
    const v = (((k * 0.37 + 0.2) % 1) - 0.5) * b.d * 0.9
    if (!inPlot(u, v) || lots.some(([lu, lv]) => Math.abs(u - lu) < W * 0.8 && Math.abs(v - lv) < D * 1.2)) continue
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 3, 6), trunk)
    const y = h(u, v)
    t.position.set(u, y + 1.5, v)
    const c = new THREE.Mesh(new THREE.IcosahedronGeometry(2.6, 0), crown)
    c.position.set(u, y + 4.4, v)
    g.add(t, c)
  }
}

/** A fence along the drawn edge (world frame, not turned). */
export function fence(poly: Pt[], ground: (x: number, z: number) => number, color = 0xe8e2d4): THREE.Group {
  const g = new THREE.Group()
  const m = mat(color)
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i]
    const [x1, z1] = poly[(i + 1) % poly.length]
    const len = Math.hypot(x1 - x0, z1 - z0)
    const f = new THREE.Mesh(new THREE.BoxGeometry(len, 1.4, 0.25), m)
    f.position.set((x0 + x1) / 2, ground((x0 + x1) / 2, (z0 + z1) / 2) + 0.7, (z0 + z1) / 2)
    f.rotation.y = -Math.atan2(z1 - z0, x1 - x0)
    g.add(f)
  }
  return g
}
