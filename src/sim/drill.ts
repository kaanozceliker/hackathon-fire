import COSTS from '../data/drillCosts.json'
import { REGIONS, defaultConfig, regionById } from '../data/regions'
import { getInfrastructure, type Infrastructure } from '../data/infrastructure'
import { getGrid } from './gridCache'
import { fuelOf } from './engine'
import { ResponseRun, ruleCommander, type RunOptions } from './response'
import { existingFor, lineCells } from './existing'
import { cellCenter, cellOf } from './terrain'
import { compass, haversineM, type LatLon } from './geo'
import { hash3 } from './rng'
import type { Grid, Settlement, SimConfig, SimResult } from './types'

/**
 * Tatbikat (drills). Two exams on a real area:
 * 1. Önlem: plan prevention before a fire whose start is hidden; the fire then starts at the most likely ignition
 *    points and the plan is judged on damage avoided, cost and harm to nature.
 * 2. Müdahale: a fire is already burning and reported late; the user commands the response.
 * Costs are approximate (src/data/drillCosts.json).
 */

export type ToolId = 'kule' | 'kamera' | 'serit' | 'aralama' | 'yerlesim' | 'havuz' | 'konuslanma'
export type ToolKind = 'point' | 'line' | 'area' | 'settlement'

export const TOOLS: Record<ToolId, { label: string; kind: ToolKind; color: string; how: string; effect: string }> = {
  kule: { label: 'Gözetleme kulesi', kind: 'point', color: '#ffffff', how: 'Haritada bir tepeye tıklayın.', effect: `Görüş alanındaki (${COSTS.araclar.kule.gorusKm} km) bir yangın ${COSTS.araclar.kule.erkenTespitDk} dk erken fark edilir.` },
  kamera: { label: 'Yangın kamerası', kind: 'point', color: '#c9d4ff', how: 'Haritada bir noktaya tıklayın.', effect: `Daha ucuz, daha kısa görüş (${COSTS.araclar.kamera.gorusKm} km): yangın ${COSTS.araclar.kamera.erkenTespitDk} dk erken fark edilir.` },
  serit: { label: 'Emniyet şeridi', kind: 'line', color: '#f2d03b', how: 'Tıklayarak çizgi çizin, bitirmek için "Bitir"e basın.', effect: 'Şeritte yakıt büyük ölçüde kalkar; rüzgara dik çizilirse yangını yavaşlatır.' },
  aralama: { label: 'Aralama / yakıt azaltma', kind: 'area', color: '#b58cff', how: 'Köşelere tıklayarak alan çizin, "Bitir"e basın.', effect: 'Alandaki yakıt %40 azalır; yangın yavaşlar, taç yangını zorlaşır.' },
  yerlesim: { label: 'Yerleşim çevresi temizliği', kind: 'settlement', color: '#7fd1ff', how: 'Haritada bir yerleşime tıklayın.', effect: 'Yerleşim çevresindeki 150 m kuşakta yakıt %75 azalır.' },
  havuz: { label: 'Yangın havuzu', kind: 'point', color: '#3b9be0', how: 'Haritada bir noktaya tıklayın.', effect: 'Helikopter ve arazözler buradan su alır; uzak su kaynağına gidiş kısalır.' },
  konuslanma: { label: 'Ön konuşlanma noktası', kind: 'point', color: '#ff8a65', how: 'Haritada bir noktaya, tercihen yola yakın tıklayın.', effect: '2 arazöz ve 1 iş makinesi sezon boyunca burada bekler, ilk müdahale erken başlar.' },
}

export const BUDGET_TL = COSTS.butceTL
export const DETECT_MIN = COSTS.ihbarDk
export const COST_NOTE = COSTS._aciklama

/** A measure as the user drew it (or as the optimiser chose it). */
export interface DrillMeasure {
  id: string
  tool: ToolId
  points: LatLon[]
  settlementId?: string
  /** Fire break width in metres. */
  widthM?: number
  /** Cells covered, worked out when placed. */
  cells: number[]
  label?: string
}

export interface MeasureCost {
  tl: number
  natureHa: number
  size: string
}

export const tlFmt = (v: number) => (v >= 1e6 ? `${(v / 1e6).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} M TL` : `${Math.round(v / 1000).toLocaleString('tr-TR')} bin TL`)

function lengthKm(pts: LatLon[]): number {
  let m = 0
  for (let i = 1; i < pts.length; i++) m += haversineM(pts[i - 1], pts[i])
  return m / 1000
}

/** Cells whose centre lies inside a polygon. */
function polygonCells(grid: Grid, poly: LatLon[]): number[] {
  if (poly.length < 3) return []
  let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity
  for (const [la, lo] of poly) {
    la0 = Math.min(la0, la); la1 = Math.max(la1, la); lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo)
  }
  const out: number[] = []
  const r0 = Math.max(0, Math.floor((grid.lat0 - la1) / grid.dLat))
  const r1 = Math.min(grid.rows - 1, Math.ceil((grid.lat0 - la0) / grid.dLat))
  const c0 = Math.max(0, Math.floor((lo0 - grid.lon0) / grid.dLon))
  const c1 = Math.min(grid.cols - 1, Math.ceil((lo1 - grid.lon0) / grid.dLon))
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const i = r * grid.cols + c
      const [y, x] = cellCenter(grid, i)
      let inside = false
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [ya, xa] = poly[a]
        const [yb, xb] = poly[b]
        if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside
      }
      if (inside && grid.kind[i] !== 0) out.push(i)
    }
  return out
}

/** Burnable cells of the 150 m belt around a settlement. */
export function settlementRing(grid: Grid, st: Settlement): number[] {
  const sc = cellOf(grid, st.pos[0], st.pos[1])
  if (sc < 0) return []
  const reach = st.radiusM + COSTS.araclar.yerlesim.halkaM
  const R = Math.ceil(reach / grid.cellM) + 1
  const out: number[] = []
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const x = (sc % grid.cols) + dx
      const y = ((sc / grid.cols) | 0) + dy
      if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue
      const j = y * grid.cols + x
      const d = haversineM(cellCenter(grid, j), st.pos)
      if (d > reach || d < st.radiusM * 0.8 || grid.kind[j] < 2) continue
      out.push(j)
    }
  return out
}

/** Works out the cells of a freshly drawn measure. */
export function measureCellsFor(grid: Grid, m: Omit<DrillMeasure, 'cells'>, settlements: Settlement[]): number[] {
  const t = TOOLS[m.tool].kind
  if (t === 'line') return lineCells(grid, m.points).filter((c) => grid.kind[c] >= 2)
  if (t === 'area') return polygonCells(grid, m.points)
  if (t === 'settlement') {
    const st = settlements.find((s) => s.id === m.settlementId)
    return st ? settlementRing(grid, st) : []
  }
  const c = cellOf(grid, m.points[0][0], m.points[0][1])
  return c >= 0 ? [c] : []
}

/** Cost and harm to nature of one measure. */
export function measureCost(grid: Grid, m: DrillMeasure): MeasureCost {
  const A = COSTS.araclar
  const haC = (grid.cellM * grid.cellM) / 10000
  // forest counts fully, shrub less, open land little
  const vegWeight = (cells: number[]) => cells.reduce((s, c) => s + (grid.kind[c] === 4 ? 1 : grid.kind[c] === 3 ? 0.6 : 0.2), 0) / Math.max(1, cells.length)
  switch (m.tool) {
    case 'kule':
      return { tl: A.kule.kurulumTL + A.kule.sezonTL, natureHa: A.kule.dogaHa, size: `görüş ${A.kule.gorusKm} km` }
    case 'kamera':
      return { tl: A.kamera.kurulumTL + A.kamera.sezonTL, natureHa: A.kamera.dogaHa, size: `görüş ${A.kamera.gorusKm} km` }
    case 'havuz':
      return { tl: A.havuz.kurulumTL, natureHa: A.havuz.dogaHa, size: '500 m³' }
    case 'konuslanma':
      return { tl: A.konuslanma.sezonTL, natureHa: A.konuslanma.dogaHa, size: '2 arazöz, 1 iş makinesi' }
    case 'serit': {
      const km = m.points.length > 1 ? lengthKm(m.points) : (m.cells.length * grid.cellM) / 1000
      const w = (m.widthM ?? 30) / 30
      return { tl: km * (A.serit.kmTL_30m * w + A.serit.bakimKmTL), natureHa: km * A.serit.dogaHaKm_30m * w * vegWeight(m.cells), size: `${km.toFixed(1)} km × ${m.widthM ?? 30} m` }
    }
    case 'aralama': {
      const ha = m.cells.length * haC
      return { tl: ha * A.aralama.haTL, natureHa: ha * A.aralama.dogaHa * vegWeight(m.cells), size: `${Math.round(ha)} ha` }
    }
    case 'yerlesim': {
      const ha = m.cells.length * haC
      return { tl: ha * A.yerlesim.haTL, natureHa: ha * A.yerlesim.dogaHa * vegWeight(m.cells), size: `${Math.round(ha)} ha` }
    }
  }
}

/** Turns a plan into run options and the earlier detection for a fire starting at `ignition`. */
export function planEffects(grid: Grid, plan: DrillMeasure[], ignition: LatLon): { opts: RunOptions; detectGainMin: number; seenBy: string | null } {
  const A = COSTS.araclar
  const mult = new Float32Array(grid.cols * grid.rows).fill(1)
  const lower = (cells: number[], f: number) => {
    for (const c of cells) mult[c] = Math.min(mult[c], f)
  }
  let gain = 0
  let seenBy: string | null = null
  const water: Infrastructure['water'] = []
  const bases: LatLon[] = []
  for (const m of plan) {
    if (m.tool === 'serit') lower(m.cells, Math.max(0.12, 1 - Math.min(1, (m.widthM ?? 30) / grid.cellM) * 0.9))
    else if (m.tool === 'aralama') lower(m.cells, A.aralama.yakitCarpani)
    else if (m.tool === 'yerlesim') lower(m.cells, A.yerlesim.yakitCarpani)
    else if (m.tool === 'kule' || m.tool === 'kamera') {
      const t = A[m.tool]
      if (haversineM(m.points[0], ignition) <= t.gorusKm * 1000 && t.erkenTespitDk > gain) {
        gain = t.erkenTespitDk
        seenBy = TOOLS[m.tool].label
      }
    } else if (m.tool === 'havuz') water.push({ id: `tb-havuz-${water.length + 1}`, name: 'Tatbikat yangın havuzu', pos: m.points[0], kind: 'reservoir', note: 'Tatbikat önlemi' })
    else if (m.tool === 'konuslanma') bases.push(m.points[0])
  }
  return { opts: { fuelMult: mult, extraWater: water, extraBases: bases }, detectGainMin: gain, seenBy }
}

// ---------------------------------------------------------------- scenarios

export interface DrillScenario {
  areaId: string
  seed: number
  config: SimConfig
  /** Exam 1: the most likely ignition points (hidden until the end). Exam 2: [0] is the fire. */
  ignitions: LatLon[]
  /** Exam 2: when the fire was reported, minutes after it started. */
  reportMin: number
}

const rnd = (seed: number, k: number) => hash3(seed, k, 7)

/**
 * The most likely ignition points: dense, dry fuel close to roads and villages (most wildfires are started by
 * people), on slopes, away from the edge of the area so the fire has room to run.
 */
export function riskPoints(grid: Grid, settlements: Settlement[], seed: number, k = 3): LatLon[] {
  const ex = existingFor(grid.areaId)
  const n = grid.cols * grid.rows
  // distance to a road, in cells (breadth-first)
  const dRoad = new Int16Array(n).fill(999)
  const q: number[] = []
  if (ex.roads) for (let i = 0; i < n; i++) if (ex.roads[i]) { dRoad[i] = 0; q.push(i) }
  for (let h = 0; h < q.length; h++) {
    const c = q[h]
    const x = c % grid.cols
    const y = (c / grid.cols) | 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx
      const yy = y + dy
      if (xx < 0 || yy < 0 || xx >= grid.cols || yy >= grid.rows) continue
      const j = yy * grid.cols + xx
      if (dRoad[j] > dRoad[c] + 1) { dRoad[j] = dRoad[c] + 1; q.push(j) }
    }
  }
  const margin = Math.round(Math.min(grid.cols, grid.rows) * 0.15)
  const scored: { i: number; s: number }[] = []
  for (let i = 0; i < n; i++) {
    const x = i % grid.cols
    const y = (i / grid.cols) | 0
    if (x < margin || y < margin || x >= grid.cols - margin || y >= grid.rows - margin) continue
    if (grid.kind[i] < 3) continue
    const f = fuelOf(grid, i, 1)
    if (f < 0.4) continue
    const road = dRoad[i] <= 3 ? 1.6 : dRoad[i] <= 8 ? 1 : 0.55
    const near = settlements.some((st) => haversineM(st.pos, cellCenter(grid, i)) < 3000) ? 1.3 : 1
    scored.push({ i, s: f * road * near * (0.75 + 0.5 * rnd(seed, i)) })
  }
  scored.sort((a, b) => b.s - a.s)
  const out: LatLon[] = []
  for (const { i } of scored) {
    const p = cellCenter(grid, i)
    if (out.every((o) => haversineM(o, p) > 3000)) out.push(p)
    if (out.length >= k) break
  }
  return out
}

/** A random summer fire-weather day on a random area. */
export function newScenario(exam: 1 | 2, seed = Math.floor(Math.random() * 1e9)): DrillScenario {
  const region = REGIONS[Math.floor(rnd(seed, 1) * REGIONS.length)]
  const grid = getGrid(region.id)
  const config: SimConfig = {
    ...defaultConfig(region),
    temperatureC: Math.round(30 + rnd(seed, 2) * 9),
    humidityPct: Math.round(12 + rnd(seed, 3) * 18),
    windSpeedKmh: Math.round(15 + rnd(seed, 4) * 25),
    windFromDeg: Math.floor(rnd(seed, 5) * 8) * 45,
    precipMmH: 0,
    durationH: 72,
    intensity: 'medium',
    weather: undefined,
  }
  const pts = riskPoints(grid, region.settlements, seed, exam === 1 ? 3 : 6)
  const fire = exam === 2 ? [pts[Math.floor(rnd(seed, 6) * pts.length)]] : pts
  return { areaId: region.id, seed, config: { ...config, ignition: fire[0] }, ignitions: fire, reportMin: exam === 2 ? 10 + Math.floor(rnd(seed, 7) * 8) * 5 : DETECT_MIN }
}

/** One full response run with the rule-based commander. */
export function runWithRules(grid: Grid, config: SimConfig, settlements: Settlement[], infra: Infrastructure, startMin: number, opts?: RunOptions): SimResult {
  const run = new ResponseRun(grid, config, settlements, infra, startMin, opts)
  for (;;) {
    const a = run.advance()
    if (a.kind === 'end') break
    run.apply(ruleCommander(run.context(a.trigger)), 'rules', a.trigger)
  }
  return run.finish()
}

// ---------------------------------------------------------------- exam 1: judging the plan

export interface FireOutcome {
  ignition: LatLon
  without: SimResult
  withPlan: SimResult
  seenBy: string | null
}

export interface Loss {
  forestHa: number
  otherHa: number
  settlements: number
  tl: number
}

export function lossOf(r: SimResult): Loss {
  const f = r.series[r.series.length - 1]
  const settlements = r.impacts.filter((i) => i.arrivalMin !== null).length
  const otherHa = Math.max(0, f.affectedHa - f.forestHa)
  return { forestHa: f.forestHa, otherHa, settlements, tl: f.forestHa * COSTS.zarar.ormanHaTL + otherHa * COSTS.zarar.digerHaTL + settlements * COSTS.zarar.yerlesimTL }
}

/** Runs every likely fire without and with the plan. Calls `progress` between runs (to let the page breathe). */
export async function runPlan(sc: DrillScenario, plan: DrillMeasure[], progress: (done: number, total: number) => Promise<void>, without?: SimResult[]): Promise<FireOutcome[]> {
  const region = regionById(sc.areaId)
  const grid = getGrid(sc.areaId)
  const infra = getInfrastructure(region)
  const out: FireOutcome[] = []
  const total = sc.ignitions.length * (without ? 1 : 2)
  let done = 0
  for (let k = 0; k < sc.ignitions.length; k++) {
    const ig = sc.ignitions[k]
    const cfg = { ...sc.config, ignition: ig }
    let base = without?.[k]
    if (!base) {
      base = runWithRules(grid, cfg, region.settlements, infra, DETECT_MIN)
      await progress(++done, total)
    }
    const fx = planEffects(grid, plan, ig)
    const withPlan = runWithRules(grid, cfg, region.settlements, infra, Math.max(0, DETECT_MIN - fx.detectGainMin), fx.opts)
    await progress(++done, total)
    out.push({ ignition: ig, without: base, withPlan, seenBy: fx.seenBy })
  }
  return out
}

export interface Verdict {
  score: number
  grade: string
  parts: { label: string; score: number; max: number; note: string }[]
  planTL: number
  natureHa: number
  lossWithout: number
  lossWith: number
  /** Net benefit: damage avoided minus what the plan cost. */
  netTL: number
  burnedWithout: number
  burnedWith: number
  forestWithout: number
  forestWith: number
  settlementsWithout: number
  settlementsWith: number
  mistakes: { level: 'kritik' | 'uyari' | 'bilgi' | 'iyi'; text: string }[]
  perMeasure: { id: string; useful: boolean; note: string }[]
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)

/** Scores a prevention plan from its runs; `settlements` names the places in the messages. */
export function judgePlan(grid: Grid, plan: DrillMeasure[], fires: FireOutcome[], settlements: Settlement[], windFromDeg: number): Verdict {
  const costs = plan.map((m) => measureCost(grid, m))
  const planTL = costs.reduce((s, c) => s + c.tl, 0)
  const natureHa = costs.reduce((s, c) => s + c.natureHa, 0)
  const L0 = fires.map((f) => lossOf(f.without))
  const L1 = fires.map((f) => lossOf(f.withPlan))
  const lossWithout = avg(L0.map((l) => l.tl))
  const lossWith = avg(L1.map((l) => l.tl))
  const saved = Math.max(0, lossWithout - lossWith)
  const netTL = lossWithout - lossWith - planTL
  const forestWithout = avg(L0.map((l) => l.forestHa))
  const forestWith = avg(L1.map((l) => l.forestHa))
  const fin = (r: SimResult) => r.series[r.series.length - 1].affectedHa

  // 1. how much damage the plan prevented
  const eff = lossWithout > 0 ? Math.min(1, saved / lossWithout) : 0
  // 2. value for money: damage avoided per lira spent (2× or better = full marks)
  const bcr = planTL > 0 ? saved / planTL : 0
  const value = Math.min(1, bcr / 2)
  // 3. nature: forest kept from burning against forest removed by the measures
  const forestSaved = Math.max(0, forestWithout - forestWith)
  const nature = natureHa + forestSaved > 0 ? Math.max(0, Math.min(1, (forestSaved - natureHa * 1.5) / Math.max(forestSaved, natureHa * 1.5) * 0.5 + 0.5)) : 0.5
  const parts = [
    { label: 'Etkinlik', score: Math.round(eff * 45), max: 45, note: `Olası yangınların zararını %${Math.round(eff * 100)} azalttı.` },
    { label: 'Maliyet verimliliği', score: Math.round(value * 30), max: 30, note: planTL ? `Harcanan her 1 TL, ${bcr.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} TL zararı önledi.` : 'Hiç önlem alınmadı.' },
    { label: 'Doğaya etki', score: Math.round(nature * 25), max: 25, note: `Önlemler ~${natureHa.toFixed(0)} ha bitki örtüsüne dokundu; yangından ~${forestSaved.toFixed(0)} ha orman kurtuldu.` },
  ]
  const score = plan.length ? parts.reduce((s, p) => s + p.score, 0) : 0
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F'

  // which measures mattered
  const burnedAny = new Uint8Array(grid.cols * grid.rows)
  for (const f of fires) f.without.ignitionStep.forEach((v, i) => { if (v >= 0) burnedAny[i] = 1 })
  const perMeasure = plan.map((m) => {
    const t = TOOLS[m.tool]
    if (t.kind === 'point' && (m.tool === 'kule' || m.tool === 'kamera')) {
      const seen = fires.filter((f) => haversineM(m.points[0], f.ignition) <= COSTS.araclar[m.tool as 'kule' | 'kamera'].gorusKm * 1000).length
      return { id: m.id, useful: seen > 0, note: seen ? `${seen}/${fires.length} yangını gördü.` : 'Hiçbir yangını görmedi.' }
    }
    if (m.tool === 'havuz' || m.tool === 'konuslanma') {
      const near = Math.min(...fires.map((f) => haversineM(m.points[0], f.ignition)))
      const lim = m.tool === 'havuz' ? 6000 : 10000
      return { id: m.id, useful: near <= lim, note: `En yakın yangına ${(near / 1000).toFixed(1)} km.` }
    }
    const hit = m.cells.filter((c) => burnedAny[c]).length
    return { id: m.id, useful: hit > 0, note: hit ? `Yangınların yolundaki ${hit} hücrede etkili oldu.` : 'Hiçbir olası yangının yolunda değildi.' }
  })

  const mistakes: Verdict['mistakes'] = []
  if (!plan.length) mistakes.push({ level: 'kritik', text: 'Hiç önlem alınmadı.' })
  if (planTL > BUDGET_TL) mistakes.push({ level: 'uyari', text: `Bütçe aşıldı: ${tlFmt(planTL)} harcandı, bütçe ${tlFmt(BUDGET_TL)}.` })
  if (planTL > 0 && saved < planTL) mistakes.push({ level: 'kritik', text: `Önlemler önledikleri zarardan pahalı: ${tlFmt(planTL)} harcandı, ${tlFmt(saved)} zarar önlendi.` })
  perMeasure.forEach((p, i) => {
    if (!p.useful) mistakes.push({ level: 'uyari', text: `${TOOLS[plan[i].tool].label} (${costs[i].size}, ${tlFmt(costs[i].tl)}): ${p.note} Bu harcama boşa gitti.` })
  })
  // towers looking at the same ground
  const eyes = plan.filter((m) => m.tool === 'kule' || m.tool === 'kamera')
  for (let a = 0; a < eyes.length; a++)
    for (let b = a + 1; b < eyes.length; b++)
      if (haversineM(eyes[a].points[0], eyes[b].points[0]) < 6000) mistakes.push({ level: 'uyari', text: `${TOOLS[eyes[a].tool].label} ile ${TOOLS[eyes[b].tool].label} birbirine çok yakın; aynı alanı izliyorlar.` })
  // fire breaks parallel to the wind do not cut the fire's path
  const windTo = (windFromDeg + 180) % 360
  for (const m of plan.filter((x) => x.tool === 'serit' && x.points.length > 1)) {
    const a = m.points[0]
    const b = m.points[m.points.length - 1]
    const brg = (Math.atan2((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]) * 180) / Math.PI
    const diff = Math.abs((((brg - windTo) % 180) + 180) % 180)
    const along = Math.min(diff, 180 - diff)
    if (along < 30) mistakes.push({ level: 'uyari', text: `Emniyet şeridi rüzgarla aynı yönde (${compass(windTo)}) çizilmiş; yangının önünü kesmek için rüzgara dik çizilmeli.` })
    if (lengthKm(m.points) < 1) mistakes.push({ level: 'bilgi', text: 'Bir emniyet şeridi 1 km\'den kısa; yangın yanından dolaşır.' })
  }
  for (const m of plan.filter((x) => x.tool === 'aralama')) {
    const forest = m.cells.filter((c) => grid.kind[c] >= 3).length
    if (m.cells.length && forest / m.cells.length < 0.5) mistakes.push({ level: 'uyari', text: 'Aralama alanının yarıdan fazlası orman veya maki değil; seyrek alanda aralama işe yaramaz.' })
    if ((m.cells.length * grid.cellM * grid.cellM) / 10000 > 400) mistakes.push({ level: 'uyari', text: 'Çok büyük bir aralama alanı: hem pahalı hem doğaya ağır müdahale.' })
  }
  // settlements the fire still reached
  settlements.forEach((st, i) => {
    const reached = fires.filter((f) => f.withPlan.impacts[i]?.arrivalMin !== null).length
    if (reached && !plan.some((m) => m.tool === 'yerlesim' && m.settlementId === st.id)) mistakes.push({ level: 'kritik', text: `${st.name}: ${reached}/${fires.length} yangında ateş yerleşime ulaştı ve çevresi temizlenmemişti.` })
  })
  if (natureHa > forestSaved * 0.8 && natureHa > 20) mistakes.push({ level: 'uyari', text: `Önlemler doğaya, kurtardıkları ormandan fazla dokunuyor (~${natureHa.toFixed(0)} ha'ya karşı ${forestSaved.toFixed(0)} ha).` })
  if (eff >= 0.5) mistakes.push({ level: 'iyi', text: `Olası yangınların zararı yarıdan fazla azaldı.` })
  if (planTL > 0 && bcr >= 2) mistakes.push({ level: 'iyi', text: 'Harcamanın en az iki katı zarar önlendi.' })
  if (fires.some((f) => f.seenBy)) mistakes.push({ level: 'iyi', text: `${fires.filter((f) => f.seenBy).length}/${fires.length} yangın gözetlemeyle erken fark edildi.` })

  return {
    score,
    grade,
    parts,
    planTL,
    natureHa,
    lossWithout,
    lossWith,
    netTL,
    burnedWithout: avg(fires.map((f) => fin(f.without))),
    burnedWith: avg(fires.map((f) => fin(f.withPlan))),
    forestWithout,
    forestWith,
    settlementsWithout: avg(L0.map((l) => l.settlements)),
    settlementsWith: avg(L1.map((l) => l.settlements)),
    mistakes,
    perMeasure,
  }
}

// ---------------------------------------------------------------- exam 1: the optimal plan

export interface OptionCandidate {
  id: string
  measure: DrillMeasure
  cost: MeasureCost
  evidence: string
}

/**
 * Candidate measures worked out from the fires as they would run without a plan (where they start, which way
 * they run, which villages they reach). The optimiser (AI or rules) picks a subset.
 */
export function optionCandidates(grid: Grid, sc: DrillScenario, fires: FireOutcome[], settlements: Settlement[]): OptionCandidate[] {
  const out: OptionCandidate[] = []
  const add = (m: Omit<DrillMeasure, 'cells'> & { cells?: number[] }, evidence: string) => {
    const cells = m.cells ?? measureCellsFor(grid, m, settlements)
    const measure = { ...m, cells } as DrillMeasure
    out.push({ id: m.id, measure, cost: measureCost(grid, measure), evidence })
  }
  const windTo = ((sc.config.windFromDeg + 180) * Math.PI) / 180
  fires.forEach((f, k) => {
    const r = f.without
    const o = r.originCell
    const ox = o % grid.cols
    const oy = (o / grid.cols) | 0
    // fire breaks across the wind at ~1.5 and ~3 km downwind
    for (const [j, km] of [[1, 1.5], [2, 3]] as const) {
      const d = (km * 1000) / grid.cellM
      const cx = ox + Math.sin(windTo) * d
      const cy = oy - Math.cos(windTo) * d
      const half = (1800 / grid.cellM) * (j === 1 ? 0.8 : 1.2)
      const px = Math.cos(windTo)
      const py = Math.sin(windTo)
      const p1 = cellCenter(grid, Math.round(cy - py * half) * grid.cols + Math.round(cx - px * half))
      const p2 = cellCenter(grid, Math.round(cy + py * half) * grid.cols + Math.round(cx + px * half))
      if (cx - Math.abs(px * half) < 0 || cy - Math.abs(py * half) < 0 || cx + Math.abs(px * half) >= grid.cols || cy + Math.abs(py * half) >= grid.rows) continue
      add({ id: `serit-${k + 1}-${j}`, tool: 'serit', points: [p1, p2], widthM: 60 }, `Yangın ${k + 1} rüzgarla ${compass(sc.config.windFromDeg + 180)} yönüne koşuyor; bu şerit ~${km} km önünü kesiyor.`)
    }
    // thinning around the likely start
    const ring: LatLon[] = Array.from({ length: 8 }, (_, a) => {
      const ang = (a / 8) * Math.PI * 2
      const R = 900
      return [f.ignition[0] + (R * Math.cos(ang)) / 111320, f.ignition[1] + (R * Math.sin(ang)) / (111320 * Math.cos((f.ignition[0] * Math.PI) / 180))] as LatLon
    })
    add({ id: `aralama-${k + 1}`, tool: 'aralama', points: ring }, `Yangın ${k + 1}'in olası başlangıcının çevresindeki yoğun yakıt.`)
    // a camera on high ground near the start
    let best = -1
    const R = Math.round(4000 / grid.cellM)
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const x = ox + dx
        const y = oy + dy
        if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue
        const i = y * grid.cols + x
        if (grid.kind[i] !== 0 && (best < 0 || grid.elev[i] > grid.elev[best])) best = i
      }
    if (best >= 0) {
      add({ id: `kamera-${k + 1}`, tool: 'kamera', points: [cellCenter(grid, best)] }, `Yangın ${k + 1} bölgesine bakan en yüksek tepe (${Math.round(grid.elev[best])} m).`)
      add({ id: `kule-${k + 1}`, tool: 'kule', points: [cellCenter(grid, best)] }, `Yangın ${k + 1} bölgesine bakan en yüksek tepe; geniş görüş.`)
    }
  })
  // villages a fire reached
  settlements.forEach((st, i) => {
    const n = fires.filter((f) => f.without.impacts[i]?.arrivalMin !== null).length
    if (n) add({ id: `yerlesim-${st.id}`, tool: 'yerlesim', points: [st.pos], settlementId: st.id }, `Önlemsiz ${n}/${fires.length} yangın ${st.name}'e ulaştı.`)
  })
  // a summer base near the middle of the likely starts
  const mid: LatLon = [avg(fires.map((f) => f.ignition[0])), avg(fires.map((f) => f.ignition[1]))]
  add({ id: 'konuslanma-1', tool: 'konuslanma', points: [mid] }, 'Olası başlangıç noktalarının ortası.')
  // drop near-duplicates (cameras on the same hill)
  return out.filter((c, i) => !out.slice(0, i).some((d) => d.measure.tool === c.measure.tool && d.measure.points.length === 1 && c.measure.points.length === 1 && haversineM(d.measure.points[0], c.measure.points[0]) < 1500))
}

/** Context for the AI optimiser. */
export function optimalContext(sc: DrillScenario, fires: FireOutcome[], cands: OptionCandidate[]) {
  const region = regionById(sc.areaId)
  return {
    region: region.name,
    weather: { temperature_c: sc.config.temperatureC, humidity_pct: sc.config.humidityPct, wind_kmh: sc.config.windSpeedKmh, wind_from: compass(sc.config.windFromDeg) },
    budget_tl: BUDGET_TL,
    damage_values: { forest_ha_tl: COSTS.zarar.ormanHaTL, other_ha_tl: COSTS.zarar.digerHaTL, settlement_reached_tl: COSTS.zarar.yerlesimTL },
    fires_without_plan: fires.map((f, k) => {
      const l = lossOf(f.without)
      return { fire: k + 1, burned_forest_ha: Math.round(l.forestHa), burned_other_ha: Math.round(l.otherHa), settlements_reached: region.settlements.filter((_, i) => f.without.impacts[i]?.arrivalMin !== null).map((s) => s.name), damage_tl: Math.round(l.tl) }
    }),
    candidates: cands.map((c) => ({ id: c.id, type: TOOLS[c.measure.tool].label, size: c.cost.size, cost_tl: Math.round(c.cost.tl), nature_ha: +c.cost.natureHa.toFixed(1), evidence: c.evidence })),
  }
}

/** Rule fallback: best damage avoided per lira, within budget (estimated, before running). */
export function ruleOptimal(cands: OptionCandidate[], fires: FireOutcome[]): string[] {
  const burned = new Uint8Array(fires[0]?.without.ignitionStep.length ?? 0)
  for (const f of fires) f.without.ignitionStep.forEach((v, i) => { if (v >= 0) burned[i] = 1 })
  const est = cands.map((c) => {
    const m = c.measure
    let v = 0
    if (m.tool === 'yerlesim') v = COSTS.zarar.yerlesimTL * 0.6
    else if (m.tool === 'kamera' || m.tool === 'kule') v = fires.filter((f) => haversineM(m.points[0], f.ignition) <= COSTS.araclar[m.tool as 'kule' | 'kamera'].gorusKm * 1000).length * 1.2e6
    else if (m.tool === 'konuslanma') v = 2.5e6
    else v = m.cells.filter((x) => burned[x]).length * 1.21 * COSTS.zarar.ormanHaTL * 0.5
    return { id: c.id, tool: m.tool, ratio: v / Math.max(1, c.cost.tl), tl: c.cost.tl }
  })
  est.sort((a, b) => b.ratio - a.ratio)
  const pick: string[] = []
  let tl = 0
  let eyes = false
  for (const e of est) {
    if (e.ratio < 1.2 || tl + e.tl > BUDGET_TL) continue
    if ((e.tool === 'kule' || e.tool === 'kamera') && eyes) continue
    if (e.tool === 'kule' || e.tool === 'kamera') eyes = true
    pick.push(e.id)
    tl += e.tl
  }
  return pick
}

// ---------------------------------------------------------------- exam 2: judging the response

export interface ResponseVerdict {
  score: number
  grade: string
  parts: { label: string; score: number; max: number; note: string }[]
  you: { ha: number; forestHa: number; settlements: number; outH: number | null; evacLate: number; retreats: number }
  rules: { ha: number; forestHa: number; settlements: number; outH: number | null }
  none: { ha: number; settlements: number }
  mistakes: Verdict['mistakes']
}

export function judgeResponse(you: SimResult, rules: SimResult, settlements: Settlement[]): ResponseVerdict {
  const r = you.response!
  const f = you.series[you.series.length - 1]
  const g = rules.series[rules.series.length - 1]
  const reached = (x: SimResult) => x.impacts.filter((i) => i.arrivalMin !== null).length
  const outH = (x: SimResult) => (x.response?.extinguishedStep != null ? (x.response.extinguishedStep * 10) / 60 : null)
  const noneHa = r.baseline.affectedHa
  const retreats = r.events.filter((e) => e.kind === 'retreat').length
  const evacLate = r.evacuations.filter((e) => e.atRisk).length
  const mistakes: Verdict['mistakes'] = []

  // people
  let peopleOk = 1
  settlements.forEach((st, i) => {
    const arr = you.impacts[i]?.arrivalMin
    const ev = r.evacuations.find((e) => e.settlementId === st.id)
    if (arr !== null && arr !== undefined && !ev) {
      peopleOk -= 0.35
      mistakes.push({ level: 'kritik', text: `${st.name} (${st.population.toLocaleString('tr-TR')} kişi): yangın yerleşime ulaştı, tahliye edilmedi.` })
    } else if (ev?.atRisk) {
      peopleOk -= 0.2
      mistakes.push({ level: 'kritik', text: `${st.name}: tahliye geç başladı, yangın bitmeden ulaştı.` })
    } else if (ev && (arr === null || arr === undefined)) {
      mistakes.push({ level: 'bilgi', text: `${st.name} tahliye edildi ama yangın ulaşmadı; gereksiz tahliye halkı yorar ve kaynak tüketir.` })
      peopleOk -= 0.05
    } else if (ev) mistakes.push({ level: 'iyi', text: `${st.name} zamanında tahliye edildi.` })
  })
  peopleOk = Math.max(0, peopleOk)

  // fire
  const base = Math.max(1, noneHa)
  const effYou = Math.max(0, (noneHa - f.affectedHa) / base)
  const effRules = Math.max(0.01, (noneHa - g.affectedHa) / base)
  const fireScore = Math.min(1, effYou / effRules)
  if (f.affectedHa > g.affectedHa * 1.25) mistakes.push({ level: 'uyari', text: `Sistem komutanı aynı yangında ${Math.round(g.affectedHa)} ha ile bitirdi; sizde ${Math.round(f.affectedHa)} ha yandı.` })
  else if (f.affectedHa <= g.affectedHa) mistakes.push({ level: 'iyi', text: `Sistem komutanından daha az alan yandı (${Math.round(f.affectedHa)} ha'ya karşı ${Math.round(g.affectedHa)} ha).` })

  // crews
  const safety = Math.max(0, 1 - retreats * 0.15)
  if (retreats) mistakes.push({ level: retreats >= 3 ? 'kritik' : 'uyari', text: `Ekipler ${retreats} kez yangın başından veya ilerleyen ateşin önünden geri çekilmek zorunda kaldı; rüzgarlı havada yangın başına kara ekibi gönderilmez.` })
  const breached = r.lines.reduce((s, l) => s + l.breachedStep.filter((b) => b !== null).length, 0)
  if (breached) mistakes.push({ level: 'uyari', text: `Kurulan sınırlar ${breached} sektörde aşıldı; sınır yangına çok yakın kuruldu ya da yeterince ekip atanmadı.` })

  // resources
  const used = new Set<string>()
  for (const d of r.decisions) for (const a of d.output.actions) if (a.resource_id && a.type !== 'withdraw') used.add(a.resource_id)
  const all = r.tracks.length
  const idle = all - r.tracks.filter((t) => used.has(t.id)).length
  const resScore = all ? Math.max(0, 1 - idle / all) : 1
  if (idle > 0) mistakes.push({ level: idle > all / 3 ? 'uyari' : 'bilgi', text: `${idle}/${all} kaynak hiç görevlendirilmedi.` })
  if (!r.drops.length && r.tracks.some((t) => t.kind === 'heli' || t.kind === 'plane')) mistakes.push({ level: 'uyari', text: 'Hava araçları hiç su atmadı.' })
  if (!r.lines.length && noneHa > 300) mistakes.push({ level: 'uyari', text: 'Büyüyen yangına hiç güvenlik sınırı kurulmadı.' })
  const first = r.decisions[0]
  if (first && first.output.actions.every((a) => a.type === 'hold')) mistakes.push({ level: 'uyari', text: 'İhbar anında hiçbir ekip gönderilmedi; ilk dakikalar kaybedildi.' })

  const parts = [
    { label: 'Yangını durdurma', score: Math.round(fireScore * 40), max: 40, note: `Müdahalesiz ${Math.round(noneHa)} ha yanacaktı; sizde ${Math.round(f.affectedHa)} ha, sistem komutanında ${Math.round(g.affectedHa)} ha.` },
    { label: 'Can güvenliği', score: Math.round(peopleOk * 35), max: 35, note: `${reached(you)} yerleşime ulaşıldı, ${r.evacuations.length} tahliye.` },
    { label: 'Ekip güvenliği', score: Math.round(safety * 15), max: 15, note: retreats ? `${retreats} geri çekilme.` : 'Ekipler tehlikeye girmedi.' },
    { label: 'Kaynak kullanımı', score: Math.round(resScore * 10), max: 10, note: `${all - idle}/${all} kaynak kullanıldı.` },
  ]
  const score = parts.reduce((s, p) => s + p.score, 0)
  return {
    score,
    grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F',
    parts,
    you: { ha: f.affectedHa, forestHa: f.forestHa, settlements: reached(you), outH: outH(you), evacLate, retreats },
    rules: { ha: g.affectedHa, forestHa: g.forestHa, settlements: reached(rules), outH: outH(rules) },
    none: { ha: noneHa, settlements: r.baseline.settlementsReached },
    mistakes,
  }
}

export { getGrid, regionById, getInfrastructure }
