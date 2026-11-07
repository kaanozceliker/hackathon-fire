import type { LatLon } from './geo'
import type { Grid, SimConfig, WeatherSeries } from './types'

/**
 * Hourly, spatially varying weather.
 *
 * Open-Meteo (https://open-meteo.com, CC BY 4.0) is sampled at 3×3 points over the grid; every cell gets values by
 * bilinear interpolation between them. Wind is interpolated as u/v components so directions average correctly.
 * Without a series the scenario's fixed values apply everywhere for the whole run.
 */

const FRACTIONS = [1 / 6, 1 / 2, 5 / 6]
const HOURLY = 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m'
const TZ = 'Europe/Istanbul'
/** Open-Meteo's archive (ERA5) lags real time by about five days; newer hours come from the forecast API. */
const ARCHIVE_LAG_DAYS = 6

export function samplePoints(grid: Grid): LatLon[] {
  const pts: LatLon[] = []
  for (const fy of FRACTIONS)
    for (const fx of FRACTIONS) pts.push([grid.lat0 - fy * grid.rows * grid.dLat, grid.lon0 + fx * grid.cols * grid.dLon])
  return pts
}

/** "2026-07-28T13:00" for the current local hour in Türkiye. */
export function currentLocalHour(): string {
  const now = new Date(Date.now() + 3 * 3600_000) // Türkiye is UTC+3 all year
  return now.toISOString().slice(0, 13) + ':00'
}

export async function fetchWeather(grid: Grid, startIso: string, hours: number): Promise<WeatherSeries> {
  const pts = samplePoints(grid)
  const lat = pts.map((p) => p[0].toFixed(4)).join(',')
  const lon = pts.map((p) => p[1].toFixed(4)).join(',')
  const startMs = Date.parse(startIso + ':00Z') - 3 * 3600_000
  const endIso = new Date(startMs + 3 * 3600_000 + hours * 3600_000).toISOString().slice(0, 13) + ':00'
  const archive = startMs + hours * 3600_000 < Date.now() - ARCHIVE_LAG_DAYS * 86400_000
  const url = archive
    ? `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&hourly=${HOURLY}&timezone=${encodeURIComponent(TZ)}&start_date=${startIso.slice(0, 10)}&end_date=${endIso.slice(0, 10)}`
    : `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${HOURLY}&timezone=${encodeURIComponent(TZ)}&wind_speed_unit=kmh&start_hour=${startIso}&end_hour=${endIso}`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.reason ?? `Open-Meteo ${res.status}`)
  }
  const json = await res.json()
  const list: any[] = Array.isArray(json) ? json : [json]
  const take = (key: string) =>
    list.map((loc) => {
      const i0 = (loc.hourly.time as string[]).indexOf(startIso)
      if (i0 < 0) throw new Error('İstenen başlangıç saati için hava verisi yok.')
      const vals = (loc.hourly[key] as (number | null)[]).slice(i0, i0 + hours + 1)
      if (vals.length < hours + 1 || vals.some((v) => v === null)) throw new Error('Seçilen süre için hava verisi eksik.')
      return vals as number[]
    })
  return {
    source: archive ? 'open-meteo-archive' : 'open-meteo-forecast',
    startIso,
    points: pts,
    temperatureC: take('temperature_2m'),
    humidityPct: take('relative_humidity_2m'),
    windSpeedKmh: take('wind_speed_10m'),
    windFromDeg: take('wind_direction_10m'),
    precipMmH: take('precipitation'),
  }
}

/** Per-cell weather for one hour of the run. Wind direction is the way it blows TO, radians clockwise from north. */
export interface CellWeather {
  temperatureC: Float32Array
  humidityPct: Float32Array
  windSpeedKmh: Float32Array
  windToRad: Float32Array
  precipMmH: Float32Array
}

const clampHour = (w: WeatherSeries, h: number) => Math.max(0, Math.min(w.windSpeedKmh[0].length - 1, h))

export function cellWeather(grid: Grid, config: SimConfig, hour: number): CellWeather {
  const n = grid.cols * grid.rows
  const out: CellWeather = {
    temperatureC: new Float32Array(n),
    humidityPct: new Float32Array(n),
    windSpeedKmh: new Float32Array(n),
    windToRad: new Float32Array(n),
    precipMmH: new Float32Array(n),
  }
  const w = config.weather
  if (!w) {
    const d = diurnal(config, hour)
    out.temperatureC.fill(d.temperatureC)
    out.humidityPct.fill(d.humidityPct)
    out.windSpeedKmh.fill(d.windSpeedKmh)
    out.windToRad.fill((((config.windFromDeg + 180) % 360) * Math.PI) / 180)
    out.precipMmH.fill(config.precipMmH)
    return out
  }
  const h = clampHour(w, hour)
  const u: number[] = []
  const v: number[] = []
  for (let p = 0; p < 9; p++) {
    const to = ((w.windFromDeg[p][h] + 180) * Math.PI) / 180
    u.push(w.windSpeedKmh[p][h] * Math.sin(to))
    v.push(w.windSpeedKmh[p][h] * Math.cos(to))
  }
  const val = (arr: number[][], p: number) => arr[p][h]
  for (let r = 0; r < grid.rows; r++) {
    const fy = (r + 0.5) / grid.rows
    const [y0, ty] = axis(fy)
    for (let c = 0; c < grid.cols; c++) {
      const fx = (c + 0.5) / grid.cols
      const [x0, tx] = axis(fx)
      const i = r * grid.cols + c
      const bl = (f: (p: number) => number) => {
        const a = f(y0 * 3 + x0)
        const b = f(y0 * 3 + x0 + 1)
        const d = f((y0 + 1) * 3 + x0)
        const e = f((y0 + 1) * 3 + x0 + 1)
        return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty
      }
      const uu = bl((p) => u[p])
      const vv = bl((p) => v[p])
      out.windSpeedKmh[i] = Math.hypot(uu, vv)
      out.windToRad[i] = Math.atan2(uu, vv)
      out.temperatureC[i] = bl((p) => val(w.temperatureC, p))
      out.humidityPct[i] = bl((p) => val(w.humidityPct, p))
      out.precipMmH[i] = bl((p) => val(w.precipMmH, p))
    }
  }
  return out
}

/** Index of the lower sample row/column and the blend factor for a 0–1 position across the grid. */
function axis(f: number): [number, number] {
  if (f <= FRACTIONS[0]) return [0, 0]
  if (f >= FRACTIONS[2]) return [1, 1]
  const k = f < FRACTIONS[1] ? 0 : 1
  return [k, (f - FRACTIONS[k]) / (FRACTIONS[k + 1] - FRACTIONS[k])]
}

export interface WeatherNow {
  temperatureC: number
  humidityPct: number
  windSpeedKmh: number
  windFromDeg: number
  precipMmH: number
}

/** Weather at the grid centre at a given minute of the run (the fixed values when there is no series). */
/** Fixed weather start at 13:00 local; the values entered are the afternoon peak (15:00). */
export const FIXED_START_HOUR = 13

/**
 * Daily cycle for fixed weather: the entered values hold in the mid-afternoon; towards 03:00 humidity rises by up to
 * 25 points, temperature falls by up to 9 °C and wind drops to about half. This is why real fires lie down at night.
 */
export function diurnal(config: SimConfig, hour: number) {
  const local = FIXED_START_HOUR + hour
  const night = (1 - Math.cos((2 * Math.PI * (local - 15)) / 24)) / 2 // 0 at 15:00, 1 at 03:00
  return {
    temperatureC: config.temperatureC - 9 * night,
    humidityPct: Math.min(95, config.humidityPct + 25 * night),
    windSpeedKmh: config.windSpeedKmh * (1 - 0.45 * night),
  }
}

export function weatherAt(config: SimConfig, minutes: number): WeatherNow {
  const w = config.weather
  if (!w) return { ...diurnal(config, Math.floor(minutes / 60)), windFromDeg: config.windFromDeg, precipMmH: config.precipMmH }
  const h = clampHour(w, Math.floor(minutes / 60))
  const C = 4
  return {
    temperatureC: w.temperatureC[C][h],
    humidityPct: w.humidityPct[C][h],
    windSpeedKmh: w.windSpeedKmh[C][h],
    windFromDeg: w.windFromDeg[C][h],
    precipMmH: w.precipMmH[C][h],
  }
}

/** Hourly weather at the grid centre, for charts. */
export function weatherSeries(config: SimConfig): (WeatherNow & { h: number })[] {
  return Array.from({ length: config.durationH + 1 }, (_, h) => ({ h, ...weatherAt(config, h * 60) }))
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

/** First hour the centre wind has turned more than 45° from the start, if it does (and is strong enough to matter). */
export function windShift(config: SimConfig): { hour: number; fromDeg: number; toDeg: number } | null {
  if (!config.weather) return null
  const s = weatherSeries(config)
  for (const p of s) if (p.windSpeedKmh >= 8 && angleDiff(p.windFromDeg, s[0].windFromDeg) > 45) return { hour: p.h, fromDeg: s[0].windFromDeg, toDeg: p.windFromDeg }
  return null
}

/** Weather fields of the config replaced by the series' first hour at the centre, so sliders show where the run starts. */
export function withStartValues(config: SimConfig): SimConfig {
  if (!config.weather) return config
  const w = weatherAt(config, 0)
  return { ...config, temperatureC: Math.round(w.temperatureC), humidityPct: Math.round(w.humidityPct), windSpeedKmh: Math.round(w.windSpeedKmh), windFromDeg: Math.round(w.windFromDeg / 5) * 5 % 360, precipMmH: Math.round(w.precipMmH * 2) / 2 }
}
