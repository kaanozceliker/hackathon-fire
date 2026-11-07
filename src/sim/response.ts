import { FireStepper, STEP_MIN } from './engine'
import { buildHazards, findRoute, type EdgeHazard } from './planner'
import { compass, fmtDuration, haversineM, type LatLon } from './geo'
import { cellCenter, cellOf } from './terrain'
import { weatherAt } from './weather'
import { inventoryFor } from '../data/inventory'
import { DETECTION_GAIN_MIN, existingFor, towerSeeing } from './existing'
import { startHour } from './smoke'
import { hash3 } from './rng'
import type { Infrastructure, NetNode } from '../data/infrastructure'
import {
  SECTORS,
  type CommanderAction,
  type CommanderOutput,
  type Decision,
  type Grid,
  type ResourceKind,
  type ResourceStatus,
  type ResponseEvent,
  type ResponseRecord,
  type Sector,
  type Settlement,
  type SimConfig,
  type SimResult,
} from './types'

/**
 * Response simulation for the Komuta Merkezi. ILLUSTRATIVE – simplified suppression effects, not validated tactics.
 *
 * The fire runs step by step. At decision points a commander (an OpenAI model through the server, or the rule-based fallback below) reads a
 * summary of the situation and issues actions; this module applies them with fixed physics, so the commander
 * decides and the engine decides what the decision achieves:
 * - Safety lines are drawn from the fire's own forecast (where it will be in 2 h or 5 h). Ground crews and the
 *   dozer drive there over the road network and clear the line sector by sector; a cleared cell is far harder to
 *   ignite and catches fewer embers. Crews pull back when the fire gets within ~200 m of them.
 * - Helicopters fly in daylight only (06:00–20:00), scoop from the nearest water source and drop on the head of
 *   the fire in a sector, putting out part of it and wetting the ground around it for an hour.
 * - Evacuations take 30 minutes plus one hour per 8,000 people, along a road route to a safe point.
 */

const MAX_HOURS = 72
const MAX_STEPS = (MAX_HOURS * 60) / STEP_MIN
const BUILD_RATE: Record<ResourceKind, number> = { crew: 0.7, dozer: 3, heli: 0, plane: 0 } // line cells per step
/** Burning cells a ground unit can put out per step in direct attack, before the wind penalty. */
const ATTACK_RATE: Record<ResourceKind, number> = { crew: 2, dozer: 3, heli: 0, plane: 0 }
const OFFROAD_KMH: Record<ResourceKind, number> = { crew: 3, dozer: 4, heli: 180, plane: 300 }
/** Aircraft: cruise speed, scoop/fill time, radius put out (cells²), radius wetted (cells). Planes scoop only from the sea or a reservoir. */
const AIR = {
  heli: { kmh: 180, fillMin: 8, outR2: 4, wetR: 3, p: 0.75 },
  plane: { kmh: 300, fillMin: 12, outR2: 8, wetR: 4, p: 0.8 },
}
const DISPATCH_DELAY_MIN = 15
const CLEARED = 0.08
const HELD = 0.03
const WET = 0.25
const WET_STEPS = 6
const MIN_GAP_STEPS = 2
const PERIODIC_STEPS = 6
const MAX_DECISIONS = 48

interface Resource {
  id: string
  name: string
  kind: ResourceKind
  base: LatLon
  pos: LatLon
  status: ResourceStatus
  availableFromStep: number
  task: { kind: 'line'; lineId: string; sector: number } | { kind: 'attack'; sector: number } | { kind: 'drop'; sector: number } | { kind: 'mopup'; sector: number; patrolFrom: number } | { kind: 'return' } | null
  /** Leftover direct-attack effort carried to the next step. */
  carry: number
  /** Movement: path and the steps it is travelled between. */
  path: LatLon[] | null
  pathFrom: number
  pathTo: number
  nextDropStep: number
  dispatched: boolean
}

interface Line {
  id: string
  level: number
  hoursAhead: number
  createdStep: number
  cells: number[]
  sectorOf: number[]
  builtStep: number[]
  breachedStep: (number | null)[]
  /** Per sector: cell indexes (into `cells`) in build order, the next one to clear, and leftover build effort. */
  order: number[][]
  next: number[]
  carry: number[]
}

interface Candidate {
  id: 'A' | 'B' | 'C'
  hoursAhead: number
  cells: number[]
}

export interface CommanderContext {
  time: { T: string; local_time: string; daylight: boolean; response_started: string }
  trigger: string
  fire: {
    total_ha: number
    burning_ha: number
    front_speed_m_per_h: number
    spreading_toward: string | null
    sectors: { sector: Sector; front_km_from_origin: number; growth_km_last_hour: number; burning_ha: number }[]
  }
  weather_now: { wind_kmh: number; wind_from: string; humidity_pct: number; temperature_c: number }
  weather_next_hours: { T: string; wind_kmh: number; wind_from: string; humidity_pct: number }[]
  forecast_without_new_actions: { area_in_2h_ha: number; area_in_5h_ha: number }
  line_candidates: { id: 'A' | 'B' | 'C'; fire_reaches_it_in_h: number; length_km: number; settlements_inside: string[]; sectors: { sector: Sector; radius_km: number }[] }[]
  next_line_id: string
  lines: { id: string; level: number; created: string; sectors: { sector: Sector; built_pct: number; breached: boolean; resources: string[] }[] }[]
  resources: { id: string; name: string; type: string; status: string; task: string | null; eta: string | null }[]
  settlements: { id: string; name: string; population: number; distance_to_fire_km: number; forecast_fire_arrival: string | null; evacuation: string }[]
  recent_events: string[]
  previous_decisions: { T: string; assessment: string; actions: string[] }[]
}

const T = (step: number) => `T+${fmtDuration(step * STEP_MIN)}`
const STATUS_TR: Record<ResourceStatus, string> = {
  unavailable: 'henüz yok',
  idle: 'boşta',
  enroute: 'yolda',
  mopping: 'soğutmada',
  attacking: 'doğrudan müdahalede',
  building: 'sınır açıyor',
  holding: 'sınırı tutuyor',
  dropping: 'su atıyor',
  retreated: 'geri çekildi',
  grounded: 'yerde (gece)',
}
const KIND_TR: Record<ResourceKind, string> = { crew: 'arazöz ekibi', dozer: 'iş makinesi', heli: 'helikopter', plane: 'yangın söndürme uçağı' }

/** Prevention measures applied to a run: lower fuel, an extra crew base, extra water points. */
export interface RunOptions {
  fuelMult?: Float32Array
  extraBase?: LatLon
  /** More pre-positioning bases (Tatbikat), each with 2 crews and a dozer. */
  extraBases?: LatLon[]
  extraWater?: Infrastructure['water']
  /** Keep the given response start even if an existing lookout tower sees the fire (Tatbikat: the report time is part of the exam). */
  noTowerGain?: boolean
}

export class ResponseRun {
  readonly grid: Grid
  readonly config: SimConfig
  readonly settlements: Settlement[]
  readonly infra: Infrastructure
  readonly st: FireStepper
  readonly startStep: number
  private resources: Resource[] = []
  private lines: Line[] = []
  private candidates: Candidate[] = []
  private lineResist: Float32Array
  private wetUntil: Int16Array
  decisions: Decision[] = []
  events: ResponseEvent[] = []
  private drops: ResponseRecord['drops'] = []
  private scoops: NonNullable<ResponseRecord['scoops']> = []
  private tracks: ResponseRecord['tracks'] = []
  private evacs: (ResponseRecord['evacuations'][number] & { started: boolean })[] = []
  private pendingTriggers: string[] = []
  private lastDecisionStep = -999
  private lastWind: { speed: number; from: number } | null = null
  private warned = new Set<string>()
  private sectorMax: Float64Array = new Float64Array(8)
  private sectorHist: number[][] = []
  private wasDaylight: boolean
  private hazards: Map<string, EdgeHazard> | null = null
  extinguishedStep: number | null = null

  constructor(grid: Grid, config: SimConfig, settlements: Settlement[], infra: Infrastructure, responseStartMin: number, opts: RunOptions = {}) {
    this.grid = grid
    this.config = config
    this.settlements = settlements
    this.infra = opts.extraWater?.length ? { ...infra, water: [...infra.water, ...opts.extraWater] } : infra
    this.st = new FireStepper(grid, config)
    if (opts.fuelMult) this.st.scaleFuel(opts.fuelMult)
    // an existing lookout tower or camera that sees the ignition spots the fire earlier
    const tower = config.ignoreExisting || opts.noTowerGain ? null : towerSeeing(grid.areaId, config.ignition)
    this.startStep = Math.max(0, Math.round((responseStartMin - (tower ? DETECTION_GAIN_MIN : 0)) / STEP_MIN))
    if (tower) this.events.push({ step: 0, kind: 'arrive', text: `${tower.name} yangını gördü: müdahale ${DETECTION_GAIN_MIN} dk erken başlıyor.` })
    const n = grid.cols * grid.rows
    this.lineResist = new Float32Array(n).fill(1)
    this.wetUntil = new Int16Array(n)
    const stations = infra.nodes.filter((x) => x.kind === 'station')
    // resources from the editable inventory (src/data/inventory.json)
    const inv = inventoryFor(grid.areaId)
    stations.forEach((stn, i) => {
      const short = stn.name.replace(/ (İtfaiye|Yangın).*$/, '')
      for (let k = 1; k <= inv.stationCrews(stn.name, i); k++) this.addResource(`ekip-${i + 1}-${k}`, `${short} arazöz ${k}`, 'crew', stn.pos, this.startStep)
      for (let k = 1; k <= inv.stationDozers(stn.name, i); k++) this.addResource(`dozer-${i + 1}${k > 1 ? `-${k}` : ''}`, `${short} iş makinesi${k > 1 ? ` ${k}` : ''}`, 'dozer', stn.pos, this.startStep)
    })
    // aircraft come from a regional base, some time after the response starts (and not before T+1:00 / T+1:30)
    const airBase = stations[0]?.pos ?? cellCenter(grid, this.st.origin)
    for (let k = 1; k <= inv.helicopters; k++) this.addResource(`heli-${k}`, `Helikopter ${k}`, 'heli', airBase, Math.max(6, this.startStep + Math.round(inv.heliArrivalMin / STEP_MIN)))
    for (let k = 1; k <= inv.planes; k++) this.addResource(`ucak-${k}`, `Söndürme uçağı ${k}`, 'plane', airBase, Math.max(9, this.startStep + Math.round(inv.planeArrivalMin / STEP_MIN)))
    // prevention: a summer pre-positioning base near the forest, staffed from the start of the response
    // existing summer pre-positioning bases (src/data/existingMeasures.json)
    if (!config.ignoreExisting)
      existingFor(grid.areaId).bases.forEach((b, i) => {
        for (let k = 1; k <= b.crews; k++) this.addResource(`mevcut-${i + 1}-${k}`, `${b.name} arazöz ${k}`, 'crew', b.pos, this.startStep)
        for (let k = 1; k <= b.dozers; k++) this.addResource(`mevcut-${i + 1}-d${k}`, `${b.name} iş makinesi ${k}`, 'dozer', b.pos, this.startStep)
      })
    ;(opts.extraBases ?? []).forEach((b, i) => {
      for (let k = 1; k <= 2; k++) this.addResource(`tb-${i + 1}-${k}`, `Konuşlanma ${i + 1} arazöz ${k}`, 'crew', b, this.startStep)
      this.addResource(`tb-${i + 1}-d`, `Konuşlanma ${i + 1} iş makinesi`, 'dozer', b, this.startStep)
    })
    if (opts.extraBase) {
      for (let k = 1; k <= 2; k++) this.addResource(`on-${k}`, `Ön konuşlanma arazöz ${k}`, 'crew', opts.extraBase, this.startStep)
      this.addResource('on-dozer', 'Ön konuşlanma iş makinesi', 'dozer', opts.extraBase, this.startStep)
    }
    // reinforcements from neighbouring provinces arrive at the furthest station
    const reBase = stations[stations.length - 1]?.pos ?? airBase
    let rn = 0
    inv.reinforcements.forEach((t, w) => {
      const at = this.startStep + Math.round((t.afterH * 60) / STEP_MIN)
      for (let k = 0; k < t.crews; k++) this.addResource(`takviye-${++rn}`, `Takviye arazöz ${rn}`, 'crew', reBase, at)
      for (let k = 0; k < t.dozers; k++) this.addResource(`takviye-dozer-${w + 1}-${k + 1}`, `Takviye iş makinesi${t.dozers > 1 ? ` ${k + 1}` : ''}`, 'dozer', reBase, at)
    })
    this.wasDaylight = this.daylight(0)
  }

  /** Resources whose time has come are ready at a decision point, before the step's own update runs. */
  private refreshAvailability() {
    const day = this.daylight(this.step)
    for (const r of this.resources) if (r.status === 'unavailable' && this.step >= r.availableFromStep) r.status = isAir(r.kind) && !day ? 'grounded' : 'idle'
  }

  private addResource(id: string, name: string, kind: ResourceKind, base: LatLon, availableFromStep: number) {
    this.resources.push({ id, name, kind, base, pos: base, status: 'unavailable', availableFromStep, task: null, carry: 0, path: null, pathFrom: 0, pathTo: 0, nextDropStep: 0, dispatched: false })
    this.tracks.push({ id, name, kind, base: [...base], availableFromStep, points: [], moves: [] })
  }

  get step() {
    return this.st.s
  }

  private localHour(step: number) {
    return startHour({ config: this.config } as SimResult) + (step * STEP_MIN) / 60
  }

  private daylight(step: number) {
    const h = ((this.localHour(step) % 24) + 24) % 24
    return h >= 6 && h < 20
  }

  private sectorOfCell(c: number): number {
    const { cols } = this.grid
    const o = this.st.origin
    const dx = (c % cols) - (o % cols)
    const dy = ((c / cols) | 0) - ((o / cols) | 0)
    if (dx === 0 && dy === 0) return 0
    const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360
    return Math.round(deg / 45) % 8
  }

  private cellDistKm(c: number): number {
    const { cols } = this.grid
    const o = this.st.origin
    return (Math.hypot((c % cols) - (o % cols), ((c / cols) | 0) - ((o / cols) | 0)) * this.grid.cellM) / 1000
  }

  private log(kind: ResponseEvent['kind'], text: string, trigger = false) {
    this.events.push({ step: this.step, kind, text })
    if (trigger) this.pendingTriggers.push(text)
  }

  // ---------------------------------------------------------------- stepping

  /** Runs the fire until a decision is due or it is over. */
  advance(): { kind: 'decision'; trigger: string } | { kind: 'end' } {
    for (;;) {
      if (this.step >= MAX_STEPS) return { kind: 'end' }
      if (this.step > 0 && !this.st.active) {
        if (this.extinguishedStep === null) {
          this.extinguishedStep = this.step
          this.log('out', `Yangın ${T(this.step)} itibarıyla söndü.`)
          if (this.step >= this.startStep) this.startMopUp()
          else return { kind: 'end' }
        }
        // after mop-up the crews drive home; the run ends when they are back (or after a time limit)
        const home = this.resources.every((r) => r.status === 'idle' || r.status === 'unavailable' || r.status === 'grounded')
        if (this.step >= this.mopEndStep && (home || this.step >= this.mopEndStep + 18)) return { kind: 'end' }
        if (this.step === this.mopEndStep) this.sendHome()
      }
      const due = this.decisionDue()
      if (due) return { kind: 'decision', trigger: due }
      this.updateResources()
      this.applyResist()
      this.st.step()
      this.afterStep()
    }
  }

  private decisionDue(): string | null {
    const s = this.step
    if (s < this.startStep || this.extinguishedStep !== null) return null
    if (this.decisions.length === 0) return 'Müdahale başlıyor: ilk değerlendirme'
    if (s - this.lastDecisionStep < MIN_GAP_STEPS) return null
    if (this.decisions.length >= MAX_DECISIONS && s - this.lastDecisionStep < 18) return null
    if (this.pendingTriggers.length) {
      const t = this.pendingTriggers.join(' · ')
      this.pendingTriggers = []
      return t
    }
    // wind change since the last decision
    const w = weatherAt(this.config, s * STEP_MIN)
    if (this.lastWind && w.windSpeedKmh >= 8) {
      const dDir = Math.abs(((w.windFromDeg - this.lastWind.from + 540) % 360) - 180)
      if (w.windSpeedKmh - this.lastWind.speed >= 10) return `Rüzgar ${Math.round(this.lastWind.speed)} km/sa'ten ${Math.round(w.windSpeedKmh)} km/sa'e çıktı`
      if (dDir >= 45) return `Rüzgar yönü ${compass(this.lastWind.from)} yönünden ${compass(w.windFromDeg)} yönüne döndü`
    }
    if (s - this.lastDecisionStep >= PERIODIC_STEPS) return 'Saatlik durum değerlendirmesi'
    return null
  }

  private applyResist() {
    const r = this.st.resist
    const s = this.step
    for (let i = 0; i < r.length; i++) r[i] = this.wetUntil[i] > s ? this.lineResist[i] * WET : this.lineResist[i]
  }

  private burningNear(c: number, radius: number): boolean {
    const { cols, rows } = this.grid
    const cx = c % cols
    const cy = (c / cols) | 0
    const s = this.step
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue
        const j = y * cols + x
        if (this.st.ig[j] >= 0 && this.st.burnout[j] > s) return true
      }
    return false
  }

  private posAlong(r: Resource): LatLon {
    if (!r.path || r.path.length < 2) return r.pos
    const f = Math.min(1, Math.max(0, (this.step - r.pathFrom) / Math.max(1, r.pathTo - r.pathFrom)))
    const seg: number[] = [0]
    for (let i = 1; i < r.path.length; i++) seg.push(seg[i - 1] + haversineM(r.path[i - 1], r.path[i]))
    const target = f * seg[seg.length - 1]
    for (let i = 1; i < r.path.length; i++) {
      if (seg[i] >= target) {
        const t = (target - seg[i - 1]) / Math.max(1e-6, seg[i] - seg[i - 1])
        return [r.path[i - 1][0] + (r.path[i][0] - r.path[i - 1][0]) * t, r.path[i - 1][1] + (r.path[i][1] - r.path[i - 1][1]) * t]
      }
    }
    return r.path[r.path.length - 1]
  }

  private updateResources() {
    const s = this.step
    const day = this.daylight(s)
    if (day !== this.wasDaylight) {
      this.wasDaylight = day
      const helis = this.resources.filter((r) => isAir(r.kind) && s >= r.availableFromStep)
      if (helis.length) this.log(day ? 'airborne' : 'grounded', day ? 'Gün doğdu: helikopterler yeniden uçabilir.' : 'Hava karardı: helikopterler yere indi.', true)
    }
    for (const r of this.resources) {
      if (s < r.availableFromStep) {
        r.status = 'unavailable'
        continue
      }
      if (r.status === 'unavailable') r.status = isAir(r.kind) && !day ? 'grounded' : 'idle'
      // movement
      if ((r.status === 'enroute' || r.status === 'mopping') && r.path) {
        r.pos = this.posAlong(r)
        // on the perimeter: the patrol part of a mop-up trip
        if (r.task?.kind === 'mopup' && s >= r.task.patrolFrom) r.status = 'mopping'
        if (s >= r.pathTo) {
          r.pos = r.path[r.path.length - 1]
          r.path = null
          if (r.task?.kind === 'attack') {
            r.status = 'attacking'
            this.log('arrive', `${r.name} ${SECTORS[r.task.sector]} sektöründe yangına doğrudan müdahaleye başladı.`)
          } else if (r.task?.kind === 'line') {
            r.status = 'building'
            this.log('arrive', `${r.name} ${r.task.lineId} sınırının ${SECTORS[r.task.sector]} sektörüne ulaştı.`)
          } else if (r.task?.kind === 'drop') {
            r.status = 'dropping'
            r.nextDropStep = s
          } else if (r.task?.kind === 'mopup') {
            r.status = 'mopping'
          } else {
            r.status = 'idle'
            r.task = null
          }
        }
      }
      if (isAir(r.kind)) this.updateAir(r, day)
      else if (r.status === 'attacking') this.updateAttack(r)
      else this.updateGround(r)
      this.tracks.find((t) => t.id === r.id)!.points.push({ step: s, lat: r.pos[0], lon: r.pos[1], status: r.status })
    }
    // evacuations
    for (const e of this.evacs) {
      if (!e.started && s >= e.startStep) e.started = true
      if (e.doneStep === s) this.log('evac_done', `${e.name} tahliyesi tamamlandı (${e.population.toLocaleString('en-US')} kişi).`)
    }
  }

  private updateGround(r: Resource) {
    if (r.status === 'retreated') {
      // regroup after half an hour, then wait for orders
      if (this.step - r.pathFrom >= 3) r.status = 'idle'
      return
    }
    if ((r.status !== 'building' && r.status !== 'holding') || r.task?.kind !== 'line') return
    const task = r.task
    const line = this.lines.find((l) => l.id === task.lineId)!
    const sec = task.sector
    const order = line.order[sec]
    // skip cells that already burned
    while (line.next[sec] < order.length && this.st.ig[line.cells[order[line.next[sec]]]] >= 0) line.next[sec]++
    if (line.next[sec] >= order.length) {
      if (r.status !== 'holding') {
        r.status = 'holding'
        if (!line.breachedStep[sec]) this.log('line_done', `${line.id} sınırının ${SECTORS[sec]} sektörü tamamlandı; ${r.name} sınırı tutuyor.`)
      }
      for (let k = 0; k < line.cells.length; k++) if (line.sectorOf[k] === sec && line.builtStep[k] >= 0) this.lineResist[line.cells[k]] = HELD
      const mid = line.cells[order[Math.floor(order.length / 2)] ?? 0]
      if (mid !== undefined) r.pos = cellCenter(this.grid, mid)
      return
    }
    const cur = line.cells[order[line.next[sec]]]
    r.pos = cellCenter(this.grid, cur)
    if (this.burningNear(cur, 2)) {
      r.status = 'retreated'
      r.pathFrom = this.step
      r.task = null
      this.log('retreat', `${r.name} yangın 200 m'ye yaklaştığı için ${line.id}/${SECTORS[sec]} sektöründen geri çekildi.`, true)
      return
    }
    line.carry[sec] += BUILD_RATE[r.kind]
    while (line.carry[sec] >= 1 && line.next[sec] < order.length) {
      line.carry[sec] -= 1
      const k = order[line.next[sec]]
      const c = line.cells[k]
      if (this.st.ig[c] < 0) {
        line.builtStep[k] = this.step
        this.lineResist[c] = CLEARED
      }
      line.next[sec]++
    }
  }

  /** Direct attack: work the fire edge in a sector, putting out burning cells; pull back if surrounded. */
  private updateAttack(r: Resource) {
    if (r.task?.kind !== 'attack') return
    const sec = r.task.sector
    const { cols } = this.grid
    const s = this.step
    let pc = cellOf(this.grid, r.pos[0], r.pos[1])
    // nearest burning edge cell in the sector (crews work from the burned side, on cells next to unburned fuel)
    let target = -1
    let bd = Infinity
    for (const c of this.st.burning) {
      if (this.st.burnout[c] <= s || this.sectorOfCell(c) !== sec || !this.isEdge(c)) continue
      const d = pc < 0 ? 0 : Math.hypot((c % cols) - (pc % cols), ((c / cols) | 0) - ((pc / cols) | 0))
      if (d < bd) { bd = d; target = c }
    }
    if (target < 0) {
      r.status = 'idle'
      r.task = null
      this.log('line_done', `${SECTORS[sec]} sektöründe yanan yer kalmadı; ${r.name} yeni görev bekliyor.`)
      return
    }
    // move along the edge (up to ~0.5 km per step off-road)
    const maxCells = (OFFROAD_KMH[r.kind] * (STEP_MIN / 60) * 1000) / this.grid.cellM
    if (pc < 0 || bd > 2) {
      const tp = cellCenter(this.grid, target)
      const f = pc < 0 ? 1 : Math.min(1, maxCells / bd)
      r.pos = [r.pos[0] + (tp[0] - r.pos[0]) * f, r.pos[1] + (tp[1] - r.pos[1]) * f]
      pc = cellOf(this.grid, r.pos[0], r.pos[1])
      if (f < 1) return
    }
    // burning edge cells within reach
    const cand: { c: number; d: number }[] = []
    const cx = pc % cols
    const cy = (pc / cols) | 0
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= cols || y >= this.grid.rows) continue
        const j = y * cols + x
        if (this.st.ig[j] >= 0 && this.st.burnout[j] > s && this.isEdge(j)) cand.push({ c: j, d: dx * dx + dy * dy })
      }
    // wind makes direct attack less effective; at the head of a strong wind-driven run it is unsafe
    const w = this.st.windAt(pc)
    const pushSector = Math.round(((((w.toRad * 180) / Math.PI) % 360) + 360) % 360 / 45) % 8
    if (w.speedKmh > 30 && sec === pushSector && cand.length >= 8) {
      r.status = 'retreated'
      r.pathFrom = s
      r.task = null
      this.log('retreat', `${r.name} rüzgarın sürüklediği yangın başında (${SECTORS[sec]}) güvenli çalışamadığı için geri çekildi.`, true)
      return
    }
    r.carry += ATTACK_RATE[r.kind] * Math.min(1, Math.max(0.15, 1.25 - w.speedKmh / 40))
    cand.sort((a, b) => a.d - b.d)
    for (const { c } of cand) {
      if (r.carry < 1) break
      r.carry -= 1
      this.st.extinguish(c)
      this.wetAround(c, 1, 3)
    }
  }

  /** A burning cell with unburned fuel next to it: where the fire can still spread. */
  private isEdge(c: number): boolean {
    const { cols, rows } = this.grid
    const cx = c % cols
    const cy = (c / cols) | 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue
        const j = y * cols + x
        if (this.st.ig[j] < 0 && this.grid.kind[j] !== 0) return true
      }
    return false
  }

  private wetAround(c: number, radius: number, steps: number) {
    const { cols, rows } = this.grid
    const cx = c % cols
    const cy = (c / cols) | 0
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue
        const j = y * cols + x
        this.wetUntil[j] = Math.max(this.wetUntil[j], this.step + steps)
      }
  }

  private updateAir(r: Resource, day: boolean) {
    if (!day) {
      if (r.status !== 'unavailable' && r.status !== 'grounded') {
        r.status = 'grounded'
        r.path = null
      }
      return
    }
    if (r.status === 'grounded') r.status = r.task?.kind === 'drop' ? 'dropping' : 'idle'
    if (r.status !== 'dropping' || r.task?.kind !== 'drop' || this.step < r.nextDropStep) return
    const target = this.headCell(r.task.sector)
    if (target < 0) {
      r.status = 'idle'
      r.task = null
      return
    }
    const p = cellCenter(this.grid, target)
    const air = AIR[r.kind as 'heli' | 'plane']
    // the head has moved since the aircraft set off: bend the end of the trip that brought it here to this drop
    // point, so the map shows it flying to where it drops instead of jumping there
    const trk = this.tracks.find((t) => t.id === r.id)!
    const lastMove = trk.moves[trk.moves.length - 1]
    if (lastMove && lastMove.toStep <= this.step + 0.01 && lastMove.toStep >= this.step - 1 && lastMove.path.length > 1) {
      lastMove.path = [...lastMove.path.slice(0, -1), p]
    }
    r.pos = p
    this.drop(target, air)
    this.drops.push({ step: this.step, lat: p[0], lon: p[1] })
    // fly to the nearest usable water source, fill, come back (planes need the sea or a reservoir)
    const sources = this.infra.water.filter((w) => r.kind === 'heli' || w.kind === 'sea' || w.kind === 'reservoir')
    const pool = sources.length ? sources : this.infra.water
    const w = pool.reduce((a, b) => (haversineM(b.pos, p) < haversineM(a.pos, p) ? b : a), pool[0])
    const km = w ? haversineM(w.pos, p) / 1000 : 8
    r.nextDropStep = this.step + Math.max(1, Math.round(((2 * km) / air.kmh) * 6 + air.fillMin / STEP_MIN))
    // the round trip as three legs (fly out, fill, fly back) so the map shows the aircraft going for water
    if (w) {
      // legs scaled to fit exactly between this drop and the next (the engine rounds the cycle to whole steps)
      const k = (r.nextDropStep - this.step) / Math.max(1e-6, 2 * Math.max(0.05, (km / air.kmh) * 6) + air.fillMin / STEP_MIN)
      const fly = Math.max(0.05, (km / air.kmh) * 6) * k
      const fill = (air.fillMin / STEP_MIN) * k
      const tr = this.tracks.find((t) => t.id === r.id)!
      const s0 = this.step
      tr.moves.push({ fromStep: s0, toStep: s0 + fly, path: [p, w.pos], purpose: 'water' })
      tr.moves.push({ fromStep: s0 + fly, toStep: s0 + fly + fill, path: [w.pos, w.pos], purpose: 'refill' })
      tr.moves.push({ fromStep: s0 + fly + fill, toStep: r.nextDropStep - 0.001, path: [w.pos, p], purpose: 'drop' })
      this.scoops.push({ step: s0 + fly, untilStep: s0 + fly + fill, lat: w.pos[0], lon: w.pos[1], kind: r.kind as 'heli' | 'plane' })
    }
  }

  /** The burning cell furthest from the origin in a sector (the head there), or -1. */
  private headCell(sector: number): number {
    let best = -1
    let bd = -1
    for (const c of this.st.burning) {
      if (this.st.burnout[c] <= this.step || this.sectorOfCell(c) !== sector || !this.isEdge(c)) continue
      const d = this.cellDistKm(c)
      if (d > bd) {
        bd = d
        best = c
      }
    }
    return best
  }

  private drop(target: number, air: (typeof AIR)['heli']) {
    const { cols, rows } = this.grid
    const cx = target % cols
    const cy = (target / cols) | 0
    for (let dy = -air.wetR; dy <= air.wetR; dy++)
      for (let dx = -air.wetR; dx <= air.wetR; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue
        const j = y * cols + x
        this.wetUntil[j] = Math.max(this.wetUntil[j], this.step + WET_STEPS)
        if (dx * dx + dy * dy <= air.outR2 && hash3(this.st.seed + 7, j, this.step) < air.p) this.st.extinguish(j)
      }
  }

  private afterStep() {
    const s = this.step
    // spot fires: caught while small by crews working nearby or by aircraft over the fire
    const fresh = this.st.spots.filter((x) => x.step === s)
    if (fresh.length && s >= this.startStep) {
      let caught = 0
      for (const sp of fresh) {
        const p = cellCenter(this.grid, sp.to)
        const near = this.resources.some((r) =>
          isAir(r.kind)
            ? (r.status === 'dropping' || r.status === 'enroute') && haversineM(r.pos, p) < 6000
            : ['attacking', 'building', 'holding', 'mopping'].includes(r.status) && haversineM(r.pos, p) < 1500,
        )
        if (!near || hash3(this.st.seed + 11, sp.to, s) > 0.85) continue
        caught++
        const { cols, rows } = this.grid
        const cx = sp.to % cols
        const cy = (sp.to / cols) | 0
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx
            const y = cy + dy
            if (x >= 0 && y >= 0 && x < cols && y < rows) this.st.extinguish(y * cols + x)
          }
        this.wetAround(sp.to, 1, 3)
      }
      if (caught) this.log('drop', `${caught} sıçrama yangını küçükken yakındaki ekiplerce söndürüldü.`)
      if (fresh.length > caught) this.log('breach', `${fresh.length - caught} kor sıçraması yakında ekip olmadığı için yeni yangın başlattı.`, fresh.length - caught >= 2)
    }
    // per-sector front
    for (const c of this.st.burning) {
      if (this.st.ig[c] !== s) continue
      const k = this.sectorOfCell(c)
      this.sectorMax[k] = Math.max(this.sectorMax[k], this.cellDistKm(c))
    }
    this.sectorHist.push(Array.from(this.sectorMax))
    // breaches
    for (const line of this.lines)
      for (let k = 0; k < line.cells.length; k++) {
        const sec = line.sectorOf[k]
        if (line.breachedStep[sec] !== null) continue
        const t = this.st.ig[line.cells[k]]
        if (t >= line.createdStep && t <= s) {
          line.breachedStep[sec] = s
          this.log('breach', `Yangın ${line.id} sınırını ${SECTORS[sec]} sektöründe aştı.`, true)
        }
      }
    // settlements threatened
    for (const st of this.settlements) {
      if (this.warned.has(st.id) || this.evacs.some((e) => e.settlementId === st.id)) continue
      if (this.fireDistanceKm(st.pos) < 2) {
        this.warned.add(st.id)
        this.log('evac_risk', `Yangın ${st.name} yerleşimine 2 km'den yakın; tahliye kararı verilmedi.`, true)
      }
    }
    // evacuations overrun by the fire
    for (const e of this.evacs) {
      if (e.atRisk || s >= e.doneStep) continue
      const st = this.settlements.find((x) => x.id === e.settlementId)!
      if (this.fireDistanceKm(st.pos) * 1000 < st.radiusM) {
        e.atRisk = true
        this.log('evac_risk', `Yangın ${e.name} sınırına ulaştı, tahliye henüz bitmedi.`, true)
      }
    }
  }

  private fireDistanceKm(p: LatLon): number {
    const c = cellOf(this.grid, p[0], p[1])
    if (c < 0) return 99
    const { cols } = this.grid
    let best = Infinity
    for (const b of this.st.burning) {
      if (this.st.burnout[b] <= this.step) continue
      const d = Math.hypot((b % cols) - (c % cols), ((b / cols) | 0) - ((c / cols) | 0))
      if (d < best) best = d
    }
    return (best * this.grid.cellM) / 1000
  }

  // ---------------------------------------------------------------- context for the commander

  context(trigger: string): CommanderContext {
    this.refreshAvailability()
    const s = this.step
    const res = this.st.result(this.settlements)
    this.hazards = new Map(buildHazards(res, this.infra).map((h) => [h.edge.id, h]))
    const stat = res.series[res.series.length - 1]
    // forecast with no new action: 2 h and 5 h ahead
    const fc = this.st.clone()
    let at2: Uint8Array | null = null
    for (let k = 0; k < 30; k++) {
      fc.step()
      if (k === 11) at2 = burnedMask(fc)
    }
    const at5 = burnedMask(fc)
    at2 ??= at5
    const fcRes = fc.result(this.settlements)
    this.candidates = [
      { id: 'A', hoursAhead: 2, cells: bandOf(this.grid, at2) },
      { id: 'B', hoursAhead: 5, cells: bandOf(this.grid, at5) },
    ]
    const haOf = (m: Uint8Array) => (m.reduce((a, v) => a + v, 0) * this.grid.cellM * this.grid.cellM) / 10000
    const w = weatherAt(this.config, s * STEP_MIN)
    const prevHist = this.sectorHist[Math.max(0, this.sectorHist.length - 7)] ?? new Array(8).fill(0)
    const lh = this.localHour(s)
    const clock = `${String(Math.floor(((lh % 24) + 24) % 24)).padStart(2, '0')}:${String(Math.round((lh % 1) * 60) % 60).padStart(2, '0')}`
    return {
      time: { T: T(s), local_time: clock, daylight: this.daylight(s), response_started: T(this.startStep) },
      trigger,
      fire: {
        total_ha: Math.round(stat.affectedHa),
        burning_ha: Math.round(stat.burningHa),
        front_speed_m_per_h: Math.round(stat.rosMh),
        spreading_toward: stat.headingDeg === null ? null : compass(stat.headingDeg),
        sectors: SECTORS.map((sec, k) => ({
          sector: sec,
          front_km_from_origin: round1(this.sectorMax[k]),
          growth_km_last_hour: round1(this.sectorMax[k] - prevHist[k]),
          burning_ha: Math.round((this.st.burning.filter((c) => this.st.burnout[c] > s && this.sectorOfCell(c) === k).length * this.grid.cellM * this.grid.cellM) / 10000),
        })),
      },
      weather_now: { wind_kmh: Math.round(w.windSpeedKmh), wind_from: compass(w.windFromDeg), humidity_pct: Math.round(w.humidityPct), temperature_c: Math.round(w.temperatureC) },
      weather_next_hours: [1, 2, 3, 4, 5, 6].map((h) => {
        const x = weatherAt(this.config, s * STEP_MIN + h * 60)
        return { T: T(s + h * 6), wind_kmh: Math.round(x.windSpeedKmh), wind_from: compass(x.windFromDeg), humidity_pct: Math.round(x.humidityPct) }
      }),
      forecast_without_new_actions: { area_in_2h_ha: Math.round(haOf(at2)), area_in_5h_ha: Math.round(haOf(at5)) },
      line_candidates: this.candidates.map((c) => {
        const mask = c.id === 'A' ? at2! : at5
        return {
          id: c.id,
          fire_reaches_it_in_h: c.hoursAhead,
          length_km: round1((c.cells.length * this.grid.cellM) / 1000),
          settlements_inside: this.settlements.filter((st) => {
            const sc = cellOf(this.grid, st.pos[0], st.pos[1])
            return sc >= 0 && mask[sc] === 1
          }).map((st) => st.name),
          sectors: SECTORS.map((sec, k) => {
            const d = c.cells.filter((x) => this.sectorOfCell(x) === k).map((x) => this.cellDistKm(x))
            return { sector: sec, radius_km: d.length ? round1(d.reduce((a, b) => a + b, 0) / d.length) : 0 }
          }).filter((x) => x.radius_km > 0),
        }
      }),
      next_line_id: `S${this.lines.length + 1}`,
      lines: this.lines.map((l) => ({
        id: l.id,
        level: l.level,
        created: T(l.createdStep),
        sectors: SECTORS.map((sec, k) => {
          const idx = l.order[k]
          const built = idx.filter((i) => l.builtStep[i] >= 0).length
          return {
            sector: sec,
            built_pct: idx.length ? Math.round((built / idx.length) * 100) : 100,
            breached: l.breachedStep[k] !== null,
            resources: this.resources.filter((r) => r.task?.kind === 'line' && r.task.lineId === l.id && r.task.sector === k).map((r) => r.id),
          }
        }).filter((x) => l.order[SECTORS.indexOf(x.sector)].length > 0),
      })),
      resources: this.resources.map((r) => ({
        id: r.id,
        name: r.name,
        type: KIND_TR[r.kind],
        status: STATUS_TR[r.status],
        task: r.task?.kind === 'line' ? `${r.task.lineId} ${SECTORS[r.task.sector]}` : r.task?.kind === 'drop' ? `su atışı ${SECTORS[r.task.sector]}` : r.task?.kind === 'attack' ? `doğrudan müdahale ${SECTORS[r.task.sector]}` : null,
        eta: r.status === 'enroute' ? T(r.pathTo) : r.status === 'unavailable' ? T(r.availableFromStep) : null,
      })),
      settlements: this.settlements.map((st, i) => {
        const e = this.evacs.find((x) => x.settlementId === st.id)
        const a = fcRes.impacts[i].arrivalMin
        return {
          id: st.id,
          name: st.name,
          population: st.population,
          distance_to_fire_km: round1(this.fireDistanceKm(st.pos)),
          forecast_fire_arrival: a === null ? null : T(Math.round(a / STEP_MIN)),
          evacuation: !e ? 'yok' : s >= e.doneStep ? 'tamamlandı' : `sürüyor (%${Math.round(((s - e.startStep) / Math.max(1, e.doneStep - e.startStep)) * 100)}, bitiş ${T(e.doneStep)})`,
        }
      }),
      recent_events: this.events.slice(-8).map((e) => `${T(e.step)} ${e.text}`),
      previous_decisions: this.decisions.slice(-4).map((d) => ({ T: T(d.step), assessment: d.output.assessment.slice(0, 300), actions: d.applied })),
    }
  }

  // ---------------------------------------------------------------- applying decisions

  apply(output: CommanderOutput, source: 'ai' | 'rules' | 'human', trigger: string, fallbackReason?: string) {
    const s = this.step
    this.refreshAvailability()
    const applied: string[] = []
    const w = weatherAt(this.config, s * STEP_MIN)
    this.lastWind = { speed: w.windSpeedKmh, from: w.windFromDeg }
    this.lastDecisionStep = s
    if (!this.hazards) this.hazards = new Map(buildHazards(this.st.result(this.settlements), this.infra).map((h) => [h.edge.id, h]))
    for (const a of output.actions) applied.push(this.applyAction(a))
    this.decisions.push({ step: s, trigger, source, fallbackReason, output, applied })
    this.hazards = null
  }

  private applyAction(a: CommanderAction): string {
    const sec = a.sector ? SECTORS.indexOf(a.sector) : -1
    const res = a.resource_id ? this.resources.find((r) => r.id === a.resource_id) : undefined
    switch (a.type) {
      case 'establish_line': {
        const c = this.candidates.find((x) => x.id === a.candidate)
        if (!c || !c.cells.length) return `Sınır kurulamadı: ${a.candidate ?? '?'} adayı yok.`
        const id = `S${this.lines.length + 1}`
        const sectorOf = c.cells.map((x) => this.sectorOfCell(x))
        const order: number[][] = SECTORS.map(() => [])
        c.cells.forEach((_, k) => order[sectorOf[k]].push(k))
        const ang = (x: number) => {
          const { cols } = this.grid
          const o = this.st.origin
          return Math.atan2((x % cols) - (o % cols), -(((x / cols) | 0) - ((o / cols) | 0)))
        }
        for (const o of order) o.sort((p, q) => ang(c.cells[p]) - ang(c.cells[q]))
        this.lines.push({ id, level: this.lines.length + 1, hoursAhead: c.hoursAhead, createdStep: this.step, cells: c.cells.slice(), sectorOf, builtStep: c.cells.map(() => -1), breachedStep: SECTORS.map(() => null), order, next: SECTORS.map(() => 0), carry: SECTORS.map(() => 0) })
        return `${id} kuruldu: ${c.hoursAhead} saatlik tahmini çevre, ${round1((c.cells.length * this.grid.cellM) / 1000)} km.`
      }
      case 'attack': {
        if (!res || isAir(res.kind)) return `Doğrudan müdahale yapılamadı: ${a.resource_id ?? '?'} bir kara ekibi değil.`
        if (sec < 0) return 'Doğrudan müdahale yapılamadı: sektör yok.'
        if (res.status === 'unavailable') return `${res.name} henüz hazır değil (${T(res.availableFromStep)}).`
        let target = -1
        let bd = Infinity
        for (const c of this.st.burning) {
          if (this.st.burnout[c] <= this.step || this.sectorOfCell(c) !== sec) continue
          const d = haversineM(cellCenter(this.grid, c), res.pos)
          if (d < bd) { bd = d; target = c }
        }
        if (target < 0) return `${a.sector} sektöründe yanan yer yok; ${res.name} görevlendirilmedi.`
        const route = this.drive(res, cellCenter(this.grid, target))
        res.task = { kind: 'attack', sector: sec }
        res.carry = 0
        res.status = 'enroute'
        res.path = route.path
        res.pathFrom = this.step
        res.pathTo = this.step + route.steps
        this.recordMove(res)
        return `${res.name} → ${a.sector} sektöründe doğrudan müdahale, varış ${T(res.pathTo)}.`
      }
      case 'assign_line': {
        const line = this.lines.find((l) => l.id === a.line_id)
        if (!res || isAir(res.kind)) return `Atanamadı: ${a.resource_id ?? '?'} bir kara ekibi değil.`
        if (!line || sec < 0 || !line.order[sec].length) return `Atanamadı: ${a.line_id ?? '?'} ${a.sector ?? '?'} sektörü yok.`
        if (res.status === 'unavailable') return `${res.name} henüz hazır değil (${T(res.availableFromStep)}).`
        const entry = line.cells[line.order[sec][Math.min(line.next[sec], line.order[sec].length - 1)]]
        const dest = cellCenter(this.grid, entry)
        const route = this.drive(res, dest)
        res.task = { kind: 'line', lineId: line.id, sector: sec }
        res.status = 'enroute'
        res.path = route.path
        res.pathFrom = this.step
        res.pathTo = this.step + route.steps
        this.recordMove(res)
        return `${res.name} → ${line.id}/${a.sector}, varış ${T(res.pathTo)}.`
      }
      case 'air_drop': {
        if (!res || !isAir(res.kind)) return `Su atışı yapılamadı: ${a.resource_id ?? '?'} bir hava aracı değil.`
        if (sec < 0) return 'Su atışı yapılamadı: sektör yok.'
        if (res.status === 'unavailable') return `${res.name} henüz bölgede değil (${T(res.availableFromStep)}).`
        const target = this.headCell(sec)
        const dest = target >= 0 ? cellCenter(this.grid, target) : res.pos
        const steps = Math.max(1, Math.round((haversineM(res.pos, dest) / 1000 / AIR[res.kind as 'heli' | 'plane'].kmh) * 6))
        res.task = { kind: 'drop', sector: sec }
        res.status = this.daylight(this.step) ? 'enroute' : 'grounded'
        res.path = [res.pos, dest]
        res.pathFrom = this.step
        res.pathTo = this.step + steps
        this.recordMove(res)
        return `${res.name} → ${a.sector} sektöründe su atışı${this.daylight(this.step) ? `, ilk atış ${T(res.pathTo)}` : ', gün doğunca'}.`
      }
      case 'evacuate': {
        const st = this.settlements.find((x) => x.id === a.settlement_id)
        if (!st) return `Tahliye başlatılamadı: ${a.settlement_id ?? '?'} yok.`
        if (this.evacs.some((e) => e.settlementId === st.id)) return `${st.name} tahliyesi zaten sürüyor.`
        const safes = this.infra.nodes.filter((x) => x.kind === 'safe')
        let best: { route: ReturnType<typeof findRoute>; to: NetNode } | null = null
        for (const sf of safes) {
          const r = findRoute(this.infra, this.hazards!, st.id, sf.id, this.step * STEP_MIN)
          if (r && (!best || r.etaMin < best.route!.etaMin)) best = { route: r, to: sf }
        }
        const steps = Math.round((30 + (st.population / 8000) * 60) / STEP_MIN) + (best ? Math.round(best.route!.etaMin / STEP_MIN) : 0)
        const ev = { settlementId: st.id, name: st.name, population: st.population, startStep: this.step, doneStep: this.step + steps, atRisk: false, to: best?.to.name ?? 'güvenli alan', geom: best?.route?.geom ?? [], started: true }
        this.evacs.push(ev)
        this.log('evac_start', `${st.name} tahliyesi başladı (${st.population.toLocaleString('en-US')} kişi, hedef ${ev.to}).`)
        return `${st.name} tahliyesi başladı, tahmini bitiş ${T(ev.doneStep)}.`
      }
      case 'withdraw': {
        if (!res) return `Geri çekilemedi: ${a.resource_id ?? '?'} yok.`
        if (isAir(res.kind)) {
          res.task = null
          res.status = this.daylight(this.step) ? 'idle' : 'grounded'
          return `${res.name} görevden alındı.`
        }
        const route = this.drive(res, res.base)
        res.task = { kind: 'return' }
        res.status = 'enroute'
        res.path = route.path
        res.pathFrom = this.step
        res.pathTo = this.step + route.steps
        this.recordMove(res)
        return `${res.name} istasyona dönüyor.`
      }
      case 'hold':
        return 'Mevcut düzen korunuyor.'
    }
  }

  private mopEndStep = Infinity

  /**
   * Mop-up after the fire is out: each ground unit takes a sector of the burned area's edge (where embers next to
   * unburned fuel can rekindle), drives there and patrols along it for four hours; aircraft go back to base.
   */
  private startMopUp() {
    const s = this.step
    const MOP_STEPS = 24
    const PATROL_KMH = 2
    this.mopEndStep = s + MOP_STEPS
    this.hazards = new Map(buildHazards(this.st.result(this.settlements), this.infra).map((h) => [h.edge.id, h]))
    const { cols, rows, kind } = this.grid
    const ig = this.st.ig
    const edge: number[][] = SECTORS.map(() => [])
    for (let i = 0; i < ig.length; i++) {
      if (ig[i] < 0) continue
      const cx = i % cols
      const cy = (i / cols) | 0
      let open = false
      for (let dy = -1; dy <= 1 && !open; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x >= 0 && y >= 0 && x < cols && y < rows && ig[y * cols + x] < 0 && kind[y * cols + x] !== 0) { open = true; break }
        }
      if (open) edge[this.sectorOfCell(i)].push(i)
    }
    const o = this.st.origin
    const ang = (x: number) => Math.atan2((x % cols) - (o % cols), -(((x / cols) | 0) - ((o / cols) | 0)))
    edge.forEach((e) => e.sort((a, b) => ang(a) - ang(b)))
    const sectors = SECTORS.map((_, k) => k).filter((k) => edge[k].length > 0).sort((a, b) => edge[b].length - edge[a].length)
    const applied: string[] = []
    let k = 0
    for (const r of this.resources) {
      if (r.status === 'unavailable') continue
      if (isAir(r.kind)) {
        r.task = { kind: 'return' }
        r.status = 'enroute'
        r.path = [r.pos, r.base]
        r.pathFrom = s
        r.pathTo = s + Math.max(1, Math.round((haversineM(r.pos, r.base) / 1000 / AIR[r.kind as 'heli' | 'plane'].kmh) * 6))
        this.recordMove(r)
        continue
      }
      if (!sectors.length) continue
      const sec = sectors[k++ % sectors.length]
      const cells = edge[sec].filter((_, i) => i % 3 === 0)
      const patrol = cells.map((c) => cellCenter(this.grid, c))
      if (!patrol.length) continue
      const go = this.drive(r, patrol[0])
      let km = 0
      for (let i = 1; i < patrol.length; i++) km += haversineM(patrol[i - 1], patrol[i]) / 1000
      const patrolSteps = Math.max(1, Math.min(MOP_STEPS, Math.round((km / PATROL_KMH) * 6)))
      r.task = { kind: 'mopup', sector: sec, patrolFrom: s + go.steps }
      r.status = 'enroute'
      r.path = [...go.path, ...patrol.slice(1)]
      r.pathFrom = s
      r.pathTo = s + go.steps + patrolSteps
      this.recordMove(r)
      applied.push(`${r.name} → ${SECTORS[sec]} sektöründe yanmış alan kenarında soğutma, devriye ${T(s + go.steps)}–${T(Math.min(this.mopEndStep, s + go.steps + patrolSteps))}.`)
    }
    applied.push(`Hava araçları üsse dönüyor. Soğutma ${T(this.mopEndStep)}'a kadar sürecek, ardından ekipler istasyonlarına dönecek.`)
    this.log('line_done', `Söndürme sonrası soğutma başladı: ekipler yanmış alanın çevresinde devriye geziyor.`)
    this.decisions.push({
      step: s,
      trigger: 'Yangın söndü',
      source: 'rules',
      output: {
        assessment: `Aktif alev kalmadı, ancak yanmış alanın kenarında içten için yanan kütükler ve kökler yangını yeniden başlatabilir. Ekipler çevreyi sektörlere bölüp, yanmamış örtüye bitişik kenarlardan başlayarak soğutma yapıyor.`,
        phase: 'Kontrol ve soğutma',
        actions: applied.map(() => ({ type: 'hold', candidate: null, line_id: null, sector: null, resource_id: null, settlement_id: null, rationale: 'Yeniden alevlenme riski en çok yanmış alanın dış kenarında.' })),
      },
      applied,
    })
  }

  /** End of mop-up: ground units drive back to their stations. */
  private sendHome() {
    for (const r of this.resources) {
      if (isAir(r.kind) || r.status === 'unavailable' || r.status === 'idle') continue
      const go = this.drive(r, r.base)
      r.task = { kind: 'return' }
      r.status = 'enroute'
      r.path = go.path
      r.pathFrom = this.step
      r.pathTo = this.step + go.steps
      this.recordMove(r)
    }
    this.log('line_done', 'Soğutma tamamlandı; ekipler istasyonlarına dönüyor.')
  }

  /** Keeps the trip just ordered, so playback can move the icon along the road instead of between samples. */
  private recordMove(r: Resource) {
    if (r.path && r.path.length > 1) this.tracks.find((t) => t.id === r.id)!.moves.push({
      fromStep: r.pathFrom, toStep: r.pathTo, path: r.path.slice(),
      purpose: r.task?.kind === 'return' ? 'return' : r.task?.kind === 'mopup' ? 'patrol' : 'dispatch',
      ...(r.task?.kind === 'mopup' ? { arrivalStep: r.task.patrolFrom } : {}),
    })
  }

  /** Road route from a resource to a point, plus the off-road leg; returns the path and travel steps. */
  private drive(r: Resource, dest: LatLon): { path: LatLon[]; steps: number } {
    const delay = r.dispatched ? 0 : DISPATCH_DELAY_MIN
    r.dispatched = true
    const junctions = this.infra.nodes.filter((n) => n.kind !== 'safe')
    const near = (p: LatLon) => junctions.reduce((a, b) => (haversineM(b.pos, p) < haversineM(a.pos, p) ? b : a), junctions[0])
    const from = near(r.pos)
    const to = near(dest)
    const route = from && to && this.hazards ? findRoute(this.infra, this.hazards, from.id, to.id, this.step * STEP_MIN + delay) : null
    const offA = haversineM(r.pos, from?.pos ?? r.pos) / 1000
    const offB = haversineM(to?.pos ?? dest, dest) / 1000
    if (!route) {
      const km = haversineM(r.pos, dest) / 1000
      return { path: [r.pos, dest], steps: Math.max(1, Math.round((delay + (km / OFFROAD_KMH[r.kind]) * 60) / STEP_MIN)) }
    }
    const min = delay + route.etaMin + ((offA + offB) / OFFROAD_KMH[r.kind]) * 60
    return { path: [r.pos, ...route.geom, dest], steps: Math.max(1, Math.round(min / STEP_MIN)) }
  }

  // ---------------------------------------------------------------- results

  /** The run so far, with its response record (baseline filled in by finish()). */
  snapshot(baseline?: SimResult): SimResult {
    const steps = this.step
    const res = this.st.result(this.settlements, { ...this.config, durationH: Math.max(1, Math.ceil((steps * STEP_MIN) / 60)) })
    const b = baseline?.series[baseline.series.length - 1]
    res.response = {
      startStep: this.startStep,
      decisions: this.decisions.slice(),
      events: this.events.slice(),
      lines: this.lines.map((l) => ({ id: l.id, level: l.level, hoursAhead: l.hoursAhead, createdStep: l.createdStep, cells: l.cells, sectorOf: l.sectorOf, builtStep: l.builtStep.slice(), breachedStep: l.breachedStep.slice() })),
      tracks: this.tracks.map((t) => ({ ...t, points: t.points.slice(), moves: t.moves.slice() })),
      drops: this.drops.slice(),
      scoops: this.scoops.slice(),
      evacuations: this.evacs.map(({ started: _s, ...e }) => ({ ...e })),
      baseline: b ? { affectedHa: b.affectedHa, forestHa: b.forestHa, settlementsReached: baseline!.impacts.filter((i) => i.arrivalMin !== null).length, steps: baseline!.steps } : { affectedHa: 0, forestHa: 0, settlementsReached: 0, steps: 0 },
      extinguishedStep: this.extinguishedStep,
    }
    return res
  }

  /** The same fire left alone for the same time, then the final result. */
  finish(): SimResult {
    const base = new FireStepper(this.grid, this.config)
    while (base.s < this.step) base.step()
    this.baselineResult = base.result(this.settlements, { ...this.config, durationH: Math.max(1, Math.ceil((this.step * STEP_MIN) / 60)) })
    return this.snapshot(this.baselineResult)
  }

  /** The same fire with no response, filled in by finish(). */
  baselineResult: SimResult | null = null

  /** Safety line candidates of the current decision point (A ~2 h, B ~5 h ahead, C drawn by the user). */
  get lineCandidates(): { id: 'A' | 'B' | 'C'; hoursAhead: number; cells: number[] }[] {
    return this.candidates.map((c) => ({ id: c.id, hoursAhead: c.hoursAhead, cells: c.cells }))
  }

  /** A safety line drawn by hand: offered as candidate "C" at this decision point. */
  setCustomLine(cells: number[]) {
    this.candidates = this.candidates.filter((c) => c.id !== 'C')
    const ok = cells.filter((c) => this.grid.kind[c] !== 0 && this.st.ig[c] === -1)
    if (ok.length) this.candidates.push({ id: 'C', hoursAhead: 0, cells: ok })
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10
const isAir = (k: ResourceKind) => k === 'heli' || k === 'plane'

function burnedMask(st: FireStepper): Uint8Array {
  const m = new Uint8Array(st.ig.length)
  for (let i = 0; i < m.length; i++) if (st.ig[i] >= 0) m[i] = 1
  return m
}

/** Burnable cells just outside a burned area (8-neighbour ring): the line that would stop it. */
function bandOf(grid: Grid, mask: Uint8Array): number[] {
  const { cols, rows, kind } = grid
  const out: number[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (mask[i] || kind[i] === 0) continue
      let edge = false
      for (let dy = -1; dy <= 1 && !edge; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = c + dx
          const y = r + dy
          if (x >= 0 && y >= 0 && x < cols && y < rows && mask[y * cols + x]) { edge = true; break }
        }
      if (edge) out.push(i)
    }
  return out
}

// ---------------------------------------------------------------- rule-based commander

/**
 * Deterministic fallback commander: used when the AI is unavailable, and by the check script. Reads only the
 * context the AI would read.
 */
export function ruleCommander(ctx: CommanderContext): CommanderOutput {
  const actions: CommanderAction[] = []
  const act = (a: Partial<CommanderAction> & Pick<CommanderAction, 'type' | 'rationale'>) =>
    actions.push({ candidate: null, line_id: null, sector: null, resource_id: null, settlement_id: null, ...a })
  const burning = ctx.fire.sectors.filter((x) => x.burning_ha > 0)
  const head = (ctx.fire.spreading_toward as Sector | null) ?? (burning.length ? burning.reduce((a, b) => (b.growth_km_last_hour > a.growth_km_last_hour ? b : a)).sector : 'K')
  const hi = SECTORS.indexOf(head)
  const at = (d: number) => SECTORS[(hi + d + 8) % 8]
  const wind = ctx.weather_now.wind_kmh
  const free = (r: CommanderContext['resources'][number]) => r.status === 'boşta' || r.status === 'geri çekildi'
  const ground = ctx.resources.filter((r) => (r.type === 'arazöz ekibi' || r.type === 'iş makinesi') && free(r))
  const air = ctx.resources.filter((r) => (r.type === 'helikopter' || r.type === 'yangın söndürme uçağı') && free(r))
  const latest = ctx.lines[ctx.lines.length - 1]
  const headBreached = latest?.sectors.some((x) => x.breached && [at(0), at(1), at(-1)].includes(x.sector)) ?? false
  const large = ctx.fire.total_ha > 400 || wind >= 30
  let phase = 'İlk müdahale – kanatlardan doğrudan söndürme'

  // 1. ground units: direct attack on the flanks and the rear; the head too when the wind allows
  const attackOrder = (wind <= 20 ? [0, 1, -1, 2, -2, 3, -3, 4] : [1, -1, 2, -2, 3, -3, 4]).map(at).filter((s) => burning.some((b) => b.sector === s))
  // 2. a large or wind-driven fire also needs a line ahead of the head
  let lineId = latest && !headBreached ? latest.id : null
  if (large && (!latest || headBreached)) {
    const cand = ctx.line_candidates.find((c) => c.id === 'B' && c.length_km > 0) ?? ctx.line_candidates.find((c) => c.length_km > 0)
    if (cand) {
      lineId = ctx.next_line_id
      phase = headBreached ? 'Sınır aşıldı – ikinci güvenlik sınırına geçiş' : 'Dolaylı müdahale – güvenlik sınırı'
      act({ type: 'establish_line', candidate: cand.id, rationale: headBreached ? `Yangın ${latest!.id} sınırını baş tarafta aştı; ${cand.fire_reaches_it_in_h} saatlik tahmini çevreye ikinci güvenlik sınırı kuruluyor.` : `Yangın ${ctx.fire.total_ha} ha ve rüzgar ${wind} km/sa; başı doğrudan durdurulamaz, ${cand.fire_reaches_it_in_h} saat ileriye güvenlik sınırı kuruluyor.` })
    }
  } else if (large) phase = 'Sınır inşası, kanatlarda söndürme'
  let k = 0
  for (const r of ground) {
    // the dozer opens the line at the head; crews work the flanks
    if (lineId && large && r.type === 'iş makinesi') {
      act({ type: 'assign_line', line_id: lineId, sector: head, resource_id: r.id, rationale: `İş makinesi ${head} yönündeki sınırı en hızlı açabilecek kaynak.` })
      continue
    }
    if (lineId && large && k % 3 === 2) {
      const sector = at(k % 2 ? 1 : -1)
      act({ type: 'assign_line', line_id: lineId, sector, resource_id: r.id, rationale: `${sector} kanadında sınır inşasına destek.` })
      k++
      continue
    }
    if (!attackOrder.length) break
    const sector = attackOrder[k++ % attackOrder.length]
    act({ type: 'attack', sector, resource_id: r.id, rationale: sector === head ? `Rüzgar ${wind} km/sa; baş tarafa doğrudan müdahale hâlâ güvenli.` : `${sector} kanadı söndürülürse yangın dar bir kolonda kalır.` })
  }
  // 3. aircraft on the head in daylight
  if (ctx.time.daylight)
    for (const r of air) act({ type: 'air_drop', sector: head, resource_id: r.id, rationale: `Yangının başı ${head} yönünde; su atışı ilerlemeyi yavaşlatır.` })
  // 4. evacuate settlements the fire is forecast to reach, or is close to
  for (const st of ctx.settlements) {
    if (st.evacuation !== 'yok') continue
    if (st.forecast_fire_arrival !== null || st.distance_to_fire_km < 3)
      act({ type: 'evacuate', settlement_id: st.id, rationale: st.forecast_fire_arrival ? `Tahmine göre yangın ${st.forecast_fire_arrival}'da ${st.name} sınırında.` : `Yangın ${st.distance_to_fire_km} km uzakta.` })
  }
  if (!actions.length) act({ type: 'hold', rationale: 'Durum değişmedi; mevcut görevler sürüyor.' })
  return {
    assessment: `${ctx.time.T}: ${ctx.fire.total_ha} ha yandı, yangın ${head} yönünde ilerliyor; rüzgar ${wind} km/sa ${ctx.weather_now.wind_from} yönünden.`,
    phase,
    actions,
  }
}
