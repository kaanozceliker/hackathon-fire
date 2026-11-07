import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, CloudDownload, Crosshair, Loader2, MapPinned, RotateCcw, ShieldCheck, Trees, Wind } from 'lucide-react'
import { WindArrow } from './MapStage'
import { Panel, Segmented, SliderField } from './ui'
import { SurroundingsPanel, type Surroundings } from './IgnitionSurroundings'
import { LandAutoInfo } from './LandAutoInfo'
import { autoTerrain, fuelFromNdmi, fuelState, liveCover, liveCoverShare, seasonalFuel } from '../sim/landAuto'
import { fuelOf } from '../sim/engine'
import { REGIONS, defaultConfig, type Region } from '../data/regions'
import { cellCenter, cellOf } from '../sim/terrain'
import { compass } from '../sim/geo'
import type { Grid, Intensity, TerrainType } from '../sim/types'
import { useStore } from '../state/store'
import { currentLocalHour, fetchWeather, withStartValues } from '../sim/weather'

/**
 * Picking the ignition point on the map: a toggle, Esc to cancel, and a click handler that keeps the point on land
 * inside the working area.
 */
export function useIgnitionPicker(grid: Grid, region: Region) {
  const { patchDraft, notify } = useStore()
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    if (!picking) return
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') setPicking(false) }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [picking])
  const onMapClick = (lat: number, lon: number) => {
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
  return { picking, setPicking, onMapClick }
}

/**
 * The fire scenario set-up: working area, ignition point, starting intensity, weather (fixed or Open-Meteo),
 * terrain and fuel (from data or by hand) and the surroundings of the ignition point. Edits the store's draft.
 */
export function ScenarioSetup({ grid, region, around, picking, setPicking, showTrees, setShowTrees, weatherHours, disabled }: {
  grid: Grid
  region: Region
  around: Surroundings
  picking: boolean
  setPicking: (v: boolean) => void
  showTrees: boolean
  setShowTrees: (v: boolean) => void
  /** Hours of weather to fetch from Open-Meteo. */
  weatherHours: number
  disabled?: boolean
}) {
  const { draft, patchDraft, notify, setDraftArea, loadPreset, active } = useStore()
  const [weatherMode, setWeatherMode] = useState<'fixed' | 'live'>(draft.weather ? 'live' : 'fixed')
  const [startIso, setStartIso] = useState(() => draft.weather?.startIso ?? currentLocalHour())
  const [weatherBusy, setWeatherBusy] = useState(false)
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
  useEffect(() => {
    // a scenario loaded from elsewhere (area change, scenario picker) decides the mode
    setWeatherMode(draft.weather ? 'live' : 'fixed')
    if (draft.weather) setStartIso(draft.weather.startIso)
  }, [draft.areaId, active.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const loadWeather = async () => {
    setWeatherBusy(true)
    try {
      const weather = await fetchWeather(grid, startIso, weatherHours)
      loadPreset(withStartValues({ ...draft, weather }))
      notify(`Hava verisi yüklendi: ${startIso.replace('T', ' ')} itibarıyla ${weatherHours} saat.`)
    } catch (e) {
      notify(`Hava verisi alınamadı: ${(e as Error).message}`)
    } finally {
      setWeatherBusy(false)
    }
  }

  return (
    <fieldset disabled={disabled} className="space-y-4 disabled:opacity-60">
      <div>
        <label htmlFor="area" className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted"><MapPinned size={13} /> Çalışma bölgesi</label>
        <select id="area" value={draft.areaId} onChange={(e) => { setDraftArea(e.target.value); setPicking(false) }} className="w-full border border-line2 bg-bg px-2.5 py-2.5 text-[12px]">
          {REGIONS.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      <div className="fg-ignition-card">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold"><Crosshair size={14} className="text-orange" /> Tutuşma noktası</span>
          <button type="button" onClick={() => patchDraft({ ignition: defaultConfig(region).ignition })} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink"><RotateCcw size={12} /> Sıfırla</button>
        </div>
        <div className="fg-ignition-coords">{draft.ignition[0].toFixed(4)}°K <span className="text-line2">/</span> {draft.ignition[1].toFixed(4)}°D</div>
        <button type="button" className={`fg-button mt-3 w-full ${picking ? 'border-orange text-orange' : ''}`} aria-pressed={picking} onClick={() => setPicking(!picking)}><Crosshair size={13} />{picking ? 'Nokta seçimini iptal et' : 'Noktayı haritada seç'}</button>
      </div>

      <div>
        <div className="mb-2 text-[11px] text-muted">Başlangıç yangın şiddeti</div>
        <Segmented<Intensity> label="Başlangıç yangın şiddeti" value={draft.intensity} onChange={(v) => patchDraft({ intensity: v })} options={[{ value: 'low', label: 'Düşük' }, { value: 'medium', label: 'Orta' }, { value: 'high', label: 'Yüksek' }]} />
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
                <button type="button" onClick={loadWeather} disabled={weatherBusy} className="flex w-full items-center justify-center gap-1.5 border border-forest/60 px-2 py-1.5 text-[12px] font-semibold text-forest hover:bg-forest-dim/40 disabled:opacity-60">
                  {weatherBusy ? <Loader2 size={13} className="animate-spin" /> : <CloudDownload size={13} />}
                  {draft.weather ? 'Hava verisini yenile' : 'Hava verisini getir'}
                </button>
                <p className="text-[11px] leading-snug text-muted">
                  {draft.weather
                    ? <>Izgarada 9 noktadan saatlik veri yüklü. Rüzgar ve nem saat saat ve yer yer değişir; aşağıdaki değerler başlangıç saatini gösterir.</>
                    : <>Geçmiş tarihler arşivden (ERA5), son günler ve önümüzdeki 16 gün tahminden gelir.</>}
                </p>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <button type="button" onClick={() => loadPreset({ ...defaultConfig(region), ignition: draft.ignition, intensity: draft.intensity, durationH: draft.durationH, terrain: draft.terrain, fuelLoad: draft.fuelLoad })} className="flex-1 border border-line2 px-1 py-1 text-[12px] text-muted hover:text-ink">Bölge örneği</button>
                <button type="button" onClick={() => loadPreset({ windSpeedKmh: 15, humidityPct: 45, temperatureC: 28 })} className="flex-1 border border-line2 px-1 py-1 text-[12px] text-muted hover:text-ink">Senaryo A</button>
                <button type="button" onClick={() => loadPreset({ windSpeedKmh: 35, humidityPct: 18, temperatureC: 37 })} className="flex-1 border border-line2 px-1 py-1 text-[12px] text-muted hover:text-ink">Senaryo B</button>
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
        </Panel></div>
      </details>

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
    </fieldset>
  )
}
