import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces'
import { regionById } from '../data/regions'
import { buildReport } from '../sim/report'
import { aqiOf, computeSmoke, exposures } from '../sim/smoke'
import { STEP_MIN } from '../sim/engine'
import { fmtDuration } from '../sim/geo'
import type { SimResult } from '../sim/types'

/**
 * Builds the scenario report as a PDF and downloads it. pdfmake and its Roboto font (which covers Turkish letters)
 * are loaded only when this runs, so they stay out of the main bundle.
 */

const n0 = (v: number) => Math.round(v).toLocaleString('en-US')
const T = (min: number) => `T+${fmtDuration(min)}`
const INK = '#16231c'
const MUTED = '#5d6b64'
const FOREST = '#2c7a4b'
const RULE = '#d5ddd8'

async function loadPdfMake() {
  const [pdfMod, vfsMod] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')])
  const pdfMake = ((pdfMod as unknown as { default?: unknown }).default ?? pdfMod) as typeof import('pdfmake/build/pdfmake')
  const vfs = ((vfsMod as unknown as { default?: unknown }).default ?? vfsMod) as Record<string, string>
  ;(pdfMake as unknown as { vfs: Record<string, string> }).vfs = vfs
  return pdfMake
}

export async function downloadReportPdf(name: string, res: SimResult, fileName: string): Promise<void> {
  const pdfMake = await loadPdfMake()
  await new Promise<void>((resolve) => pdfMake.createPdf(reportPdfDefinition(name, res)).download(fileName, () => resolve()))
}

/** The PDF as bytes (used by the check script). */
export async function reportPdfBytes(name: string, res: SimResult): Promise<Uint8Array> {
  const pdfMake = await loadPdfMake()
  return new Promise((resolve) => pdfMake.createPdf(reportPdfDefinition(name, res)).getBuffer((b) => resolve(new Uint8Array(b))))
}

export function reportPdfDefinition(name: string, res: SimResult): TDocumentDefinitions {
  const c = res.config
  const region = regionById(c.areaId)
  const f = res.series[res.series.length - 1]
  const sm = computeSmoke(res)
  const ex = exposures(sm)
  const last = sm.co2T.length - 1
  const peakRos = Math.max(...res.series.map((p) => p.rosMh))
  const reached = res.impacts.filter((i) => i.arrivalMin !== null).length
  const created = new Date().toLocaleString('tr-TR', { dateStyle: 'long', timeStyle: 'short' })

  const kv = (k: string, v: string): Content[] => [{ text: k, color: MUTED }, { text: v, bold: true, alignment: 'right' }]
  const summary: Content = {
    table: {
      widths: ['*', 'auto', '*', 'auto'],
      body: [
        [...kv('Etkilenen alan', `${n0(f.affectedHa)} ha`), ...kv('Yangın çevresi', `${f.perimeterKm.toFixed(1)} km`)],
        [...kv('Orman ve maki', `${n0(f.forestHa)} ha`), ...kv('En yüksek cephe hızı', `${n0(peakRos)} m/sa`)],
        [...kv('Ulaşılan yerleşimler', `${reached} / ${res.impacts.length}`), ...kv('En uzak nokta', `${f.maxRadiusKm.toFixed(1)} km`)],
        [...kv('CO₂ salımı', `${n0(sm.co2T[last])} t`), ...kv('PM2.5 salımı', `${n0(sm.pmT[last])} t`)],
      ],
    },
    layout: { hLineColor: () => RULE, vLineWidth: () => 0, hLineWidth: (i) => (i === 0 ? 0 : 0.5), paddingTop: () => 4, paddingBottom: () => 4 },
    margin: [0, 6, 0, 10],
  }

  const settlementTable: Content = {
    table: {
      headerRows: 1,
      widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'],
      body: [
        ['Yerleşim', 'Nüfus', 'Yangın varışı', 'Tepe PM2.5', 'Kategori', 'Sağlıksız'].map((h) => ({ text: h, bold: true, fontSize: 8.5, color: MUTED })),
        ...region.settlements.map((st, i) => {
          const e = ex[i]
          const a = res.impacts[i].arrivalMin
          const q = aqiOf(e.peakPm)
          return [
            { text: st.name },
            { text: n0(st.population), alignment: 'right' as const },
            { text: a === null ? 'ulaşmıyor' : T(a), alignment: 'right' as const },
            { text: `${n0(e.peakPm)} µg/m³`, alignment: 'right' as const },
            { text: q.name, color: q.color },
            { text: `${e.hoursUnhealthy.toFixed(1)} sa`, alignment: 'right' as const },
          ]
        }),
      ],
    },
    layout: { hLineColor: () => RULE, vLineWidth: () => 0, hLineWidth: (i) => (i === 1 ? 0.8 : 0.4), paddingTop: () => 3, paddingBottom: () => 3 },
    fontSize: 9,
    margin: [0, 4, 0, 4],
  }

  const sections: Content[] = buildReport(name, res).flatMap((s): Content[] => [
    { text: s.title, style: 'h2' },
    { ul: s.lines.map((l) => ({ text: l, margin: [0, 0, 0, 3] as [number, number, number, number] })), margin: [0, 0, 0, 6] },
  ])

  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [44, 48, 44, 56],
    info: { title: `ForestGuard raporu – ${name}`, creator: 'ForestGuard' },
    defaultStyle: { font: 'Roboto', fontSize: 10, color: INK, lineHeight: 1.2 },
    styles: {
      h1: { fontSize: 18, bold: true, color: INK },
      h2: { fontSize: 12, bold: true, color: FOREST, margin: [0, 10, 0, 4] },
    },
    content: [
      { text: 'ForestGuard raporu', style: 'h1' },
      { text: name, fontSize: 12, margin: [0, 2, 0, 0] },
      { text: `${region.name} · ${c.durationH} saatlik simülasyon · oluşturulma ${created}`, color: MUTED, fontSize: 9, margin: [0, 2, 0, 8] },
      {
        table: { widths: ['*'], body: [[{ text: 'Temsili simülasyon. Sonuçlar doğrulanmış bir yangın veya duman tahmini değildir; operasyonel talimat yerine geçmez.', color: '#8a5a00', fontSize: 9 }]] },
        layout: { fillColor: () => '#fff4dc', hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6 },
      },
      { text: 'Özet', style: 'h2' },
      summary,
      { text: 'Yerleşimler: yangın ve duman', style: 'h2' },
      settlementTable,
      { text: `"Sağlıksız": PM2.5 55,5 µg/m³ ve üstünde geçen süre. Adım ${STEP_MIN} dakika.`, color: MUTED, fontSize: 8 },
      ...sections,
      { text: 'Veri kaynakları', style: 'h2' },
      {
        text: 'Arazi örtüsü: ESA WorldCover 10 m 2021 (CC BY 4.0). Yükselti: Copernicus DEM GLO-30. Yollar, yerleşimler, istasyonlar: © OpenStreetMap katkıcıları (ODbL). Hava: Open-Meteo (CC BY 4.0) veya senaryodaki sabit değerler. Tür kayıtları: GBIF.org. Emisyon faktörleri: Andreae ve Merlet (2001). Hava kalitesi kategorileri: ABD EPA PM2.5 endeksi.',
        color: MUTED,
        fontSize: 8.5,
      },
    ],
    footer: (page, pages) => ({
      columns: [
        { text: 'ForestGuard · temsili simülasyon', color: MUTED, fontSize: 8 },
        { text: `${page} / ${pages}`, alignment: 'right', color: MUTED, fontSize: 8 },
      ],
      margin: [44, 20, 44, 0],
    }),
  }

  return doc
}
