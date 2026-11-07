import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Circle, Marker, Tooltip } from 'react-leaflet'
import { ArrowRight, Droplets, Thermometer, Wind, CloudRain, Undo2, Activity, MapPinned, Layers3, ShieldCheck } from 'lucide-react'
import { MapStage, WindArrow } from '../components/MapStage'
import { Legend, Panel, SimBadge, Stat, fmtHa } from '../components/ui'
import { icons } from '../components/mapIcons'
import { REGIONS, RISK_HOTSPOTS, SIMULATED_FIRES, regionById } from '../data/regions'
import { useStore } from '../state/store'
import { compass } from '../sim/geo'
import { HIGH_RISK_THRESHOLD, RISK_BANDS, riskBand } from '../lib/risk'
import { ScenarioSnapshot } from '../components/ScenarioSnapshot'
import { DataProvenance } from '../components/DataProvenance'

const riskColor = (score: number) => riskBand(score).color

export function Dashboard() {
  const nav = useNavigate()
  const { scenarios, active, setActive, setDraftArea, selectedRegionId, setSelectedRegionId } = useStore()
  const [focus, setFocus] = useState<string | null>(null)
  const region = regionById(selectedRegionId)
  const final = active.result.series[active.result.series.length - 1]
  const settlementCount = new Set(REGIONS.flatMap((r) => r.settlements.map((settlement) => settlement.id))).size
  const highRisk = REGIONS.filter((r) => r.risk >= HIGH_RISK_THRESHOLD).length
  const sorted = useMemo(() => [...REGIONS].sort((a, b) => b.risk - a.risk), [])

  const pick = (id: string) => {
    setSelectedRegionId(id)
    setFocus(id)
  }
  const openStudio = (id: string) => {
    setDraftArea(id)
    nav('/studio')
  }

  return (
    <div className="flex min-h-full flex-col lg:h-full">
      <div className="relative shrink-0 overflow-hidden border-b border-line bg-panel px-4 py-4 sm:px-5">
        <div aria-hidden="true" className="pointer-events-none absolute -right-14 -top-24 h-64 w-64 rounded-full bg-forest/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-forest"><ShieldCheck size={13} /> Bölgesel genel bakış</p>
            <h2 className="text-[25px] font-semibold leading-tight tracking-tight sm:text-[29px]">Yangından önce, veriye dayalı karar.</h2>
            <p className="mt-1 text-[12.5px] text-muted">{REGIONS.length} çalışma bölgesi · gerçek coğrafi veriler üzerinde temsili senaryolar</p>
          </div>
          <button onClick={() => openStudio(region.id)} className="inline-flex items-center gap-2 rounded-lg bg-forest px-3.5 py-2.5 text-[13px] font-semibold text-white hover:bg-forest/85">Senaryo oluştur <ArrowRight size={15} /></button>
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-3 border-b border-line bg-panel px-4 py-3 lg:grid-cols-4">
        <Stat label="Bu oturumdaki simülasyonlar" value={scenarios.length} hint="Bellekte tutulan senaryolar – hazır ve özel çalıştırmalar" tone="forest" />
        <Stat label="Yüksek ve aşırı endeksli" value={highRisk} unit={`/ ${REGIONS.length}`} hint={`Temsili tehlike endeksi ${HIGH_RISK_THRESHOLD} veya üzeri; harita lejandıyla aynı eşik`} tone="fire" />
        <Stat label="Haritalanan yerleşimler" value={settlementCount} hint="Çalışma bölgelerindeki benzersiz OpenStreetMap yerleşim kayıtları" />
        <Stat label="Seçili senaryo · etkilenen" value={fmtHa(final.affectedHa)} unit="ha" hint={`“${active.name}” senaryosunun son yayılımı`} tone="amber" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-panel/70 px-4 py-2">
            <span className="flex items-center gap-1.5 text-[12px] font-medium"><MapPinned size={14} className="text-forest" /> Bölgesel tehlike haritası</span>
            <span className="flex items-center gap-1.5 text-[10.5px] text-muted"><Layers3 size={12} /> Temsili endeks · 0–100</span>
          </div>
        <div className="relative h-[56vh] min-h-[360px] shrink-0 lg:h-auto lg:min-h-0 lg:flex-1">
          <MapStage
            fitKey={focus ?? 'turkey'}
            center={focus ? regionById(focus).center : [38.9, 31.8]}
            zoom={focus ? 9 : 6}
            controls={focus ? (
              <button onClick={() => setFocus(null)} className="flex items-center gap-1.5 border border-line2 bg-bg/90 px-2.5 py-1 text-[12px] font-medium hover:text-forest">
                <Undo2 size={13} /> Türkiye'ye dön
              </button>
            ) : undefined}
            legend={
              <Legend
                title="Yangın tehlike endeksi (temsili)"
                items={[
                  ...RISK_BANDS.map((band) => ({ color: band.color, label: `${band.label}, ${band.range}`, kind: 'dot' as const })),
                  { color: '#d4501f', label: 'Simüle yangın (örnek)', kind: 'dot' },
                ]}
              />
            }
          >
            {RISK_HOTSPOTS.flatMap((h, i) =>
              [95, 62, 32].map((km, k) => (
                <Circle key={`${i}-${k}`} center={h.pos} radius={km * 1000} interactive={false} pathOptions={{ stroke: false, fillColor: riskColor(h.risk), fillOpacity: 0.09 + k * 0.05 }} />
              )),
            )}
            {SIMULATED_FIRES.map((f) => (
              <Marker key={f.id} position={f.pos} icon={icons.fireSmall} eventHandlers={{ click: () => pick(f.areaId) }}>
                <Tooltip direction="top" offset={[0, -10]}>
                  <b>{f.name}</b>
                  <br />
                  Simüle yangın, T+{f.hours} sa
                </Tooltip>
              </Marker>
            ))}
            {REGIONS.map((r) => (
              <Marker key={r.id} position={r.center} icon={icons.regionDot(r.risk, r.id === selectedRegionId)} eventHandlers={{ click: () => pick(r.id) }}>
                <Tooltip direction="right" offset={[14, 0]} permanent className="fg-label">{r.name}</Tooltip>
              </Marker>
            ))}
          </MapStage>
        </div>
        </div>

        <aside aria-label="Bölge ve senaryo özeti" className="w-full shrink-0 space-y-3 overflow-auto border-t border-line bg-bg p-3 lg:w-[350px] lg:border-l lg:border-t-0">
          <Panel title={region.name} action={<span className="rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{ color: riskColor(region.risk), borderColor: `${riskColor(region.risk)}66`, background: `${riskColor(region.risk)}12` }}>{riskBand(region.risk).label} · {region.risk}</span>}>
            <p className="mb-3 text-[13px] leading-snug text-muted">{region.note}</p>
            <div className="mb-1 flex items-center justify-between text-[12px] text-muted">
              <span>Örnek hava durumu</span>
              <SimBadge text="Canlı değil" />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <div className="flex items-center gap-2"><Thermometer size={15} className="text-orange" /><dt className="sr-only">Sıcaklık</dt><dd>{region.weather.temperatureC} °C</dd></div>
              <div className="flex items-center gap-2"><Droplets size={15} className="text-water" /><dt className="sr-only">Nem</dt><dd>%{region.weather.humidityPct} nem</dd></div>
              <div className="flex items-center gap-2"><Wind size={15} className="shrink-0 text-muted" /><dt className="sr-only">Rüzgar</dt><dd className="flex items-center gap-1 whitespace-nowrap">{region.weather.windSpeedKmh} km/sa <WindArrow fromDeg={region.weather.windFromDeg} className="shrink-0 text-ink" /> {compass(region.weather.windFromDeg)}<span className="sr-only"> yönünden</span></dd></div>
              <div className="flex items-center gap-2"><CloudRain size={15} className="text-muted" /><dt className="sr-only">Yağış</dt><dd>{region.weather.precipMmH} mm/sa</dd></div>
            </dl>
            <div className="mt-3 text-[12px] text-muted">Çalışma alanında {region.settlements.length} yerleşim · bölgesel orman alanı ~{region.forestKm2.toLocaleString('tr-TR')} km² (temsili)</div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => openStudio(region.id)} className="flex flex-1 items-center justify-center gap-1.5 bg-forest px-3 py-2 text-[13px] font-semibold text-bg hover:bg-forest/85">
                Simülasyon Stüdyosunda incele <ArrowRight size={14} />
              </button>
            </div>
          </Panel>

          <DataProvenance areaId={region.id} />
          <ScenarioSnapshot scenario={active} />

          <Panel title="Bölgelerin temsili endeksi" pad={false}>
            <ul>
              {sorted.map((r) => (
                <li key={r.id}>
                  <button onClick={() => pick(r.id)} aria-pressed={r.id === selectedRegionId} className={`flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-panel2 ${r.id === selectedRegionId ? 'bg-panel2' : ''}`}>
                    <span className="w-32 shrink-0 text-[13px] font-medium">{r.name}</span>
                    <span className="h-1.5 flex-1 bg-line"><span className="block h-full" style={{ width: `${r.risk}%`, background: riskColor(r.risk) }} /></span>
                    <span className="w-6 text-right text-[13px] font-semibold" style={{ color: riskColor(r.risk) }}>{r.risk}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={<span className="flex items-center gap-1.5"><Activity size={14} className="text-forest" /> Oturumdaki senaryolar</span>} pad={false}>
            <ul>
              {[...scenarios].reverse().map((s) => {
                const f = s.result.series[s.result.series.length - 1]
                const c = s.result.config
                return (
                  <li key={s.id}>
                    <button onClick={() => { setActive(s.id); nav('/studio') }} className="flex w-full items-start gap-2 border-b border-line px-3 py-2 text-left hover:bg-panel2">
                      <span className="mt-1 h-2.5 w-2.5 shrink-0" style={{ background: s.color }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{s.name}</span>
                        <span className="block text-[12px] text-muted">{s.preset ? 'Hazır senaryo' : 'Bu oturumda hesaplandı'} · {c.windSpeedKmh} km/sa {compass(c.windFromDeg)} · {c.durationH} sa</span>
                      </span>
                      <span className="text-right text-[13px] font-semibold text-amber">{fmtHa(f.affectedHa)}<span className="block text-[11px] font-normal text-muted">ha</span></span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  )
}
