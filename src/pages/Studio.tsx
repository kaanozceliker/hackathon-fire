import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import { Marker, Polyline, Tooltip } from 'react-leaflet'
import { Area, AreaChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { Activity, ChevronDown, CloudDownload, CloudFog, Crosshair, Flame, Info, Layers3, Loader2, MapPinned, PanelRightClose, PanelRightOpen, RotateCcw, Settings2, ShieldCheck, Trees, Wind } from 'lucide-react'
import { MapStage, WindArrow } from '../components/MapStage'
import { Timeline } from '../components/Timeline'
import { Legend, Panel, Segmented, SliderField, Stat, fmtHa } from '../components/ui'
import { icons } from '../components/mapIcons'
import { SurroundingsPanel, TreeCoverOverlay, surroundings } from '../components/IgnitionSurroundings'
import { EXISTING_LEGEND, ExistingOverlay } from '../components/ExistingOverlay'
import { simYear } from '../sim/existing'
import { LandAutoInfo } from '../components/LandAutoInfo'
import { autoTerrain, fuelFromNdmi, fuelState, liveCover, liveCoverShare, seasonalFuel } from '../sim/landAuto'
import { fuelOf } from '../sim/engine'
import { ARRIVAL_LEGEND, type FireMode } from '../components/FireCanvasLayer'
import { REGIONS, regionById, defaultConfig } from '../data/regions'
import { getGrid } from '../sim/gridCache'
import { cellCenter, cellOf } from '../sim/terrain'
import { compass } from '../sim/geo'
import type { Intensity, TerrainType } from '../sim/types'
import { useStore } from '../state/store'
import { useState } from 'react'
import { currentLocalHour, fetchWeather, weatherAt, weatherSeries, withStartValues } from '../sim/weather'
import { aqiOf, computeSmoke, exposures } from '../sim/smoke'
import { EventFeed, simulationEvents } from '../components/SimulationEvents'

const fmtT = (t: number) => (t >= 1000 ? `${(t / 1000).toFixed(t >= 100000 ? 0 : 1)} bin` : t >= 10 ? Math.round(t).toLocaleString('en-US') : t.toFixed(1))

const WEATHER_SOURCE = { 'open-meteo-forecast': 'Open-Meteo tahmini', 'open-meteo-archive': 'Open-Meteo arşivi (ERA5)', custom: 'Özel seri' } as const

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
  const { draft, patchDraft, active, step, dirty, progress, startSimulation, notify, setDraftArea, loadPreset } = s
  const [mode, setMode] = useState<FireMode>('fire')
  const region = regionById(draft.areaId)
  const grid = getGrid(draft.areaId)
  const res = active.result
  const playbackClock = useRef(step * res.stepMin)
  useEffect(() => {
    const target = step * res.stepMin
    const start = playbackClock.current
    if (!s.playing || target < start || target - start > res.stepMin * 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      playbackClock.current = target
      return
    }
    let frame = 0
    const began = performance.now()
    const duration = 1000 / (5 * s.speed)
    const animate = (now: number) => {
      const share = Math.min(1, (now - began) / duration)
      playbackClock.current = start + (target - start) * share
      if (share < 1) frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [res, step, s.playing, s.speed])
  const sameArea = res.config.areaId === draft.areaId
  // the shown run only fits the map while the ignition point is where it started; after a move the map shows the land
  const matches = sameArea && res.config.ignition[0] === draft.ignition[0] && res.config.ignition[1] === draft.ignition[1]
  const shownMode: FireMode = matches ? mode : mode === 'fuel' ? 'fuel' : 'none'
  const stat = res.series[Math.min(step, res.series.length - 1)]
  const [weatherMode, setWeatherMode] = useState<'fixed' | 'live'>(draft.weather ? 'live' : 'fixed')
  const [startIso, setStartIso] = useState(() => draft.weather?.startIso ?? currentLocalHour())
  const [weatherBusy, setWeatherBusy] = useState(false)
  const [showWind, setShowWind] = useState(true)
  const [showSmoke, setShowSmoke] = useState(true)
  const [showTrees, setShowTrees] = useState(false)
  const [insightsOpen, setInsightsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(() => window.innerWidth >= 1024)
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    if (!picking) return
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') setPicking(false) }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [picking])
  const events = useMemo(() => matches ? simulationEvents(res, step) : [], [res, step, matches])
  const seekEvent = (next: number) => { s.setPlaying(false); s.setStep(next) }
  const around = useMemo(() => surroundings(grid, draft.ignition, simYear(draft)), [grid, draft])
  const [showExisting, setShowExisting] = useState(false)
  // "Arazi ve yakıt" from data: slope from the DEM, fuel dryness from the latest Sentinel-2 pass (null = set by hand)
  const [landMode, setLandMode] = useState<'auto' | 'manual'>(() => (draft.landAuto === null ? 'manual' : 'auto'))
  const [landBusy, setLandBusy] = useState(false)
  const fireDate = draft.weather?.startIso ?? new Date().toISOString().slice(0, 10)
  // share of vegetation at the ignition cell on the latest satellite pass (null = unknown)
  const originVeg = useMemo(() => {
    const cov = draft.landAuto?.cover
    if (!cov) return null
    const share = liveCoverShare(cov.b64, grid.cols * grid.rows)
    const c = cellOf(grid, draft.ignition[0], draft.ignition[1])
    return share && c >= 0 && share[c] !== 255 ? share[c] / 254 : null
  }, [draft.landAuto, draft.ignition, grid])
  useEffect(() => {
    if (landMode !== 'auto') return
    const t = autoTerrain(grid, draft.ignition)
    let alive = true
    setLandBusy(true)
    const timer = window.setTimeout(() => {
      Promise.all([fuelState(draft.ignition, fireDate), liveCover(grid, fireDate)]).then(([fuel, cover]) => {
        if (!alive) return
        const f = 'ndmi' in fuel ? fuelFromNdmi(fuel.ndmi) : seasonalFuel(Number(fireDate.slice(5, 7)))
        patchDraft({ terrain: t.terrain, fuelLoad: Math.round(f * 20) / 20, landAuto: { terrain: { meanSlopePct: t.meanSlopePct, steepPct: t.steepPct }, fuel, cover } })
        setLandBusy(false)
      })
    }, 350)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [landMode, grid, draft.ignition, fireDate, patchDraft])
  const smoke = useMemo(() => (matches ? computeSmoke(res) : null), [res, matches])
  const smokeExp = useMemo(() => (smoke ? exposures(smoke) : null), [smoke])
  useEffect(() => {
    // a scenario loaded from elsewhere (area change, scenario picker) decides the mode
    setWeatherMode(draft.weather ? 'live' : 'fixed')
    if (draft.weather) setStartIso(draft.weather.startIso)
  }, [draft.areaId, active.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const loadWeather = async () => {
    setWeatherBusy(true)
    try {
      const weather = await fetchWeather(grid, startIso, draft.durationH)
      loadPreset(withStartValues({ ...draft, weather }))
      notify(`Hava verisi yüklendi: ${startIso.replace('T', ' ')} itibarıyla ${draft.durationH} saat.`)
    } catch (e) {
      notify(`Hava verisi alınamadı: ${(e as Error).message}`)
    } finally {
      setWeatherBusy(false)
    }
  }
  const now = weatherAt(res.config, stat.minutes)
  const weatherChart = useMemo(() => (res.config.weather ? weatherSeries(res.config) : null), [res])


  const onMapClick = (lat: number, lon: number) => {
    if (!picking) return
    const c = cellOf(grid, lat, lon)
    if (c < 0) return notify(`Tutuşma noktası seçili orman alanının (${region.name}) içinde olmalı.`)
    if (grid.kind[c] === 0) {
      // on water: take the nearest land cell (the coast is hard to see on the dark map)
      let best = -1
      let bd = Infinity
      const cx = c % grid.cols
      const cy = (c / grid.cols) | 0
      for (let dy = -6; dy <= 6; dy++)
        for (let dx = -6; dx <= 6; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows || grid.kind[y * grid.cols + x] === 0) continue
          if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = y * grid.cols + x }
        }
      if (best < 0) return notify('Bu nokta açık su. Karada bir nokta seçin.')
      notify('Tıkladığınız yer su; en yakın kara noktası seçildi.')
      patchDraft({ ignition: cellCenter(grid, best) })
      setPicking(false)
      return
    }
    if (fuelOf(grid, c, 1) === 0) notify('Bu nokta neredeyse çıplak toprak: yangın burada tutunamayabilir.')
    patchDraft({ ignition: [lat, lon] })
    setPicking(false)
  }

  const chartData = useMemo(() => res.series.map((p) => ({ h: p.minutes / 60, ha: Math.round(p.affectedHa), burning: Math.round(p.burningHa) })), [res])
  const final = res.series[res.series.length - 1]
  const heading = stat.headingDeg
  const arrowEnd = matches && heading !== null && step > 0 ? destination(res.config.ignition[0], res.config.ignition[1], heading, Math.max(0.5, stat.maxRadiusKm * 0.7)) : null

  const legend =
    shownMode === 'fuel' ? (
      <Legend title="Arazi örtüsü ve yakıt" items={[
        { color: 'rgba(122,146,155,.7)', label: 'Çam ormanı (yoğun yakıt)' },
        { color: 'rgba(169,156,133,.5)', label: 'Maki çalılığı' },
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
        { color: '#3a302e', label: 'Yanmış alan' },
        { color: '#ead1ad', label: 'Toplam yangın çevresi', kind: 'line' },
        { color: '#ffcd71', label: 'Aktif yanma sınırı', kind: 'line' },
        { color: '#ffd24a', label: 'Yayılma yönü', kind: 'dash' },
        { color: '#ffa53a', label: 'Olası kor düşme noktası', kind: 'dot' },
        { color: '#fff1a6', label: 'Yeni sıçrama (kor)', kind: 'dot' },
      ]} />
    )

  return (
    <div className="fg-workbench">
      {/* configuration */}
      <aside className={`fg-control-rail ${settingsOpen ? '' : 'is-collapsed'}`}>
        <div className="fg-rail-heading"><div><p className="fg-eyebrow">Senaryo kurulumu</p><h2>Ayarları belirleyin</h2></div><button className="fg-icon-button" onClick={() => setSettingsOpen(!settingsOpen)} aria-expanded={settingsOpen} aria-label={settingsOpen ? 'Senaryo ayarlarını gizle' : 'Senaryo ayarlarını göster'}><Settings2 size={15} /></button></div>
        {settingsOpen && <div className="fg-control-scroll space-y-4">
        <div>
          <label htmlFor="area" className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted"><MapPinned size={13} /> Çalışma bölgesi</label>
          <select id="area" value={draft.areaId} onChange={(e) => { setDraftArea(e.target.value); setPicking(false) }} className="w-full border border-line2 bg-bg px-2.5 py-2.5 text-[12px]">
            {REGIONS.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        <div className="fg-ignition-card">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold"><Crosshair size={14} className="text-orange" /> Tutuşma noktası</span>
            <button onClick={() => patchDraft({ ignition: defaultConfig(region).ignition })} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink"><RotateCcw size={12} /> Sıfırla</button>
          </div>
          <div className="fg-ignition-coords">{draft.ignition[0].toFixed(4)}°K <span className="text-line2">/</span> {draft.ignition[1].toFixed(4)}°D</div>
          <div className="text-[10px] leading-relaxed text-muted">Başlangıcı belirleyin; yayılımı seçtiğiniz koşullarda inceleyin.</div>
          <button className={`fg-button mt-3 w-full ${picking ? 'border-orange text-orange' : ''}`} aria-pressed={picking} onClick={() => setPicking(!picking)}><Crosshair size={13} />{picking ? 'Nokta seçimini iptal et' : 'Noktayı haritada seç'}</button>
        </div>

        <div className="space-y-3 rounded-lg border border-line p-3">
          <div>
            <div className="mb-2 text-[11px] text-muted">Başlangıç yangın şiddeti</div>
            <Segmented<Intensity> label="Başlangıç yangın şiddeti" value={draft.intensity} onChange={(v) => patchDraft({ intensity: v })} options={[{ value: 'low', label: 'Düşük' }, { value: 'medium', label: 'Orta' }, { value: 'high', label: 'Yüksek' }]} />
          </div>
          <SliderField label="Simülasyon süresi" value={draft.durationH} min={1} max={72} unit="sa" onChange={(v) => patchDraft(draft.weather && draft.weather.windSpeedKmh[0].length < v + 1 ? { durationH: v, weather: undefined } : { durationH: v })} hint="1 ile 72 saat arası, 10 dakikalık adımlarla" />
        </div>

        <details className="fg-setting-section" open>
          <summary><span className="flex items-center gap-2"><Wind size={14} className="text-water" /> Hava koşulları</span><ChevronDown size={13} /></summary>
          <div className="fg-setting-content"><Panel>
          <div className="space-y-2.5">
            <Segmented<'fixed' | 'live'> label="Hava kaynağı" value={weatherMode} onChange={(v) => { setWeatherMode(v); if (v === 'fixed' && draft.weather) patchDraft({ weather: undefined }) }} options={[{ value: 'fixed', label: 'Sabit' }, { value: 'live', label: 'Open-Meteo' }]} />
            {weatherMode === 'live' ? (
              <div className="space-y-2 border border-line2 bg-bg p-2.5">
                <label className="block text-[12px] text-muted">
                  Başlangıç (Türkiye saati)
                  <input type="datetime-local" step={3600} value={startIso} onChange={(e) => setStartIso(e.target.value.slice(0, 13) + ':00')} className="mt-1 w-full border border-line2 bg-panel px-2 py-1 text-[13px] text-ink" />
                </label>
                <button onClick={loadWeather} disabled={weatherBusy} className="flex w-full items-center justify-center gap-1.5 border border-forest/60 px-2 py-1.5 text-[12px] font-semibold text-forest hover:bg-forest-dim/40 disabled:opacity-60">
                  {weatherBusy ? <Loader2 size={13} className="animate-spin" /> : <CloudDownload size={13} />}
                  {draft.weather ? 'Hava verisini yenile' : 'Hava verisini getir'}
                </button>
                <p className="text-[11px] leading-snug text-muted">
                  {draft.weather
                    ? <>Izgarada 9 noktadan {draft.durationH + 1} saatlik veri yüklü. Rüzgar ve nem simülasyon boyunca saat saat ve yer yer değişir; aşağıdaki değerler başlangıç saatini gösterir.</>
                    : <>Geçmiş tarihler arşivden (ERA5), son günler ve önümüzdeki 16 gün tahminden gelir.</>}
                </p>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <button onClick={() => loadPreset({ ...defaultConfig(region), ignition: draft.ignition, intensity: draft.intensity, durationH: draft.durationH, terrain: draft.terrain, fuelLoad: draft.fuelLoad })} className="flex-1 border border-line2 px-1 py-1 text-[12px] text-muted hover:text-ink">Bölge örneği</button>
                <button onClick={() => loadPreset({ windSpeedKmh: 15, humidityPct: 45, temperatureC: 28 })} className="flex-1 border border-line2 px-1 py-1 text-[12px] text-muted hover:text-ink">Senaryo A</button>
                <button onClick={() => loadPreset({ windSpeedKmh: 35, humidityPct: 18, temperatureC: 37 })} className="flex-1 border border-line2 px-1 py-1 text-[12px] text-muted hover:text-ink">Senaryo B</button>
              </div>
            )}
            <fieldset disabled={!!draft.weather} className="space-y-2.5 disabled:opacity-60">
              <SliderField label="Sıcaklık" value={draft.temperatureC} min={5} max={45} unit="°C" onChange={(v) => patchDraft({ temperatureC: v })} />
              <SliderField label="Bağıl nem" value={draft.humidityPct} min={5} max={95} unit="%" onChange={(v) => patchDraft({ humidityPct: v })} hint="Düşük nem yakıtı kurutur ve yayılmayı hızlandırır" />
              <SliderField label="Rüzgar hızı" value={draft.windSpeedKmh} min={0} max={60} unit="km/sa" onChange={(v) => patchDraft({ windSpeedKmh: v })} />
              <div>
                <SliderField label="Rüzgar yönü (geldiği)" value={draft.windFromDeg} min={0} max={355} step={5} unit="°" format={(v) => `${compass(v)} ${v}`} onChange={(v) => patchDraft({ windFromDeg: v })} hint="Rüzgarın estiği yön. Yangın ters yöne yayılır." />
                <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted"><WindArrow fromDeg={draft.windFromDeg} className="text-ink" /> Yangını {compass(draft.windFromDeg + 180)} yönüne iter</div>
              </div>
              <SliderField label="Yağış" value={draft.precipMmH} min={0} max={10} step={0.5} unit="mm/sa" onChange={(v) => patchDraft({ precipMmH: v })} />
            </fieldset>
          </div>
        </Panel></div></details>

        <details className="fg-setting-section"><summary><span className="flex items-center gap-2"><Trees size={14} className="text-forest" /> Arazi ve yakıt</span><ChevronDown size={13} /></summary><div className="fg-setting-content"><Panel>
          <div className="space-y-2.5">
            <Segmented<'auto' | 'manual'> label="Arazi ve yakıt kaynağı" value={landMode} onChange={(v) => { setLandMode(v); if (v === 'manual') patchDraft({ landAuto: null }) }} options={[{ value: 'auto', label: 'Otomatik' }, { value: 'manual', label: 'Elle' }]} />
            {landMode === 'auto' ? (
              <LandAutoInfo terrain={draft.terrain} fuelLoad={draft.fuelLoad} auto={draft.landAuto ?? null} busy={landBusy} originVeg={originVeg} />
            ) : (
              <>
                <div>
                  <div className="mb-1 text-[12px] text-muted">Arazi koşulları</div>
                  <Segmented<TerrainType> label="Arazi koşulları" value={draft.terrain} onChange={(v) => patchDraft({ terrain: v })} options={[{ value: 'coastal-plain', label: 'Düz' }, { value: 'rolling-hills', label: 'Tepelik' }, { value: 'steep-mountain', label: 'Dik' }]} />
                  <div className="mt-1 text-[11px] text-muted">Eğimin yokuş yukarı yayılımı ne kadar hızlandırdığını ayarlar.</div>
                </div>
                <SliderField label="Bitki örtüsü yoğunluğu" value={Math.round(draft.fuelLoad * 100)} min={60} max={140} step={5} unit="%" onChange={(v) => patchDraft({ fuelLoad: v / 100 })} hint="Her orman hücresindeki kullanılabilir yakıtı ölçekler" />
              </>
            )}
            <label className="flex cursor-pointer items-start gap-2 text-[12.5px]">
              <input type="checkbox" checked={!draft.ignoreExisting} onChange={(e) => patchDraft({ ignoreExisting: e.target.checked ? undefined : true })} className="mt-0.5 h-4 w-4 accent-[#3fa564]" />
              <span>Mevcut önlemleri hesaba kat<span className="block text-[11px] text-muted">Yollar ve emniyet şeritleri yakıt kesintisi, son yıllardaki yanık alanlar az yakıt, kuleler erken tespit, havuzlar su noktası olur.</span></span>
            </label>
          </div>
        </Panel></div></details>
        <details className="fg-setting-section"><summary><span className="flex items-center gap-2"><ShieldCheck size={14} className="text-forest" /> Başlangıç çevresini tanıyın</span><ChevronDown size={13} /></summary><div className="fg-setting-content"><SurroundingsPanel s={around} cellM={grid.cellM} showTrees={showTrees} setShowTrees={setShowTrees} /></div></details>
        </div>}
        <div className="fg-control-footer">
        <button onClick={startSimulation} disabled={progress !== null} aria-label={progress !== null ? 'Hesaplanıyor' : 'Simülasyonu başlat'} className="fg-button fg-button--primary">
          {progress !== null ? <Loader2 size={17} className="animate-spin" /> : <Flame size={17} />}
          <span className="fg-run-label">{progress !== null ? 'Hesaplanıyor…' : 'Simülasyonu başlat'}</span>
        </button>
        <p>Temsili model · Planlama ve eğitim amaçlı</p>
        </div>
      </aside>

      {/* map */}
      <div className="fg-scene">
        <div className="fg-scene-heading">
          <div><h2>{region.name}</h2><p>{matches ? active.name : 'Yeni senaryo taslağı'} <span className="mx-1 opacity-40">·</span> {draft.durationH} saat / {grid.cellM} m çözünürlük {matches && dirty && <span className="fg-draft-pill" title="Harita kayıtlı senaryoyu gösteriyor. Yeni ayarları uygulamak için simülasyonu başlatın.">Ayarlar değişti</span>}</p></div>
          <div className="fg-scene-heading-actions"><button className="fg-button" aria-pressed={insightsOpen} onClick={() => setInsightsOpen(!insightsOpen)}>{insightsOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />} {insightsOpen ? 'Analizi gizle' : 'Analiz ve olaylar'}</button></div>
        </div>
        <div className="fg-scene-metrics">
          <Stat label="Etkilenen alan" value={matches ? fmtHa(stat.affectedHa) : '—'} unit="ha" tone="amber" />
          <Stat label="Aktif yanma" value={matches ? fmtHa(stat.burningHa) : '—'} unit="ha" tone="fire" />
          <Stat label="Cephe hızı" value={matches ? Math.round(stat.rosMh).toLocaleString('tr-TR') : '—'} unit="m/sa" />
          <Stat label="Ulaşılan yerleşim" value={matches ? res.impacts.filter((impact) => impact.arrivalMin !== null && impact.arrivalMin <= stat.minutes).length : '—'} unit={matches ? `/ ${res.impacts.length}` : ''} tone="forest" />
        </div>
        <div className="fg-map-toolbar">
          <div className="fg-segmented" role="radiogroup" aria-label="Harita katmanı">{([['fire', 'Yayılım'], ['arrival', 'Varış zamanı'], ['fuel', 'Arazi']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={shownMode === value} disabled={!matches && value !== 'fuel'} onClick={() => setMode(value)} className={shownMode === value ? 'is-selected' : ''}>{label}</button>)}</div>
          <div className="flex items-center gap-3"><span className="fg-wind-reading"><WindArrow fromDeg={matches ? now.windFromDeg : draft.windFromDeg} />{Math.round(matches ? now.windSpeedKmh : draft.windSpeedKmh)} km/sa {compass(matches ? now.windFromDeg : draft.windFromDeg)}</span><details className="fg-layer-menu"><summary><Layers3 size={13} /> Katmanlar <ChevronDown size={11} /></summary><div>
            <label><input type="checkbox" checked={showWind} onChange={(e) => setShowWind(e.target.checked)} /><Wind size={14} /> Rüzgar akışı</label>
            <label><input type="checkbox" checked={showSmoke} disabled={!matches} onChange={(e) => setShowSmoke(e.target.checked)} /><CloudFog size={14} /> Duman yayılımı</label>
            <label><input type="checkbox" checked={showTrees} onChange={(e) => setShowTrees(e.target.checked)} /><Trees size={14} /> Ağaç örtüsü</label>
            <label><input type="checkbox" checked={showExisting} onChange={(e) => setShowExisting(e.target.checked)} /><ShieldCheck size={14} /> Koruma altyapısı</label>
          </div></details></div>
        </div>
        {picking ? <div className="fg-scene-notice"><Crosshair size={13} className="shrink-0" />Kesikli çalışma alanında bir başlangıç noktası seçin. Vazgeçmek için Esc tuşuna basın.</div> : !matches && progress === null && <div className="fg-scene-notice"><Info size={13} className="shrink-0" />Yeni bölge veya tutuşma noktası seçildi. Yayılımı görmek için simülasyonu başlatın.</div>}
      <div className="fg-scene-map">
        <MapStage
          grid={grid}
          result={matches ? res : null}
          step={step}
          clockRef={playbackClock}
          mode={shownMode}
          fitGrid
          fitKey={draft.areaId}
          pick={picking}
          hud
          onMapClick={onMapClick}
          smoke={matches && showSmoke ? { result: res, step } : null}
          wind={showWind ? { config: matches ? res.config : draft, minutes: matches ? stat.minutes : 0 } : null}
          legend={showExisting ? <div className="space-y-2">{legend}<Legend title="Mevcut önlemler" items={EXISTING_LEGEND} /></div> : matches && showSmoke ? <div className="space-y-2">{legend}<Legend title="Duman, yer seviyesi PM2.5" items={[{ color: 'rgba(200,195,188,.45)', label: 'Pus, 10–35 µg/m³' }, { color: 'rgba(160,150,140,.7)', label: 'Yoğun, 55–225 µg/m³' }, { color: 'rgba(110,95,86,.88)', label: 'Çok yoğun, 225+ µg/m³' }]} /></div> : legend}
        >
          {region.settlements.map((st) => (
            <Marker key={st.id} position={st.pos} icon={icons.settlement}>
              <Tooltip direction="right" permanent offset={[8, 0]} className="fg-label">{st.name}</Tooltip>
            </Marker>
          ))}
          {showExisting && <ExistingOverlay grid={grid} year={simYear(draft)} />}
          {showTrees && <TreeCoverOverlay grid={grid} s={around} at={draft.ignition} />}
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

        {progress !== null && (
          <div className="absolute inset-0 z-[900] flex items-center justify-center bg-bg/60">
            <div className="w-[320px] rounded-xl border border-line2 bg-panel p-5 shadow-2xl">
              <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold"><Loader2 size={16} className="animate-spin text-forest" /> Yangın yayılımı simüle ediliyor</div>
              <div className="h-2 bg-line"><div className="fg-busy h-full bg-forest transition-[width]" style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>
              <div className="mt-2 text-[12px] text-muted">Arazi ızgarası oluşturuluyor; {draft.durationH} sa için rüzgar, nem ve eğim uygulanıyor…</div>
            </div>
          </div>
        )}

      </div>
      {events.length > 0 && <EventFeed events={events} onSeek={seekEvent} compact stepMin={res.stepMin} />}
      <Timeline disabled={!matches} />
      </div>

      {/* live statistics */}
      {insightsOpen && <aside className="fg-insight-rail space-y-3" aria-label="Simülasyon analizi">
        <div className="flex items-center justify-between pb-1"><span className="fg-eyebrow flex items-center gap-2"><Activity size={13} /> Model içgörüleri</span><button className="fg-icon-button" onClick={() => setInsightsOpen(false)} aria-label="Analiz panelini kapat"><PanelRightClose size={14} /></button></div>
        <Panel title={`Model özeti · T+${Math.floor(stat.minutes / 60)}:${String(stat.minutes % 60).padStart(2, '0')}`}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-3">
            <Stat label="Şu an yanan" value={fmtHa(stat.burningHa)} unit="ha" tone="fire" />
            <Stat label="Toplam etkilenen" value={fmtHa(stat.affectedHa)} unit="ha" tone="amber" />
            <Stat label="Yangın çevresi" value={stat.perimeterKm.toFixed(1)} unit="km" />
            <Stat label="Cephe hızı" value={Math.round(stat.rosMh).toLocaleString('en-US')} unit="m/sa" hint="En uzak yangın noktasının son bir saatteki ilerlemesi" />
            <Stat label="Yayılma yönü" value={stat.headingDeg === null ? '–' : compass(stat.headingDeg)} unit={stat.headingDeg === null ? '' : `${Math.round(stat.headingDeg)}°`} />
            <Stat label="En uzak nokta" value={stat.maxRadiusKm.toFixed(1)} unit="km" hint="Tutuşma noktasına uzaklık" />
          </div>
        </Panel>

        {matches && <Panel title="Olay akışı" action={<span className="text-[10px] text-muted">Zamana gitmek için seçin</span>}><EventFeed events={events} onSeek={seekEvent} stepMin={res.stepMin} /></Panel>}

        <Panel title={`Hava · T+${Math.floor(stat.minutes / 60)}:${String(stat.minutes % 60).padStart(2, '0')}`} action={res.config.weather ? <span className="text-[11px] text-muted">{WEATHER_SOURCE[res.config.weather.source]}</span> : <span className="text-[11px] text-muted">Sabit</span>}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[13px]">
            <div className="flex items-center gap-1.5"><WindArrow fromDeg={now.windFromDeg} className="text-ink" />{Math.round(now.windSpeedKmh)} km/sa {compass(now.windFromDeg)}</div>
            <div>%{Math.round(now.humidityPct)} nem</div>
            <div>{now.temperatureC.toFixed(0)} °C</div>
            <div>{now.precipMmH.toFixed(1)} mm/sa</div>
          </div>
          {weatherChart && (
            <div className="mt-2 h-[120px]">
              <ResponsiveContainer>
                <ComposedChart data={weatherChart} margin={{ top: 6, right: 0, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="var(--color-line)" vertical={false} />
                  <XAxis dataKey="h" type="number" domain={[0, res.config.durationH]} tick={{ fill: 'var(--color-muted)', fontSize: 11 }} tickFormatter={(v) => `${v}sa`} stroke="var(--color-line2)" />
                  <YAxis yAxisId="w" tick={{ fill: 'var(--color-muted)', fontSize: 11 }} stroke="var(--color-line2)" width={40} />
                  <YAxis yAxisId="h" orientation="right" domain={[0, 100]} tick={{ fill: 'var(--color-muted)', fontSize: 11 }} stroke="var(--color-line2)" width={30} />
                  <RTooltip contentStyle={{ background: 'var(--color-panel)', border: '1px solid var(--color-line2)', fontSize: 12 }} labelFormatter={(v) => `T+${v} sa`} formatter={(v, k, item) => (k === 'windSpeedKmh' ? [`${Number(v).toFixed(0)} km/sa ${compass((item.payload as { windFromDeg: number }).windFromDeg)}`, 'Rüzgar'] : [`%${Number(v).toFixed(0)}`, 'Nem'])} />
                  <Line yAxisId="w" dataKey="windSpeedKmh" stroke="var(--color-ink)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line yAxisId="h" dataKey="humidityPct" stroke="#3b9be0" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <ReferenceLine yAxisId="w" x={stat.minutes / 60} stroke="var(--color-ink)" strokeDasharray="3 3" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
          {weatherChart && <div className="mt-1 flex gap-3 text-[11px] text-muted"><span><span className="mr-1 inline-block h-0.5 w-3 bg-ink align-middle" />Rüzgar (km/sa)</span><span><span className="mr-1 inline-block h-0.5 w-3 bg-water align-middle" />Nem (%)</span></div>}
        </Panel>

        {smoke && smokeExp && (
          <Panel title="Duman ve hava kalitesi" action={<span className="text-[11px] text-muted">temsili</span>}>
            <div className="grid grid-cols-3 gap-x-2 gap-y-2">
              <Stat label="CO₂" value={fmtT(smoke.co2T[step])} unit="t" />
              <Stat label="CO" value={fmtT(smoke.coT[step])} unit="t" />
              <Stat label="PM2.5" value={fmtT(smoke.pmT[step])} unit="t" />
            </div>
            <div className="mt-2 text-[11px] text-muted">Toplam salım, T+{Math.floor(stat.minutes / 60)}:{String(stat.minutes % 60).padStart(2, '0')} itibarıyla · karışım yüksekliği {Math.round(smoke.mixingM[step])} m</div>
            <ul className="mt-2 space-y-1">
              {regionById(res.config.areaId).settlements.map((st, i) => {
                const pm = smoke.settlements[i].pm[step]
                const q = aqiOf(pm)
                const e = smokeExp[i]
                return (
                  <li key={st.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                    <span className="flex min-w-0 items-center gap-1.5"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: q.color }} /><span className="truncate">{st.name}</span></span>
                    <span className="shrink-0 text-right" title={`Tepe ${Math.round(e.peakPm)} µg/m³ (T+${(e.peakStep / 6).toFixed(1)} sa), 55 µg/m³ üstünde ${e.hoursUnhealthy.toFixed(1)} sa`}>
                      <b>{Math.round(pm)}</b> <span className="text-muted">µg/m³ · {q.name}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </Panel>
        )}

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
                <CartesianGrid stroke="var(--color-line)" vertical={false} />
                <XAxis dataKey="h" type="number" domain={[0, res.config.durationH]} tick={{ fill: 'var(--color-muted)', fontSize: 11 }} tickFormatter={(v) => `${v}sa`} stroke="var(--color-line2)" />
                <YAxis tick={{ fill: 'var(--color-muted)', fontSize: 11 }} stroke="var(--color-line2)" width={44} />
                <RTooltip contentStyle={{ background: 'var(--color-panel)', border: '1px solid var(--color-line2)', fontSize: 12 }} labelFormatter={(v) => `T+${Number(v).toFixed(1)} sa`} formatter={(v) => [`${Number(v).toLocaleString('en-US')} ha`, 'Etkilenen']} />
                <Area type="monotone" dataKey="ha" stroke="#e3a72f" strokeWidth={2} fill="#e3a72f" fillOpacity={0.18} isAnimationActive={false} />
                <ReferenceLine x={stat.minutes / 60} stroke="var(--color-ink)" strokeDasharray="3 3" />
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
      </aside>}
    </div>
  )
}
