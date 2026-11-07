import { REGIONS, defaultConfig } from '../src/data/regions'
import { buildGrid } from '../src/sim/terrain'
import { runSimulation } from '../src/sim/engine'

for (const r of REGIONS.slice(0, 1)) {
  const grid = buildGrid(r.id, r.center, r.seed, r.settlements)
  const kinds = [0, 0, 0, 0, 0]
  for (const k of grid.kind) kinds[k]++
  console.log(r.name, 'cover cells', kinds)
  const base = defaultConfig(r)
  const cases = {
    demo: base,
    A: { ...base, windSpeedKmh: 15, humidityPct: 45, temperatureC: 28 },
    B: { ...base, windSpeedKmh: 35, humidityPct: 18, temperatureC: 37 },
    rain: { ...base, precipMmH: 4, humidityPct: 80, windSpeedKmh: 8 },
  }
  for (const [name, cfg] of Object.entries(cases)) {
    const t0 = performance.now()
    const a = runSimulation(grid, cfg, r.settlements)
    const b = runSimulation(grid, cfg, r.settlements)
    const same = a.ignitionStep.every((v, i) => v === b.ignitionStep[i])
    const f = a.series[a.series.length - 1]
    console.log(name, 'ms', Math.round(performance.now() - t0), 'deterministic', same,
      'ha@3h', Math.round(a.series[18].affectedHa), 'ha@6h', Math.round(a.series[36].affectedHa), 'ha@12h', Math.round(f.affectedHa),
      'perim', f.perimeterKm.toFixed(1), 'ros', Math.round(f.rosMh), 'hdg', f.headingDeg?.toFixed(0))
    console.log('  impacts', a.impacts.map((i, k) => `${r.settlements[k].name}:${i.arrivalMin === null ? '-' : (i.arrivalMin / 60).toFixed(1) + 'h'}`).join(' '))
  }
}

import { getInfrastructure } from '../src/data/infrastructure'
import { buildResponsePlan } from '../src/sim/planner'
{
  const r = REGIONS[0]
  const grid = buildGrid(r.id, r.center, r.seed, r.settlements)
  const res = runSimulation(grid, defaultConfig(r), r.settlements)
  const plan = buildResponsePlan(res, getInfrastructure(r), r.settlements)
  console.log('target', plan.target.name)
  for (const [k, p] of [['primary', plan.primary], ['alt', plan.alternative]] as const)
    console.log(k, p && `${p.from.name} → ${p.to.name} ${p.distanceKm.toFixed(1)}km ${p.etaMin.toFixed(0)}min blocked=${p.blockedEdges.length} via ${p.names.join(', ')}`)
  console.log('evac', plan.evacuations.map((e) => `${e.settlement.name}→${e.route.to.name} ${e.route.etaMin.toFixed(0)}min blocked=${e.route.blockedEdges.length}`))
  console.log('danger', plan.dangerous.map((d) => `${d.edge.id}@${(d.fireMin / 60).toFixed(1)}h`).join(' '))
  console.log('water', plan.water.map((w) => `${w.source.name}:${w.distanceKm.toFixed(1)}km:${w.compromisedAtMin}`))
  for (const r2 of REGIONS.slice(1)) {
    const g2 = buildGrid(r2.id, r2.center, r2.seed, r2.settlements)
    const s2 = runSimulation(g2, defaultConfig(r2), r2.settlements)
    const p2 = buildResponsePlan(s2, getInfrastructure(r2), r2.settlements)
    console.log(r2.name, 'ha12h', Math.round(s2.series.at(-1)!.affectedHa), 'primary', p2.primary && Math.round(p2.primary.etaMin), 'alt', p2.alternative && Math.round(p2.alternative.etaMin), 'evac', p2.evacuations.length, 'threat', p2.threatened.length)
  }
}
