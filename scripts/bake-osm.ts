/**
 * Bakes settlements, the road network, fire stations, assembly points and water sources of every region from
 * OpenStreetMap (© OpenStreetMap contributors, ODbL) via the Overpass API.
 *
 * Roads are turned into a small graph: vertices only where roads meet or end, short dead-end spurs pruned, chains of
 * the same road merged, only the largest connected piece kept. Settlements, stations and assembly points are joined to
 * the nearest vertex with a short link edge so the planner can route from and to them.
 *
 * Needs src/data/landcover.generated.ts (run `npm run bake:landcover` first).
 * Output: src/data/osm.generated.ts. Run with `npm run bake:osm`.
 */
import { writeFileSync } from 'node:fs'
import { REGIONS } from '../src/data/regions'
import { LANDCOVER } from '../src/data/landcover.generated'
import { CELL_M, GRID_COLS, GRID_ROWS } from '../src/sim/terrain'
import { haversineM } from '../src/sim/geo'
import type { BakedEdge, BakedLatLon, BakedNode, BakedRegion, BakedSettlement, BakedWater } from '../src/data/baked'

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const STATION_SEARCH_KM = 30
const MAX_SETTLEMENTS = 6

/** Town populations where the OSM tag holds the whole district (sample-era figures, approximate). */
const KNOWN_POP: Record<string, number> = { Marmaris: 35000, Seferihisar: 18000, Kemer: 12000, Edremit: 50000 }

type Bbox = [number, number, number, number] // s, w, n, e
const bboxStr = (b: Bbox) => b.map((v) => v.toFixed(5)).join(',')
const r5 = (v: number) => Math.round(v * 1e5) / 1e5
const pt = (lat: number, lon: number): BakedLatLon => [r5(lat), r5(lon)]

async function overpass(query: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'forestguard-bake-script' },
    })
    if (res.ok) return res.json()
    console.log(`  overpass ${res.status}, retrying`)
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
  }
  throw new Error('Overpass failed')
}

const slug = (s: string) =>
  s
    .toLocaleLowerCase('tr')
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

function gridOf(center: [number, number]) {
  const dLat = CELL_M / 111320
  const dLon = CELL_M / (111320 * Math.cos((center[0] * Math.PI) / 180))
  const lat0 = center[0] + (GRID_ROWS * dLat) / 2
  const lon0 = center[1] - (GRID_COLS * dLon) / 2
  const cellOf = (lat: number, lon: number) => {
    const c = Math.floor((lon - lon0) / dLon)
    const r = Math.floor((lat0 - lat) / dLat)
    return c < 0 || r < 0 || c >= GRID_COLS || r >= GRID_ROWS ? -1 : r * GRID_COLS + c
  }
  const centerOf = (i: number): BakedLatLon => [lat0 - ((i / GRID_COLS | 0) + 0.5) * dLat, lon0 + ((i % GRID_COLS) + 0.5) * dLon]
  const bbox: Bbox = [lat0 - GRID_ROWS * dLat, lon0, lat0, lon0 + GRID_COLS * dLon]
  return { cellOf, centerOf, bbox }
}

function expand(b: Bbox, km: number): Bbox {
  const dLat = km / 111.32
  const dLon = km / (111.32 * Math.cos((((b[0] + b[2]) / 2) * Math.PI) / 180))
  return [b[0] - dLat, b[1] - dLon, b[2] + dLat, b[3] + dLon]
}

/** Douglas–Peucker in a local metric frame; keeps both ends. */
function simplify(geom: BakedLatLon[], tolM: number): BakedLatLon[] {
  if (geom.length < 3) return geom
  const k = Math.cos((geom[0][0] * Math.PI) / 180) * 111320
  const xy = geom.map(([la, lo]) => [lo * k, la * 111320])
  const keep = new Uint8Array(geom.length)
  keep[0] = keep[geom.length - 1] = 1
  const stack: [number, number][] = [[0, geom.length - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    const [x1, y1] = xy[i]
    const [x2, y2] = xy[j]
    const L = Math.hypot(x2 - x1, y2 - y1) || 1
    let far = -1
    let fd = tolM
    for (let m = i + 1; m < j; m++) {
      const d = Math.abs((x2 - x1) * (y1 - xy[m][1]) - (x1 - xy[m][0]) * (y2 - y1)) / L
      if (d > fd) { fd = d; far = m }
    }
    if (far >= 0) {
      keep[far] = 1
      stack.push([i, far], [far, j])
    }
  }
  return geom.filter((_, i) => keep[i])
}

const ROAD_TYPE =(hw: string): BakedEdge['type'] =>
  /^(motorway|trunk|primary|secondary)(_link)?$/.test(hw) ? 'highway' : hw === 'track' ? 'forest' : 'road'
const FALLBACK_NAME = { highway: 'İsimsiz ana yol', road: 'İsimsiz yol', forest: 'Orman yolu' }

async function bake(region: (typeof REGIONS)[number]): Promise<BakedRegion> {
  const g = gridOf(region.center)
  const kinds = (() => {
    const bin = atob(LANDCOVER[region.id])
    const out = new Uint8Array(GRID_COLS * GRID_ROWS)
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i * 2)
    return out
  })()
  const onLand = (p: BakedLatLon) => {
    const c = g.cellOf(p[0], p[1])
    return c < 0 || kinds[c] !== 0
  }
  const search = expand(g.bbox, STATION_SEARCH_KM)

  // ---------- points of interest ----------
  const poi = await overpass(`[out:json][timeout:120];
(
  nwr["amenity"="fire_station"](${bboxStr(search)});
  node["place"~"^(town|village|suburb|hamlet)$"](${bboxStr(g.bbox)});
  nwr["emergency"="assembly_point"](${bboxStr(expand(g.bbox, 2))});
  nwr["natural"="water"](${bboxStr(g.bbox)});
  nwr["landuse"="reservoir"](${bboxStr(g.bbox)});
);
out tags center qt;`)
  const at = (el: any): BakedLatLon => (el.type === 'node' ? pt(el.lat, el.lon) : pt(el.center.lat, el.center.lon))
  const els: any[] = poi.elements

  // settlements
  const RANK: Record<string, number> = { town: 0, village: 1, suburb: 2, hamlet: 3 }
  const places = els
    .filter((e) => e.tags?.place && e.tags.name && e.type === 'node')
    .map((e) => ({ name: (e.tags['name:tr'] ?? e.tags.name) as string, pos: at(e), rank: RANK[e.tags.place], pop: Number(e.tags.population) || 0 }))
    .filter((p) => onLand(p.pos))
    .sort((a, b) => a.rank - b.rank || b.pop - a.pop)
  const chosen: typeof places = []
  for (const p of places) {
    if (chosen.length >= MAX_SETTLEMENTS) break
    if (chosen.some((c) => haversineM(c.pos, p.pos) < 1500)) continue
    chosen.push(p)
  }
  const builtRadius = (pos: BakedLatLon) => {
    // built-up cells within 1.5 km that connect to the place, as an equal-area circle
    const start = g.cellOf(pos[0], pos[1])
    if (start < 0) return 250
    let seed = -1
    let best = Infinity
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const r = (start / GRID_COLS | 0) + dy
        const c = (start % GRID_COLS) + dx
        if (r < 0 || c < 0 || r >= GRID_ROWS || c >= GRID_COLS) continue
        const i = r * GRID_COLS + c
        if (kinds[i] === 1 && dx * dx + dy * dy < best) { best = dx * dx + dy * dy; seed = i }
      }
    if (seed < 0) return 250
    const seen = new Set([seed])
    const queue = [seed]
    while (queue.length) {
      const i = queue.pop()!
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const r = (i / GRID_COLS | 0) + dy
        const c = (i % GRID_COLS) + dx
        if (r < 0 || c < 0 || r >= GRID_ROWS || c >= GRID_COLS) continue
        const j = r * GRID_COLS + c
        if (seen.has(j) || kinds[j] !== 1 || haversineM(g.centerOf(j), pos) > 1500) continue
        seen.add(j)
        queue.push(j)
      }
    }
    return Math.round(Math.min(1600, Math.max(250, Math.sqrt((seen.size * CELL_M * CELL_M) / Math.PI))))
  }
  const settlements: BakedSettlement[] = chosen.map((p) => {
    const radiusM = builtRadius(p.pos)
    const estimate = Math.max(200, Math.round((Math.PI * radiusM * radiusM) / (CELL_M * CELL_M) * 45 / 100) * 100)
    const population = KNOWN_POP[p.name] ?? (p.rank > 0 && p.pop > 0 && p.pop < 60000 ? p.pop : estimate)
    return { id: slug(p.name), name: p.name, pos: p.pos, population, radiusM }
  })

  // stations: everything inside the grid, then the nearest outside until there are three (at most five)
  const stationEls = els
    .filter((e) => e.tags?.amenity === 'fire_station')
    .map((e) => ({ name: (e.tags.name as string) ?? 'İtfaiye istasyonu', pos: at(e), d: haversineM(at(e), region.center), inside: g.cellOf(at(e)[0], at(e)[1]) >= 0 }))
    .sort((a, b) => a.d - b.d)
  const stations = [...stationEls.filter((s) => s.inside).slice(0, 4)]
  for (const s of stationEls) if (stations.length < 3 && !stations.includes(s)) stations.push(s)

  // assembly points near the chosen settlements
  const assembly = els
    .filter((e) => e.tags?.emergency === 'assembly_point')
    .map((e) => ({ name: (e.tags.name as string) ?? 'Toplanma alanı', pos: at(e) }))
  const safes: { name: string; pos: BakedLatLon }[] = []
  for (const s of settlements.slice(0, 4)) {
    const near = assembly.filter((a) => !safes.includes(a)).sort((a, b) => haversineM(a.pos, s.pos) - haversineM(b.pos, s.pos))[0]
    if (near && haversineM(near.pos, s.pos) < 3000) safes.push(near)
  }
  if (safes.length === 0) for (const s of settlements.slice(0, 2)) safes.push({ name: `${s.name} toplanma alanı (tahmini)`, pos: s.pos })

  // water sources
  const WATER_KIND: Record<string, BakedWater['kind']> = { reservoir: 'reservoir', lake: 'reservoir', pond: 'pond', basin: 'pond', river: 'stream', stream: 'stream', canal: 'stream' }
  const NOTE: Record<BakedWater['kind'], string> = {
    sea: 'Sınırsız – helikopter ve tekne ile su alımı',
    reservoir: 'OSM: gölet / baraj, kapasite bilinmiyor',
    pond: 'OSM: havuz, kapasite bilinmiyor',
    stream: 'OSM: akarsu, yazın debi düşük olabilir',
  }
  const waterEls = els
    .filter((e) => e.tags?.natural === 'water' || e.tags?.landuse === 'reservoir')
    .map((e) => ({ name: (e.tags['name:tr'] ?? e.tags.name) as string | undefined, pos: at(e), kind: e.tags.landuse === 'reservoir' ? 'reservoir' : WATER_KIND[e.tags.water] ?? 'pond' }))
    .filter((w) => w.kind !== 'stream' || w.name)
    .sort((a, b) => Number(!!b.name) - Number(!!a.name))
  // unnamed ponds only fill up a short list
  const namedCount = waterEls.filter((w) => w.name).length
  waterEls.splice(namedCount >= 3 ? namedCount : 5)
  const water: BakedWater[] = waterEls.map((w, i) => ({
    id: `w${i}`,
    name: w.name ?? `İsimsiz ${w.kind === 'reservoir' ? 'gölet' : w.kind === 'stream' ? 'dere' : 'havuz'}`,
    pos: w.pos,
    kind: w.kind as BakedWater['kind'],
    note: NOTE[w.kind as BakedWater['kind']],
  }))
  // sea: an open-water cell (5×5 all water) nearest the region centre
  if (kinds.reduce((s, k) => s + (k === 0 ? 1 : 0), 0) > 800) {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] !== 0) continue
      const r = i / GRID_COLS | 0
      const c = i % GRID_COLS
      let open = true
      for (let dy = -2; dy <= 2 && open; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const rr = r + dy, cc = c + dx
          if (rr < 0 || cc < 0 || rr >= GRID_ROWS || cc >= GRID_COLS || kinds[rr * GRID_COLS + cc] !== 0) { open = false; break }
        }
      if (!open) continue
      const d = haversineM(g.centerOf(i), region.center)
      if (d < bestD) { bestD = d; best = i }
    }
    if (best >= 0) water.unshift({ id: 'sea', name: 'Deniz (su alım noktası)', pos: pt(...g.centerOf(best)), kind: 'sea', note: NOTE.sea })
  }

  // ---------- roads ----------
  const pois: BakedLatLon[] = [...settlements.map((s) => s.pos), ...stations.map((s) => s.pos), ...safes.map((s) => s.pos)]
  const lats = pois.map((p) => p[0])
  const lons = pois.map((p) => p[1])
  const outer = expand([Math.min(g.bbox[0], ...lats), Math.min(g.bbox[1], ...lons), Math.max(g.bbox[2], ...lats), Math.max(g.bbox[3], ...lons)], 1.5)
  const roadsJson = await overpass(`[out:json][timeout:180];
(
  way["highway"~"^(motorway|trunk|primary|secondary)$"](${bboxStr(outer)});
  way["highway"~"^(tertiary|unclassified|track)$"](${bboxStr(expand(g.bbox, 0.5))});
);
out body;
>;
out skel qt;`)
  const coord = new Map<number, BakedLatLon>()
  const ways: { nodes: number[]; type: BakedEdge['type']; name: string }[] = []
  for (const el of roadsJson.elements) {
    if (el.type === 'node') coord.set(el.id, pt(el.lat, el.lon))
    else if (el.type === 'way') {
      const type = ROAD_TYPE(el.tags.highway)
      ways.push({ nodes: el.nodes, type, name: el.tags['name:tr'] ?? el.tags.name ?? el.tags.ref ?? FALLBACK_NAME[type] })
    }
  }
  const use = new Map<number, number>()
  for (const w of ways) w.nodes.forEach((n, i) => use.set(n, (use.get(n) ?? 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)))

  // split ways at shared nodes
  type E = { id: number; a: number; b: number; type: BakedEdge['type']; name: string; geom: BakedLatLon[]; len: number }
  let edges: E[] = []
  let eid = 0
  const len = (geom: BakedLatLon[]) => geom.slice(1).reduce((s, p, i) => s + haversineM(geom[i], p), 0)
  for (const w of ways) {
    let start = 0
    for (let i = 1; i < w.nodes.length; i++) {
      if (i === w.nodes.length - 1 || (use.get(w.nodes[i]) ?? 0) >= 2) {
        const ids = w.nodes.slice(start, i + 1)
        if (ids.every((n) => coord.has(n)) && ids[0] !== ids[ids.length - 1]) {
          const geom = ids.map((n) => coord.get(n)!)
          edges.push({ id: eid++, a: ids[0], b: ids[ids.length - 1], type: w.type, name: w.name, geom, len: len(geom) })
        }
        start = i
      }
    }
  }

  const adjacency = () => {
    const m = new Map<number, E[]>()
    for (const e of edges) for (const v of [e.a, e.b]) m.set(v, [...(m.get(v) ?? []), e])
    return m
  }

  // keep the largest connected component
  {
    const adj = adjacency()
    const comp = new Map<number, number>()
    const sizes: number[] = []
    for (const v of adj.keys()) {
      if (comp.has(v)) continue
      const k = sizes.length
      let size = 0
      const stack = [v]
      comp.set(v, k)
      while (stack.length) {
        const u = stack.pop()!
        for (const e of adj.get(u)!) {
          size += e.len
          const w = e.a === u ? e.b : e.a
          if (!comp.has(w)) { comp.set(w, k); stack.push(w) }
        }
      }
      sizes.push(size)
    }
    const main = sizes.indexOf(Math.max(...sizes))
    edges = edges.filter((e) => comp.get(e.a) === main)
  }

  // prune short dead-end spurs (not main roads), a few passes
  for (let pass = 0; pass < 4; pass++) {
    const adj = adjacency()
    const before = edges.length
    edges = edges.filter((e) => {
      if (e.type === 'highway' || e.len > 500) return true
      return !((adj.get(e.a)!.length === 1) !== (adj.get(e.b)!.length === 1))
    })
    if (edges.length === before) break
  }

  // merge chains through degree-2 vertices when both sides are the same road
  for (;;) {
    const adj = adjacency()
    let merged = false
    for (const [v, list] of adj) {
      if (list.length !== 2) continue
      const [e1, e2] = list
      if (e1 === e2 || e1.type !== e2.type) continue
      const g1 = e1.b === v ? e1.geom : [...e1.geom].reverse()
      const g2 = e2.a === v ? e2.geom : [...e2.geom].reverse()
      const a = e1.b === v ? e1.a : e1.b
      const b = e2.a === v ? e2.b : e2.a
      if (a === b) continue
      const geom = [...g1, ...g2.slice(1)]
      edges = edges.filter((e) => e !== e1 && e !== e2)
      edges.push({ id: eid++, a, b, type: e1.type, name: e1.len >= e2.len ? e1.name : e2.name, geom, len: e1.len + e2.len })
      merged = true
      break
    }
    if (!merged) break
  }

  // ---------- graph out ----------
  const vertexIds = new Set<number>()
  for (const e of edges) { vertexIds.add(e.a); vertexIds.add(e.b) }
  const nodes: BakedNode[] = [...vertexIds].map((v) => ({ id: `v${v}`, name: 'Kavşak', pos: coord.get(v)!, kind: 'junction' }))
  const outEdges: BakedEdge[] = edges.map((e, i) => ({ id: `e${i}`, name: e.name, type: e.type, from: `v${e.a}`, to: `v${e.b}`, geom: simplify(e.geom, 20) }))
  const nearestVertex = (p: BakedLatLon, preferLocal = false) => {
    let best = nodes[0]
    let bd = Infinity
    for (const n of nodes) {
      if (n.kind !== 'junction') continue
      const d = haversineM(n.pos, p) * (preferLocal ? 1 : 1)
      if (d < bd) { bd = d; best = n }
    }
    return best
  }
  let link = 0
  const attach = (id: string, name: string, pos: BakedLatLon, kind: BakedNode['kind'], linkName: string) => {
    const v = nearestVertex(pos)
    nodes.push({ id, name, pos, kind })
    outEdges.push({ id: `l${link++}`, name: linkName, type: 'road', from: id, to: v.id, geom: [pos, v.pos] })
  }
  for (const s of settlements) attach(s.id, s.name, s.pos, 'settlement', 'Yerleşim bağlantısı')
  stations.forEach((s, i) => attach(`st${i}`, s.name, s.pos, 'station', 'İstasyon bağlantısı'))
  safes.forEach((s, i) => attach(`safe${i}`, s.name, s.pos, 'safe', 'Toplanma alanı bağlantısı'))

  const km = outEdges.reduce((s, e) => s + len(e.geom), 0) / 1000
  console.log(`  ${region.id}: ${settlements.length} settlements (${settlements.map((s) => s.name).join(', ')}), ${stations.length} stations, ${safes.length} safe, ${water.length} water, ${nodes.length} nodes, ${outEdges.length} edges, ${km.toFixed(0)} km`)
  return { settlements, nodes, edges: outEdges, water }
}

const out: Record<string, BakedRegion> = {}
for (const r of REGIONS) {
  console.log(`baking ${r.id}`)
  out[r.id] = await bake(r)
  await new Promise((res) => setTimeout(res, 2000))
}
writeFileSync(
  new URL('../src/data/osm.generated.ts', import.meta.url),
  `// GENERATED by scripts/bake-osm.ts – do not edit.\n// © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).\nimport type { BakedRegion } from './baked'\n\nexport const OSM: Record<string, BakedRegion> = ${JSON.stringify(out)}\n`,
)
console.log('wrote src/data/osm.generated.ts')
