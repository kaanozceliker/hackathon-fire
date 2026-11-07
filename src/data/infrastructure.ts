import type { LatLon } from '../sim/geo'
import { haversineM, polylineLengthM } from '../sim/geo'
import { existingFor } from '../sim/existing'
import { hash3 } from '../sim/rng'
import type { Region } from './regions'
import { OSM } from './osm.generated'

export type NodeKind = 'settlement' | 'junction' | 'station' | 'access' | 'safe'
export type RoadType = 'highway' | 'road' | 'forest'

export interface NetNode {
  id: string
  name: string
  pos: LatLon
  kind: NodeKind
}
export interface NetEdge {
  id: string
  name: string
  type: RoadType
  from: string
  to: string
  /** Full geometry including both end nodes. */
  geom: LatLon[]
  lengthM: number
}
export interface WaterSource {
  id: string
  name: string
  pos: LatLon
  kind: 'sea' | 'reservoir' | 'pond' | 'stream'
  /** Rough capacity note shown in tooltip (sample value). */
  note: string
}
export interface Infrastructure {
  nodes: NetNode[]
  edges: NetEdge[]
  water: WaterSource[]
}

/** Typical engine speed by road class, km/h. */
export const ROAD_SPEED: Record<RoadType, number> = { highway: 60, road: 40, forest: 20 }

const node = (id: string, name: string, pos: LatLon, kind: NodeKind): NetNode => ({ id, name, pos, kind })
function edge(nodes: NetNode[], id: string, name: string, type: RoadType, from: string, to: string, via: LatLon[] = []): NetEdge {
  const a = nodes.find((n) => n.id === from)!
  const b = nodes.find((n) => n.id === to)!
  const geom: LatLon[] = [a.pos, ...via, b.pos]
  return { id, name, type, from, to, geom, lengthM: polylineLengthM(geom) }
}

/** Real network baked from OpenStreetMap (scripts/bake-osm.ts). */
function bakedInfrastructure(regionId: string): Infrastructure | null {
  const b = OSM[regionId]
  if (!b) return null
  const edges = b.edges.map((e) => ({ ...e, lengthM: polylineLengthM(e.geom) }))
  // Name each junction after the most important named road through it, e.g. "D400 kavşağı".
  const RANK = { highway: 0, road: 1, forest: 2 }
  const best = new Map<string, NetEdge>()
  for (const e of edges) {
    if (e.name.startsWith('İsimsiz') || e.name.endsWith('bağlantısı')) continue
    for (const v of [e.from, e.to]) {
      const cur = best.get(v)
      if (!cur || RANK[e.type] < RANK[cur.type]) best.set(v, e)
    }
  }
  const nodes = b.nodes.map((n) => (n.kind === 'junction' && best.has(n.id) ? { ...n, name: `${best.get(n.id)!.name} kavşağı` } : n))
  return { nodes, edges, water: b.water }
}

/** Procedural fallback network for regions without baked OSM data: hub-and-spoke roads with gentle wiggles. */
function proceduralInfrastructure(region: Region): Infrastructure {
  const sts = [...region.settlements].sort((a, b) => b.population - a.population)
  const hub = sts[0]
  const nodes: NetNode[] = sts.map((s) => node(s.id, s.name, s.pos, 'settlement'))
  const edges: NetEdge[] = []
  const wiggle = (a: LatLon, b: LatLon, seed: number): LatLon[] => {
    const out: LatLon[] = []
    for (let k = 1; k <= 3; k++) {
      const t = k / 4
      const off = (hash3(region.seed, seed, k) - 0.5) * 0.012
      out.push([a[0] + (b[0] - a[0]) * t + off, a[1] + (b[1] - a[1]) * t - off * 0.8])
    }
    return out
  }
  const tmp = (id: string, name: string, type: RoadType, from: string, to: string, extra?: LatLon[]) => {
    const a = nodes.find((n) => n.id === from)!
    const b = nodes.find((n) => n.id === to)!
    edges.push(edge(nodes, id, name, type, from, to, extra ?? wiggle(a.pos, b.pos, edges.length + 1)))
  }
  sts.slice(1).forEach((s, i) => {
    // mid-point access junction on each spoke
    const mid: LatLon = [(hub.pos[0] + s.pos[0]) / 2 + 0.004, (hub.pos[1] + s.pos[1]) / 2 - 0.003]
    const jid = `j${i}`
    nodes.push(node(jid, `${s.name} kavşağı`, mid, 'access'))
    tmp(`h${i}a`, `${hub.name}–${s.name} yolu`, 'highway', hub.id, jid)
    tmp(`h${i}b`, `${hub.name}–${s.name} yolu`, 'road', jid, s.id)
  })
  // ring roads between neighbouring spokes
  for (let i = 1; i < sts.length - 1; i++) tmp(`ring${i}`, `${sts[i].name}–${sts[i + 1].name} orman yolu`, 'forest', sts[i].id, sts[i + 1].id)
  // stations at hub and two next-largest settlements
  sts.slice(0, 3).forEach((s, i) => {
    const sid = `st${i}`
    nodes.push(node(sid, `${s.name} İtfaiye İstasyonu`, [s.pos[0] + 0.0035, s.pos[1] - 0.003], 'station'))
    tmp(`stl${i}`, 'İstasyon bağlantısı', 'road', sid, s.id, [])
  })
  nodes.push(node('safe0', `${hub.name} toplanma alanı`, [hub.pos[0] - 0.004, hub.pos[1] + 0.004], 'safe'))
  tmp('safel0', 'Toplanma yolu', 'road', hub.id, 'safe0', [])
  const sf = sts[1]
  nodes.push(node('safe1', `${sf.name} toplanma alanı`, [sf.pos[0] - 0.004, sf.pos[1] + 0.003], 'safe'))
  tmp('safel1', 'Toplanma yolu', 'road', sf.id, 'safe1', [])

  const kinds: WaterSource['kind'][] = ['reservoir', 'pond', 'stream', 'reservoir']
  const water: WaterSource[] = kinds.map((k, i) => ({
    id: `w${i}`,
    name: `${sts[i % sts.length].name} ${k === 'reservoir' ? 'göleti' : k === 'pond' ? 'havuzu' : 'deresi'}`,
    pos: [sts[i % sts.length].pos[0] + (hash3(region.seed, 40 + i, 1) - 0.5) * 0.03, sts[i % sts.length].pos[1] + (hash3(region.seed, 40 + i, 2) - 0.5) * 0.03],
    kind: k,
    note: 'Örnek su noktası',
  }))
  return { nodes, edges, water }
}

const cache = new Map<string, Infrastructure>()
export function getInfrastructure(region: Region): Infrastructure {
  let v = cache.get(region.id)
  if (!v) {
    v = bakedInfrastructure(region.id) ?? proceduralInfrastructure(region)
    // existing fire ponds and water tanks (OSM, existingMeasures.json) are water points too
    const ponds = existingFor(region.id).ponds.filter((p) => !v!.water.some((w) => haversineM(w.pos, p.pos) < 150))
    v = { ...v, water: [...v.water, ...ponds.map((p, i) => ({ id: `mevcut-havuz-${i + 1}`, name: p.name, pos: p.pos, kind: 'pond' as const, note: `Mevcut önlem (${p.source})` }))] }
    cache.set(region.id, v)
  }
  return v
}
