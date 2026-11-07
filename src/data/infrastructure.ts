import type { LatLon } from '../sim/geo'
import { polylineLengthM } from '../sim/geo'
import { hash3 } from '../sim/rng'
import type { Region } from './regions'

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

/** Hand-authored sample network for the Marmaris demo. Positions are approximate and for illustration only. */
function marmarisInfrastructure(): Infrastructure {
  const nodes: NetNode[] = [
    node('marmaris', 'Marmaris', [36.8545, 28.273], 'settlement'),
    node('armutalan', 'Armutalan', [36.8815, 28.2605], 'settlement'),
    node('siteler', 'Siteler', [36.892, 28.298], 'settlement'),
    node('beldibi', 'Beldibi', [36.8655, 28.2125], 'settlement'),
    node('icmeler', 'İçmeler', [36.8195, 28.2375], 'settlement'),
    node('st_marmaris', 'Marmaris İtfaiye İstasyonu', [36.856, 28.265], 'station'),
    node('st_armutalan', 'Armutalan İtfaiye İstasyonu', [36.885, 28.27], 'station'),
    node('st_ogm', 'Orman İşletme Marmaris Şefliği', [36.87, 28.305], 'station'),
    node('st_icmeler', 'İçmeler Yangın Noktası', [36.824, 28.24], 'station'),
    node('gate1', 'Beldibi orman girişi', [36.8855, 28.2155], 'access'),
    node('gate2', 'Kuzey orman girişi', [36.8995, 28.27], 'access'),
    node('ridge', 'Sırt kavşağı', [36.884, 28.236], 'access'),
    node('d400n', 'D400 kuzey kavşağı', [36.905, 28.248], 'access'),
    node('safe_marmaris', 'Marmaris sahil toplanma alanı', [36.8505, 28.279], 'safe'),
    node('safe_icmeler', 'İçmeler plaj toplanma alanı', [36.8165, 28.2425], 'safe'),
  ]
  const e = (...a: Parameters<typeof edge> extends [unknown, ...infer R] ? R : never) => edge(nodes, ...(a as [string, string, RoadType, string, string, LatLon[]?]))
  const edges: NetEdge[] = [
    e('d400-a', 'D400 Muğla yolu', 'highway', 'd400n', 'armutalan', [[36.895, 28.254]]),
    e('d400-b', 'D400 Muğla yolu', 'highway', 'armutalan', 'marmaris', [[36.871, 28.267]]),
    e('beldibi-rd', 'Beldibi yolu', 'road', 'marmaris', 'beldibi', [[36.86, 28.245], [36.863, 28.228]]),
    e('forest-a', 'Beldibi orman yolu', 'forest', 'beldibi', 'gate1', [[36.872, 28.213]]),
    e('forest-b', 'Sırt orman yolu', 'forest', 'gate1', 'ridge', [[36.885, 28.225]]),
    e('ridge-a', 'Sırt yolu', 'forest', 'ridge', 'armutalan', [[36.883, 28.248]]),
    e('ridge-b', 'Sırt yolu', 'forest', 'ridge', 'd400n', [[36.895, 28.24]]),
    e('coast', 'Sahil yolu', 'highway', 'marmaris', 'icmeler', [[36.847, 28.26], [36.835, 28.248]]),
    e('inland', 'İçmeler iç yolu', 'road', 'beldibi', 'icmeler', [[36.85, 28.213], [36.83, 28.225]]),
    e('siteler-a', 'Siteler yolu', 'road', 'marmaris', 'siteler', [[36.862, 28.285], [36.878, 28.293]]),
    e('siteler-b', 'Kuzey orman yolu', 'forest', 'siteler', 'gate2', [[36.896, 28.285]]),
    e('siteler-c', 'Kuzey orman yolu', 'forest', 'gate2', 'd400n', [[36.904, 28.26]]),
    e('st1', 'İstasyon bağlantısı', 'road', 'st_marmaris', 'marmaris'),
    e('st2', 'İstasyon bağlantısı', 'road', 'st_armutalan', 'armutalan'),
    e('st3', 'Orman işletme yolu', 'road', 'st_ogm', 'siteler', [[36.88, 28.3]]),
    e('st3b', 'Orman işletme yolu', 'road', 'st_ogm', 'marmaris', [[36.862, 28.29]]),
    e('st4', 'İstasyon bağlantısı', 'road', 'st_icmeler', 'icmeler'),
    e('safe1', 'Sahil kordonu', 'road', 'marmaris', 'safe_marmaris'),
    e('safe2', 'Plaj yolu', 'road', 'icmeler', 'safe_icmeler'),
  ]
  const water: WaterSource[] = [
    { id: 'w1', name: 'Marmaris Koyu (deniz alımı)', pos: [36.839, 28.285], kind: 'sea', note: 'Sınırsız – helikopter ve tekne ile su alımı' },
    { id: 'w2', name: 'Armutalan göleti', pos: [36.8905, 28.2475], kind: 'reservoir', note: 'Örnek: ~4.000 m³ depolama tankı' },
    { id: 'w3', name: 'Beldibi kaynak havuzu', pos: [36.876, 28.23], kind: 'pond', note: 'Örnek: mevsimlik, helikopterle erişilebilir' },
    { id: 'w4', name: 'İçmeler dere havuzu', pos: [36.828, 28.2175], kind: 'stream', note: 'Örnek: yazın düşük debi' },
    { id: 'w5', name: 'Siteler yangın tankı', pos: [36.894, 28.3], kind: 'reservoir', note: 'Örnek: ~1.200 m³ beton tank' },
  ]
  return { nodes, edges, water }
}

/** Procedural sample network for the other regions: hub-and-spoke roads with gentle wiggles. */
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
    v = region.id === 'mugla' ? marmarisInfrastructure() : proceduralInfrastructure(region)
    cache.set(region.id, v)
  }
  return v
}
