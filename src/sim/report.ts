import { compass, fmtDuration } from './geo'
import { weatherSeries, windShift } from './weather'
import { aqiOf, computeSmoke, exposures } from './smoke'
import { STEP_MIN } from './engine'
import { SPECIES } from '../data/species.generated'
import { getInfrastructure } from '../data/infrastructure'
import { regionById } from '../data/regions'
import { buildResponsePlan } from './planner'
import type { SimResult } from './types'
import { SEVERITY_LABEL, WHEN_LABEL, type AiReport } from '../lib/aiReport'

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
        `Simülasyon süresi: ${res.grid.cellM} m'lik ızgarada (${res.grid.cols} × ${res.grid.rows} hücre) ${res.stepMin} dakikalık adımlarla ${c.durationH} sa.`,
        'Bu, arazi girdileri ve temsili parametrelerle çalışan bir hücresel otomat simülasyonudur; doğrulanmış bir orman yangını tahmini değildir.',
      ],
    },
    {
      title: 'Çevresel koşullar',
      lines: [
        ...(c.weather ? hourlyWeatherLines(c) : [
          `Sıcaklık ${c.temperatureC} °C, bağıl nem %${c.humidityPct}, yağış ${c.precipMmH} mm/sa.`,
          `Rüzgar ${c.windSpeedKmh} km/sa, ${compass(c.windFromDeg)} yönünden (${c.windFromDeg}°); yangını ${compass(c.windFromDeg + 180)} yönüne itiyor.`,
        ]),
        `Arazi: ${terrain}; bitki örtüsü yoğunluğu örnek referansın %${Math.round(c.fuelLoad * 100)} kadarı.`,
        ...(c.landAuto
          ? [
              `Arazi ve yakıt otomatik belirlendi: 1,5 km içinde ortalama eğim %${Math.round(c.landAuto.terrain.meanSlopePct)} (Copernicus DEM); ${'ndmi' in c.landAuto.fuel ? `bitki nem indeksi NDMI ${c.landAuto.fuel.ndmi.toFixed(2)} (Sentinel-2, ${c.landAuto.fuel.date})` : `uydu verisi alınamadı, ayın tipik kuruluğu kullanıldı`}.`,
            ]
          : []),
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
    ...smokeSections(res),
    ...(res.response ? [responseSection(res)] : []),
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

function hourlyWeatherLines(c: SimResult['config']): string[] {
  const s = weatherSeries(c)
  const range = (k: 'windSpeedKmh' | 'humidityPct' | 'temperatureC') => `${Math.round(Math.min(...s.map((p) => p[k])))}–${Math.round(Math.max(...s.map((p) => p[k])))}`
  const src = c.weather!.source === 'open-meteo-archive' ? 'Open-Meteo arşivi (ERA5)' : c.weather!.source === 'open-meteo-forecast' ? 'Open-Meteo tahmini' : 'özel seri'
  const shift = windShift(c)
  return [
    `Hava: ${src}, ${c.weather!.startIso.replace('T', ' ')} başlangıçlı saatlik veri, ızgarada 9 noktadan enterpole edildi.`,
    `Sıcaklık ${range('temperatureC')} °C, bağıl nem %${range('humidityPct')}, toplam yağış ${s.reduce((a, p) => a + p.precipMmH, 0).toFixed(1)} mm.`,
    `Rüzgar ${range('windSpeedKmh')} km/sa; başlangıçta ${compass(s[0].windFromDeg)} yönünden esiyor.`,
    shift
      ? `Rüzgar T+${shift.hour}:00'da ${compass(shift.fromDeg)} yönünden ${compass(shift.toDeg)} yönüne döndü; yayılım yönü buna göre değişir.`
      : 'Simüle edilen süre boyunca rüzgar yönünde 45°yi aşan bir dönüş yok.',
  ]
}

/** What the commander did and what it achieved, for runs from the Komuta Merkezi. */
function responseSection(res: SimResult): ReportSection {
  const r = res.response!
  const f = res.series[res.series.length - 1]
  const ai = r.decisions.filter((d) => d.source === 'ai').length
  const phases = [...new Set(r.decisions.map((d) => d.output.phase))]
  const key = r.decisions.filter((d, i) => i === 0 || d.output.phase !== r.decisions[i - 1].output.phase).slice(0, 6)
  return {
    title: 'Müdahale ve komuta kararları',
    lines: [
      `Müdahale ${T(r.startStep * STEP_MIN)}'da başladı; ${r.decisions.length} karar verildi (${ai} tanesi yapay zeka komutanı ChatGPT'den, ${r.decisions.length - ai} tanesi kural tabanlı).`,
      r.extinguishedStep !== null ? `Yangın ${T(r.extinguishedStep * STEP_MIN)}'da söndü.` : `Simülasyon ${T(res.steps * STEP_MIN)}'da sona erdi; yangın sönmedi.`,
      `Müdahaleyle ${n0(f.affectedHa)} ha yandı; müdahale olmasaydı aynı sürede ${n0(r.baseline.affectedHa)} ha yanacaktı (${n0(Math.max(0, r.baseline.affectedHa - f.affectedHa))} ha kurtarıldı). Yangının ulaştığı yerleşim: ${res.impacts.filter((i) => i.arrivalMin !== null).length}, müdahalesiz ${r.baseline.settlementsReached}.`,
      `Evreler: ${phases.join(' → ')}.`,
      ...key.map((d) => `${T(d.step * STEP_MIN)} – ${d.output.phase}: ${d.output.assessment}`),
      `Güvenlik sınırları: ${r.lines.length ? r.lines.map((l) => `${l.id} (${l.hoursAhead} saatlik tahmini çevre, %${Math.round((l.builtStep.filter((b) => b >= 0).length / Math.max(1, l.cells.length)) * 100)} açıldı, ${l.breachedStep.filter((b) => b !== null).length}/8 sektörde aşıldı)`).join('; ') : 'kurulmadı'}. Su atışı: ${r.drops.length}.`,
      r.evacuations.length ? `Tahliyeler: ${r.evacuations.map((e) => `${e.name} (${n0(e.population)} kişi, ${T(e.startStep * STEP_MIN)}–${T(e.doneStep * STEP_MIN)}${e.atRisk ? ', yangın tahliye bitmeden ulaştı' : ''})`).join('; ')}.` : 'Tahliye kararı verilmedi.',
      'Söndürme etkileri basitleştirilmiştir; komutanın kararları doğrulanmış yangın taktiği değildir.',
    ],
  }
}

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']
const CLASS_TR = { mammal: 'memeli', bird: 'kuş', reptile: 'sürüngen', amphibian: 'amfibi' } as const
const CAR_T_PER_YEAR = 4.6

/** Emissions, effects on people from smoke, and effects on wildlife. Screening estimates, labelled as such. */
function smokeSections(res: SimResult): ReportSection[] {
  const sm = computeSmoke(res)
  const ex = exposures(sm)
  const region = regionById(res.config.areaId)
  const f = res.series[res.series.length - 1]
  const last = sm.co2T.length - 1
  const peakRos = Math.max(...res.series.map((p) => p.rosMh))

  // --- emissions ---
  const worstCo = ex.reduce((a, b) => (b.peakCoPpm > a.peakCoPpm ? b : a), ex[0])
  const worstCoName = worstCo ? region.settlements.find((s) => s.id === worstCo.id)?.name : null
  const emissions: ReportSection = {
    title: 'Emisyonlar: CO₂, CO ve duman',
    lines: [
      `Yaklaşık ${n0(sm.biomassT[last])} t kuru biyokütle yandı. Salım: ${n0(sm.co2T[last])} t CO₂, ${n0(sm.coT[last])} t CO, ${n0(sm.pmT[last])} t PM2.5 (emisyon faktörleri Andreae ve Merlet 2001, yaklaşık).`,
      `Bu CO₂, yaklaşık ${n0(sm.co2T[last] / CAR_T_PER_YEAR)} otomobilin bir yıllık salımına denk (otomobil başına ~4,6 t/yıl, ABD EPA).`,
      'CO₂ yerleşimlerde sağlığı etkileyecek yoğunluğa ulaşmaz; etkisi iklim üzerindendir. Yakın çevrede asıl sağlık riski ince partikül (PM2.5) ve karbonmonoksittir.',
      worstCo && worstCoName
        ? worstCo.peakCoPpm > 9
          ? `Yerleşimlerde en yüksek CO ${worstCo.peakCoPpm.toFixed(1)} ppm (${worstCoName}). Bu, 8 saatlik 9 ppm sınırının üstünde: baş ağrısı, baş dönmesi ve kalp hastalarında göğüs ağrısı görülebilir.`
          : `Yerleşimlerde en yüksek CO ${worstCo.peakCoPpm.toFixed(1)} ppm (${worstCoName}); 8 saatlik 9 ppm sınırının altında. CO, asıl olarak yangın hattında çalışan ekipler için risk oluşturur.`
        : 'Çalışma alanında yerleşim yok.',
    ],
  }

  // --- people ---
  const hit = ex
    .map((e, i) => ({ e, st: region.settlements[i] }))
    .filter(({ e }) => e.firstSensitiveStep !== null)
    .sort((a, b) => a.e.firstSensitiveStep! - b.e.firstSensitiveStep!)
  const worst = hit.reduce((m, { e }) => Math.max(m, e.peakPm), 0)
  const people: ReportSection = {
    title: 'Dumanın insanlara etkisi',
    lines: hit.length
      ? [
          ...hit.map(({ e, st }) => {
            const peak = aqiOf(e.peakPm)
            return `${st.name} (${n0(st.population)} kişi): duman ${T(e.firstSensitiveStep! * STEP_MIN)} anında hassas gruplar için sağlıksız düzeye çıkıyor; tepe ${n0(e.peakPm)} µg/m³ PM2.5 (${peak.name}, ${T(e.peakStep * STEP_MIN)}). ${e.hoursUnhealthy.toFixed(1)} saat "sağlıksız" ve üstünde kalıyor${e.ongoing ? '; simülasyon sonunda duman hâlâ yoğun' : ''}.`
          }),
          worst > 55.4
            ? 'Etki: göz, burun ve boğaz tahrişi, öksürük, nefes darlığı; astım ve KOAH ataklarında, kalp krizi ve inme riskinde artış. En hassas olanlar çocuklar, 65 yaş üstü, hamileler, kalp ve akciğer hastalarıdır.'
            : 'Etki: hassas gruplarda (astım, KOAH, kalp hastaları, çocuklar, yaşlılar, hamileler) öksürük ve nefes darlığı; diğerlerinde hafif tahriş.',
          'Öneri: kapı ve pencereler kapalı, mümkünse HEPA filtreli bir oda; dışarıda N95/FFP2 maske (bez ve cerrahi maske korumaz). Duman "çok sağlıksız" düzeye çıkan yerlerde hassas grupların geçici olarak bölgeden çıkarılması değerlendirilmeli.',
          "Ne kadar sürer: duman, yangın yandıkça ve rüzgar yerleşime doğru estikçe sürer. Gece karışım yüksekliği ~400 m'ye indiği için yoğunluk geceleri artar. Belirtilerin çoğu duman dağıldıktan sonra birkaç günde geçer; hassas gruplarda ve uzun maruziyette haftalarca sürebilir (genel bilgi).",
        ]
      : ['Hiçbir yerleşimde duman hassas gruplar için sağlıksız düzeye (35,5 µg/m³ PM2.5) çıkmıyor.'],
  }
  people.lines.push('Kategoriler ABD EPA PM2.5 hava kalitesi endeksinden alındı; endeks 24 saatlik ortalama içindir, burada saatlik değerlere uygulandı. Duman modeli tarama amaçlıdır; ölçüm yerine geçmez.')

  // --- wildlife ---
  const sp = SPECIES[res.config.areaId]
  const month = res.config.weather ? Number(res.config.weather.startIso.slice(5, 7)) : null
  const speciesLine = sp
    ? `GBIF kayıtlarına göre bu alanda ${sp.classes.map((c) => `${c.species} ${CLASS_TR[c.key]}`).join(', ')} türü gözlenmiş (gözlem kaydıdır, hayvan sayısı değildir).`
    : 'Bu alan için tür kaydı yok.'
  const notable = sp
    ? sp.classes
        .filter((c) => c.top.length)
        .map((c) => `${CLASS_TR[c.key]}: ${c.top.slice(0, 3).map((t) => `${t.name ?? t.scientific} (${t.scientific}${t.iucn && t.iucn !== 'NE' ? `, IUCN ${t.iucn}` : ''})`).join(', ')}`)
        .join('; ')
    : ''
  const wildlife: ReportSection = {
    title: 'Yaban hayatına etkisi',
    lines: [
      `Yanan yaşam alanı: ${n0(f.forestHa)} ha orman ve maki (${n0(f.pineHa)} ha çam ormanı), ${n0(f.sparseHa)} ha açık ve tarım alanı.`,
      speciesLine,
      ...(notable ? [`En sık kaydedilenler — ${notable}.`] : []),
      `Yangın cephesi en hızlı ~${(peakRos / 1000).toFixed(1)} km/sa ilerliyor. Kuşlar ve yaban domuzu, tilki gibi büyük memeliler çoğunlukla kaçabilir; kara kaplumbağaları, sürüngenlerin bir kısmı, amfibiler, yuvadaki yavrular ve böcekler kaçamaz. Toprağa gömülen türlerin bir kısmı hayatta kalır.`,
      month
        ? month >= 3 && month <= 7
          ? `Yangın ${MONTHS[month - 1]} ayında: kuşların üreme dönemi, yuvalar ve yavrular kaybolur.`
          : `Yangın ${MONTHS[month - 1]} ayında: üreme dönemi dışında, yuva kaybı daha sınırlı.`
        : 'Mart–Temmuz arasındaki bir yangında kuş yuvaları ve yavrular da kaybolur.',
      'Duman kuşları özellikle etkiler (solunum sistemleri hassastır); kaçan hayvanlar dumanda yönünü kaybedebilir ve yollara çıkabilir.',
      'Ne kadar sürer (genel literatür, yaklaşık): maki örtüsü 3–7 yılda geri gelir. Kızılçam yangından sonra tohumla kendiliğinden yenilenir; kapalı orman örtüsü 20–30 yıl sürer. Açık alan kuşları ilk yıllarda artar; orman türleri ve yaşlı ağaç kovuklarına bağlı türler onlarca yıl etkilenir. Yangından sonraki ilk kış erozyon ve sel riski en yüksektir.',
    ],
  }
  return [emissions, people, wildlife]
}

export function reportMarkdown(name: string, res: SimResult, ai?: { report: AiReport; model?: string }): string {
  const aiLines = ai
    ? [
        `## Yapay zeka değerlendirmesi${ai.model ? ` (${ai.model})` : ''}`,
        '',
        `**${ai.report.headline}**`,
        '',
        ai.report.executive_summary,
        '',
        '### Temel bulgular',
        '',
        ...ai.report.key_findings.map((f) => `- **${f.title}:** ${f.value}. ${f.detail}`),
        '',
        '### Riskler',
        '',
        ...ai.report.risks.map((r) => `- **${r.title}** (${SEVERITY_LABEL[r.severity]}): ${r.detail}`),
        '',
        '### Öneriler',
        '',
        ...ai.report.recommendations.map((r, i) => `${i + 1}. ${r.action} — ${WHEN_LABEL[r.when] ?? r.when}. ${r.rationale}`),
        '',
        '### Halka bilgilendirme',
        '',
        `> ${ai.report.public_message}`,
        '',
        `_${ai.report.caveats}_`,
        '',
      ]
    : []
  return [`# ForestGuard raporu – ${name}`, '', '> Temsili simülasyon. Örnek veriler, canlı gözlem değildir.', '', ...aiLines, ...buildReport(name, res).flatMap((s) => [`## ${s.title}`, '', ...s.lines.map((l) => `- ${l}`), ''])].join('\n')
}
