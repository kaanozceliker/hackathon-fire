import { compass, fmtDuration } from './geo'
import { getInfrastructure } from '../data/infrastructure'
import { regionById } from '../data/regions'
import { buildResponsePlan } from './planner'
import type { SimResult } from './types'

export interface ReportSection {
  title: string
  lines: string[]
}

const T = (m: number) => `T+${fmtDuration(m)}`
const n0 = (v: number) => Math.round(v).toLocaleString('en-US')

export function buildReport(name: string, res: SimResult): ReportSection[] {
  const c = res.config
  const region = regionById(c.areaId)
  const f = res.series[res.series.length - 1]
  const peakRos = Math.max(...res.series.map((s) => s.rosMh))
  const plan = buildResponsePlan(res, getInfrastructure(region), region.settlements)
  const dangerous = plan.dangerous.slice(0, 3)
  const terrain = { 'coastal-plain': 'düz arazi', 'rolling-hills': 'tepelik arazi', 'steep-mountain': 'dik arazi' }[c.terrain]
  const intensity = { low: 'düşük', medium: 'orta', high: 'yüksek' }[c.intensity]

  return [
    {
      title: 'Simülasyon özeti',
      lines: [
        `Senaryo: ${name}.`,
        `Alan: ${region.name}. Tutuşma noktası ${c.ignition[0].toFixed(4)}°K, ${c.ignition[1].toFixed(4)}°D; başlangıç şiddeti ${intensity}.`,
        `Simülasyon süresi: 110 m'lik ızgarada (${res.grid.cols} × ${res.grid.rows} hücre) 10 dakikalık adımlarla ${c.durationH} sa.`,
        'Bu, sentetik arazi üzerinde temsili bir hücresel otomat simülasyonudur; doğrulanmış bir orman yangını tahmini değildir.',
      ],
    },
    {
      title: 'Çevresel koşullar',
      lines: [
        `Sıcaklık ${c.temperatureC} °C, bağıl nem %${c.humidityPct}, yağış ${c.precipMmH} mm/sa.`,
        `Rüzgar ${c.windSpeedKmh} km/sa, ${compass(c.windFromDeg)} yönünden (${c.windFromDeg}°); yangını ${compass(c.windFromDeg + 180)} yönüne itiyor.`,
        `Arazi: ${terrain}; bitki örtüsü yoğunluğu örnek referansın %${Math.round(c.fuelLoad * 100)} kadarı.`,
      ],
    },
    {
      title: 'Tahmini yangın davranışı',
      lines: [
        `Çalıştırmanın sonunda yangın yaklaşık ${n0(f.affectedHa)} ha alanı etkiliyor; bunun ${n0(f.forestHa)} ha kadarı orman veya maki (${n0(f.pineHa)} ha çam).`,
        `Yangın çevresi yaklaşık ${f.perimeterKm.toFixed(1)} km; en uzak nokta tutuşma noktasından ${f.maxRadiusKm.toFixed(1)} km uzakta.`,
        `En yüksek cephe hızı yaklaşık ${n0(peakRos)} m/sa; yangın başı ${f.headingDeg === null ? 'tek bir yönde ilerlemiyor' : `${compass(f.headingDeg)} yönüne ilerliyor`}.`,
      ],
    },
    {
      title: 'Potansiyel risk alanları',
      lines: plan.threatened.length
        ? plan.threatened.map((s) => `${s.name} (${n0(s.population)} kişi): yangın yerleşim sınırına ${T(s.arrivalMin)} anında ulaşıyor; çevre arazinin %${Math.round(s.exposurePct)} kadarı yanıyor.`)
        : ['Simüle edilen süre içinde çalışma alanındaki hiçbir yerleşime ulaşılmıyor.'],
    },
    {
      title: 'Önerilen müdahale değerlendirmeleri',
      lines: [
        plan.primary ? `Birincil erişim: ${plan.primary.from.name} → ${plan.primary.to.name}, ${plan.primary.distanceKm.toFixed(1)} km, yaklaşık ${Math.round(plan.primary.etaMin)} dk.` : 'Birincil erişim rotası bulunamadı.',
        plan.alternative ? `Alternatif erişim: ${plan.alternative.from.name} → ${plan.alternative.to.name}, ${plan.alternative.distanceKm.toFixed(1)} km, yaklaşık ${Math.round(plan.alternative.etaMin)} dk.` : 'Alternatif erişim rotası bulunamadı.',
        dangerous.length ? `Yangının ilk ulaştığı yollar: ${dangerous.map((d) => `${d.edge.name} (${T(d.fireMin)})`).join(', ')}.` : 'Bu senaryoda yangın hiçbir yola ulaşmıyor.',
        plan.threatened[0] ? `Yangının ilk ulaştığı yerleşim olan ${plan.threatened[0].name} öncelikli olarak değerlendirilmeli.` : 'İzlemeye devam edin; hiçbir yerleşime ulaşılması öngörülmüyor.',
        'Bunlar örnek veriler üzerinde simüle edilmiş karar destek önerileridir; operasyonel talimat değildir.',
      ],
    },
  ]
}

export function reportMarkdown(name: string, res: SimResult): string {
  return [`# ForestGuard raporu – ${name}`, '', '> Temsili simülasyon. Örnek veriler, canlı gözlem değildir.', '', ...buildReport(name, res).flatMap((s) => [`## ${s.title}`, '', ...s.lines.map((l) => `- ${l}`), ''])].join('\n')
}
