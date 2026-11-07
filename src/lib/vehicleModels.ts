import * as THREE from 'three'
import type { ResourceKind } from '../sim/types'

/**
 * Low-poly 3D models of the response resources, in the same flat-shaded style as the 3D trees and the Varlık Kalkanı
 * models: fire engine, dozer, helicopter with a water bucket and an amphibious water bomber. Sizes are real metres;
 * each model faces +x (east) with y up, and stands on y = 0. Parts that move are named: "rotor", "tailRotor", "prop",
 * "bucket", "beacon".
 */

const mats = new Map<number, THREE.MeshLambertMaterial>()
const mat = (color: number) => {
  let m = mats.get(color)
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true })
    mats.set(color, m)
  }
  return m
}
const RED = 0xc9261d
const DARK = 0x23262a
const STEEL = 0x8d969c
const WHITE = 0xeeeeea
const GLASS = 0x1d3448
const YELLOW = 0xf0b21a
const AMBER = 0xffb02e

function box(g: THREE.Object3D, w: number, h: number, d: number, color: number, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color))
  m.position.set(x, y, z)
  g.add(m)
  return m
}
function cyl(g: THREE.Object3D, rTop: number, rBottom: number, len: number, color: number, seg = 8) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, len, seg), mat(color))
  g.add(m)
  return m
}
function wheel(g: THREE.Object3D, x: number, z: number, r: number, w: number) {
  const m = cyl(g, r, r, w, DARK, 8)
  m.rotation.x = Math.PI / 2
  m.position.set(x, r, z)
}

/** Fire engine (arazöz): red cab and tank body with a white band, ladder and hose reel, blue beacon. */
function engine(): THREE.Group {
  const g = new THREE.Group()
  box(g, 7.4, 0.45, 2.2, DARK, 0, 0.75, 0)
  box(g, 2.1, 2.0, 2.4, RED, 2.6, 1.95, 0)
  box(g, 0.08, 0.85, 2.1, GLASS, 3.66, 2.35, 0)
  box(g, 1.4, 0.7, 2.42, GLASS, 2.7, 2.35, 0).scale.set(0.98, 1, 1)
  box(g, 4.9, 2.3, 2.45, RED, -1.05, 2.1, 0)
  box(g, 4.95, 0.22, 2.48, WHITE, -1.05, 1.75, 0)
  box(g, 7.0, 0.1, 0.5, STEEL, 0, 3.3, 0.55)
  for (let k = 0; k < 6; k++) box(g, 0.08, 0.12, 0.55, STEEL, -2.8 + k * 1.15, 3.36, 0.55)
  const reel = cyl(g, 0.45, 0.45, 0.5, STEEL, 10)
  reel.rotation.x = Math.PI / 2
  reel.position.set(-2.6, 3.55, -0.6)
  const beacon = box(g, 0.25, 0.2, 1.4, 0x2d7cff, 2.6, 3.05, 0)
  beacon.name = 'beacon'
  for (const x of [2.7, -1.6, -2.8]) for (const z of [-1.08, 1.08]) wheel(g, x, z, 0.52, 0.38)
  return g
}

/** Dozer (iş makinesi): yellow body and cab on dark tracks, steel blade in front. */
function dozer(): THREE.Group {
  const g = new THREE.Group()
  for (const z of [-1.15, 1.15]) {
    box(g, 4.0, 0.85, 0.75, DARK, 0, 0.45, z)
    for (const x of [-1.6, 1.6]) {
      const r = cyl(g, 0.42, 0.42, 0.78, 0x34373b, 8)
      r.rotation.x = Math.PI / 2
      r.position.set(x, 0.45, z)
    }
  }
  box(g, 3.1, 1.15, 2.1, YELLOW, -0.2, 1.45, 0)
  box(g, 1.5, 1.45, 1.7, YELLOW, -0.7, 2.75, 0)
  box(g, 1.52, 0.8, 1.72, GLASS, -0.7, 2.95, 0)
  box(g, 0.2, 0.08, 1.9, YELLOW, -0.7, 3.52, 0)
  const pipe = cyl(g, 0.08, 0.08, 1.0, DARK, 6)
  pipe.position.set(0.7, 2.4, 0.6)
  box(g, 0.28, 1.15, 3.2, STEEL, 2.45, 0.75, 0).rotation.z = -0.12
  box(g, 1.2, 0.18, 0.18, STEEL, 1.75, 0.95, 0.85)
  box(g, 1.2, 0.18, 0.18, STEEL, 1.75, 0.95, -0.85)
  const beacon = box(g, 0.22, 0.2, 0.22, AMBER, -0.7, 3.65, 0)
  beacon.name = 'beacon'
  return g
}

/** Helicopter: red and white body, tail boom, skids, main and tail rotors, a water bucket on a line below. */
function helicopter(): THREE.Group {
  const g = new THREE.Group()
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mat(RED))
  body.scale.set(2.7, 1.35, 1.25)
  body.position.set(0.4, 2.2, 0)
  g.add(body)
  const belly = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(WHITE))
  belly.scale.set(2.72, 1.37, 1.27)
  belly.position.copy(body.position)
  g.add(belly)
  const glass = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6, 0, Math.PI), mat(GLASS))
  glass.scale.set(1.2, 0.9, 1.0)
  glass.rotation.y = -Math.PI / 2
  glass.position.set(1.85, 2.45, 0)
  g.add(glass)
  const boom = cyl(g, 0.22, 0.42, 6.2, RED, 8)
  boom.rotation.z = Math.PI / 2
  boom.position.set(-4.4, 2.55, 0)
  box(g, 1.1, 1.7, 0.12, RED, -7.3, 3.2, 0).rotation.z = 0.35
  box(g, 0.9, 0.08, 2.0, RED, -6.9, 2.6, 0)
  const tail = new THREE.Group()
  tail.name = 'tailRotor'
  tail.position.set(-7.4, 3.3, 0.18)
  box(tail, 0.18, 2.2, 0.04, DARK, 0, 0, 0)
  g.add(tail)
  for (const z of [-1.05, 1.05]) {
    const skid = cyl(g, 0.07, 0.07, 4.2, DARK, 6)
    skid.rotation.z = Math.PI / 2
    skid.position.set(0.4, 0.25, z)
    for (const x of [-0.6, 1.4]) box(g, 0.08, 0.95, 0.08, DARK, x, 0.75, z * 0.85)
  }
  const mast = cyl(g, 0.15, 0.15, 0.7, DARK, 6)
  mast.position.set(0.3, 3.75, 0)
  const rotor = new THREE.Group()
  rotor.name = 'rotor'
  rotor.position.set(0.3, 4.1, 0)
  for (let k = 0; k < 4; k++) {
    const pivot = new THREE.Group()
    pivot.rotation.y = (k * Math.PI) / 2
    box(pivot, 5.6, 0.05, 0.32, DARK, 2.8, 0, 0)
    rotor.add(pivot)
  }
  g.add(rotor)
  const bucket = new THREE.Group()
  bucket.name = 'bucket'
  const line = cyl(bucket, 0.03, 0.03, 9, DARK, 4)
  line.position.y = -4.5
  const pail = cyl(bucket, 0.85, 0.6, 1.3, AMBER, 10)
  pail.position.y = -9.6
  bucket.position.set(0.4, 0.4, 0)
  g.add(bucket)
  return g
}

/** Amphibious water bomber: yellow hull with a red band, high wing, two engines with propellers, tail. */
function waterBomber(): THREE.Group {
  const g = new THREE.Group()
  const hull = cyl(g, 1.25, 1.25, 13, YELLOW, 10)
  hull.rotation.z = Math.PI / 2
  hull.position.set(0, 2.4, 0)
  const nose = cyl(g, 0.05, 1.25, 3, YELLOW, 10)
  nose.rotation.z = -Math.PI / 2
  nose.position.set(8, 2.4, 0)
  const tailCone = cyl(g, 1.25, 0.35, 5.5, YELLOW, 10)
  tailCone.rotation.z = Math.PI / 2
  tailCone.position.set(-9.2, 2.7, 0)
  const band = cyl(g, 1.27, 1.27, 1.6, RED, 10)
  band.rotation.z = Math.PI / 2
  band.position.set(2.5, 2.4, 0)
  box(g, 1.6, 0.6, 2.2, GLASS, 6.4, 3.25, 0)
  box(g, 3.4, 0.38, 28, YELLOW, 1.2, 4.0, 0)
  box(g, 3.42, 0.4, 2.0, RED, 1.2, 4.0, 13)
  box(g, 3.42, 0.4, 2.0, RED, 1.2, 4.0, -13)
  for (const z of [-4.6, 4.6]) {
    const nac = cyl(g, 0.6, 0.55, 3.6, WHITE, 8)
    nac.rotation.z = Math.PI / 2
    nac.position.set(2.2, 3.6, z)
    const prop = new THREE.Group()
    prop.name = 'prop'
    prop.position.set(4.1, 3.6, z)
    box(prop, 0.08, 3.4, 0.3, DARK, 0, 0, 0)
    box(prop, 0.08, 0.3, 3.4, DARK, 0, 0, 0)
    g.add(prop)
  }
  for (const z of [-11.5, 11.5]) {
    box(g, 1.6, 0.5, 0.6, YELLOW, 1.6, 2.6, z)
    box(g, 0.12, 1.3, 0.12, DARK, 1.6, 3.2, z)
  }
  box(g, 2.6, 3.6, 0.22, YELLOW, -11, 4.4, 0)
  box(g, 0.6, 3.6, 0.24, RED, -11.9, 4.6, 0)
  box(g, 2.0, 0.22, 8.5, YELLOW, -11.4, 6.0, 0)
  return g
}

const BUILD: Record<ResourceKind, () => THREE.Group> = { crew: engine, dozer, heli: helicopter, plane: waterBomber }
/** Length of each model, metres. */
export const MODEL_LENGTH: Record<ResourceKind, number> = { crew: 7.6, dozer: 5, heli: 14, plane: 22 }

export function buildVehicle(kind: ResourceKind): THREE.Group {
  return BUILD[kind]()
}
