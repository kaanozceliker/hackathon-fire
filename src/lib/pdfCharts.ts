import { AQI, aqiOf, type SmokeResult } from '../sim/smoke'
import { regionById } from '../data/regions'
import type { SimResult } from '../sim/types'

/**
 * The report charts as SVG strings for the PDF (pdfmake draws SVG; text uses the document's Roboto font, so Turkish
 * letters work). Light colours for paper.
 */

const INK = '#16231c'
const MUTED = '#5d6b64'
const GRID = '#e2e8e4'
const FONT = 'font-family="Roboto"'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const n0 = (v: number) => Math.round(v).toLocaleString('tr-TR')

/** "Nice" round step for an axis covering 0…max with about `count` ticks. */
function niceStep(max: number, count: number): number {
  const raw = max / count
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)))
  const m = raw / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p
}

/** Burned area over time (area) and the area burning at that moment (line), with the settlement arrivals. */
export function growthSvg(res: SimResult, W = 507, H = 175): string {
  const region = regionById(res.config.areaId)
  const L = 46
  const R = 8
  const Tp = 18
  const B = 22
  const pw = W - L - R
  const ph = H - Tp - B
  const s = res.series
  const hours = s[s.length - 1].minutes / 60 || 1
  const maxHa = Math.max(1, ...s.map((p) => p.affectedHa))
  const step = niceStep(maxHa, 4)
  const top = Math.ceil(maxHa / step) * step
  const x = (h: number) => L + (h / hours) * pw
  const y = (v: number) => Tp + ph - (v / top) * ph
  const pts = s.filter((_, i) => i % 2 === 0 || i === s.length - 1)
  const area = `M${x(0)},${y(0)} ` + pts.map((p) => `L${x(p.minutes / 60).toFixed(1)},${y(p.affectedHa).toFixed(1)}`).join(' ') + ` L${x(hours)},${y(0)} Z`
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.minutes / 60).toFixed(1)},${y(p.burningHa).toFixed(1)}`).join(' ')
  let g = ''
  for (let v = 0; v <= top + 1e-6; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${GRID}" stroke-width="0.6"/><text x="${L - 5}" y="${y(v) + 3}" font-size="7.5" fill="${MUTED}" text-anchor="end" ${FONT}>${n0(v)}</text>`
  const hStep = hours > 36 ? 12 : hours > 12 ? 3 : hours > 4 ? 1 : 0.5
  for (let h = 0; h <= hours + 1e-6; h += hStep) g += `<text x="${x(h)}" y="${H - 8}" font-size="7.5" fill="${MUTED}" text-anchor="middle" ${FONT}>${h}sa</text>`
  const arrivals = res.impacts.map((im, i) => ({ name: region.settlements[i].name, min: im.arrivalMin })).filter((a): a is { name: string; min: number } => a.min !== null).sort((a, b) => a.min - b.min).slice(0, 6)
  let marks = ''
  arrivals.forEach((a, i) => {
    const xx = x(a.min / 60)
    marks += `<line x1="${xx}" x2="${xx}" y1="${Tp - 4}" y2="${Tp + ph}" stroke="${MUTED}" stroke-width="0.7" stroke-dasharray="2 2"/><text x="${xx + (i % 2 ? -2 : 2)}" y="${Tp - 6 + (i % 2) * 8}" font-size="7" fill="${INK}" text-anchor="${i % 2 ? 'end' : 'start'}" ${FONT}>${esc(a.name)}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}<path d="${area}" fill="#e5502a" fill-opacity="0.28" stroke="#d2491f" stroke-width="1.4"/><path d="${line}" fill="none" stroke="#c99a00" stroke-width="1.4"/>${marks}<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="${MUTED}" stroke-width="0.8"/></svg>`
}

export const COVER_COLORS = { pine: '#2f9e5c', forest: '#5cbf86', maquis: '#8fc46a', sparse: '#c2b65e' } as const

/** Donut of the burned cover with the total in the middle. */
export function donutSvg(parts: { ha: number; color: string }[], size = 130): string {
  const total = parts.reduce((s, p) => s + p.ha, 0) || 1
  const c = size / 2
  const r1 = size / 2 - 2
  const r0 = r1 * 0.62
  let a = -Math.PI / 2
  let paths = ''
  for (const p of parts) {
    const da = (p.ha / total) * Math.PI * 2
    if (da <= 0) continue
    const a1 = a + Math.min(da, Math.PI * 2 - 1e-4)
    const big = da > Math.PI ? 1 : 0
    const P = (r: number, t: number) => `${(c + r * Math.cos(t)).toFixed(2)},${(c + r * Math.sin(t)).toFixed(2)}`
    paths += `<path d="M${P(r1, a)} A${r1},${r1} 0 ${big} 1 ${P(r1, a1)} L${P(r0, a1)} A${r0},${r0} 0 ${big} 0 ${P(r0, a)} Z" fill="${p.color}" stroke="#ffffff" stroke-width="1.5"/>`
    a = a1
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}<text x="${c}" y="${c + 2}" font-size="13" font-weight="bold" fill="${INK}" text-anchor="middle" ${FONT}>${n0(total)}</text><text x="${c}" y="${c + 13}" font-size="7.5" fill="${MUTED}" text-anchor="middle" ${FONT}>hektar</text></svg>`
}

/** One row per settlement: the hourly worst PM2.5 as coloured cells and a mark where the fire reached it. */
export function smokeStripSvg(res: SimResult, sm: SmokeResult, W = 507): string {
  const region = regionById(res.config.areaId)
  const hours = Math.max(1, Math.ceil((res.steps * 10) / 60))
  const LBL = 92
  const RT = 4
  const rowH = 14
  const gap = 4
  const Tp = 4
  const n = region.settlements.length
  const H = Tp + n * (rowH + gap) + 26
  const pw = W - LBL - RT
  const cw = pw / hours
  let g = ''
  region.settlements.forEach((st, i) => {
    const yy = Tp + i * (rowH + gap)
    g += `<text x="0" y="${yy + rowH - 4}" font-size="8" fill="${INK}" ${FONT}>${esc(st.name.length > 18 ? st.name.slice(0, 17) + '…' : st.name)}</text>`
    const pm = sm.settlements[i]?.pm
    for (let h = 0; h < hours; h++) {
      let m = 0
      if (pm) for (let s = h * 6; s < Math.min(pm.length, (h + 1) * 6); s++) m = Math.max(m, pm[s])
      g += `<rect x="${(LBL + h * cw + 0.4).toFixed(2)}" y="${yy}" width="${Math.max(0.5, cw - 0.8).toFixed(2)}" height="${rowH}" rx="1" fill="${m < 1 ? '#eef2ef' : aqiOf(m).color}"/>`
    }
    const arr = res.impacts[i]?.arrivalMin
    if (arr !== null && arr !== undefined) {
      const xx = LBL + (arr / 60) * cw
      g += `<path d="M${xx},${yy + rowH + 2} L${xx - 4},${yy - 3} L${xx + 4},${yy - 3} Z" fill="${INK}" stroke="#ffffff" stroke-width="0.8"/>`
    }
  })
  const axisY = Tp + n * (rowH + gap) + 6
  const tick = hours > 36 ? 12 : hours > 12 ? 6 : 2
  for (let h = 0; h <= hours; h += tick) g += `<text x="${LBL + h * cw}" y="${axisY}" font-size="7" fill="${MUTED}" text-anchor="middle" ${FONT}>${h}sa</text>`
  // legend
  let lx = LBL
  const ly = axisY + 10
  for (const a of AQI) {
    g += `<rect x="${lx}" y="${ly - 6}" width="7" height="7" rx="1" fill="${a.color}"/><text x="${lx + 10}" y="${ly}" font-size="6.5" fill="${MUTED}" ${FONT}>${esc(a.name)}</text>`
    lx += 14 + a.name.length * 3.2
  }
  g += `<path d="M${lx + 4},${ly + 1} L${lx},${ly - 7} L${lx + 8},${ly - 7} Z" fill="${INK}"/><text x="${lx + 11}" y="${ly}" font-size="6.5" fill="${MUTED}" ${FONT}>yangın sınıra ulaştı</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg>`
}

/** A thin bar split by risk severity. */
export function severityBarSvg(counts: { n: number; color: string }[], W = 160, H = 8): string {
  const total = counts.reduce((s, c) => s + c.n, 0) || 1
  let x = 0
  let g = ''
  for (const c of counts) {
    if (!c.n) continue
    const w = (c.n / total) * W
    g += `<rect x="${x}" y="0" width="${Math.max(0, w - 1.5)}" height="${H}" rx="2" fill="${c.color}"/>`
    x += w
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg>`
}
