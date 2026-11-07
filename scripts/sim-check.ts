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
  console.log('danger', plan.dangerous.length, 'edges; first', plan.dangerous.slice(0, 8).map((d) => `${d.edge.name}@${(d.fireMin / 60).toFixed(1)}h`).join(', '))
  console.log('water', plan.water.map((w) => `${w.source.name}:${w.distanceKm.toFixed(1)}km:${w.compromisedAtMin}`))
  for (const r2 of REGIONS.slice(1)) {
    const g2 = buildGrid(r2.id, r2.center, r2.seed, r2.settlements)
    const s2 = runSimulation(g2, defaultConfig(r2), r2.settlements)
    const p2 = buildResponsePlan(s2, getInfrastructure(r2), r2.settlements)
    console.log(r2.name, 'ha12h', Math.round(s2.series.at(-1)!.affectedHa), 'primary', p2.primary && Math.round(p2.primary.etaMin), 'alt', p2.alternative && Math.round(p2.alternative.etaMin), 'evac', p2.evacuations.length, 'threat', p2.threatened.length)
  }
}

// ---- Faz 1 gate: real data lines up with the land-cover grid ----
import { getGrid } from '../src/sim/gridCache'
import { cellOf } from '../src/sim/terrain'
import { densify } from '../src/sim/geo'
import { SIMULATED_FIRES } from '../src/data/regions'
{
  const KIND = ['su', 'yapılaşma', 'seyrek', 'maki', 'orman']
  const fails: string[] = []
  for (const r of REGIONS) {
    const g = getGrid(r.id)
    const kindAt = (p: [number, number]) => {
      const c = cellOf(g, p[0], p[1])
      return c < 0 ? -1 : g.kind[c]
    }
    for (const s of r.settlements) if (kindAt(s.pos) === 0) fails.push(`${r.id}: yerleşim ${s.name} suda`)
    const ig = kindAt(r.defaultIgnition)
    if (ig < 2) fails.push(`${r.id}: varsayılan tutuşma noktası ${ig < 0 ? 'ızgara dışında' : KIND[ig]}`)
    for (const f of SIMULATED_FIRES.filter((f) => f.areaId === r.id)) if (kindAt(f.pos) === 0) fails.push(`${r.id}: örnek yangın ${f.name} suda`)
    // road length on water cells; coastal roads and bridges may graze a 110 m water cell, so allow 2 %
    let total = 0
    let wet = 0
    for (const e of getInfrastructure(r).edges) {
      const pts = densify(e.geom, 40)
      for (let i = 1; i < pts.length; i++) {
        const k = kindAt(pts[i])
        if (k < 0) continue
        total++
        if (k === 0) wet++
      }
    }
    const pct = total ? (wet / total) * 100 : 0
    if (pct > 2) fails.push(`${r.id}: yol uzunluğunun %${pct.toFixed(1)}'i su hücresinde`)
    const t0 = performance.now()
    const plan = buildResponsePlan(runSimulation(g, defaultConfig(r), r.settlements), getInfrastructure(r), r.settlements)
    console.log(`gate ${r.id}: yerleşim ${r.settlements.length}, yolun suda kalan payı %${pct.toFixed(2)}, tutuşma ${KIND[ig] ?? 'dışarıda'}, plan ${Math.round(performance.now() - t0)} ms, birincil ${plan.primary ? Math.round(plan.primary.etaMin) + ' dk' : 'yok'}`)
  }
  if (fails.length) {
    console.log('FAZ 1 KAPISI GEÇİLMEDİ:\n  ' + fails.join('\n  '))
    process.exitCode = 1
  } else console.log('Faz 1 kapısı geçildi.')
}

// ---- Faz 2 gate: a wind shift shows in the spread and in the report ----
import { buildReport } from '../src/sim/report'
import { fetchWeather, samplePoints, windShift } from '../src/sim/weather'
import type { WeatherSeries } from '../src/sim/types'
{
  // Çanakkale: inland forest with almost no water or built-up land, so terrain edges do not steer the test
  const r = REGIONS.find((x) => x.id === 'canakkale')!
  const g = getGrid(r.id)
  const H = 7
  const nine = (f: (h: number) => number) => Array.from({ length: 9 }, () => Array.from({ length: H }, (_, h) => f(h)))
  const run = (fromAfter: number) => {
    const weather: WeatherSeries = {
      source: 'custom',
      startIso: '2026-07-28T12:00',
      points: samplePoints(g),
      temperatureC: nine(() => 33),
      humidityPct: nine(() => 25),
      windSpeedKmh: nine(() => 25),
      windFromDeg: nine((h) => (h < 3 ? 315 : fromAfter)), // karayel for 3 h, then the new wind
      precipMmH: nine(() => 0),
    }
    // ignite mid-grid so the grid edge does not steer the result
    const cfg = { ...defaultConfig(r), ignition: [r.center[0] + 0.01, r.center[1] - 0.01] as [number, number], durationH: 6, weather }
    return { cfg, res: runSimulation(g, cfg, r.settlements) }
  }
  // bearing of the area that burns after the shift, seen from the area burned before it
  const growthBearing = (res: ReturnType<typeof runSimulation>) => {
    let ax = 0, ay = 0, an = 0, bx = 0, by = 0, bn = 0
    res.ignitionStep.forEach((t, i) => {
      if (t < 0) return
      const x = i % g.cols
      const y = -((i / g.cols) | 0)
      if (t < 18) { ax += x; ay += y; an++ } else { bx += x; by += y; bn++ }
    })
    return ((Math.atan2(bx / bn - ax / an, by / bn - ay / an) * 180) / Math.PI + 360) % 360
  }
  const diffDeg = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)
  const steady = run(315)
  const shifted = run(45) // poyraz: pushes the fire south-west (225°)
  const bSteady = growthBearing(steady.res)
  const bShift = growthBearing(shifted.res)
  const report = buildReport('rüzgar dönüşü', shifted.res).flatMap((s) => s.lines).join(' ')
  const shift = windShift(shifted.cfg)
  console.log(`gate faz2: dönüşten sonraki büyüme yönü sabit rüzgarda ${bSteady.toFixed(0)}°, dönüşte ${bShift.toFixed(0)}° (beklenen ~225°), dönüş saati ${shift?.hour}, raporda ${report.includes('döndü') ? 'var' : 'yok'}`)
  const fails: string[] = []
  if (diffDeg(bShift, 225) > 60 || diffDeg(bShift, bSteady) < 45) fails.push('rüzgar dönüşü yayılım yönünü beklenen tarafa çevirmedi')
  if (!report.includes('döndü')) fails.push('rapor rüzgar dönüşünü yazmıyor')

  try {
    const m = REGIONS[0]
    const gm = getGrid(m.id)
    const real = await fetchWeather(gm, '2021-07-28T12:00', 12)
    const w = runSimulation(gm, { ...defaultConfig(m), durationH: 12, weather: real }, m.settlements)
    console.log(`gate faz2: Open-Meteo arşivi 2021-07-28 Marmaris: rüzgar ${Math.min(...real.windSpeedKmh[4]).toFixed(0)}–${Math.max(...real.windSpeedKmh[4]).toFixed(0)} km/sa, 12 sa sonunda ${Math.round(w.series.at(-1)!.affectedHa)} ha`)
  } catch (e) {
    console.log(`gate faz2: Open-Meteo erişilemedi, gerçek veri denemesi atlandı (${(e as Error).message})`)
  }
  if (fails.length) {
    console.log('FAZ 2 KAPISI GEÇİLMEDİ:\n  ' + fails.join('\n  '))
    process.exitCode = 1
  } else console.log('Faz 2 kapısı geçildi.')
}

// ---- smoke gate: emissions scale with the fire, smoke goes downwind, report covers people and wildlife ----
import { computeSmoke, pmAt } from '../src/sim/smoke'
{
  const r = REGIONS.find((x) => x.id === 'canakkale')!
  const g = getGrid(r.id)
  const base = { ...defaultConfig(r), ignition: [r.center[0] + 0.01, r.center[1] - 0.01] as [number, number], windFromDeg: 270, windSpeedKmh: 20, durationH: 6 }
  const small = runSimulation(g, { ...base, humidityPct: 45, temperatureC: 25 }, r.settlements)
  const big = runSimulation(g, { ...base, humidityPct: 18, temperatureC: 37 }, r.settlements)
  const sS = computeSmoke(small)
  const sB = computeSmoke(big)
  const haS = small.series.at(-1)!.affectedHa
  const haB = big.series.at(-1)!.affectedHa
  const perHa = sB.co2T.at(-1)! / haB
  // 6 km downwind (east) vs 6 km upwind (west) of the ignition, at the end
  const kmLon = 6 / (111.32 * Math.cos((base.ignition[0] * Math.PI) / 180))
  const down = pmAt(sB, big.steps, base.ignition[0], base.ignition[1] + kmLon)
  const up = pmAt(sB, big.steps, base.ignition[0], base.ignition[1] - kmLon)
  const report = buildReport('duman', big).map((s) => s.title)
  console.log(`gate duman: küçük yangın ${Math.round(haS)} ha -> ${Math.round(sS.co2T.at(-1)!)} t CO2, büyük ${Math.round(haB)} ha -> ${Math.round(sB.co2T.at(-1)!)} t CO2 (${perHa.toFixed(0)} t/ha); rüzgar altı ${down.toFixed(0)} µg/m³, rüzgar üstü ${up.toFixed(1)} µg/m³`)
  const fails: string[] = []
  if (!(haB > haS && sB.co2T.at(-1)! > sS.co2T.at(-1)!)) fails.push('büyük yangın daha çok emisyon üretmiyor')
  if (perHa < 10 || perHa > 150) fails.push(`hektar başına CO2 (${perHa.toFixed(0)} t) makul aralıkta değil`)
  if (!(down > 35 && down > 10 * Math.max(up, 0.1))) fails.push('duman rüzgar altında birikmiyor')
  for (const t of ['Emisyonlar: CO₂, CO ve duman', 'Dumanın insanlara etkisi', 'Yaban hayatına etkisi']) if (!report.includes(t)) fails.push(`raporda "${t}" yok`)
  if (fails.length) {
    console.log('DUMAN KAPISI GEÇİLMEDİ:\n  ' + fails.join('\n  '))
    process.exitCode = 1
  } else console.log('Duman kapısı geçildi.')
  // sample of the new report text for Marmaris
  const m = REGIONS[0]
  const rep = buildReport('demo', runSimulation(getGrid(m.id), defaultConfig(m), m.settlements))
  for (const s of rep.slice(4, 7)) console.log(`\n## ${s.title}\n- ${s.lines.join('\n- ')}`)
}
