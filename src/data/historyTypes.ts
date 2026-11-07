/** Shape of a past fire baked by scripts/bake-history.ts. */
export interface HistoryFire {
  id: string
  name: string
  started: string
  bounds: [[number, number], [number, number]]
  cols: number
  rows: number
  cellM: number
  centre: [number, number]
  pre: string
  passes: { date: string; time: string; burnedHa: number }[]
  /** Base64, one byte per cell: 0 not burned, k = first seen burned at passes[k-1]. */
  firstPass: string
  weather: { time: string[]; temperatureC: number[]; humidityPct: number[]; windKmh: number[]; gustKmh: number[]; windFromDeg: number[] }
}
