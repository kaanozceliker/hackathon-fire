import { useMemo, useState, type ReactNode } from 'react'
import { Marker, Polyline, Tooltip } from 'react-leaflet'
import { AlertTriangle, Droplets, ShieldCheck, Users } from 'lucide-react'
import { MapStage } from '../components/MapStage'
import { Timeline } from '../components/Timeline'
import { Legend, Panel } from '../components/ui'
import { icons } from '../components/mapIcons'
import { ARRIVAL_LEGEND, type FireMode } from '../components/FireCanvasLayer'
import { getInfrastructure } from '../data/infrastructure'
import { regionById } from '../data/regions'
import { DISPATCH_DELAY_MIN, buildResponsePlan, type RoutePlan } from '../sim/planner'
import { fmtDuration, haversineM, type LatLon } from '../sim/geo'
import { useStore } from '../state/store'

const COL = { route: '#4cd37a', alt: '#f2d03b', danger: '#e5483d', water: '#3b9be0', evac: '#e3ece6', road: '#66767e' }
const t = (min: number) => `T+${fmtDuration(min)}`

function Toggle({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted hover:text-ink">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-[#3fa564]" />
      {children}
    </label>
  )
}

function RouteCard({ color, title, route, why, tone }: { color: string; title: string; route: RoutePlan | null; why: string[]; tone: string }) {
  if (!route) return <div className="border border-line2 p-2.5 text-[13px] text-muted">{title}: bu senaryo için bulunamadı.</div>
  return (
    <div className="border border-line2 p-2.5" style={{ borderLeft: `4px solid ${color}` }}>
      <div className="flex items-baseline justify-between">
        <span className={`text-[13px] font-semibold ${tone}`}>{title}</span>
        <span className="text-[13px] font-semibold">{Math.round(route.etaMin)} dk · {route.distanceKm.toFixed(1)} km</span>
      </div>
      <div className="mt-0.5 text-[12px] text-muted">{route.from.name} → {route.to.name}</div>
      <div className="text-[12px] text-muted">{DISPATCH_DELAY_MIN} dk sevk gecikmesiyle {t(DISPATCH_DELAY_MIN + route.etaMin)} anında varır</div>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-[12.5px] leading-snug">
        {why.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
    </div>
  )
}

export function Planner() {
  const { active, step } = useStore()
  const res = active.result
  const region = regionById(res.config.areaId)
  const infra = useMemo(() => getInfrastructure(region), [region])
  const plan = useMemo(() => buildResponsePlan(res, infra, region.settlements), [res, infra, region])
  const minutes = res.series[step].minutes

  const [layers, setLayers] = useState({ roads: true, stations: true, water: true, access: true, settlements: true, evac: true })
  const [mode, setMode] = useState<FireMode>('fire')
  const set = (k: keyof typeof layers) => (v: boolean) => setLayers((l) => ({ ...l, [k]: v }))

  const primary = plan.primary
  const alt = plan.alternative
  const share = (r: RoutePlan, type: string) => Math.round((r.edges.filter((e) => e.type === type).reduce((s, e) => s + e.lengthM, 0) / (r.edges.reduce((s, e) => s + e.lengthM, 0) || 1)) * 100)
  const firstThreat = (r: RoutePlan) => Math.min(...r.edges.map((e) => plan.hazards.find((h) => h.edge.id === e.id)?.firstFireMin ?? Infinity))

  const primaryWhy = primary
    ? [
        `Her yoldaki tahmini yangın varışı hesaba katıldığında ${plan.stationsEvaluated} itfaiye istasyonu seçeneği arasında en hızlısı.`,
        primary.blockedEdges.length === 0
          ? 'Ekip geçmeden önce yanması beklenen bir yol kesimi yok.'
          : `${primary.blockedEdges.length} kesim geçişten önce yanabilir (${[...new Set(primary.blockedEdges.map((e) => e.name))].join(', ')}). Dikkatli kullanın.`,
        `Rotanın asfalt yol oranı %${share(primary, 'highway') + share(primary, 'road')}, orman yolu oranı %${share(primary, 'forest')}.`,
        Number.isFinite(firstThreat(primary)) ? `Yangın bu rotayı ilk kez ${t(firstThreat(primary))} anında tehdit ediyor; kullanım süresi sınırlı.` : 'Yangın simüle edilen süre içinde bu rotaya ulaşmıyor.',
      ]
    : []
  const altWhy = alt && primary
    ? [
        `Çıkış noktası ${alt.from.name}; farklı bir koridor kullanır${alt.etaMin > primary.etaMin ? `, birincil rotadan ${Math.round(alt.etaMin - primary.etaMin)} dk daha yavaş` : ''}.`,
        'Birincil yol kesilir veya tıkanırsa aynı hedefe erişimi açık tutar.',
        alt.blockedEdges.length === 0 ? 'Ekip geçmeden önce yanması beklenen bir yol kesimi yok.' : `${alt.blockedEdges.length} kesim geçişten önce yanabilir. Karar vermeden önce yeniden kontrol edin.`,
      ]
    : []

  const water2 = plan.water.filter((w) => w.compromisedAtMin === null || w.compromisedAtMin > minutes + 60).slice(0, 2)

  const legend = (
    <Legend
      title="Müdahale katmanları"
      items={[
        { color: COL.route, label: 'Önerilen erişim rotası', kind: 'line' },
        { color: COL.alt, label: 'Alternatif rota', kind: 'line' },
        { color: COL.danger, label: 'Tehlikeli kesim (düz: yanıyor, kesikli: tahmini)', kind: 'line' },
        { color: COL.water, label: 'Su kaynağı', kind: 'line' },
        { color: COL.evac, label: 'Tahliye rotası', kind: 'dash' },
        ...(mode === 'arrival' ? ARRIVAL_LEGEND.map((a) => ({ ...a, label: `Yangın varışı: ${a.label}` })) : [{ color: '#e5502a', label: 'Yangın çevresi ve yanan alan' }]),
      ]}
    />
  )

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:flex-row">
      <div className="flex min-h-[600px] min-w-0 flex-1 flex-col lg:min-h-0">
        <div className="relative min-h-[460px] flex-1">
          <MapStage
            grid={res.grid}
            result={res}
            step={step}
            mode={mode}
            fitGrid
            fitKey={`${active.id}`}
            hud
            legend={legend}
            controls={
              <div className="w-[190px] space-y-1.5 border border-line2 bg-bg/92 p-2.5">
                <div className="text-[12px] font-semibold">Harita katmanları</div>
                <div className="flex border border-line2 text-[12px]" role="radiogroup" aria-label="Yangın gösterimi">
                  {([['fire', 'Şu anki yangın'], ['arrival', 'Risk bölgeleri'], ['none', 'Kapalı']] as const).map(([k, l]) => (
                    <button key={k} role="radio" aria-checked={mode === k} onClick={() => setMode(k)} className={`flex-1 px-1.5 py-1 font-medium ${mode === k ? 'bg-forest-dim text-ink' : 'text-muted hover:text-ink'}`}>{l}</button>
                  ))}
                </div>
                <Toggle on={layers.roads} onChange={set('roads')}>Yol ağı</Toggle>
                <Toggle on={layers.stations} onChange={set('stations')}>İtfaiye istasyonları</Toggle>
                <Toggle on={layers.water} onChange={set('water')}>Su kaynakları</Toggle>
                <Toggle on={layers.access} onChange={set('access')}>Erişim noktaları</Toggle>
                <Toggle on={layers.settlements} onChange={set('settlements')}>Yerleşimler</Toggle>
                <Toggle on={layers.evac} onChange={set('evac')}>Tahliye rotaları</Toggle>
              </div>
            }
          >
            {layers.roads &&
              plan.hazards.map((h) => (
                <Polyline key={h.edge.id} positions={h.edge.geom} pathOptions={{ color: COL.road, weight: h.edge.type === 'highway' ? 3.5 : h.edge.type === 'road' ? 2.5 : 2, dashArray: h.edge.type === 'forest' ? '2 5' : undefined, opacity: 0.9 }}>
                  <Tooltip sticky>{h.edge.name} · {h.edge.type === 'forest' ? 'orman yolu' : h.edge.type === 'highway' ? 'ana yol' : 'yerel yol'} · {(h.edge.lengthM / 1000).toFixed(1)} km{Number.isFinite(h.firstFireMin) ? ` · yangın varışı ${t(h.firstFireMin)}` : ''}</Tooltip>
                </Polyline>
              ))}

            {layers.evac &&
              plan.evacuations.map((e) => (
                <Polyline key={`ev-${e.settlement.id}`} positions={e.route.geom} pathOptions={{ color: COL.evac, weight: 3, dashArray: '9 7', opacity: 0.95 }}>
                  <Tooltip sticky>Tahliye: {e.settlement.name} → {e.route.to.name} · {e.route.distanceKm.toFixed(1)} km · karayoluyla yaklaşık {Math.round(e.route.etaMin)} dk</Tooltip>
                </Polyline>
              ))}

            {alt && (
              <>
                <Polyline positions={alt.geom} pathOptions={{ color: '#0a1014', weight: 8, opacity: 0.8 }} interactive={false} />
                <Polyline positions={alt.geom} pathOptions={{ color: COL.alt, weight: 5 }}><Tooltip sticky>Alternatif rota · {alt.distanceKm.toFixed(1)} km · {Math.round(alt.etaMin)} dk</Tooltip></Polyline>
              </>
            )}
            {primary && (
              <>
                <Polyline positions={primary.geom} pathOptions={{ color: '#0a1014', weight: 9, opacity: 0.85 }} interactive={false} />
                <Polyline positions={primary.geom} pathOptions={{ color: COL.route, weight: 6 }}><Tooltip sticky>Önerilen erişim rotası · {primary.distanceKm.toFixed(1)} km · {Math.round(primary.etaMin)} dk</Tooltip></Polyline>
              </>
            )}

            {layers.roads &&
              plan.hazards.flatMap((h) =>
                h.segments
                  .filter((sg) => Number.isFinite(sg.fireMin))
                  .map((sg, i) => {
                    const live = sg.fireMin <= minutes
                    return <Polyline key={`${h.edge.id}-${i}`} positions={[sg.a, sg.b]} interactive={false} pathOptions={{ color: COL.danger, weight: live ? 4 : 3, dashArray: live ? undefined : '3 5', opacity: live ? 1 : 0.9 }} />
                  }),
              )}

            {water2.map((w) => (
              <Polyline key={`wl-${w.source.id}`} positions={[w.source.pos, plan.target.pos] as LatLon[]} pathOptions={{ color: COL.water, weight: 2.5, dashArray: '2 6' }} interactive={false} />
            ))}
            {layers.water &&
              infra.water.map((w) => {
                const a = plan.water.find((x) => x.source.id === w.id)!
                return (
                  <Marker key={w.id} position={w.pos} icon={icons.water}>
                    <Tooltip direction="top" offset={[0, -10]}><b>{w.name}</b><br />{w.note}<br />{a.distanceKm.toFixed(1)} km (tutuşma noktasına){a.compromisedAtMin !== null ? ` · ${t(a.compromisedAtMin)} itibarıyla yangın alanında` : ''}</Tooltip>
                  </Marker>
                )
              })}
            {layers.stations && infra.nodes.filter((n) => n.kind === 'station').map((n) => (
              <Marker key={n.id} position={n.pos} icon={icons.station}><Tooltip direction="top" offset={[0, -10]}>{n.name}{primary?.from.id === n.id ? ' (birincil sevk)' : alt?.from.id === n.id ? ' (alternatif sevk)' : ''}</Tooltip></Marker>
            ))}
            {layers.access && plan.target.kind !== 'access' && (
              <Marker position={plan.target.pos} icon={icons.access}><Tooltip direction="top" offset={[0, -10]}>Erişim noktası: {plan.target.name} (toplanma hedefi)</Tooltip></Marker>
            )}
            {layers.access && infra.nodes.filter((n) => n.kind === 'access').map((n) => (
              <Marker key={n.id} position={n.pos} icon={icons.access}><Tooltip direction="top" offset={[0, -10]}>Erişim noktası: {n.name}{n.id === plan.target.id ? ' (toplanma hedefi)' : ''}</Tooltip></Marker>
            ))}
            {infra.nodes.filter((n) => n.kind === 'safe').map((n) => (
              <Marker key={n.id} position={n.pos} icon={icons.safe}><Tooltip direction="top" offset={[0, -10]}>{n.name}</Tooltip></Marker>
            ))}
            {layers.settlements && region.settlements.map((st) => (
              <Marker key={st.id} position={st.pos} icon={icons.settlement}>
                <Tooltip direction="right" permanent offset={[8, 0]} className="fg-label">{st.name}</Tooltip>
              </Marker>
            ))}
            <Marker position={res.config.ignition} icon={icons.ignition}><Tooltip direction="top" offset={[0, -12]}>Ignition point</Tooltip></Marker>
          </MapStage>
        </div>
        <div className="border-t border-line bg-panel p-2"><Timeline /></div>
      </div>

      <aside className="w-full shrink-0 space-y-3 overflow-auto border-t border-line bg-bg p-3 lg:w-[370px] lg:border-l lg:border-t-0">
        <Panel title="Müdahale özeti">
          <p className="text-[13px] leading-snug text-muted">
            <b className="text-ink">{active.name}</b> için ekipler, tutuşma noktasına en yakın yol erişim noktası olan <b className="text-ink">{plan.target.name}</b> noktasına yönlendirilir. Rotalar tahmini yangın varışını kullanır; böylece ekipler yangının önce ulaştığı yollardan kaçınır.
          </p>
        </Panel>

        <RouteCard color={COL.route} tone="text-route" title="Birincil erişim rotası" route={primary} why={primaryWhy} />
        <RouteCard color={COL.alt} tone="text-alt" title="Alternatif erişim rotası" route={alt} why={altWhy} />

        <Panel title={<span className="flex items-center gap-1.5"><AlertTriangle size={14} className="text-fire" /> Potansiyel tehlikeli yol kesimleri</span>} pad={false}>
          {plan.dangerous.length === 0 ? <p className="p-3 text-[13px] text-muted">Bu senaryoda yangın hiçbir yola ulaşmıyor.</p> : (
            <ul>
              {plan.dangerous.slice(0, 7).map((d) => (
                <li key={d.edge.id} className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[13px] last:border-b-0">
                  <span>{d.edge.name}</span>
                  <span className={d.fireMin <= minutes ? 'font-semibold text-fire' : 'text-amber'}>{d.fireMin <= minutes ? 'Yanıyor: ' : 'Tahmini: '}{t(d.fireMin)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={<span className="flex items-center gap-1.5"><Users size={14} /> Öncelikli değerlendirme gereken alanlar</span>} pad={false}>
          {plan.threatened.length === 0 ? <p className="p-3 text-[13px] text-muted">Simüle edilen süre içinde hiçbir yerleşime ulaşılmıyor.</p> : (
            <ul>
              {plan.threatened.map((s, i) => {
                const ev = plan.evacuations.find((e) => e.settlement.id === s.id)
                return (
                  <li key={s.id} className="border-b border-line px-3 py-2 last:border-b-0">
                    <div className="flex items-baseline justify-between text-[13px]">
                      <span className="font-semibold">{i + 1}. {s.name} <span className="font-normal text-muted">{s.population.toLocaleString('en-US')} kişi</span></span>
                      <span className="text-amber">{t(s.arrivalMin)}</span>
                    </div>
                    <div className="text-[12px] text-muted">
                      Sonunda çevre arazinin %{Math.round(s.exposurePct)} kadarı yanıyor.{' '}
                      {ev ? <>Tahliye yönü: {ev.route.to.name}, {ev.route.distanceKm.toFixed(1)} km{ev.route.blockedEdges.length ? ', riskli kesimler var' : ', rota açık kalıyor'}.</> : 'Tahliye rotası modellenmedi.'}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        <Panel title={<span className="flex items-center gap-1.5"><Droplets size={14} className="text-water" /> Yakındaki su kaynakları</span>} pad={false}>
          <ul>
            {plan.water.map((w) => {
              const near = haversineM(w.source.pos, res.config.ignition) < 12000
              return (
                <li key={w.source.id} className="flex items-start justify-between gap-2 border-b border-line px-3 py-1.5 text-[13px] last:border-b-0">
                  <span className="min-w-0"><span className="block truncate">{w.source.name}</span><span className="block text-[12px] text-muted">{w.source.note}</span></span>
                  <span className="shrink-0 text-right text-[12px]">{w.distanceKm.toFixed(1)} km<span className={`block ${w.compromisedAtMin !== null ? 'text-amber' : near ? 'text-forest' : 'text-muted'}`}>{w.compromisedAtMin !== null ? `yangın: ${t(w.compromisedAtMin)} itibarıyla` : 'güvende kalıyor'}</span></span>
                </li>
              )
            })}
          </ul>
        </Panel>

        <div className="flex items-start gap-2 border border-amber/40 bg-amber/5 p-2.5 text-[12px] leading-snug text-amber">
          <ShieldCheck size={15} className="mt-0.5 shrink-0" />
          <span>Örnek yollar, istasyonlar ve su noktaları üzerinde simüle edilmiş karar destek önerileridir. Gerçek operasyonel talimat değildir.</span>
        </div>
      </aside>
    </div>
  )
}
