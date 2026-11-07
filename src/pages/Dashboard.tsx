import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Circle, Marker, Tooltip } from 'react-leaflet'
import { ArrowRight, Droplets, Thermometer, Wind, CloudRain, Undo2 } from 'lucide-react'
import { MapStage, WindArrow } from '../components/MapStage'
import { Legend, Panel, SimBadge, Stat, fmtHa } from '../components/ui'
import { icons } from '../components/mapIcons'
import { REGIONS, RISK_HOTSPOTS, SIMULATED_FIRES, regionById } from '../data/regions'
import { useStore } from '../state/store'
import { compass } from '../sim/geo'

const riskColor = (r: number) => (r >= 80 ? '#e5483d' : r >= 65 ? '#ee7a2b' : r >= 50 ? '#e3a72f' : '#3fa564')
const riskLabel = (r: number) => (r >= 80 ? 'Aşırı' : r >= 65 ? 'Yüksek' : r >= 50 ? 'Orta' : 'Düşük')

const SAMPLE_HISTORY = [
  { name: 'Kemer yaylası – örnek çalıştırma', area: 'Antalya', ha: 2140, wind: '22 km/sa B', when: 'Örnek' },
  { name: 'Ayvacık sırtı – örnek çalıştırma', area: 'Çanakkale', ha: 960, wind: '30 km/sa KD', when: 'Örnek' },
  { name: 'Edremit etekleri – örnek çalıştırma', area: 'Balıkesir', ha: 1580, wind: '26 km/sa K', when: 'Örnek' },
]

export function Dashboard() {
  const nav = useNavigate()
  const { scenarios, active, setActive, setDraftArea, selectedRegionId, setSelectedRegionId } = useStore()
  const [focus, setFocus] = useState<string | null>(null)
  const region = regionById(selectedRegionId)
  const final = active.result.series[active.result.series.length - 1]
  const totalKm2 = REGIONS.reduce((s, r) => s + r.forestKm2, 0)
  const highRisk = REGIONS.filter((r) => r.risk >= 70).length
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
    <div className="flex min-h-full flex-col">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-line bg-panel px-4 py-3 lg:grid-cols-4">
        <Stat label="Bu oturumdaki simülasyonlar" value={scenarios.length} hint="Bellekte tutulan senaryolar – hazır ve özel çalıştırmalar" tone="forest" />
        <Stat label="Yüksek riskli bölgeler" value={highRisk} unit={`/ ${REGIONS.length}`} hint="Temsili tehlike endeksi 70 veya üzeri" tone="fire" />
        <Stat label="İzlenen orman alanı" value={totalKm2.toLocaleString('en-US')} unit="km²" hint="Beş demo bölgesi için örnek değer" />
        <Stat label="Potansiyel etkilenen" value={fmtHa(final.affectedHa)} unit="ha" hint={`“${active.name}” senaryosunun son yayılımı`} tone="amber" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative h-[58vh] min-h-[380px] flex-1 lg:h-auto">
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
                  { color: '#e5483d', label: 'Aşırı, 80+', kind: 'dot' },
                  { color: '#ee7a2b', label: 'Yüksek, 65–79', kind: 'dot' },
                  { color: '#e3a72f', label: 'Orta, 50–64', kind: 'dot' },
                  { color: '#3fa564', label: 'Düşük, 50 altı', kind: 'dot' },
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

        <aside className="w-full shrink-0 space-y-3 overflow-auto border-t border-line bg-bg p-3 lg:w-[350px] lg:border-l lg:border-t-0">
          <Panel title={region.name} action={<span className="text-[12px] font-semibold" style={{ color: riskColor(region.risk) }}>{riskLabel(region.risk)} · {region.risk}</span>}>
            <p className="mb-3 text-[13px] leading-snug text-muted">{region.note}</p>
            <div className="mb-1 flex items-center justify-between text-[12px] text-muted">
              <span>Örnek hava durumu</span>
              <SimBadge text="Canlı değil" />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <div className="flex items-center gap-2"><Thermometer size={15} className="text-orange" /><dt className="sr-only">Sıcaklık</dt><dd>{region.weather.temperatureC} °C</dd></div>
              <div className="flex items-center gap-2"><Droplets size={15} className="text-water" /><dt className="sr-only">Nem</dt><dd>%{region.weather.humidityPct} nem</dd></div>
              <div className="flex items-center gap-2"><Wind size={15} className="text-muted" /><dt className="sr-only">Rüzgar</dt><dd className="flex items-center gap-1">{region.weather.windSpeedKmh} km/sa <WindArrow fromDeg={region.weather.windFromDeg} className="text-ink" /> {compass(region.weather.windFromDeg)} yönünden</dd></div>
              <div className="flex items-center gap-2"><CloudRain size={15} className="text-muted" /><dt className="sr-only">Yağış</dt><dd>{region.weather.precipMmH} mm/sa</dd></div>
            </dl>
            <div className="mt-3 text-[12px] text-muted">Orman alanı {region.forestKm2.toLocaleString('en-US')} km² · çalışma alanında {region.settlements.length} yerleşim</div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => openStudio(region.id)} className="flex flex-1 items-center justify-center gap-1.5 bg-forest px-3 py-2 text-[13px] font-semibold text-bg hover:bg-forest/85">
                Simülasyon Stüdyosunda incele <ArrowRight size={14} />
              </button>
            </div>
          </Panel>

          <Panel title="Yüksek riskli orman bölgeleri" pad={false}>
            <ul>
              {sorted.map((r) => (
                <li key={r.id}>
                  <button onClick={() => pick(r.id)} className={`flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-panel2 ${r.id === selectedRegionId ? 'bg-panel2' : ''}`}>
                    <span className="w-24 shrink-0 text-[13px] font-medium">{r.name}</span>
                    <span className="h-1.5 flex-1 bg-line"><span className="block h-full" style={{ width: `${r.risk}%`, background: riskColor(r.risk) }} /></span>
                    <span className="w-6 text-right text-[13px] font-semibold" style={{ color: riskColor(r.risk) }}>{r.risk}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Son simülasyonlar" pad={false}>
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
                        <span className="block text-[12px] text-muted">{c.windSpeedKmh} km/sa {compass(c.windFromDeg)} · %{c.humidityPct} BN · {c.durationH} sa</span>
                      </span>
                      <span className="text-right text-[13px] font-semibold text-amber">{fmtHa(f.affectedHa)}<span className="block text-[11px] font-normal text-muted">ha</span></span>
                    </button>
                  </li>
                )
              })}
              {SAMPLE_HISTORY.map((h) => (
                <li key={h.name} className="flex items-start gap-2 border-b border-line px-3 py-2 last:border-b-0 opacity-70">
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 bg-line2" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{h.name}</span>
                    <span className="block text-[12px] text-muted">{h.area} · {h.wind}</span>
                  </span>
                  <span className="text-right text-[13px] font-semibold">{h.ha.toLocaleString('en-US')}<span className="block text-[11px] font-normal text-muted">ha</span></span>
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  )
}
