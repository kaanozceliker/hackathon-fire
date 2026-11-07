import { useMemo } from 'react'
import { Area, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, Building2, Clock, Flame, HeartPulse, Leaf, Loader2, Megaphone, RotateCcw, Sparkles, Users, Wind } from 'lucide-react'
import { CATEGORY_LABEL, SEVERITY_LABEL, WHEN_LABEL, WHEN_ORDER, type AiReport, type AiReportState } from '../lib/aiReport'
import { AQI, aqiOf, computeSmoke, exposures } from '../sim/smoke'
import { regionById } from '../data/regions'
import { fmtDuration } from '../sim/geo'
import type { SimResult } from '../sim/types'

/**
 * The AI end-of-run report as a visual page: headline, key numbers, charts of growth, burned cover and smoke per
 * settlement, risks by severity and the recommendations on a time line. Numbers and charts come from the run; the
 * AI writes the short texts.
 */

const axis = { fill: '#8a9ba3', fontSize: 11 }
const tip = { background: '#0f171c', border: '1px solid #2f414b', fontSize: 12 }
const n0 = (v: number) => Math.round(v).toLocaleString('tr-TR')
const T = (min: number) => `T+${fmtDuration(min)}`

const SEV = {
  yuksek: { text: 'text-fire', border: 'border-fire/60', bg: 'bg-fire' },
  orta: { text: 'text-amber', border: 'border-amber/60', bg: 'bg-amber' },
  dusuk: { text: 'text-muted', border: 'border-line2', bg: 'bg-[#5d6f78]' },
} as const
const CAT_ICON = { can: Users, saglik: HeartPulse, altyapi: Building2, doga: Leaf } as const
const COVER = [
  { key: 'pine', label: 'Çam ormanı', color: '#2f9e5c' },
  { key: 'forest', label: 'Diğer orman', color: '#5cbf86' },
  { key: 'maquis', label: 'Maki çalılığı', color: '#8fc46a' },
  { key: 'sparse', label: 'Seyrek / tarım', color: '#b8ad5a' },
] as const

export function AiReportView({ state, preset, onAsk, res }: { state?: AiReportState; preset: boolean; onAsk: () => void; res: SimResult }) {
  if (!state)
    return (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border border-line2 bg-bg px-3 py-2.5 text-[13px]">
        <span className="text-muted">{preset ? 'Hazır örnek senaryo: yapay zeka raporu kendiliğinden istenmez.' : 'Yapay zeka raporu henüz istenmedi.'}</span>
        <button onClick={onAsk} className="flex items-center gap-1.5 border border-forest/60 px-2 py-1 text-[12px] font-semibold text-forest hover:bg-forest-dim/40"><Sparkles size={13} /> Yapay zeka raporu oluştur</button>
      </div>
    )
  if (state.status === 'loading')
    return <div className="mb-4 flex items-center gap-2 border border-line2 bg-bg px-3 py-2.5 text-[13px] text-muted"><Loader2 size={14} className="animate-spin text-forest" /> Yapay zeka raporu hazırlanıyor…</div>
  if (state.status === 'error' || !state.report)
    return (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border border-amber/50 bg-bg px-3 py-2.5 text-[13px] text-amber">
        <span>Yapay zeka raporu alınamadı: {state.error}. Aşağıdaki kural tabanlı rapor geçerli.</span>
        <button onClick={onAsk} className="flex items-center gap-1.5 border border-line2 px-2 py-1 text-[12px] text-ink hover:text-forest"><RotateCcw size={13} /> Tekrar dene</button>
      </div>
    )
  // reports cached before the visual layout have plain-text findings; ask again for the new form
  if (!state.report.headline || typeof state.report.key_findings[0] === 'string')
    return (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border border-line2 bg-bg px-3 py-2.5 text-[13px]">
        <span className="text-muted">Bu rapor eski biçimde. Grafikli görünüm için yeniden oluşturun.</span>
        <button onClick={onAsk} className="flex items-center gap-1.5 border border-forest/60 px-2 py-1 text-[12px] font-semibold text-forest hover:bg-forest-dim/40"><RotateCcw size={13} /> Yeniden oluştur</button>
      </div>
    )
  return <Visual r={state.report} model={state.model} cached={state.cached} res={res} />
}

function Visual({ r, model, cached, res }: { r: AiReport; model?: string; cached?: boolean; res: SimResult }) {
  const region = regionById(res.config.areaId)
  const f = res.series[res.series.length - 1]
  const sm = useMemo(() => computeSmoke(res), [res])
  const ex = useMemo(() => exposures(sm), [sm])
  const last = sm.co2T.length - 1
  const peakRos = Math.max(...res.series.map((p) => p.rosMh))
  const reached = res.impacts.filter((i) => i.arrivalMin !== null).length
  const worst = ex.reduce((a, b) => (b.peakPm > a.peakPm ? b : a), ex[0])
  const worstName = worst ? region.settlements.find((s) => s.id === worst.id)?.name : null

  const growth = useMemo(() => res.series.filter((_, i) => i % 3 === 0 || i === res.series.length - 1).map((p) => ({ h: +(p.minutes / 60).toFixed(2), ha: Math.round(p.affectedHa), burning: Math.round(p.burningHa) })), [res])
  const arrivals = res.impacts
    .map((im, i) => ({ name: region.settlements[i].name, min: im.arrivalMin }))
    .filter((a): a is { name: string; min: number } => a.min !== null)
    .sort((a, b) => a.min - b.min)
  const cover = [
    { ...COVER[0], ha: f.pineHa },
    { ...COVER[1], ha: Math.max(0, f.forestHa - f.pineHa - f.maquisHa) },
    { ...COVER[2], ha: f.maquisHa },
    { ...COVER[3], ha: f.sparseHa },
  ].filter((c) => c.ha >= 1)
  const coverTotal = cover.reduce((s, c) => s + c.ha, 0)

  const kpis = [
    { icon: Flame, label: 'Etkilenen alan', value: `${n0(f.affectedHa)} ha`, sub: `${n0(f.forestHa)} ha orman ve maki` },
    { icon: Users, label: 'Ulaşılan yerleşim', value: `${reached} / ${res.impacts.length}`, sub: arrivals[0] ? `ilki ${arrivals[0].name}, ${T(arrivals[0].min)}` : 'hiçbirine ulaşmadı' },
    { icon: Wind, label: 'En hızlı cephe', value: `${(peakRos / 1000).toFixed(1)} km/sa`, sub: `çevre ${f.perimeterKm.toFixed(1)} km` },
    { icon: Clock, label: res.response ? 'Söndü' : 'Süre', value: res.response?.extinguishedStep != null ? T(res.response.extinguishedStep * 10) : `${res.config.durationH} sa`, sub: res.response ? `${res.response.decisions.length} karar` : 'müdahalesiz' },
    { icon: Leaf, label: 'CO₂ salımı', value: `${n0(sm.co2T[last])} t`, sub: `~${n0(sm.co2T[last] / 4.6)} otomobilin yıllığı` },
    { icon: HeartPulse, label: 'En kötü hava', value: worst ? `${n0(worst.peakPm)} µg/m³` : '–', sub: worst && worstName ? `${worstName} · ${aqiOf(worst.peakPm).name}` : '', color: worst ? aqiOf(worst.peakPm).color : undefined },
  ]

  const sevCount = (['yuksek', 'orta', 'dusuk'] as const).map((s) => ({ s, n: r.risks.filter((x) => x.severity === s).length }))
  const lanes = WHEN_ORDER.map((w) => ({ w, items: r.recommendations.map((x, i) => ({ ...x, i })).filter((x) => x.when === w) })).filter((l) => l.items.length)

  return (
    <section className="mb-6 space-y-4 border border-forest/40 bg-bg p-3 sm:p-4">
      {/* headline */}
      <header>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-forest"><Sparkles size={14} /> Yapay zeka değerlendirmesi</h4>
          <span className="text-[11px] text-muted">{model}{cached ? ' · önbellekten' : ''}</span>
        </div>
        <p className="mt-2 text-[19px] font-semibold leading-snug">{r.headline}</p>
        <p className="mt-1 max-w-[900px] text-[13px] leading-relaxed text-muted">{r.executive_summary}</p>
      </header>

      {/* key numbers from the run */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.label} className="border border-line bg-panel p-2.5">
            <div className="flex items-center gap-1.5 text-[11px] text-muted"><k.icon size={13} /> {k.label}</div>
            <div className="mt-1 flex items-center gap-1.5 text-[19px] font-semibold leading-tight">
              {k.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: k.color }} />}
              {k.value}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted" title={k.sub}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* findings */}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {r.key_findings.map((k, i) => (
          <div key={i} className="flex gap-3 border-l-2 border-forest/60 bg-panel px-3 py-2">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-muted">{k.title}</div>
              <div className="text-[17px] font-semibold leading-tight">{k.value}</div>
              <div className="mt-0.5 text-[12px] leading-snug text-muted">{k.detail}</div>
            </div>
          </div>
        ))}
      </div>

      {/* growth + burned cover */}
      <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
        <figure className="border border-line bg-panel p-3">
          <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold">Yangının büyümesi</span>
            <span className="flex items-center gap-3 text-[11px] text-muted">
              <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-[#e5502a]/70" /> Toplam etkilenen</span>
              <span className="flex items-center gap-1"><span className="h-0.5 w-3 bg-[#ffd24a]" /> O an yanan</span>
              <span className="flex items-center gap-1"><span className="h-3 border-l border-dashed border-[#c8d3cd]" /> Yerleşime varış</span>
            </span>
          </figcaption>
          <div className="h-[240px]">
            <ResponsiveContainer>
              <ComposedChart data={growth} margin={{ top: 18, right: 12, left: -4, bottom: 0 }}>
                <CartesianGrid stroke="#233139" vertical={false} />
                <XAxis dataKey="h" type="number" domain={[0, 'dataMax']} tick={axis} stroke="#2f414b" tickFormatter={(v) => `${v}sa`} />
                <YAxis tick={axis} stroke="#2f414b" width={52} tickFormatter={(v) => n0(v)} />
                <RTooltip contentStyle={tip} labelFormatter={(v) => `T+${Number(v).toFixed(1)} sa`} formatter={(v, k) => [`${n0(Number(v))} ha`, k === 'ha' ? 'Toplam etkilenen' : 'O an yanan']} />
                <Area dataKey="ha" type="monotone" stroke="#e5502a" strokeWidth={2} fill="#e5502a" fillOpacity={0.28} isAnimationActive={false} />
                <Line dataKey="burning" type="monotone" stroke="#ffd24a" strokeWidth={2} dot={false} isAnimationActive={false} />
                {arrivals.slice(0, 6).map((a, i) => (
                  <ReferenceLine key={a.name} x={+(a.min / 60).toFixed(2)} stroke="#c8d3cd" strokeOpacity={0.6} strokeDasharray="3 4" label={{ value: a.name, position: i % 2 ? 'insideTopRight' : 'insideTopLeft', fill: '#c8d3cd', fontSize: 10 }} />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </figure>

        <figure className="border border-line bg-panel p-3">
          <figcaption className="mb-1 text-[13px] font-semibold">Yanan örtü</figcaption>
          <div className="flex items-center gap-3">
            <div className="relative h-[180px] w-[180px] shrink-0">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={cover} dataKey="ha" nameKey="label" innerRadius={56} outerRadius={84} paddingAngle={2} stroke="#0f171c" strokeWidth={2} isAnimationActive={false}>
                    {cover.map((c) => <Cell key={c.key} fill={c.color} />)}
                  </Pie>
                  <RTooltip contentStyle={tip} formatter={(v, k) => [`${n0(Number(v))} ha`, String(k)]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[17px] font-semibold">{n0(coverTotal)}</span>
                <span className="text-[10.5px] text-muted">hektar</span>
              </div>
            </div>
            <ul className="min-w-0 space-y-1.5 text-[12px]">
              {cover.map((c) => (
                <li key={c.key} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: c.color }} />
                  <span className="min-w-0 flex-1">{c.label}</span>
                  <b className="tabular-nums">%{Math.round((c.ha / Math.max(1, coverTotal)) * 100)}</b>
                </li>
              ))}
            </ul>
          </div>
        </figure>
      </div>

      {/* settlements: smoke per hour and fire arrival */}
      <SettlementStrip res={res} sm={sm} ex={ex} />

      {/* risks */}
      <div className="border border-line bg-panel p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[13px] font-semibold"><AlertTriangle size={14} className="text-amber" /> Riskler</span>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <div className="flex h-2 w-40 overflow-hidden rounded-full bg-line">
              {sevCount.map(({ s, n }) => n > 0 && <div key={s} className={`${SEV[s].bg} border-r-2 border-panel last:border-r-0`} style={{ width: `${(n / Math.max(1, r.risks.length)) * 100}%` }} title={`${SEVERITY_LABEL[s]}: ${n}`} />)}
            </div>
            {sevCount.filter((x) => x.n).map(({ s, n }) => <span key={s}>{SEVERITY_LABEL[s]} {n}</span>)}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {r.risks.map((x, i) => {
            const Icon = CAT_ICON[x.category] ?? AlertTriangle
            return (
              <div key={i} className={`border-l-[3px] bg-bg px-2.5 py-2 ${SEV[x.severity].border}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] text-muted"><Icon size={13} /> {CATEGORY_LABEL[x.category] ?? ''}</span>
                  <span className={`text-[10.5px] font-semibold uppercase ${SEV[x.severity].text}`}>{SEVERITY_LABEL[x.severity]}</span>
                </div>
                <div className="mt-1 text-[13px] font-semibold leading-snug">{x.title}</div>
                <div className="mt-0.5 text-[12px] leading-snug text-muted">{x.detail}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* recommendations on a time line */}
      <div className="border border-line bg-panel p-3">
        <div className="mb-2 text-[13px] font-semibold">Öneriler, zamana göre</div>
        <ol className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(200px, 1fr))` }}>
          {lanes.map((l) => (
            <li key={l.w} className="relative">
              <div className="mb-2 flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-forest" />
                <span className="text-[11.5px] font-semibold uppercase tracking-wide text-forest">{WHEN_LABEL[l.w]}</span>
                <span className="h-px flex-1 bg-line2" />
              </div>
              <div className="space-y-2">
                {l.items.map((x) => (
                  <div key={x.i} className="flex gap-2 bg-bg px-2.5 py-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-forest/60 text-[11px] font-semibold text-forest">{x.i + 1}</span>
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-semibold leading-snug">{x.action}</div>
                      <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{x.rationale}</div>
                    </div>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* message to residents */}
      <blockquote className="flex gap-3 border border-forest/40 bg-forest-dim/20 px-3 py-2.5">
        <Megaphone size={18} className="mt-0.5 shrink-0 text-forest" />
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-forest">Halka bilgilendirme</div>
          <p className="mt-0.5 text-[13px] leading-relaxed">{r.public_message}</p>
        </div>
      </blockquote>
      <p className="text-[11px] leading-snug text-muted">{r.caveats}</p>
    </section>
  )
}

/** One row per settlement: the hourly worst PM2.5 as coloured cells (EPA categories) and the fire's arrival. */
function SettlementStrip({ res, sm, ex }: { res: SimResult; sm: ReturnType<typeof computeSmoke>; ex: ReturnType<typeof exposures> }) {
  const region = regionById(res.config.areaId)
  const hours = Math.max(1, Math.ceil((res.steps * 10) / 60))
  const per = 6
  const rows = region.settlements.map((st, i) => {
    const pm = sm.settlements[i]?.pm
    const cells = Array.from({ length: hours }, (_, h) => {
      let m = 0
      if (pm) for (let s = h * per; s < Math.min(pm.length, (h + 1) * per); s++) m = Math.max(m, pm[s])
      return m
    })
    return { st, cells, arrival: res.impacts[i]?.arrivalMin ?? null, e: ex[i] }
  })
  const tickEvery = hours > 36 ? 12 : hours > 12 ? 6 : 2
  return (
    <figure className="border border-line bg-panel p-3">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold">Yerleşimler: saat saat duman ve yangının varışı</span>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted">
          {AQI.map((a) => <span key={a.name} className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: a.color }} />{a.name}</span>)}
          <span className="flex items-center gap-1"><Flame size={11} className="text-[#ffd24a]" /> Yangın sınıra ulaştı</span>
        </span>
      </figcaption>
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          {rows.map(({ st, cells, arrival, e }) => (
            <div key={st.id} className="grid items-center gap-2 py-1" style={{ gridTemplateColumns: '140px 1fr 150px' }}>
              <div className="truncate text-[12px]" title={st.name}>{st.name} <span className="text-[10.5px] text-muted">{n0(st.population)}</span></div>
              <div className="relative flex h-5 gap-[2px]">
                {cells.map((v, h) => (
                  <div key={h} className="h-full flex-1 rounded-[2px]" style={{ background: v < 1 ? '#1b262d' : aqiOf(v).color, opacity: v < 1 ? 1 : 0.9 }} title={`${st.name} · T+${h}–${h + 1} sa · en yüksek ${n0(v)} µg/m³ (${aqiOf(v).name})`} />
                ))}
                {arrival !== null && (
                  <div className="pointer-events-none absolute -top-1 bottom-[-4px] flex flex-col items-center" style={{ left: `calc(${(arrival / 60 / hours) * 100}% - 7px)` }} title={`Yangın ${T(arrival)}'da ulaştı`}>
                    <Flame size={14} className="fill-[#ffd24a] text-[#0f171c]" />
                  </div>
                )}
              </div>
              <div className="whitespace-nowrap text-right text-[11px] text-muted">{e && e.hoursUnhealthy > 0 ? <><b className="text-ink">{e.hoursUnhealthy.toFixed(1)} sa</b> sağlıksız</> : 'sağlıksız saat yok'}</div>
            </div>
          ))}
          <div className="grid gap-2 pt-1 text-[10.5px] text-muted" style={{ gridTemplateColumns: '140px 1fr 150px' }}>
            <span />
            <div className="relative h-3">
              {Array.from({ length: Math.floor(hours / tickEvery) + 1 }, (_, k) => k * tickEvery).map((h) => (
                <span key={h} className="absolute -translate-x-1/2" style={{ left: `${(h / hours) * 100}%` }}>{h}sa</span>
              ))}
            </div>
            <span />
          </div>
        </div>
      </div>
    </figure>
  )
}
