/**
 * Bakes the fire protection that already exists in every region from OpenStreetMap (© OpenStreetMap contributors,
 * ODbL) via the Overpass API:
 * - roads of every class, rasterised onto the simulation grid (a road is a gap in the fuel: the engine treats it as a
 *   partial fuel break, stronger for wide roads),
 * - fire lookout and observation towers,
 * - fire ponds, water tanks and suction points,
 * - mapped fire breaks ("yangın emniyet yolu / şeridi").
 * How much of this is mapped varies a lot by area; the editable src/data/existingMeasures.json adds what OSM lacks.
 *
 * Output: src/data/existing.generated.ts. Run with `npm run bake:existing` (optionally with area ids, merged).
 */
import { existsSync, writeFileSync } from 'node:fs'
import { REGIONS } from '../src/data/regions'
import { getGrid } from '../src/sim/gridCache'
import { cellOf } from '../src/sim/terrain'
import type { BakedExisting } from '../src/data/baked'

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const ONLY = process.argv.slice(2)
const AREAS = ONLY.length ? REGIONS.filter((r) => ONLY.includes(r.id)) : REGIONS
const r5 = (v: number) => Math.round(v * 1e5) / 1e5

async function overpass(query: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'forestguard-bake-script' },
    })
    if (res.ok) return res.json()
    console.log(`  overpass ${res.status}, retrying`)
    await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)))
  }
  throw new Error('Overpass failed')
}

/** Road class: 3 motorway/trunk/primary, 2 secondary/tertiary, 1 minor and forest tracks. */
const roadClass = (hw: string) => (/^(motorway|trunk|primary)(_link)?$/.test(hw) ? 3 : /^(secondary|tertiary)(_link)?$/.test(hw) ? 2 : 1)

async function bake(region: (typeof REGIONS)[number]): Promise<BakedExisting> {
  const g = getGrid(region.id)
  const bb = [g.lat0 - g.rows * g.dLat, g.lon0, g.lat0, g.lon0 + g.cols * g.dLon].map((v) => v.toFixed(5)).join(',')
  const q = `[out:json][timeout:180];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track)(_link)?$"](${bb});
  nwr["man_made"="tower"]["tower:type"~"observation|fire_lookout|firewatch|watchtower"](${bb});
  nwr["man_made"~"tower|watchtower"]["name"~"[Gg]özetleme|[Yy]angın|[Kk]ule"](${bb});
  nwr["emergency"~"^(fire_lookout|fire_water_pond|water_tank|suction_point)$"](${bb});
  nwr["name"~"[Yy]angın ([Hh]avuz|[Gg]ölet|[Ss]u [Dd]epo)"](${bb});
  way["man_made"="firebreak"](${bb});
  way["firebreak"](${bb});
  way["landuse"="firebreak"](${bb});
  way["name"~"([Yy]angın|[Ee]mniyet) ([Ee]mniyet )?([Yy]olu|[Şş]eridi)"](${bb});
);
out geom;`
  const j = await overpass(q)
  const n = g.cols * g.rows
  const roads = new Uint8Array(n)
  const out: BakedExisting = { roads: '', towers: [], ponds: [], firebreaks: [] }
  const posOf = (e: any): [number, number] | null => {
    if (e.type === 'node') return [r5(e.lat), r5(e.lon)]
    if (e.geometry?.length) {
      const la = e.geometry.reduce((s: number, p: any) => s + p.lat, 0) / e.geometry.length
      const lo = e.geometry.reduce((s: number, p: any) => s + p.lon, 0) / e.geometry.length
      return [r5(la), r5(lo)]
    }
    return null
  }
  for (const e of j.elements as any[]) {
    const t = e.tags ?? {}
    const name = (t['name:tr'] ?? t.name) as string | undefined
    const geom: [number, number][] = e.geometry ? e.geometry.map((p: any) => [r5(p.lat), r5(p.lon)]) : []
    const isBreak = t.man_made === 'firebreak' || t.firebreak || t.landuse === 'firebreak' || /(yangın|emniyet) (emniyet )?(yolu|şeridi)/i.test(name ?? '')
    if (isBreak && geom.length > 1) {
      out.firebreaks.push({ name: name ?? 'Yangın emniyet şeridi (OSM)', geom, widthM: Number(t.width) || 0 })
      continue
    }
    if (t.highway && geom.length > 1) {
      const cls = roadClass(t.highway)
      // sample the line every ~30 m
      for (let k = 1; k < geom.length; k++) {
        const [a, b] = [geom[k - 1], geom[k]]
        const steps = Math.max(1, Math.ceil(Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180)) / 30))
        for (let s = 0; s <= steps; s++) {
          const c = cellOf(g, a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps)
          if (c >= 0 && roads[c] < cls) roads[c] = cls
        }
      }
      continue
    }
    const p = posOf(e)
    if (!p || cellOf(g, p[0], p[1]) < 0) continue
    if (t.man_made === 'tower' || t.man_made === 'watchtower' || t.emergency === 'fire_lookout') out.towers.push({ name: name ?? 'Gözetleme kulesi (OSM)', pos: p })
    else out.ponds.push({ name: name ?? (t.emergency === 'water_tank' ? 'Yangın su deposu (OSM)' : 'Yangın havuzu (OSM)'), pos: p, kind: t.emergency === 'water_tank' ? 'tank' : 'pond' })
  }
  out.roads = Buffer.from(roads).toString('base64')
  const cnt = [0, 0, 0, 0]
  for (const v of roads) cnt[v]++
  console.log(`  ${region.id}: road cells minor ${cnt[1]}, medium ${cnt[2]}, major ${cnt[3]}; towers ${out.towers.length}, ponds ${out.ponds.length}, fire breaks ${out.firebreaks.length}`)
  return out
}

const FILE = new URL('../src/data/existing.generated.ts', import.meta.url)
const result: Record<string, BakedExisting> = ONLY.length && existsSync(FILE) ? { ...(await import('../src/data/existing.generated')).EXISTING } : {}
for (const r of AREAS) {
  console.log(`baking ${r.id}`)
  result[r.id] = await bake(r)
  await new Promise((res) => setTimeout(res, 2000))
}
writeFileSync(
  FILE,
  `// GENERATED by scripts/bake-existing.ts – do not edit.\n// Roads, lookout towers, fire ponds and fire breaks from © OpenStreetMap contributors (ODbL), via Overpass.\n// roads: base64, one byte per grid cell: 0 none, 1 minor road / forest track, 2 secondary, 3 major.\nimport type { BakedExisting } from './baked'\nexport const EXISTING: Record<string, BakedExisting> = ${JSON.stringify(result)}\n`,
)
console.log('wrote src/data/existing.generated.ts')
