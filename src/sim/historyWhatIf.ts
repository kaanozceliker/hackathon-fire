import type { HistoryFire } from '../data/historyTypes'
import { regionById, defaultConfig } from '../data/regions'
import { getInfrastructure } from '../data/infrastructure'
import { getGrid } from './gridCache'
import { samplePoints } from './weather'
import { ResponseRun, ruleCommander, type RunOptions } from './response'
import type { SimConfig, SimResult, WeatherSeries } from './types'

/**
 * "What if": the past fire run in our own engine on its real area (region 'menderes'), from the estimated ignition
 * at the assumed start time, with the real hourly ERA5 weather of those days and the rule-based response.
 * Run once as it was and once with prevention measures in place, to compare with each other and with reality.
 */

export const WHATIF_REGION = 'menderes'
const HOURS = 72

/** Engine config for the past fire: real hourly weather from the assumed start (same at every sample point). */
export function whatIfConfig(fire: HistoryFire, startIso: string): SimConfig {
  const region = regionById(WHATIF_REGION)
  const grid = getGrid(WHATIF_REGION)
  const w = fire.weather
  const i0 = Math.max(0, w.time.indexOf(startIso))
  const take = (a: number[]) => Array.from({ length: 9 }, () => Array.from({ length: HOURS + 1 }, (_, h) => a[Math.min(a.length - 1, i0 + h)]))
  const weather: WeatherSeries = {
    source: 'open-meteo-archive',
    startIso,
    points: samplePoints(grid),
    temperatureC: take(w.temperatureC),
    humidityPct: take(w.humidityPct),
    windSpeedKmh: take(w.windKmh),
    windFromDeg: take(w.windFromDeg),
    precipMmH: take(w.windKmh.map(() => 0)),
  }
  return { ...defaultConfig(region), durationH: HOURS, weather, temperatureC: weather.temperatureC[4][0], humidityPct: weather.humidityPct[4][0], windSpeedKmh: weather.windSpeedKmh[4][0], windFromDeg: weather.windFromDeg[4][0] }
}

/** One full run with the rule-based commander (fast; no AI calls). */
export function runWhatIf(config: SimConfig, responseStartMin: number, opts?: RunOptions): SimResult {
  const region = regionById(WHATIF_REGION)
  const run = new ResponseRun(getGrid(WHATIF_REGION), config, region.settlements, getInfrastructure(region), responseStartMin, opts)
  for (;;) {
    const a = run.advance()
    if (a.kind === 'end') break
    run.apply(ruleCommander(run.context(a.trigger)), 'rules', a.trigger)
  }
  return run.finish()
}
