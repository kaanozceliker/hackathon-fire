/** Shared display bands for the illustrative regional index; this is not a fire-weather forecast. */
export const HIGH_RISK_THRESHOLD = 65

export const RISK_BANDS = [
  { min: 80, label: 'Aşırı', range: '80–100', color: '#e5483d' },
  { min: HIGH_RISK_THRESHOLD, label: 'Yüksek', range: '65–79', color: '#ee7a2b' },
  { min: 50, label: 'Orta', range: '50–64', color: '#e3a72f' },
  { min: 0, label: 'Düşük', range: '0–49', color: '#3fa564' },
] as const

export const riskBand = (score: number) => RISK_BANDS.find((band) => score >= band.min) ?? RISK_BANDS[RISK_BANDS.length - 1]
