import type { LatLon } from './geo'
import { densify, haversineM } from './geo'
import { cellOf } from './terrain'
import { STEP_MIN } from './engine'
import type { SimResult } from './types'
import { ROAD_SPEED, type Infrastructure, type NetEdge, type NetNode, type WaterSource } from '../data/infrastructure'

/**
 * Response-planning logic for the prototype. It combines the simulated fire arrival times with a small
 * road graph to propose access and evacuation routes. Illustrative decision support – not operational guidance.
 */

export const DISPATCH_DELAY_MIN = 20

export interface Segment {
  edgeId: string
  a: LatLon
  b: LatLon
  /** Minutes after ignition when fire reaches (or is adjacent to) this segment; Infinity if never. */
  fireMin: number
}
export interface EdgeHazard {
  edge: NetEdge
  firstFireMin: number
  segments: Segment[]
}

export interface RoutePlan {
  from: NetNode
  to: NetNode
  edges: NetEdge[]
  geom: LatLon[]
  distanceKm: number
  etaMin: number
  blockedEdges: NetEdge[]
  names: string[]
}

export interface ThreatenedSettlement {
  id: string
  name: string
  population: number
  arrivalMin: number
  exposurePct: number
}

export interface WaterAssessment {
  source: WaterSource
  distanceKm: number
  compromisedAtMin: number | null
}

export interface ResponsePlan {
  target: NetNode
  primary: RoutePlan | null
  alternative: RoutePlan | null
  evacuations: { settlement: ThreatenedSettlement; route: RoutePlan }[]
  hazards: EdgeHazard[]
  dangerous: { edge: NetEdge; fireMin: number }[]
  threatened: ThreatenedSettlement[]
  water: WaterAssessment[]
  stationsEvaluated: number
}

function minFireAt(result: SimResult, lat: number, lon: number): number {
  const g = result.grid
  const c = cellOf(g, lat, lon)
  if (c < 0) return Infinity
  const col = c % g.cols
  const row = (c / g.cols) | 0
  let best = Infinity
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = col + dx
      const y = row + dy
      if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue
      const t = result.ignitionStep[y * g.cols + x]
      if (t >= 0 && t * STEP_MIN < best) best = t * STEP_MIN
    }
  return best
}

export function buildHazards(result: SimResult, infra: Infrastructure): EdgeHazard[] {
  return infra.edges.map((edge) => {
    const pts = densify(edge.geom, 130)
    const segments: Segment[] = []
    let first = Infinity
    for (let i = 1; i < pts.length; i++) {
      const fa = minFireAt(result, pts[i - 1][0], pts[i - 1][1])
      const fb = minFireAt(result, pts[i][0], pts[i][1])
      const fireMin = Math.min(fa, fb)
      first = Math.min(first, fireMin)
      segments.push({ edgeId: edge.id, a: pts[i - 1], b: pts[i], fireMin })
    }
    return { edge, firstFireMin: first, segments }
  })
}

/** Short connector edges that join a point of interest to the road graph; never reported as a road by name. */
const LINK_NAMES = new Set(['İstasyon bağlantısı', 'Yerleşim bağlantısı', 'Toplanma alanı bağlantısı'])

const adjCache = new WeakMap<Infrastructure, Map<string, NetEdge[]>>()
function adjacencyOf(infra: Infrastructure) {
  let m = adjCache.get(infra)
  if (!m) {
    m = new Map()
    for (const e of infra.edges) for (const v of [e.from, e.to]) {
      const list = m.get(v)
      if (list) list.push(e)
      else m.set(v, [e])
    }
    adjCache.set(infra, m)
  }
  return m
}

/** Binary min-heap of (cost, node id) for Dijkstra. */
class MinHeap {
  private k: number[] = []
  private v: string[] = []
  push(key: number, val: string) {
    let i = this.k.length
    this.k.push(key)
    this.v.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.k[p] <= key) break
      this.k[i] = this.k[p]
      this.v[i] = this.v[p]
      i = p
    }
    this.k[i] = key
    this.v[i] = val
  }
  pop(): [number, string] | null {
    if (!this.k.length) return null
    const top: [number, string] = [this.k[0], this.v[0]]
    const key = this.k.pop()!
    const val = this.v.pop()!
    const n = this.k.length
    if (n) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= n) break
        const c = l + 1 < n && this.k[l + 1] < this.k[l] ? l + 1 : l
        if (this.k[c] >= key) break
        this.k[i] = this.k[c]
        this.v[i] = this.v[c]
        i = c
      }
      this.k[i] = key
      this.v[i] = val
    }
    return top
  }
}

function findRoute(
  infra: Infrastructure,
  hazards: Map<string, EdgeHazard>,
  fromId: string,
  toId: string,
  startMin: number,
  penalty: Map<string, number> = new Map(),
): RoutePlan | null {
  const adj = adjacencyOf(infra)
  const cost = new Map<string, number>()
  const time = new Map<string, number>()
  const prev = new Map<string, { edge: NetEdge; from: string }>()
  const done = new Set<string>()
  cost.set(fromId, 0)
  time.set(fromId, startMin)
  const heap = new MinHeap()
  heap.push(0, fromId)
  for (;;) {
    const top = heap.pop()
    if (!top) break
    const [best, u] = top
    if (done.has(u) || best > (cost.get(u) ?? Infinity)) continue
    if (u === toId) break
    done.add(u)
    for (const e of adj.get(u) ?? []) {
      const v = e.from === u ? e.to : e.from
      if (done.has(v)) continue
      const travel = (e.lengthM / 1000 / ROAD_SPEED[e.type]) * 60
      const tEnd = time.get(u)! + travel
      const blocked = (hazards.get(e.id)?.firstFireMin ?? Infinity) <= tEnd
      const c = best + travel * (blocked ? 6 : 1) * (penalty.get(e.id) ?? 1)
      if (c < (cost.get(v) ?? Infinity)) {
        cost.set(v, c)
        time.set(v, tEnd)
        prev.set(v, { edge: e, from: u })
        heap.push(c, v)
      }
    }
  }
  if (!prev.has(toId) && fromId !== toId) return null
  const edges: NetEdge[] = []
  const geom: LatLon[] = []
  let cur = toId
  const chain: { edge: NetEdge; from: string; to: string }[] = []
  while (cur !== fromId) {
    const p = prev.get(cur)!
    chain.unshift({ edge: p.edge, from: p.from, to: cur })
    cur = p.from
  }
  for (const step of chain) {
    edges.push(step.edge)
    const g = step.edge.from === step.from ? step.edge.geom : [...step.edge.geom].reverse()
    geom.push(...(geom.length ? g.slice(1) : g))
  }
  const distanceKm = edges.reduce((s, e) => s + e.lengthM, 0) / 1000
  const etaMin = (time.get(toId) ?? startMin) - startMin
  const names = edges.map((e) => e.name).filter((n, i, a) => !LINK_NAMES.has(n) && a.indexOf(n) === i)
  return {
    from: infra.nodes.find((n) => n.id === fromId)!,
    to: infra.nodes.find((n) => n.id === toId)!,
    edges,
    geom,
    distanceKm,
    etaMin,
    blockedEdges: edges.filter((e) => (hazards.get(e.id)?.firstFireMin ?? Infinity) <= startMin + etaMin),
    names,
  }
}

export function buildResponsePlan(result: SimResult, infra: Infrastructure, settlementsMeta: { id: string; name: string; population: number }[]): ResponsePlan {
  const hazardList = buildHazards(result, infra)
  const hz = new Map(hazardList.map((h) => [h.edge.id, h]))
  const ign: LatLon = result.config.ignition

  const candidates = infra.nodes.filter((n) => n.kind === 'access' || n.kind === 'junction' || n.kind === 'settlement')
  const target = candidates.reduce((a, b) => (haversineM(a.pos, ign) <= haversineM(b.pos, ign) ? a : b))
  const stations = infra.nodes.filter((n) => n.kind === 'station')

  const routes = stations
    .map((s) => findRoute(infra, hz, s.id, target.id, DISPATCH_DELAY_MIN))
    .filter((r): r is RoutePlan => !!r)
    .sort((a, b) => a.etaMin + a.blockedEdges.length * 30 - (b.etaMin + b.blockedEdges.length * 30))
  const primary = routes[0] ?? null

  let alternative: RoutePlan | null = null
  if (primary) {
    const pen = new Map(primary.edges.filter((e) => !LINK_NAMES.has(e.name)).map((e) => [e.id, 3]))
    const alts = stations
      .map((s) => findRoute(infra, hz, s.id, target.id, DISPATCH_DELAY_MIN, pen))
      .filter((r): r is RoutePlan => !!r)
      .filter((r) => {
        const shared = r.edges.filter((e) => primary.edges.some((p) => p.id === e.id && !LINK_NAMES.has(e.name))).length
        return shared < r.edges.length && !(r.from.id === primary.from.id && shared === r.edges.length)
      })
      .sort((a, b) => a.etaMin + a.blockedEdges.length * 30 - (b.etaMin + b.blockedEdges.length * 30))
    alternative = alts.find((r) => r.geom.length !== primary.geom.length || r.from.id !== primary.from.id) ?? null
  }

  const threatened: ThreatenedSettlement[] = result.impacts
    .filter((i) => i.arrivalMin !== null)
    .map((i) => {
      const m = settlementsMeta.find((s) => s.id === i.id)!
      return { id: i.id, name: m.name, population: m.population, arrivalMin: i.arrivalMin!, exposurePct: i.exposurePct }
    })
    .sort((a, b) => a.arrivalMin - b.arrivalMin)

  const safes = infra.nodes.filter((n) => n.kind === 'safe')
  const evacuations: ResponsePlan['evacuations'] = []
  for (const t of threatened.slice(0, 3)) {
    if (!infra.nodes.some((n) => n.id === t.id)) continue
    const depart = Math.max(0, t.arrivalMin - 120)
    const best = safes
      .map((s) => findRoute(infra, hz, t.id, s.id, depart))
      .filter((r): r is RoutePlan => !!r && r.edges.length > 0)
      .sort((a, b) => a.etaMin + a.blockedEdges.length * 30 - (b.etaMin + b.blockedEdges.length * 30))[0]
    if (best) evacuations.push({ settlement: t, route: best })
  }

  const horizon = result.steps * STEP_MIN
  const dangerous = hazardList
    .filter((h) => h.firstFireMin <= horizon)
    .map((h) => ({ edge: h.edge, fireMin: h.firstFireMin }))
    .sort((a, b) => a.fireMin - b.fireMin)

  const water: WaterAssessment[] = infra.water
    .map((w) => {
      const fm = minFireAt(result, w.pos[0], w.pos[1])
      return { source: w, distanceKm: haversineM(w.pos, ign) / 1000, compromisedAtMin: Number.isFinite(fm) ? fm : null }
    })
    .sort((a, b) => a.distanceKm - b.distanceKm)

  return { target, primary, alternative, evacuations, hazards: hazardList, dangerous, threatened, water, stationsEvaluated: stations.length }
}
