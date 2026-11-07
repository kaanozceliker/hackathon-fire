import { useEffect, useMemo } from 'react'
import L from 'leaflet'
import { Marker, Polyline, Rectangle, Tooltip } from 'react-leaflet'
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { Crosshair, Flame, Loader2, RotateCcw } from 'lucide-react'
import { MapStage, WindArrow } from '../components/MapStage'
import { Timeline } from '../components/Timeline'
import { Legend, Panel, Segmented, SliderField, Stat, fmtHa } from '../components/ui'
import { icons } from '../components/mapIcons'
import { ARRIVAL_LEGEND, type FireMode } from '../components/FireCanvasLayer'
import { REGIONS, regionById, defaultConfig } from '../data/regions'
import { getGrid } from '../sim/gridCache'
import { cellOf, gridBounds } from '../sim/terrain'
import { compass } from '../sim/geo'
import type { Intensity, TerrainType } from '../sim/types'
import { useStore } from '../state/store'
import { useState } from 'react'

function destination(lat: number, lon: number, bearingDeg: number, km: number): [number, number] {
  const b = (bearingDeg * Math.PI) / 180
  return [lat + (km * Math.cos(b)) / 111.32, lon + (km * Math.sin(b)) / (111.32 * Math.cos((lat * Math.PI) / 180))]
}

const arrowIcon = (deg: number) =>
  L.divIcon({
    html: `<svg width="26" height="26" viewBox="-13 -13 26 26" style="transform:rotate(${deg}deg)"><path d="M0 -11 L8 8 L0 3 L-8 8 Z" fill="#ffd24a" stroke="#0a1014" stroke-width="1.5"/></svg>`,
    className: 'fg-icon',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  })

export function Studio() {
  const s = useStore()
  const { draft, patchDraft, active, step, dirty, progress, startSimulation, notify, setDraftArea, demoPlayed, markDemoPlayed, restart, setPlaying, loadPreset } = s
  const [mode, setMode] = useState<FireMode>('fire')
  const region = regionById(draft.areaId)
  const grid = getGrid(draft.areaId)
  const res = active.result
  const matches = res.config.areaId === draft.areaId
  const shownMode: FireMode = matches ? mode : 'fuel'
  const stat = res.series[Math.min(step, res.series.length - 1)]

  useEffect(() => {
    if (!demoPlayed) {
      markDemoPlayed()
      restart()
      const t = window.setTimeout(() => setPlaying(true), 600)
      return () => window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onMapClick = (lat: number, lon: number) => {
    const c = cellOf(grid, lat, lon)
    if (c < 0) return notify(`Tutuşma noktası seçili orman alanının (${region.name}) içinde olmalı.`)
    if (grid.kind[c] === 0) return notify('Bu nokta açık su. Karada bir nokta seçin.')
    patchDraft({ ignition: [lat, lon] })
  }

  const chartData = useMemo(() => res.series.map((p) => ({ h: p.minutes / 60, ha: Math.round(p.affectedHa), burning: Math.round(p.burningHa) })), [res])
  const final = res.series[res.series.length - 1]
  const heading = stat.headingDeg
  const arrowEnd = matches && heading !== null && step > 0 ? destination(res.config.ignition[0], res.config.ignition[1], heading, Math.max(0.5, stat.maxRadiusKm * 0.7)) : null

  const legend =
    shownMode === 'fuel' ? (
      <Legend title="Arazi örtüsü ve yakıt" items={[
        { color: 'rgba(30,130,70,.7)', label: 'Çam ormanı (yoğun yakıt)' },
        { color: 'rgba(86,170,95,.5)', label: 'Maki çalılığı' },
        { color: 'rgba(190,180,90,.4)', label: 'Seyrek / tarım' },
        { color: 'rgba(160,170,175,.5)', label: 'Yerleşim' },
        { color: 'rgba(40,90,140,.6)', label: 'Su' },
      ]} />
    ) : shownMode === 'arrival' ? (
      <Legend title="Tahmini yangın varışı" items={ARRIVAL_LEGEND} />
    ) : (
      <Legend title="Yangın durumu" items={[
        { color: '#ffd24a', label: 'Aktif yanıyor, yeni' },
        { color: '#e5502a', label: 'Yanıyor, son evre' },
        { color: '#46181a', label: 'Yanıp söndü' },
        { color: '#ffe9b0', label: 'Yangın çevresi', kind: 'line' },
        { color: '#ffd24a', label: 'Yayılma yönü', kind: 'dash' },
      ]} />
    )

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:flex-row">
      {/* configuration */}
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-b border-line bg-panel p-3 lg:w-[300px] lg:border-b-0 lg:border-r">
        <div>
          <label htmlFor="area" className="mb-1 block text-[12px] text-muted">Orman alanı</label>
          <select id="area" value={draft.areaId} onChange={(e) => setDraftArea(e.target.value)} className="w-full border border-line2 bg-bg px-2 py-1.5 text-[14px]">
            {REGIONS.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        <div className="border border-line2 bg-bg p-2.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold"><Crosshair size={14} className="text-fire" /> Tutuşma noktası</span>
            <button onClick={() => patchDraft({ ignition: defaultConfig(region).ignition })} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink"><RotateCcw size={12} /> Sıfırla</button>
          </div>
          <div className="mt-1 text-[13px]">{draft.ignition[0].toFixed(4)}°K, {draft.ignition[1].toFixed(4)}°D</div>
          <div className="text-[12px] text-muted">Taşımak için haritada kesikli alanın içinde herhangi bir yere tıklayın.</div>
        </div>

        <div className="space-y-2.5">
          <div>
            <div className="mb-1 text-[12px] text-muted">Başlangıç yangın şiddeti</div>
            <Segmented<Intensity> label="Başlangıç yangın şiddeti" value={draft.intensity} onChange={(v) => patchDraft({ intensity: v })} options={[{ value: 'low', label: 'Düşük' }, { value: 'medium', label: 'Orta' }, { value: 'high', label: 'Yüksek' }]} />
          </div>
          <div>
            <div className="mb-1 text-[12px] text-muted">Simülasyon süresi</div>
            <Segmented<number> label="Simülasyon süresi" value={draft.durationH} onChange={(v) => patchDraft({ durationH: v as 1 | 3 | 6 | 12 | 24 })} options={[1, 3, 6, 12, 24].map((h) => ({ value: h, label: `${h} sa` }))} />
          </div>
        </div>

        <Panel title="Hava durumu" action={<span className="text-[11px] text-muted">Örnek girdiler</span>}>
          <div className="space-y-2.5">
            <div className="flex gap-1.5">
              <button onClick={() => loadPreset({ ...defaultConfig(region), ignition: draft.ignition, intensity: draft.intensity, durationH: draft.durationH, terrain: draft.terrain, fuelLoad: draft.fuelLoad })} className="flex-1 border border-line2 px-1 py-1 text-[12px] text-muted hover:text-ink">Bölge örneği</button>
              <button onClick={() => loadPreset({ windSpeedKmh: 15, humidityPct: 45, temperatureC: 28 })} className="flex-1 border border-line2 px-1 py-1 text-[12px] text-muted hover:text-ink">Senaryo A</button>
              <button onClick={() => loadPreset({ windSpeedKmh: 35, humidityPct: 18, temperatureC: 37 })} className="flex-1 border border-line2 px-1 py-1 text-[12px] text-muted hover:text-ink">Senaryo B</button>
            </div>
            <SliderField label="Sıcaklık" value={draft.temperatureC} min={5} max={45} unit="°C" onChange={(v) => patchDraft({ temperatureC: v })} />
            <SliderField label="Bağıl nem" value={draft.humidityPct} min={5} max={95} unit="%" onChange={(v) => patchDraft({ humidityPct: v })} hint="Düşük nem yakıtı kurutur ve yayılmayı hızlandırır" />
            <SliderField label="Rüzgar hızı" value={draft.windSpeedKmh} min={0} max={60} unit="km/sa" onChange={(v) => patchDraft({ windSpeedKmh: v })} />
            <div>
              <SliderField label="Rüzgar yönü (geldiği)" value={draft.windFromDeg} min={0} max={355} step={5} unit="°" format={(v) => `${compass(v)} ${v}`} onChange={(v) => patchDraft({ windFromDeg: v })} hint="Rüzgarın estiği yön. Yangın ters yöne yayılır." />
              <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted"><WindArrow fromDeg={draft.windFromDeg} className="text-ink" /> Yangını {compass(draft.windFromDeg + 180)} yönüne iter</div>
            </div>
            <SliderField label="Yağış" value={draft.precipMmH} min={0} max={10} step={0.5} unit="mm/sa" onChange={(v) => patchDraft({ precipMmH: v })} />
          </div>
        </Panel>

        <Panel title="Arazi ve yakıt">
          <div className="space-y-2.5">
            <div>
              <div className="mb-1 text-[12px] text-muted">Arazi koşulları</div>
              <Segmented<TerrainType> label="Arazi koşulları" value={draft.terrain} onChange={(v) => patchDraft({ terrain: v })} options={[{ value: 'coastal-plain', label: 'Düz' }, { value: 'rolling-hills', label: 'Tepelik' }, { value: 'steep-mountain', label: 'Dik' }]} />
              <div className="mt-1 text-[11px] text-muted">Eğimin yokuş yukarı yayılımı ne kadar hızlandırdığını ayarlar.</div>
            </div>
            <SliderField label="Bitki örtüsü yoğunluğu" value={Math.round(draft.fuelLoad * 100)} min={60} max={140} step={5} unit="%" onChange={(v) => patchDraft({ fuelLoad: v / 100 })} hint="Her orman hücresindeki kullanılabilir yakıtı ölçekler" />
          </div>
        </Panel>

        <button onClick={startSimulation} disabled={progress !== null} className="flex w-full items-center justify-center gap-2 bg-fire px-3 py-2.5 text-[15px] font-semibold text-white hover:bg-fire/90 disabled:opacity-60">
          {progress !== null ? <Loader2 size={17} className="animate-spin" /> : <Flame size={17} />}
          {progress !== null ? 'Hesaplanıyor…' : 'Simülasyonu başlat'}
        </button>
        <p className="text-[11px] leading-snug text-muted">Sonuçlar temsili bir hücresel otomat simülasyonudur; doğrulanmış bir orman yangını tahmini veya operasyonel yönlendirme değildir.</p>
      </aside>

      {/* map */}
      <div className="flex min-h-[560px] min-w-0 flex-1 flex-col lg:min-h-0">
      <div className="relative min-h-[440px] flex-1">
        <MapStage
          grid={grid}
          result={matches ? res : null}
          step={step}
          mode={shownMode}
          fitGrid
          fitKey={draft.areaId}
          pick
          hud
          onMapClick={onMapClick}
          legend={legend}
          controls={
            <div className="space-y-2">
              <div className="flex border border-line2 bg-bg/90 text-[12px]" role="radiogroup" aria-label="Harita katmanı">
                {([['fire', 'Yangın yayılımı'], ['arrival', 'Varış süresi'], ['fuel', 'Yakıt']] as const).map(([k, l]) => (
                  <button key={k} role="radio" aria-checked={shownMode === k} disabled={!matches && k !== 'fuel'} onClick={() => setMode(k)} className={`px-2 py-1 font-medium disabled:opacity-40 ${shownMode === k ? 'bg-forest-dim text-ink' : 'text-muted hover:text-ink'}`}>{l}</button>
                ))}
              </div>
              <div className="flex items-center gap-2 border border-line2 bg-bg/90 px-2 py-1 text-[12px]">
                <WindArrow fromDeg={draft.windFromDeg} className="text-ink" />
                <span>{draft.windSpeedKmh} km/sa, {compass(draft.windFromDeg)} yönünden</span>
              </div>
            </div>
          }
        >
          <Rectangle bounds={gridBounds(grid)} interactive={false} pathOptions={{ color: '#3fa564', weight: 1.5, dashArray: '6 6', fill: false }} />
          {region.settlements.map((st) => (
            <Marker key={st.id} position={st.pos} icon={icons.settlement}>
              <Tooltip direction="right" permanent offset={[8, 0]} className="fg-label">{st.name}</Tooltip>
            </Marker>
          ))}
          <Marker position={draft.ignition} icon={icons.ignition}>
            <Tooltip direction="top" offset={[0, -12]}>Tutuşma noktası</Tooltip>
          </Marker>
          {arrowEnd && (
            <>
              <Polyline positions={[res.config.ignition, arrowEnd]} pathOptions={{ color: '#ffd24a', weight: 2.5, dashArray: '8 6', opacity: 0.95 }} interactive={false} />
              <Marker position={arrowEnd} icon={arrowIcon(heading!)} interactive={false} />
            </>
          )}
        </MapStage>

        {!matches && (
          <div className="absolute left-14 top-2 z-[500] max-w-[300px] border border-line2 bg-bg/92 px-2.5 py-2 text-[12px]">
            <b>{region.name}</b> yeni bir alan. Harita bu alanın yakıtını gösteriyor. Tutuşma noktasını yerleştirin, hava durumunu ayarlayın ve <b>Simülasyonu başlat</b>'a basın.
          </div>
        )}
        {matches && dirty && progress === null && (
          <div className="absolute left-14 top-2 z-[500] max-w-[300px] border border-amber/50 bg-bg/92 px-2.5 py-2 text-[12px] text-amber">
            Ayarlar değişti. Harita hâlâ “{active.name}” senaryosunu gösteriyor. Güncellemek için Simülasyonu başlat'a basın.
          </div>
        )}
        {matches && !dirty && (
          <div className="absolute left-14 top-2 z-[500] border border-line2 bg-bg/92 px-2.5 py-1.5 text-[12px]">
            Gösterilen: <b>{active.name}</b>
          </div>
        )}

        {progress !== null && (
          <div className="absolute inset-0 z-[900] flex items-center justify-center bg-bg/60">
            <div className="w-[320px] border border-line2 bg-panel p-4">
              <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold"><Loader2 size={16} className="animate-spin text-forest" /> Yangın yayılımı simüle ediliyor</div>
              <div className="h-2 bg-line"><div className="fg-busy h-full bg-forest transition-[width]" style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>
              <div className="mt-2 text-[12px] text-muted">Arazi ızgarası oluşturuluyor; {draft.durationH} sa için rüzgar, nem ve eğim uygulanıyor…</div>
            </div>
          </div>
        )}

      </div>
      <div className="border-t border-line bg-panel p-2"><Timeline /></div>
      </div>

      {/* live statistics */}
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-t border-line bg-bg p-3 lg:w-[290px] lg:border-l lg:border-t-0">
        <Panel title={`Canlı istatistikler · T+${Math.floor(stat.minutes / 60)}:${String(stat.minutes % 60).padStart(2, '0')}`}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-3">
            <Stat label="Şu an yanan" value={fmtHa(stat.burningHa)} unit="ha" tone="fire" />
            <Stat label="Toplam etkilenen" value={fmtHa(stat.affectedHa)} unit="ha" tone="amber" />
            <Stat label="Yangın çevresi" value={stat.perimeterKm.toFixed(1)} unit="km" />
            <Stat label="Cephe hızı" value={Math.round(stat.rosMh).toLocaleString('en-US')} unit="m/sa" hint="En uzak yangın noktasının son bir saatteki ilerlemesi" />
            <Stat label="Yayılma yönü" value={stat.headingDeg === null ? '–' : compass(stat.headingDeg)} unit={stat.headingDeg === null ? '' : `${Math.round(stat.headingDeg)}°`} />
            <Stat label="En uzak nokta" value={stat.maxRadiusKm.toFixed(1)} unit="km" hint="Tutuşma noktasına uzaklık" />
          </div>
        </Panel>

        <Panel title="Etkilenen orman örtüsü">
          {[
            { label: 'Çam ormanı', v: stat.pineHa, c: '#2f9e5c' },
            { label: 'Maki çalılığı', v: stat.maquisHa, c: '#7fbf6a' },
            { label: 'Seyrek ve diğer', v: stat.sparseHa, c: '#b8ad5a' },
          ].map((r) => (
            <div key={r.label} className="mb-2 last:mb-0">
              <div className="flex justify-between text-[12px]"><span className="text-muted">{r.label}</span><span className="font-semibold">{fmtHa(r.v)} ha</span></div>
              <div className="mt-0.5 h-1.5 bg-line"><div className="h-full" style={{ width: `${final.affectedHa ? (r.v / final.affectedHa) * 100 : 0}%`, background: r.c }} /></div>
            </div>
          ))}
        </Panel>

        <Panel title="Zamana göre etkilenen alan">
          <div className="h-[150px]">
            <ResponsiveContainer>
              <AreaChart data={chartData} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="#233139" vertical={false} />
                <XAxis dataKey="h" type="number" domain={[0, res.config.durationH]} tick={{ fill: '#8a9ba3', fontSize: 11 }} tickFormatter={(v) => `${v}sa`} stroke="#2f414b" />
                <YAxis tick={{ fill: '#8a9ba3', fontSize: 11 }} stroke="#2f414b" width={44} />
                <RTooltip contentStyle={{ background: '#0f171c', border: '1px solid #2f414b', fontSize: 12 }} labelFormatter={(v) => `T+${Number(v).toFixed(1)} sa`} formatter={(v) => [`${Number(v).toLocaleString('en-US')} ha`, 'Etkilenen']} />
                <Area type="monotone" dataKey="ha" stroke="#e3a72f" strokeWidth={2} fill="#e3a72f" fillOpacity={0.18} isAnimationActive={false} />
                <ReferenceLine x={stat.minutes / 60} stroke="#e7eee9" strokeDasharray="3 3" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {matches && (
          <Panel title="Yerleşimler" pad={false}>
            <ul>
              {regionById(res.config.areaId).settlements.map((st, i) => {
                const a = res.impacts[i].arrivalMin
                const reached = a !== null && a <= stat.minutes
                return (
                  <li key={st.id} className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[13px] last:border-b-0">
                    <span>{st.name}<span className="ml-1.5 text-[11px] text-muted">{st.population.toLocaleString('en-US')}</span></span>
                    <span className={reached ? 'font-semibold text-fire' : a !== null ? 'text-amber' : 'text-forest'}>
                      {reached ? 'Yangın sınırda' : a !== null ? `Tahmini T+${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}` : 'Ulaşılmadı'}
                    </span>
                  </li>
                )
              })}
            </ul>
          </Panel>
        )}
      </aside>
    </div>
  )
}
