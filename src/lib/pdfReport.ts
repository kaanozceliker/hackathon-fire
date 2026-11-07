import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces'
import { regionById } from '../data/regions'
import { buildReport } from '../sim/report'
import { aqiOf, computeSmoke, exposures } from '../sim/smoke'
import { STEP_MIN } from '../sim/engine'
import { fmtDuration } from '../sim/geo'
import type { SimResult } from '../sim/types'
import { CATEGORY_LABEL, SEVERITY_LABEL, WHEN_LABEL, WHEN_ORDER, type AiReport } from './aiReport'
import { COVER_COLORS, donutSvg, growthSvg, severityBarSvg, smokeStripSvg } from './pdfCharts'

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

export async function downloadReportPdf(name: string, res: SimResult, fileName: string, ai?: { report: AiReport; model?: string }): Promise<void> {
  const pdfMake = await loadPdfMake()
  await new Promise<void>((resolve) => pdfMake.createPdf(reportPdfDefinition(name, res, ai)).download(fileName, () => resolve()))
}

/** The PDF as bytes (used by the check script). */
export async function reportPdfBytes(name: string, res: SimResult, ai?: { report: AiReport; model?: string }): Promise<Uint8Array> {
  const pdfMake = await loadPdfMake()
  return new Promise((resolve) => pdfMake.createPdf(reportPdfDefinition(name, res, ai)).getBuffer((b) => resolve(new Uint8Array(b))))
}

export function reportPdfDefinition(name: string, res: SimResult, ai?: { report: AiReport; model?: string }): TDocumentDefinitions {
  const c = res.config
  const region = regionById(c.areaId)
  const f = res.series[res.series.length - 1]
  const sm = computeSmoke(res)
  const ex = exposures(sm)
  const last = sm.co2T.length - 1
  const peakRos = Math.max(...res.series.map((p) => p.rosMh))
  const reached = res.impacts.filter((i) => i.arrivalMin !== null).length
  const created = new Date().toLocaleString('tr-TR', { dateStyle: 'long', timeStyle: 'short' })

  const box = { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 7, paddingRight: () => 7, paddingTop: () => 5, paddingBottom: () => 5 }
  const h3 = (t: string): Content => ({ text: t, bold: true, fontSize: 10.5, margin: [0, 10, 0, 4] })
  const swatch = (color: string): Content => ({ canvas: [{ type: 'rect', x: 0, y: 2.5, w: 7, h: 7, r: 1, color }], width: 11 } as unknown as Content)

  // key numbers as tiles
  const worst = ex.reduce((a, b) => (b.peakPm > a.peakPm ? b : a), ex[0])
  const worstName = worst ? region.settlements.find((x) => x.id === worst.id)?.name ?? '' : ''
  const firstArr = res.impacts
    .map((im, i) => ({ n: region.settlements[i].name, m: im.arrivalMin }))
    .filter((x): x is { n: string; m: number } => x.m !== null)
    .sort((a, b) => a.m - b.m)[0]
  const tiles: [string, string, string][] = [
    ['Etkilenen alan', `${n0(f.affectedHa)} ha`, `${n0(f.forestHa)} ha orman ve maki`],
    ['Ulaşılan yerleşim', `${reached} / ${res.impacts.length}`, firstArr ? `ilki ${firstArr.n}, ${T(firstArr.m)}` : 'hiçbirine ulaşmadı'],
    ['En hızlı cephe', `${(peakRos / 1000).toFixed(1)} km/sa`, `çevre ${f.perimeterKm.toFixed(1)} km, en uzak ${f.maxRadiusKm.toFixed(1)} km`],
    [res.response ? 'Söndü' : 'Süre', res.response?.extinguishedStep != null ? T(res.response.extinguishedStep * STEP_MIN) : `${c.durationH} sa`, res.response ? `${res.response.decisions.length} komuta kararı` : 'müdahalesiz simülasyon'],
    ['CO₂ salımı', `${n0(sm.co2T[last])} t`, `~${n0(sm.co2T[last] / 4.6)} otomobilin yıllık salımı`],
    ['En kötü hava (PM2.5)', worst ? `${n0(worst.peakPm)} µg/m³` : '–', worst ? `${worstName}, ${aqiOf(worst.peakPm).name}` : ''],
  ]
  const tile = ([k, v, sub]: [string, string, string]): Content => ({
    stack: [{ text: k, fontSize: 8, color: MUTED }, { text: v, fontSize: 15, bold: true, margin: [0, 1, 0, 1] }, { text: sub, fontSize: 7.5, color: MUTED }],
  })
  const cardLayout = { ...box, fillColor: () => '#f3f6f4', hLineWidth: () => 3, vLineWidth: () => 3, hLineColor: () => '#ffffff', vLineColor: () => '#ffffff' }
  const kpiTable: Content = {
    table: { widths: ['*', '*', '*'], body: [tiles.slice(0, 3).map(tile), tiles.slice(3).map(tile)] },
    layout: cardLayout,
    margin: [0, 4, 0, 2],
  }

  // burned cover
  const cover = [
    { label: 'Çam ormanı', ha: f.pineHa, color: COVER_COLORS.pine },
    { label: 'Diğer orman', ha: Math.max(0, f.forestHa - f.pineHa - f.maquisHa), color: COVER_COLORS.forest },
    { label: 'Maki çalılığı', ha: f.maquisHa, color: COVER_COLORS.maquis },
    { label: 'Seyrek / tarım', ha: f.sparseHa, color: COVER_COLORS.sparse },
  ].filter((x) => x.ha >= 1)
  const coverTotal = cover.reduce((a, x) => a + x.ha, 0) || 1
  const coverBlock: Content = {
    columns: [
      { svg: donutSvg(cover, 110), width: 110 },
      {
        stack: cover.map((x): Content => ({ columns: [swatch(x.color), { text: x.label, width: '*' }, { text: `${n0(x.ha)} ha  ·  %${Math.round((x.ha / coverTotal) * 100)}`, alignment: 'right', bold: true, width: 'auto' }], margin: [0, 3, 0, 3] })),
        margin: [14, 22, 0, 0],
        width: '*',
      },
    ],
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
            { columns: [swatch(q.color), { text: q.name, width: 'auto' }] },
            { text: `${e.hoursUnhealthy.toFixed(1)} sa`, alignment: 'right' as const },
          ]
        }),
      ],
    },
    layout: { hLineColor: () => RULE, vLineWidth: () => 0, hLineWidth: (i: number) => (i === 1 ? 0.8 : 0.4), paddingTop: () => 3, paddingBottom: () => 3 },
    fontSize: 8.5,
    margin: [0, 6, 0, 4],
  }

  // the AI's assessment, laid out as cards
  const SEVC = { yuksek: '#d2491f', orta: '#c98500', dusuk: '#8a9ba3' } as const
  const rep = ai?.report
  const aiHead: Content[] = rep
    ? [
        { text: `YAPAY ZEKA DEĞERLENDİRMESİ${ai?.model ? ` · ${ai.model}` : ''}`, fontSize: 7.5, color: FOREST, bold: true, margin: [0, 8, 0, 2] },
        { text: rep.headline, fontSize: 13, bold: true, margin: [0, 0, 0, 3] },
        { text: rep.executive_summary, color: MUTED, margin: [0, 0, 0, 4] },
      ]
    : []
  const findings: Content[] = rep?.key_findings.length
    ? [
        h3('Temel bulgular'),
        {
          table: {
            widths: ['*', '*', '*'],
            body: Array.from({ length: Math.ceil(rep.key_findings.length / 3) }, (_, r) =>
              [0, 1, 2].map((k): Content => {
                const x = rep.key_findings[r * 3 + k]
                return x
                  ? { stack: [{ text: x.title.toLocaleUpperCase('tr'), fontSize: 7, color: MUTED }, { text: x.value, fontSize: 12.5, bold: true, margin: [0, 1, 0, 1] }, { text: x.detail, fontSize: 8, color: MUTED }] }
                  : { text: '', fillColor: '#ffffff' }
              }),
            ),
          },
          layout: cardLayout,
        },
      ]
    : []
  const sevCounts = (['yuksek', 'orta', 'dusuk'] as const).map((k) => ({ k, n: rep?.risks.filter((x) => x.severity === k).length ?? 0 }))
  const risks: Content[] = rep?.risks.length
    ? [
        {
          columns: [
            { text: 'Riskler', bold: true, fontSize: 10.5, margin: [0, 10, 0, 4], width: '*' },
            {
              stack: [
                { svg: severityBarSvg(sevCounts.map((x) => ({ n: x.n, color: SEVC[x.k] }))), width: 140 },
                { text: sevCounts.filter((x) => x.n).map((x) => `${SEVERITY_LABEL[x.k]} ${x.n}`).join('   '), fontSize: 7.5, color: MUTED, margin: [0, 2, 0, 0] },
              ],
              width: 150,
              margin: [0, 12, 0, 0],
            },
          ],
        },
        {
          table: {
            widths: [3, '*'],
            body: rep.risks.map((x) => [
              { text: '', fillColor: SEVC[x.severity] },
              {
                fillColor: '#f7f9f8',
                stack: [
                  { columns: [{ text: CATEGORY_LABEL[x.category] ?? '', fontSize: 7.5, color: MUTED }, { text: SEVERITY_LABEL[x.severity].toLocaleUpperCase('tr'), fontSize: 7.5, bold: true, color: SEVC[x.severity], alignment: 'right' }] },
                  { text: x.title, bold: true },
                  { text: x.detail, fontSize: 8.5, color: MUTED },
                ],
              },
            ]),
          },
          layout: { hLineWidth: () => 4, vLineWidth: () => 0, hLineColor: () => '#ffffff', paddingLeft: (i: number) => (i === 0 ? 0 : 7), paddingRight: () => 4, paddingTop: () => 3, paddingBottom: () => 3 },
        },
      ]
    : []
  const recs: Content[] = rep?.recommendations.length
    ? [
        h3('Öneriler, zamana göre'),
        {
          table: {
            widths: [78, '*'],
            body: WHEN_ORDER.map((w) => ({ w, items: rep.recommendations.map((x, i) => ({ ...x, i })).filter((x) => x.when === w) }))
              .filter((l) => l.items.length)
              .map((l) => [
                { text: WHEN_LABEL[l.w].toLocaleUpperCase('tr'), fontSize: 8, bold: true, color: FOREST },
                { stack: l.items.map((x): Content => ({ columns: [{ text: `${x.i + 1}`, bold: true, color: FOREST, width: 14 }, { stack: [{ text: x.action, bold: true }, { text: x.rationale, fontSize: 8.5, color: MUTED }], width: '*' }], margin: [0, 0, 0, 4] })) },
              ]),
          },
          layout: { hLineColor: () => RULE, vLineWidth: () => 0, hLineWidth: (i: number) => (i === 0 ? 0 : 0.5), paddingTop: () => 5, paddingBottom: () => 3 },
        },
      ]
    : []
  const message: Content[] = rep
    ? [
        {
          table: { widths: ['*'], body: [[{ stack: [{ text: 'HALKA BİLGİLENDİRME', fontSize: 7.5, bold: true, color: FOREST }, { text: rep.public_message, margin: [0, 2, 0, 0] }] }]] },
          layout: { ...box, fillColor: () => '#eaf4ee' },
          margin: [0, 10, 0, 4],
        },
        { text: rep.caveats, color: MUTED, fontSize: 8 },
      ]
    : []

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
      ...aiHead,
      kpiTable,
      ...findings,
      h3('Yangının büyümesi'),
      { text: 'Turuncu alan toplam etkilenen alan, sarı çizgi o an yanan alan; kesikli çizgiler yangının yerleşim sınırına ulaştığı an.', fontSize: 7.5, color: MUTED, margin: [0, 0, 0, 4] },
      { svg: growthSvg(res), width: 507 },
      { stack: [h3('Yanan örtü'), coverBlock], unbreakable: true },
      { stack: [h3('Yerleşimler: saat saat duman ve yangının varışı'), { svg: smokeStripSvg(res, sm), width: 507 }], unbreakable: true },
      settlementTable,
      { text: `"Sağlıksız": PM2.5 55,5 µg/m³ ve üstünde geçen süre. Adım ${STEP_MIN} dakika. Renkler ABD EPA PM2.5 kategorileri.`, color: MUTED, fontSize: 8 },
      ...risks,
      ...recs,
      ...message,
      { text: 'Ayrıntılı metin raporu', fontSize: 14, bold: true, margin: [0, 22, 0, 4] },
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
