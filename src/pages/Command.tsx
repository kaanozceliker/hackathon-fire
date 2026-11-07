import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { Circle, ImageOverlay, Marker, Popup, Tooltip, useMap } from 'react-leaflet'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bot, Lightbulb, Sprout, ChevronDown, ChevronRight, Cpu, Crosshair, Droplets, Eye, Flame, Helicopter, Home, Info, Layers3, Loader2, Milestone, Play, Plane, Save, ShieldCheck, Square, RotateCcw, Tractor, Trees, Truck, Wind } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { ScenarioSetup, useIgnitionPicker } from '../components/ScenarioSetup'
import { TreeCoverOverlay, surroundings } from '../components/IgnitionSurroundings'
import { ExistingOverlay } from '../components/ExistingOverlay'
import { simYear } from '../sim/existing'
import { MapStage, WindArrow } from '../components/MapStage'
// the 3D view (MapTiler SDK, ~1.3 MB) loads only when chosen
const Map3D = lazy(() => import('../components/Map3D').then((m) => ({ default: m.Map3D })))
import { Legend, Panel, Segmented, SliderField, Stat, fmtHa } from '../components/ui'
import { icons } from '../components/mapIcons'
import { lineColor } from '../components/ResponseLayer'
import { regionById } from '../data/regions'
import { getInfrastructure } from '../data/infrastructure'
import { getGrid } from '../sim/gridCache'
import { compass, fmtDuration } from '../sim/geo'
import { activeMove, alongPath } from '../lib/tracks'
import { weatherAt } from '../sim/weather'
import type { Decision, ResourceKind, ResourceStatus, ResponseRecord, SimResult } from '../sim/types'
import { useStore } from '../state/store'
import { useCommandRun, type CommanderMode } from '../state/useCommandRun'
import { aiHealth, askPrevention, askRecovery, type AiHealth } from '../lib/commanderClient'
import { ACTION_INFO, PHASE_LABEL, recoveryContext, ruleRecovery, zoneCentroids, zoneOfCell, type RecoveryContext, type RecoveryPlan } from '../sim/recovery'
import { cellCenter, cellOf, gridBounds } from '../sim/terrain'
import { MEASURE_INFO, buildCandidates, measureSize, measuresToRun, preventionContext, rulePrevention, type Measure, type PreventionPlan } from '../sim/prevention'
import { SECTORS } from '../sim/types'
import { PlaybackBar } from '../components/PlaybackBar'
import { ResourcesPanel } from '../components/ResourcesPanel'

const T = (step: number) => `T+${fmtDuration(step * 10)}`
/** Playback time, in minutes (moves in 15-minute ticks). */
const Tm = (min: number) => `T+${fmtDuration(Math.max(0, min))}`

const KIND: Record<ResourceKind, { label: string; color: string; Icon: typeof Truck }> = {
  crew: { label: 'Arazöz ekibi', color: '#e5483d', Icon: Truck },
  dozer: { label: 'İş makinesi', color: '#e3a72f', Icon: Tractor },
  heli: { label: 'Helikopter', color: '#3b9be0', Icon: Helicopter },
  plane: { label: 'Söndürme uçağı', color: '#7fc4f0', Icon: Plane },
}
const STATUS: Record<ResourceStatus, { label: string; tone: string }> = {
  unavailable: { label: 'yolda değil', tone: 'text-muted' },
  idle: { label: 'boşta', tone: 'text-muted' },
  enroute: { label: 'yolda', tone: 'text-ink' },
  mopping: { label: 'soğutmada', tone: 'text-water' },
  attacking: { label: 'söndürüyor', tone: 'text-fire' },
  building: { label: 'sınır açıyor', tone: 'text-amber' },
  holding: { label: 'sınırı tutuyor', tone: 'text-forest' },
  dropping: { label: 'su atıyor', tone: 'text-water' },
  retreated: { label: 'geri çekildi', tone: 'text-orange' },
  grounded: { label: 'yerde (gece)', tone: 'text-muted' },
}

/** Phase colour for the incident strip, from the commander's own phase name. */
function phaseTone(phase: string): { color: string; name: string } {
  const p = phase.toLocaleLowerCase('tr')
  if (/aşıldı|ikinci|geçiş|geri çekil/.test(p)) return { color: '#e5483d', name: 'Tırmanma' }
  if (/kontrol|soğut|söndü/.test(p)) return { color: '#3b9be0', name: 'Kontrol' }
  if (/sınır|dolaylı/.test(p)) return { color: '#e3a72f', name: 'Güvenlik sınırı' }
  if (/ilk|doğrudan/.test(p)) return { color: '#3fa564', name: 'İlk müdahale' }
  return { color: 'var(--color-muted)', name: 'Diğer' }
}

const iconCache = new Map<string, L.DivIcon>()
function unitIcon(kind: ResourceKind, status: ResourceStatus): L.DivIcon {
  const key = `${kind}|${status}`
  let ic = iconCache.get(key)
  if (!ic) {
    const { color, Icon } = KIND[kind]
    const dim = status === 'idle' || status === 'grounded' || status === 'unavailable'
    const ring = status === 'retreated' ? '#ee7a2b' : status === 'attacking' || status === 'dropping' ? '#ffffff' : '#0a1014'
    const html = `<div style="width:24px;height:24px;border-radius:${kind === 'heli' || kind === 'plane' ? '50%' : '4px'};background:${color};opacity:${dim ? 0.5 : 1};border:2px solid ${ring};display:flex;align-items:center;justify-content:center;color:#0a1014;box-shadow:0 1px 4px rgba(0,0,0,.5)">${renderToStaticMarkup(<Icon size={13} strokeWidth={2.4} />)}</div>`
    ic = L.divIcon({ html, className: 'fg-icon', iconSize: [24, 24], iconAnchor: [12, 12] })
    iconCache.set(key, ic)
  }
  return ic
}

export function Command() {
  const { draft, addScenario, notify } = useStore()
  const run = useCommandRun()
  const [startMin, setStartMin] = useState(30)
  const [mode, setMode] = useState<CommanderMode>('ai')
  const [health, setHealth] = useState<AiHealth | null>(null)
  const [compare, setCompare] = useState(false)
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const [plan, setPlan] = useState<{ plan: RecoveryPlan; ctx: RecoveryContext; source: 'ai' | 'rules'; model?: string; reason?: string } | null>(null)
  const [hoverZone, setHoverZone] = useState<number | null>(null)
  const [openZone, setOpenZone] = useState<{ zone: number; at: [number, number] } | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [showZones, setShowZones] = useState(true)
  // "Bugün ne yapabiliriz?": prevention package, the first run kept for comparison, and the before/after map
  const [prev, setPrev] = useState<{ cands: Measure[]; plan: PreventionPlan; source: 'ai' | 'rules'; model?: string; reason?: string; startMin: number } | null>(null)
  const [prevBusy, setPrevBusy] = useState(false)
  const [before, setBefore] = useState<SimResult | null>(null)
  const [compareBefore, setCompareBefore] = useState(false)
  const [openMeasure, setOpenMeasure] = useState<string | null>(null)
  // during the rerun only the chosen measures stay on the map
  const shownMeasures = useMemo(() => (prev ? (before ? prev.cands.filter((m) => prev.plan.selected.some((x) => x.id === m.id)) : prev.cands) : []), [prev, before])
  const makePrevention = async () => {
    const l = run.live
    if (!l) return
    setPrevBusy(true)
    const cands = buildCandidates(l, infra)
    const ctx = preventionContext(l, cands, startMin)
    try {
      const r = await askPrevention(ctx)
      const valid = r.output.selected.filter((x) => cands.some((c) => c.id === x.id))
      setPrev({ cands, plan: { ...r.output, selected: valid }, source: 'ai', model: r.model, startMin })
    } catch (e) {
      setPrev({ cands, plan: rulePrevention(ctx), source: 'rules', reason: (e as Error).message, startMin })
    } finally {
      setPrevBusy(false)
    }
  }
  const startWithMeasures = () => {
    const l = run.live
    if (!l || !prev) return
    const { opts, startGainMin } = measuresToRun(prev.cands, prev.plan.selected.map((x) => x.id), grid, infra)
    setBefore(l)
    setCompare(false)
    setCompareBefore(false)
    setSaved(false)
    run.start(grid, config, region.settlements, infra, Math.max(0, prev.startMin - startGainMin), mode, opts)
  }
  useEffect(() => {
    setPlan(null)
    setOpenZone(null)
  }, [run.live?.response?.startStep, run.status === 'running'])
  const makePlan = async () => {
    const l = run.live
    if (!l) return
    setPlanBusy(true)
    const ctx = recoveryContext(l)
    try {
      const r = await askRecovery(ctx)
      setPlan({ plan: r.output, ctx, source: 'ai', model: r.model })
    } catch (e) {
      setPlan({ plan: ruleRecovery(ctx), ctx, source: 'rules', reason: (e as Error).message })
    } finally {
      setPlanBusy(false)
      setShowZones(true)
    }
  }
  const zoneColors = plan && showZones && !prev ? SECTORS.map((sec) => { const z = plan.plan.zones.find((x) => x.sector === sec); return z ? ACTION_INFO[z.action].color : null }) : null
  const [selected, setSelected] = useState<number | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    aiHealth().then(setHealth)
  }, [])

  // the fire is set up here (the store's draft) and runs with the response; a finished run keeps the config it ran with
  const config = run.live && run.live.config.areaId === draft.areaId ? run.live.config : draft
  const region = regionById(draft.areaId)
  const grid = getGrid(draft.areaId)
  const changed = !!run.live && JSON.stringify({ ...run.live.config, durationH: 0 }) !== JSON.stringify({ ...draft, durationH: 0 })
  const [setupOpen, setSetupOpen] = useState(true)
  const { picking, setPicking, onMapClick: pickIgnition } = useIgnitionPicker(grid, region)
  const [showTrees, setShowTrees] = useState(false)
  const [showWind, setShowWind] = useState(true)
  const [showExisting, setShowExisting] = useState(false)
  const [landView, setLandView] = useState(false)
  const around = useMemo(() => surroundings(grid, draft.ignition, simYear(draft)), [grid, draft])
  const infra = useMemo(() => getInfrastructure(region), [region])
  // a run from another working area does not fit this grid (it is reset right after an area change)
  const live = run.live && run.live.config.areaId === draft.areaId ? run.live : null
  const rec = live?.response ?? null
  const head = run.head
  const stat = live ? live.series[Math.min(head, live.series.length - 1)] : null
  const aiReady = !!health?.ai
  const done = run.status === 'done' || run.status === 'stopped'

  const begin = () => {
    setSelected(null)
    setCompare(false)
    setSaved(false)
    setPrev(null)
    setBefore(null)
    setCompareBefore(false)
    setPicking(false)
    setSetupOpen(false)
    run.start(grid, draft, region.settlements, infra, startMin, mode)
  }
  // a new working area has another grid: the old run cannot be shown on it
  const firstArea = useRef(true)
  useEffect(() => {
    if (firstArea.current) { firstArea.current = false; return }
    run.reset()
    setPrev(null)
    setBefore(null)
    setPlan(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.areaId])
  // "Demoyu oynat" opens here and starts the response at once
  const location = useLocation()
  const autostart = (location.state as { autostart?: number } | null)?.autostart
  useEffect(() => {
    if (autostart) begin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart])
  const save = () => {
    if (!live) return
    addScenario(`Komuta – ${region.name}`, live)
    setSaved(true)
    notify('Müdahaleli senaryo kaydedildi; Analiz ve Raporlar\'da karşılaştırabilirsiniz.')
  }

  const decisions = rec ? rec.decisions.filter((d) => d.step <= head) : []
  const events = rec ? rec.events.filter((e) => e.step <= head).slice(-8).reverse() : []
  const evacuated = rec ? rec.evacuations.filter((e) => e.startStep <= head).reduce((s, e) => s + Math.round(e.population * Math.min(1, (head - e.startStep) / Math.max(1, e.doneStep - e.startStep))), 0) : 0
  const lastDecision = decisions[decisions.length - 1]
  const w = live ? weatherAt(live.config, run.headMin) : null

  return (
    <div className="fg-command flex min-h-full flex-col lg:h-full lg:flex-row">
      {/* setup */}
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-b border-line bg-panel p-3 lg:w-[290px] lg:border-b-0 lg:border-r">
        <details className="fg-setting-section" open={setupOpen} onToggle={(e) => setSetupOpen((e.target as HTMLDetailsElement).open)}>
          <summary><span className="flex items-center gap-2"><Flame size={14} className="text-orange" /> Yangın senaryosu</span><ChevronDown size={13} /></summary>
          <div className="fg-setting-content">
            {setupOpen && <ScenarioSetup grid={grid} region={region} around={around} picking={picking} setPicking={setPicking} showTrees={showTrees} setShowTrees={setShowTrees} weatherHours={72} disabled={run.status === 'running'} />}
            {run.status === 'running' && <p className="mt-2 text-[11px] text-muted">Müdahale sürerken senaryo değiştirilemez. Durdurup değiştirin.</p>}
          </div>
        </details>
        {!setupOpen && (
          <div className="px-1 text-[12px] text-muted">
            {region.name} · {draft.weather ? 'Open-Meteo saatlik hava' : `sabit hava, rüzgar ${draft.windSpeedKmh} km/sa ${compass(draft.windFromDeg)}`}
          </div>
        )}
        <Panel title="Müdahale">
          <div className="space-y-3">
            <SliderField label="Müdahale başlangıcı" value={startMin} min={0} max={180} step={10} unit="dk" onChange={setStartMin} hint="Yangın başladıktan kaç dakika sonra ilk karar verilir ve ekipler yola çıkar" />
            <div>
              <div className="mb-1 text-[12px] text-muted">Olay komutanı</div>
              <Segmented<CommanderMode> label="Olay komutanı" value={mode} onChange={setMode} options={[{ value: 'ai', label: 'Yapay zeka' }, { value: 'rules', label: 'Kural tabanlı' }]} />
              <p className="mt-1.5 text-[11.5px] leading-snug text-muted">
                {mode === 'ai'
                  ? aiReady
                    ? `Her karar anında durum ${health!.model} modeline gönderilir; yanıt gelene kadar simülasyon bekler.`
                    : 'Yapay zeka şu an bağlı değil. Simülasyon kural tabanlı komutanla devam eder.'
                  : 'Sabit kurallarla karar verir: küçük yangında kanatlardan söndürme, büyüyünce güvenlik sınırı, tehlikedeki yerleşimlerde tahliye.'}
              </p>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            {run.status === 'running' ? (
              <button onClick={run.stop} className="flex flex-1 items-center justify-center gap-1.5 border border-fire/60 px-3 py-2 text-[13px] font-semibold text-fire hover:bg-fire/10"><Square size={14} /> Durdur</button>
            ) : (
              <button onClick={begin} className="fg-button fg-button--primary flex-1"><Play size={14} /> {done ? 'Yeniden başlat' : 'Müdahaleyi başlat'}</button>
            )}
            {run.status !== 'idle' && run.status !== 'running' && <button onClick={run.reset} aria-label="Sıfırla" className="border border-line2 px-2.5 text-muted hover:text-ink"><RotateCcw size={14} /></button>}
          </div>
        </Panel>

        {rec && live && <ResourcesPanel rec={rec} step={run.headMin / live.stepMin} stepMin={live.stepMin} />}

        <p className="text-[11px] leading-snug text-muted">
          Temsili simülasyon. Söndürme etkileri basitleştirilmiştir; yapay zekanın kararları doğrulanmış yangın taktiği değildir ve gerçek bir operasyonu yönlendirmez.
        </p>
      </aside>

      {/* map + incident strip */}
      <div className="flex min-h-[620px] min-w-0 flex-1 flex-col lg:min-h-0">
        <div className="fg-command-metrics">
          <Stat label="Yanan alan" value={stat ? fmtHa(stat.affectedHa) : '–'} unit="ha" tone="amber" />
          <Stat label="Şu an yanan" value={stat ? fmtHa(stat.burningHa) : '–'} unit="ha" tone="fire" />
          <Stat label="Tahliye edilen" value={rec ? evacuated.toLocaleString('tr-TR') : '–'} unit="kişi" />
          <Stat label="Müdahalesiz olsaydı" value={done && rec ? fmtHa(rec.baseline.affectedHa) : '–'} unit={done ? 'ha' : ''} hint="Aynı yangın, aynı süre, hiç müdahale olmadan" />
          <div className="self-center justify-self-end">
            <Segmented<'2d' | '3d'> label="Harita görünümü" value={view} onChange={setView} options={[{ value: '2d', label: '2B' }, { value: '3d', label: '3B' }]} />
          </div>
          <Stat label="Kurtarılan alan" value={done && rec && live ? fmtHa(Math.max(0, rec.baseline.affectedHa - live.series[live.series.length - 1].affectedHa)) : '–'} unit={done ? 'ha' : ''} tone="forest" />
        </div>
          <div className="fg-command-situation">
            {run.status === 'idle' ? (
              <div className="fg-command-status flex items-center gap-2 text-[11px]"><span className="fg-status-dot is-active" /> Senaryo hazır <span className="text-muted">· Müdahale bekleniyor</span></div>
            ) : run.thinking ? (
              <div className="fg-command-status flex items-start gap-2 text-[11px]">
                <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-water" />
                <span>
                  <b>{mode === 'ai' && aiReady ? 'ChatGPT değerlendiriyor' : 'Komutan değerlendiriyor'}</b> · {Tm(run.headMin)}
                  <span className="block text-muted">{run.pending?.trigger}</span>
                </span>
              </div>
            ) : (
              <div className="fg-command-status text-[11px]">
                <b>{Tm(run.headMin)}</b>
                {w && <span className="text-muted"> · rüzgar {Math.round(w.windSpeedKmh)} km/sa {compass(w.windFromDeg)}</span>}
                {lastDecision && <span> · {lastDecision.output.phase}</span>}
                {rec?.extinguishedStep !== null && rec?.extinguishedStep !== undefined && head >= rec.extinguishedStep && <span className="text-forest"> · yangın söndü</span>}
              </div>
            )}
          </div>
        {picking ? <div className="fg-scene-notice"><Crosshair size={13} className="shrink-0" />Kesikli çalışma alanında bir başlangıç noktası seçin. Vazgeçmek için Esc tuşuna basın.</div> : changed && run.status !== 'running' && <div className="fg-scene-notice"><Info size={13} className="shrink-0" />Senaryo ayarları değişti. Haritadaki müdahale eski ayarlarla çalıştı; yenisi için müdahaleyi yeniden başlatın.</div>}
        <div className="fg-command-map relative min-h-[420px] flex-1">
          {view === '3d' ? (
            <Suspense fallback={<div className="flex h-full items-center justify-center bg-bg text-[13px] text-muted"><Loader2 size={16} className="mr-2 animate-spin" />3B harita yükleniyor…</div>}>
              <Map3D grid={grid} result={live} rec={rec} clockRef={run.clockRef} settlements={region.settlements} ignition={config.ignition} />
            </Suspense>
          ) : (
          <MapStage
            grid={grid}
            result={live}
            resultB={compareBefore && before ? before : compare && run.baseline ? run.baseline : null}
            step={head}
            clockRef={live ? run.clockRef : undefined}
            zoneColors={zoneColors}
            zoneHover={zoneColors ? hoverZone : null}
            onHoverCell={(c) => {
              const z = zoneColors && live && c ? zoneOfCell(live, cellOf(grid, c.lat, c.lon)) : -1
              const v = z >= 0 && zoneColors?.[z] ? z : null
              setHoverZone((prev) => (prev === v ? prev : v))
            }}
            pick={picking || !!zoneColors}
            onMapClick={(lat, lon) => {
              if (picking) return pickIgnition(lat, lon)
              if (!zoneColors || !live) return
              const z = zoneOfCell(live, cellOf(grid, lat, lon))
              setOpenZone(z >= 0 && zoneColors[z] ? { zone: z, at: [lat, lon] } : null)
            }}
            mode={(compareBefore && before) || (compare && run.baseline) ? 'diff' : landView ? 'fuel' : live ? 'fire' : 'none'}
            wind={showWind ? { config, minutes: live ? run.headMin : 0 } : null}
            fitGrid
            fitKey={config.areaId}
            hud
            response={rec && !compare ? { record: rec, step: head } : null}
            legend={
              compareBefore && before ? (
                <Legend title="Önlemlerin etkisi" items={[{ color: 'rgba(217,89,38,.85)', label: 'Önlemler sayesinde yanmadı' }, { color: 'rgba(57,135,229,.8)', label: 'Yalnızca önlemli senaryoda yandı' }, { color: 'rgba(235,235,225,.55)', label: 'İki durumda da yandı' }]} />
              ) : compare ? (
                <Legend title="Müdahalenin etkisi" items={[{ color: 'rgba(217,89,38,.85)', label: 'Müdahale sayesinde yanmadı' }, { color: 'rgba(235,235,225,.55)', label: 'İki durumda da yandı' }]} />
              ) : landView ? (
                <Legend title="Arazi örtüsü ve yakıt" items={[
                  { color: 'rgba(122,146,155,.7)', label: 'Çam ormanı (yoğun yakıt)' },
                  { color: 'rgba(169,156,133,.5)', label: 'Maki çalılığı' },
                  { color: 'rgba(190,180,90,.4)', label: 'Seyrek / tarım' },
                  { color: 'rgba(160,170,175,.5)', label: 'Yerleşim' },
                  { color: 'rgba(40,90,140,.6)', label: 'Su' },
                ]} />
              ) : (
                <Legend title="Müdahale" items={[
                  { color: lineColor(1), label: '1. güvenlik sınırı (soluk: planlanan)' },
                  { color: lineColor(2), label: '2. güvenlik sınırı' },
                  { color: '#ff5a4e', label: 'Aşılan sektör' },
                  { color: 'rgba(120,190,255,.8)', label: 'Su atışı', kind: 'dot' },
                  { color: '#ecf4f0', label: 'Tahliye rotası', kind: 'dash' },
                  { color: '#ffa53a', label: 'Olası kor düşme noktası', kind: 'dot' },
                  { color: '#fff1a6', label: 'Yeni sıçrama (kor)', kind: 'dot' },
                ]} />
              )
            }
            controls={
              <div className="flex flex-col items-end gap-1">
                <details className="fg-layer-menu"><summary><Layers3 size={13} /> Katmanlar <ChevronDown size={11} /></summary><div>
                  <label><input type="checkbox" checked={showWind} onChange={(e) => setShowWind(e.target.checked)} /><Wind size={14} /> Rüzgar akışı</label>
                  <label><input type="checkbox" checked={landView} onChange={(e) => setLandView(e.target.checked)} /><Layers3 size={14} /> Arazi ve yakıt</label>
                  <label><input type="checkbox" checked={showTrees} onChange={(e) => setShowTrees(e.target.checked)} /><Trees size={14} /> Ağaç örtüsü</label>
                  <label><input type="checkbox" checked={showExisting} onChange={(e) => setShowExisting(e.target.checked)} /><ShieldCheck size={14} /> Koruma altyapısı</label>
                </div></details>
              {done && run.baseline ? (
                <div className="flex flex-col items-end gap-1">
                  <button onClick={() => { setCompare(!compare); setCompareBefore(false) }} aria-pressed={compare} className={`border border-line2 bg-bg/90 px-2.5 py-1 text-[12px] font-medium ${compare ? 'text-forest' : 'text-muted hover:text-ink'}`}>
                    {compare ? 'Müdahaleyi göster' : 'Müdahalesiz hâliyle karşılaştır'}
                  </button>
                  {before && (
                    <button onClick={() => { setCompareBefore(!compareBefore); setCompare(false) }} aria-pressed={compareBefore} className={`border border-line2 bg-bg/90 px-2.5 py-1 text-[12px] font-medium ${compareBefore ? 'text-forest' : 'text-muted hover:text-ink'}`}>
                      {compareBefore ? 'Önlemli senaryoyu göster' : 'Önlem öncesiyle karşılaştır'}
                    </button>
                  )}
                </div>
              ) : null}
              </div>
            }
          >
            {showExisting && <ExistingOverlay grid={grid} year={simYear(draft)} />}
            {showTrees && <TreeCoverOverlay grid={grid} s={around} at={draft.ignition} />}
            {rec && !compare && <UnitsLayer rec={rec} clockRef={run.clockRef} />}
            {prev && !compareBefore && <MeasuresOverlay grid={grid} measures={shownMeasures} plan={prev.plan} open={openMeasure} setOpen={setOpenMeasure} faded={!!before} />}
            {plan && zoneColors && live && <ZoneOverlay result={live} plan={plan.plan} ctx={plan.ctx} open={openZone} setOpen={setOpenZone} />}
            {region.settlements.map((st) => {
              const ev = rec?.evacuations.find((e) => e.settlementId === st.id && e.startStep <= head)
              const label = !ev ? '' : head >= ev.doneStep ? ' · tahliye edildi' : ` · tahliye %${Math.round(((head - ev.startStep) / Math.max(1, ev.doneStep - ev.startStep)) * 100)}`
              return (
                <Marker key={st.id} position={st.pos} icon={icons.settlement}>
                  <Tooltip direction="right" permanent offset={[8, 0]} className="fg-label">{st.name}{label}</Tooltip>
                </Marker>
              )
            })}
            <Marker position={draft.ignition} icon={icons.ignition}><Tooltip direction="top" offset={[0, -12]}>Tutuşma noktası</Tooltip></Marker>
          </MapStage>
          )}


        </div>
        <IncidentStrip run={run} rec={rec} live={live} onSelect={(i) => { setSelected(i); run.setPlaying(false); run.setHead(rec!.decisions[i].step) }} />
      </div>

      {/* decision log */}
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-t border-line bg-bg p-3 lg:w-[390px] lg:border-l lg:border-t-0">
        {live && stat && w && (
          <Panel title={`Saha durumu · ${Tm(run.headMin)}`}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
              <div className="min-w-0 border-l-2 border-line2 pl-2.5">
                <div className="text-[12px] text-muted">Rüzgar</div>
                <div className="flex items-center gap-1.5 text-[18px] font-semibold leading-tight">
                  <WindArrow fromDeg={w.windFromDeg} className="text-ink" />
                  {Math.round(w.windSpeedKmh)}<span className="text-[12px] font-normal text-muted">km/sa {compass(w.windFromDeg)} yönünden</span>
                </div>
              </div>
              <Stat label="Yangının ilerleme yönü" value={stat.headingDeg === null ? '–' : compass(stat.headingDeg)} unit={stat.headingDeg === null ? '' : `${Math.round(stat.headingDeg)}°`} tone="fire" />
              <Stat label="Cephe hızı" value={Math.round(stat.rosMh).toLocaleString('tr-TR')} unit="m/sa" hint="En uzak yangın noktasının son bir saatteki ilerlemesi" />
              <Stat label="Şu an yanan" value={fmtHa(stat.burningHa)} unit="ha" tone="amber" />
              <Stat label="Nem / sıcaklık" value={`%${Math.round(w.humidityPct)}`} unit={`${Math.round(w.temperatureC)} °C`} />
              <Stat label="Son 1 saatte sıçrama" value={(live.spots ?? []).filter((x) => x.step <= head && x.step > head - 6).length} unit="kor" tone={w.windSpeedKmh > 14 ? 'amber' : 'ink'} hint="Rüzgarın taşıdığı korların başlattığı yeni yangınlar; 14 km/sa altında kor sıçraması olmaz" />
            </div>
          </Panel>
        )}
        {done && live && rec && (
          <Panel title="Sonuç">
            <p className="text-[13px] leading-snug">
              {rec.extinguishedStep !== null ? <>Yangın <b>{T(rec.extinguishedStep)}</b>'da söndü. </> : <>Simülasyon {T(live.steps)}'da durduruldu. </>}
              Müdahaleyle <b>{fmtHa(live.series[live.series.length - 1].affectedHa)} ha</b> yandı; müdahale olmasaydı aynı sürede <b>{fmtHa(rec.baseline.affectedHa)} ha</b> yanacaktı.
              {' '}Yangının ulaştığı yerleşim: {live.impacts.filter((i) => i.arrivalMin !== null).length} (müdahalesiz {rec.baseline.settlementsReached}).
            </p>
            <div className="mt-2 text-[12px] text-muted">{rec.decisions.length} karar · {rec.decisions.filter((d) => d.source === 'ai').length} tanesi ChatGPT'den · {rec.drops.length} su atışı · {rec.evacuations.length} tahliye</div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button onClick={save} disabled={saved} className="flex items-center gap-1.5 border border-forest/60 px-2.5 py-1.5 text-[12px] font-semibold text-forest hover:bg-forest-dim/40 disabled:opacity-50"><Save size={13} /> {saved ? 'Kaydedildi' : 'Analize kaydet'}</button>
              {rec.extinguishedStep !== null && (
                <button onClick={makePlan} disabled={planBusy} className="flex items-center gap-1.5 bg-forest px-2.5 py-1.5 text-[12px] font-semibold text-bg hover:bg-forest/85 disabled:opacity-60">
                  {planBusy ? <Loader2 size={13} className="animate-spin" /> : <Sprout size={13} />} {plan ? 'Stratejiyi yeniden oluştur' : 'Yangın sonrası stratejisi oluştur'}
                </button>
              )}
            </div>
          </Panel>
        )}
        {before && done && live && <ComparisonPanel before={before} after={live} />}
        {plan && !before && (
          <button onClick={makePrevention} disabled={prevBusy} className="flex w-full items-center justify-center gap-2 border border-amber/60 bg-amber/10 px-3 py-2 text-[13px] font-semibold text-amber hover:bg-amber/20 disabled:opacity-60">
            {prevBusy ? <Loader2 size={14} className="animate-spin" /> : <Lightbulb size={14} />} {prev ? 'Önlemleri yeniden belirle' : 'Bugün ne yapabiliriz?'}
          </button>
        )}
        {prev && <PreventionPanel prev={prev} cellM={grid.cellM} canRun={done && !before} onRun={startWithMeasures} onOpen={setOpenMeasure} open={openMeasure} />}
        {plan && !prev && <StrategyPanel plan={plan} showZones={showZones} onToggleZones={() => setShowZones(!showZones)} />}
        <Panel title="Komuta günlüğü" pad={false} action={<span className="text-[11px] text-muted">{decisions.length} karar</span>}>
          {decisions.length === 0 ? (
            <p className="p-3 text-[13px] text-muted">{run.status === 'idle' ? 'Kararlar burada, verildikleri sırayla görünecek.' : `İlk karar ${rec ? T(rec.startStep) : ''}'da verilecek.`}</p>
          ) : (
            <ol className="divide-y divide-line">
              {[...decisions].reverse().map((d) => {
                const i = rec!.decisions.indexOf(d)
                return <DecisionCard key={i} d={d} open={selected === null ? i === rec!.decisions.length - 1 || i === decisions.length - 1 : selected === i} onToggle={() => setSelected(selected === i ? -1 : i)} />
              })}
            </ol>
          )}
        </Panel>
        {events.length > 0 && (
          <Panel title="Sahadan" pad={false}>
            <ul className="divide-y divide-line">
              {events.map((e, i) => (
                <li key={i} className="flex gap-2 px-3 py-1.5 text-[12.5px]">
                  <span className="w-12 shrink-0 text-muted">{T(e.step)}</span>
                  <span className={e.kind === 'breach' || e.kind === 'evac_risk' || e.kind === 'retreat' ? 'text-amber' : e.kind === 'out' || e.kind === 'evac_done' || e.kind === 'line_done' ? 'text-forest' : ''}>{e.text}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </aside>
    </div>
  )
}

/**
 * Resource icons, moved every frame from the playback clock: each glides between the positions recorded at the
 * surrounding 10-minute steps instead of jumping. Markers are managed directly in Leaflet, not re-rendered by React.
 */
export function UnitsLayer({ rec, clockRef }: { rec: ResponseRecord; clockRef: { current: number } }) {
  const map = useMap()
  const recRef = useRef(rec)
  recRef.current = rec
  useEffect(() => {
    // routes are SVG (not the map's canvas) so they can carry a slow CSS dash animation
    const svg = L.svg({ padding: 0.5 })
    const markers = new Map<string, { m: L.Marker; status: ResourceStatus | null; route: L.Polyline | null; move: unknown }>()
    const fx = new Map<string, L.Marker>()
    const scoopIcon = L.divIcon({ html: '<div class="fg-scoop"><i></i><i></i><i></i></div>', className: 'fg-icon', iconSize: [0, 0], iconAnchor: [0, 0] })
    const splashIcon = L.divIcon({ html: '<div class="fg-splash"><i></i><i></i></div>', className: 'fg-icon', iconSize: [0, 0], iconAnchor: [0, 0] })
    let raf = 0
    const loop = () => {
      const r = recRef.current
      const s = clockRef.current / 10
      const seen = new Set<string>()
      for (const tr of r.tracks) {
        const pts = tr.points
        let lo = 0
        let hi = pts.length - 1
        let i = -1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (pts[mid].step <= s) {
            i = mid
            lo = mid + 1
          } else hi = mid - 1
        }
        if (i < 0 || pts[i].status === 'unavailable') continue
        const p0 = pts[i]
        const p1 = pts[i + 1]
        const f = p1 && p1.step === p0.step + 1 ? Math.min(1, Math.max(0, s - p0.step)) : 0
        // on a trip: follow the recorded road path; otherwise glide between the sampled positions
        const mv = activeMove(tr.moves, s)
        const ll: [number, number] = mv
          ? alongPath(mv.path, (s - mv.fromStep) / Math.max(1e-6, mv.toStep - mv.fromStep))
          : p1 ? [p0.lat + (p1.lat - p0.lat) * f, p0.lon + (p1.lon - p0.lon) * f] : [p0.lat, p0.lon]
        seen.add(tr.id)
        let e = markers.get(tr.id)
        if (!e) {
          const m = L.marker(ll, { icon: unitIcon(tr.kind, p0.status), zIndexOffset: 500, keyboard: false }).addTo(map)
          m.bindTooltip('', { direction: 'top', offset: [0, -12] })
          e = { m, status: null, route: null, move: null }
          markers.set(tr.id, e)
        } else e.m.setLatLng(ll)
        if (e.status !== p0.status) {
          e.m.setIcon(unitIcon(tr.kind, p0.status))
          e.m.setTooltipContent(`${tr.name} · ${STATUS[p0.status].label}`)
          e.status = p0.status
        }
        // the route of the trip under way: a faint line with a slow flow towards where the unit is heading
        const moving = mv && mv.path.length > 1 && (mv.path[0][0] !== mv.path[mv.path.length - 1][0] || mv.path[0][1] !== mv.path[mv.path.length - 1][1])
        if (e.move !== (moving ? mv : null)) {
          e.route?.remove()
          e.route = null
          e.move = moving ? mv : null
          if (moving) {
            const air = tr.kind === 'heli' || tr.kind === 'plane'
            e.route = L.polyline(mv!.path, { renderer: svg, className: air ? 'fg-route fg-route-air' : 'fg-route', color: air ? '#8fd8ff' : '#ffd9a0', weight: air ? 1.6 : 2.4, opacity: air ? 0.55 : 0.5, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(map)
          }
        }
      }
      for (const [id, e] of markers)
        if (!seen.has(id)) {
          e.m.remove()
          e.route?.remove()
          markers.delete(id)
        }
      // aircraft filling up at a water source, and the splash of a drop
      const want = new Set<string>()
      ;(r.scoops ?? []).forEach((sc, k) => {
        if (s < sc.step || s > sc.untilStep) return
        const key = `s${k}`
        want.add(key)
        if (!fx.has(key)) fx.set(key, L.marker([sc.lat, sc.lon], { icon: scoopIcon, interactive: false, keyboard: false, zIndexOffset: 300 }).addTo(map))
      })
      r.drops.forEach((d, k) => {
        if (s < d.step || s > d.step + 0.6) return
        const key = `d${k}`
        want.add(key)
        if (!fx.has(key)) fx.set(key, L.marker([d.lat, d.lon], { icon: splashIcon, interactive: false, keyboard: false, zIndexOffset: 300 }).addTo(map))
      })
      for (const [k, m] of fx)
        if (!want.has(k)) {
          m.remove()
          fx.delete(k)
        }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      markers.forEach((e) => {
        e.m.remove()
        e.route?.remove()
      })
      fx.forEach((m) => m.remove())
    }
  }, [map, clockRef])
  return null
}

/** Labels on each strategy zone and the card that opens over the map when a zone is clicked. */
function ZoneOverlay({ result, plan, ctx, open, setOpen }: { result: SimResult; plan: RecoveryPlan; ctx: RecoveryContext; open: { zone: number; at: [number, number] } | null; setOpen: (v: { zone: number; at: [number, number] } | null) => void }) {
  const centres = useMemo(() => zoneCentroids(result), [result])
  const icons = useMemo(
    () =>
      SECTORS.map((sec) => {
        const z = plan.zones.find((x) => x.sector === sec)
        if (!z) return null
        const info = ACTION_INFO[z.action]
        return L.divIcon({
          html: `<div class="fg-zone-tag" style="border-color:${info.color}"><span style="background:${info.color}"></span>${sec}</div>`,
          className: 'fg-icon',
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        })
      }),
    [plan],
  )
  const sel = open ? plan.zones.find((x) => x.sector === SECTORS[open.zone]) : null
  const stats = open ? ctx.zones.find((x) => x.sector === SECTORS[open.zone]) : null
  return (
    <>
      {SECTORS.map((sec, k) => {
        const c = centres[k]
        const ic = icons[k]
        if (!c || !ic) return null
        return <Marker key={sec} position={c} icon={ic} zIndexOffset={800} eventHandlers={{ click: () => setOpen({ zone: k, at: c }) }} keyboard={false} />
      })}
      {open && sel && (
        <Popup position={open.at} className="fg-popup" maxWidth={330} minWidth={280} eventHandlers={{ remove: () => setOpen(null) }}>
          <div className="text-[12.5px] leading-snug">
            <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
              <span className="h-3 w-3 shrink-0" style={{ background: ACTION_INFO[sel.action].color }} />
              {sel.sector} bölgesi
            </div>
            <div className="mb-2 font-medium" style={{ color: ACTION_INFO[sel.action].color }}>{ACTION_INFO[sel.action].label}</div>
            {stats && (
              <div className="mb-2 grid grid-cols-3 gap-x-2 gap-y-1 text-[11.5px]">
                <span><b>{stats.burned_ha}</b> ha yandı</span>
                <span>eğim <b>%{stats.mean_slope_pct}</b></span>
                <span><b>{stats.mean_elevation_m}</b> m</span>
                <span>çam <b>%{stats.pine_share_pct}</b></span>
                <span>dik alan <b>%{stats.steep_share_pct}</b></span>
                <span>tohum kaynağı <b>%{stats.seed_source_nearby_pct}</b></span>
              </div>
            )}
            {sel.species.length > 0 && <div className="mb-1"><b>Türler:</b> {sel.species.join(', ')}</div>}
            <div className="mb-1"><b>Zamanlama:</b> {sel.timing}</div>
            <div className="opacity-80">{sel.rationale}</div>
            {stats && stats.settlements_within_1km.length > 0 && <div className="mt-1.5 text-[11.5px] opacity-80">Yakın yerleşim: {stats.settlements_within_1km.join(', ')}</div>}
          </div>
        </Popup>
      )}
    </>
  )
}

const SCALE_M = 6 // texture pixels per cell for the measure patterns

/** Paints one measure's cells with its own pattern (stripes, cross-hatch, dots) and a solid outline. */
function paintMeasure(ctx: CanvasRenderingContext2D, grid: SimResult['grid'], m: Measure, on: boolean) {
  const set = new Set(m.cells)
  const color = MEASURE_INFO[m.type].color
  const S = SCALE_M
  const W = grid.cols * S
  const H = grid.rows * S
  // soft fill (slightly blurred so the 110 m cells read as a shape, not squares)
  ctx.save()
  ctx.filter = 'blur(1.2px)'
  ctx.globalAlpha = on ? (m.type === 'emniyet_seridi' ? 0.5 : 0.26) : 0.1
  ctx.fillStyle = color
  for (const i of m.cells) ctx.fillRect((i % grid.cols) * S, ((i / grid.cols) | 0) * S, S, S)
  ctx.restore()
  // pattern inside: fire break = road dashes, thinning = small tree dots, settlement belt = fine dots
  ctx.save()
  ctx.beginPath()
  for (const i of m.cells) ctx.rect((i % grid.cols) * S, ((i / grid.cols) | 0) * S, S, S)
  ctx.clip()
  ctx.globalAlpha = on ? 0.85 : 0.3
  ctx.fillStyle = color
  ctx.strokeStyle = color
  if (m.type === 'emniyet_seridi') {
    ctx.strokeStyle = 'rgba(30, 24, 8, 0.75)'
    ctx.lineWidth = 1.2
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    for (let k = -H; k < W; k += 9) {
      ctx.moveTo(k, H)
      ctx.lineTo(k + H, 0)
    }
    ctx.stroke()
  } else if (m.type === 'aralama') {
    for (let y = 3; y < H; y += 7)
      for (let x = 3 + ((y / 7) % 2) * 3.5; x < W; x += 7) {
        ctx.beginPath()
        ctx.arc(x, y, 1.5, 0, Math.PI * 2)
        ctx.fill()
      }
  } else if (m.type === 'yerlesim_temizligi') {
    for (let y = 2; y < H; y += 5) for (let x = 2 + ((y / 5) % 2) * 2.5; x < W; x += 5) ctx.fillRect(x, y, 1.3, 1.3)
  }
  ctx.restore()
  // outline with a soft glow along the edges facing outside
  ctx.save()
  ctx.globalAlpha = on ? 0.95 : 0.35
  ctx.strokeStyle = color
  ctx.lineWidth = on ? 1.4 : 0.9
  ctx.shadowColor = color
  ctx.shadowBlur = on ? 5 : 0
  ctx.beginPath()
  for (const i of m.cells) {
    const x = (i % grid.cols) * S
    const y = ((i / grid.cols) | 0) * S
    if (!set.has(i - 1) || i % grid.cols === 0) { ctx.moveTo(x, y); ctx.lineTo(x, y + S) }
    if (!set.has(i + 1) || i % grid.cols === grid.cols - 1) { ctx.moveTo(x + S, y); ctx.lineTo(x + S, y + S) }
    if (!set.has(i - grid.cols)) { ctx.moveTo(x, y); ctx.lineTo(x + S, y) }
    if (!set.has(i + grid.cols)) { ctx.moveTo(x, y + S); ctx.lineTo(x + S, y + S) }
  }
  ctx.stroke()
  ctx.restore()
}

/** Icon of each measure type, for the map tags. */
const MEASURE_ICON: Record<Measure['type'], typeof Eye> = { yerlesim_temizligi: Home, emniyet_seridi: Milestone, aralama: Trees, gozetleme: Eye, on_konuslanma: Truck, su_deposu: Droplets }
const measureTagCache = new Map<string, L.DivIcon>()
/** A map tag: a round badge with the measure's icon (its priority on top when chosen) and a short label. */
export function measureTag(type: Measure['type'], label: string, priority: number | null, state: 'on' | 'off' | 'faded'): L.DivIcon {
  const key = `${type}|${label}|${priority}|${state}`
  let ic = measureTagCache.get(key)
  if (!ic) {
    const info = MEASURE_INFO[type]
    const Icon = MEASURE_ICON[type]
    const svg = renderToStaticMarkup(<Icon size={13} strokeWidth={2.3} />)
    ic = L.divIcon({
      html: `<div class="fg-mtag fg-mtag-${state}" style="--c:${info.color}"><span class="fg-mtag-badge">${svg}${priority ? `<b>${priority}</b>` : ''}</span><span class="fg-mtag-label">${label}</span></div>`,
      className: 'fg-icon',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    })
    measureTagCache.set(key, ic)
  }
  return ic
}

/** Prevention measures on the map: patterned areas, numbered tags, and a card describing the measure on click. */
export function MeasuresOverlay({ grid, measures, plan, open, setOpen, faded = false }: { grid: SimResult['grid']; measures: Measure[]; plan: PreventionPlan; open: string | null; setOpen: (id: string | null) => void; faded?: boolean }) {
  const rank = new Map(plan.selected.map((x) => [x.id, x]))
  const url = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = grid.cols * SCALE_M
    c.height = grid.rows * SCALE_M
    const ctx = c.getContext('2d')!
    for (const m of measures) if (m.cells.length && !rank.has(m.id)) paintMeasure(ctx, grid, m, false)
    for (const m of measures) if (m.cells.length && rank.has(m.id)) paintMeasure(ctx, grid, m, true)
    return c.toDataURL()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, measures, plan])
  const anchor = (m: Measure): [number, number] => {
    if (m.point) return m.point
    let a = 0
    let b = 0
    for (const i of m.cells) {
      const p = cellCenter(grid, i)
      a += p[0]
      b += p[1]
    }
    return [a / m.cells.length, b / m.cells.length]
  }
  const tag = (m: Measure) => {
    const r = rank.get(m.id)
    return measureTag(m.type, MEASURE_INFO[m.type].short, r ? r.priority : null, faded ? 'faded' : r ? 'on' : 'off')
  }
  const sel = open ? measures.find((m) => m.id === open) : null
  const selRank = sel ? rank.get(sel.id) : undefined
  return (
    <>
      {/* during the rerun the measures step back so the fire stays in front */}
      <ImageOverlay url={url} bounds={gridBounds(grid)} zIndex={faded ? 350 : 450} opacity={faded ? 0.3 : 1} />
      {measures.filter((m) => m.point && rank.has(m.id) && (m.type === 'gozetleme' || m.type === 'on_konuslanma' || m.type === 'su_deposu')).map((m) => (
        <Circle key={`r${m.id}`} center={m.point!} radius={m.type === 'gozetleme' ? 15000 : m.type === 'su_deposu' ? 1200 : 2500} interactive={false} pathOptions={{ color: MEASURE_INFO[m.type].color, weight: 1.2, opacity: faded ? 0.15 : 0.45, dashArray: m.type === 'gozetleme' ? '2 7' : '4 5', fillColor: MEASURE_INFO[m.type].color, fillOpacity: faded ? 0 : m.type === 'gozetleme' ? 0.03 : 0.08 }} />
      ))}
      {measures.map((m) => (
        <Marker key={m.id} position={anchor(m)} icon={tag(m)} zIndexOffset={faded ? 0 : rank.has(m.id) ? 900 : 700} eventHandlers={{ click: () => setOpen(m.id) }} title={m.title} />
      ))}
      {sel && (
        <Popup position={anchor(sel)} className="fg-popup" maxWidth={340} minWidth={290} eventHandlers={{ remove: () => setOpen(null) }}>
          <div className="text-[12.5px] leading-snug">
            <div className="mb-0.5 flex items-center gap-2 text-[14px] font-semibold">
              <span className="h-3 w-3 shrink-0" style={{ background: MEASURE_INFO[sel.type].color }} />
              {selRank ? `${selRank.priority}. ` : ''}{sel.title}
            </div>
            <div className="mb-2 text-[11.5px] opacity-75">{sel.where}{measureSize(sel, grid.cellM) ? ` · ${measureSize(sel, grid.cellM)}` : ''} · ~{(sel.costK / 1000).toFixed(1)} milyon TL{selRank ? '' : ' · seçilmedi'}</div>
            <div className="mb-1.5"><b>Sahada ne yapılır:</b> {MEASURE_INFO[sel.type].what}</div>
            <div className="mb-1.5"><b>Simülasyondaki etkisi:</b> {MEASURE_INFO[sel.type].effect}</div>
            <div className="mb-1.5"><b>İlk yangında:</b> {sel.evidence}</div>
            {selRank && <div className="opacity-85"><b>Neden seçildi:</b> {selRank.rationale}</div>}
          </div>
        </Popup>
      )}
    </>
  )
}

export function PreventionPanel({ prev, cellM, canRun, onRun, onOpen, open }: { prev: { cands: Measure[]; plan: PreventionPlan; source: 'ai' | 'rules'; model?: string; reason?: string }; cellM: number; canRun: boolean; onRun: () => void; onOpen: (id: string | null) => void; open: string | null }) {
  const chosen = [...prev.plan.selected].sort((a, b) => a.priority - b.priority).map((x) => ({ x, m: prev.cands.find((c) => c.id === x.id)! })).filter((r) => r.m)
  const cost = chosen.reduce((s, r) => s + r.m.costK, 0)
  return (
    <Panel title="Bugün ne yapabiliriz?" action={<span className={`flex items-center gap-1 text-[11px] ${prev.source === 'ai' ? 'text-water' : 'text-muted'}`}>{prev.source === 'ai' ? <Bot size={12} /> : <Cpu size={12} />}{prev.source === 'ai' ? `ChatGPT${prev.model ? ` · ${prev.model}` : ''}` : 'Kural tabanlı'}</span>}>
      {prev.reason && <p className="mb-2 text-[11.5px] text-amber">Yapay zeka bağlantısı kullanılamadı. Öneriler kural tabanlı hazırlandı.</p>}
      <p className="text-[13px] leading-snug">{prev.plan.summary}</p>
      <div className="mt-2 grid grid-cols-3 gap-2 border-y border-line py-2">
        <Stat label="Önlem" value={chosen.length} />
        <Stat label="Temsili maliyet" value={(cost / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} unit="M TL" />
        <Stat label="Temizlenen alan" value={Math.round(chosen.reduce((s, r) => s + r.m.cells.length, 0) * cellM * cellM / 10000)} unit="ha" />
      </div>
      <ol className="mt-2 space-y-2">
        {chosen.map(({ x, m }) => {
          const Icon = MEASURE_ICON[m.type]
          return (
          <li key={m.id}>
            <button onClick={() => onOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id} className={`fg-prevention-card ${open === m.id ? 'is-open' : ''}`} style={{ ['--measure-color' as string]: MEASURE_INFO[m.type].color }}>
              <div className="flex items-start gap-2"><span className="fg-event-icon" style={{ ['--event-color' as string]: MEASURE_INFO[m.type].color }}><Icon size={14} /></span><div className="min-w-0 flex-1"><span className="fg-eyebrow">Öncelik {x.priority}</span><b className="mt-0.5 block text-[12px] font-semibold leading-relaxed">{m.title}</b></div><ChevronDown size={13} className={`mt-1 shrink-0 text-muted ${open === m.id ? 'rotate-180' : ''}`} /></div>
              <div className="mt-2 text-[10.5px] leading-relaxed text-muted">{m.where}{measureSize(m, cellM) ? ` · ${measureSize(m, cellM)}` : ''}</div>
              <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-[10px]"><span className="text-muted">Temsili maliyet</span><b className="font-medium">~{(m.costK / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} M TL</b></div>
              {open === m.id && <div className="mt-3 space-y-2 border-t border-line pt-3"><p className="text-[11px] leading-relaxed">{MEASURE_INFO[m.type].what}</p><p className="rounded-md bg-amber/5 p-2 text-[10.5px] leading-relaxed text-amber">{x.rationale}</p></div>}
            </button>
          </li>
        )})}
      </ol>
      <p className="mt-2 text-[11.5px] text-muted">Ayrıntı için bir önleme ya da haritadaki etiketine tıklayın. {prev.plan.expected_effect}</p>
      {canRun && (
        <button onClick={onRun} className="fg-button fg-button--primary mt-2.5 w-full"><Play size={14} /> Önlemlerle simülasyonu başlat</button>
      )}
      <p className="mt-2 text-[11px] leading-snug text-muted">{prev.plan.caveats}</p>
    </Panel>
  )
}

/** First run vs the run with prevention measures. */
function ComparisonPanel({ before, after }: { before: SimResult; after: SimResult }) {
  const row = (r: SimResult) => {
    const f = r.series[r.series.length - 1]
    const rr = r.response
    return {
      ha: f.affectedHa,
      forest: f.forestHa,
      settl: r.impacts.filter((i) => i.arrivalMin !== null).length,
      out: rr?.extinguishedStep ?? null,
      evac: rr ? rr.evacuations.reduce((s, e) => s + e.population, 0) : 0,
    }
  }
  const a = row(before)
  const b = row(after)
  const pct = a.ha ? Math.round(((a.ha - b.ha) / a.ha) * 100) : 0
  const line = (label: string, x: string, y: string, better: boolean | null) => (
    <tr className="border-b border-line last:border-b-0">
      <th scope="row" className="py-1.5 pr-2 text-left text-[12.5px] font-normal text-muted">{label}</th>
      <td className="px-2 py-1.5 text-right text-[13px]">{x}</td>
      <td className={`px-2 py-1.5 text-right text-[13px] font-semibold ${better === null ? '' : better ? 'text-forest' : 'text-fire'}`}>{y}</td>
    </tr>
  )
  return (
    <Panel title="Önlem öncesi ve sonrası">
      <p className="mb-2 text-[13px] leading-snug">
        Önlemlerle yanan alan <b className={pct >= 0 ? 'text-forest' : 'text-fire'}>%{Math.abs(pct)} {pct >= 0 ? 'azaldı' : 'arttı'}</b>: {fmtHa(a.ha)} ha yerine {fmtHa(b.ha)} ha.
      </p>
      <table className="w-full">
        <thead><tr className="border-b border-line2 text-[11.5px] text-muted"><th /><th className="px-2 pb-1 text-right font-medium">İlk yangın</th><th className="px-2 pb-1 text-right font-medium">Önlemlerle</th></tr></thead>
        <tbody>
          {line('Yanan alan', `${fmtHa(a.ha)} ha`, `${fmtHa(b.ha)} ha`, b.ha <= a.ha)}
          {line('Yanan orman', `${fmtHa(a.forest)} ha`, `${fmtHa(b.forest)} ha`, b.forest <= a.forest)}
          {line('Ulaşılan yerleşim', String(a.settl), String(b.settl), b.settl <= a.settl)}
          {line('Söndürme', a.out === null ? '–' : T(a.out), b.out === null ? '–' : T(b.out), a.out !== null && b.out !== null ? b.out <= a.out : null)}
          {line('Tahliye edilen', a.evac.toLocaleString('tr-TR'), b.evac.toLocaleString('tr-TR'), b.evac <= a.evac)}
        </tbody>
      </table>
      <p className="mt-2 text-[11.5px] text-muted">Aynı tutuşma noktası, hava ve komutan; yalnızca önlemler farklı. Haritada "Önlem öncesiyle karşılaştır" ile farkı görün.</p>
    </Panel>
  )
}

function StrategyPanel({ plan, showZones, onToggleZones }: { plan: { plan: RecoveryPlan; ctx: RecoveryContext; source: 'ai' | 'rules'; model?: string; reason?: string }; showZones: boolean; onToggleZones: () => void }) {
  const p = plan.plan
  return (
    <Panel title="Yangın sonrası stratejisi" action={<span className={`flex items-center gap-1 text-[11px] ${plan.source === 'ai' ? 'text-water' : 'text-muted'}`}>{plan.source === 'ai' ? <Bot size={12} /> : <Cpu size={12} />}{plan.source === 'ai' ? `ChatGPT${plan.model ? ` · ${plan.model}` : ''}` : 'Kural tabanlı'}</span>}>
      {plan.reason && <p className="mb-2 text-[11.5px] text-amber">Yapay zeka bağlantısı kullanılamadı. Strateji kural tabanlı hazırlandı.</p>}
      <p className="text-[13px] leading-snug">{p.summary}</p>
      <div className="mt-3 flex items-center justify-between">
        <h4 className="text-[12.5px] font-semibold">Bölgeler <span className="font-normal text-muted">· haritada bölgeye tıklayın</span></h4>
        <button onClick={onToggleZones} aria-pressed={showZones} className={`text-[11.5px] ${showZones ? 'text-forest' : 'text-muted hover:text-ink'}`}>{showZones ? 'Haritada gösteriliyor' : 'Haritada göster'}</button>
      </div>
      <ul className="mt-1 space-y-2">
        {p.zones.map((z) => (
          <li key={z.sector} className="border-l-2 pl-2 text-[12.5px] leading-snug" style={{ borderColor: ACTION_INFO[z.action].color }}>
            <div><b>{z.sector}</b> · <span style={{ color: ACTION_INFO[z.action].color }}>{ACTION_INFO[z.action].label}</span></div>
            {z.species.length > 0 && <div className="text-[12px]">{z.species.join(', ')}</div>}
            <div className="text-[11.5px] text-muted">{z.timing} · {z.rationale}</div>
          </li>
        ))}
      </ul>
      <h4 className="mt-3 text-[12.5px] font-semibold">Yeniden yangın çıkmaması için</h4>
      <ul className="mt-1 space-y-1.5">
        {p.prevention.map((x, i) => (
          <li key={i} className="text-[12.5px] leading-snug"><b className="font-medium">{x.measure}</b> <span className="text-muted">({x.where})</span><span className="block text-[11.5px] text-muted">{x.rationale}</span></li>
        ))}
      </ul>
      <h4 className="mt-3 text-[12.5px] font-semibold">Yangın sonrası aksiyonlar</h4>
      <ol className="mt-1 space-y-2">
        {p.phases.map((ph) => (
          <li key={ph.phase} className="text-[12.5px]">
            <div className="font-medium text-forest">{PHASE_LABEL[ph.phase]}</div>
            <ul className="list-disc space-y-0.5 pl-4 leading-snug">{ph.actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </li>
        ))}
      </ol>
      {p.monitoring.length > 0 && <><h4 className="mt-3 text-[12.5px] font-semibold">İzleme</h4><ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] leading-snug">{p.monitoring.map((m, i) => <li key={i}>{m}</li>)}</ul></>}
      <p className="mt-3 text-[11.5px] leading-snug text-muted">{p.caveats}</p>
    </Panel>
  )
}

function DecisionCard({ d, open, onToggle }: { d: Decision; open: boolean; onToggle: () => void }) {
  const tone = phaseTone(d.output.phase)
  return (
    <li className={`fg-decision-card ${open ? 'is-open' : ''}`} style={{ ['--decision-color' as string]: tone.color }}>
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-2 text-left">
        <span className="fg-event-icon" style={{ ['--event-color' as string]: tone.color }}><Milestone size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <b className="text-[11px] font-semibold" style={{ color: tone.color }}>{T(d.step)}</b>
            <span className="text-[12px] font-medium">{d.output.phase}</span>
          </span>
          <span className="block text-[11.5px] text-muted">{d.trigger}</span>
        </span>
        <span className={`flex shrink-0 items-center gap-1 text-[11px] ${d.source === 'ai' ? 'text-water' : 'text-muted'}`} title={d.fallbackReason ? `Yapay zeka yerine: ${d.fallbackReason}` : undefined}>
          {d.source === 'ai' ? <Bot size={12} /> : <Cpu size={12} />}
          {d.source === 'ai' ? 'ChatGPT' : d.fallbackReason ? 'Kural (yedek)' : 'Kural'}
        </span>
        {open ? <ChevronDown size={14} className="mt-0.5 text-muted" /> : <ChevronRight size={14} className="mt-0.5 text-muted" />}
      </button>
      {open && (
        <div className="fg-decision-body">
          <p className="text-[12px] leading-relaxed text-ink-soft">{d.output.assessment}</p>
          {d.fallbackReason && <p className="mt-1 text-[11.5px] text-amber">Yapay zekaya ulaşılamadı: {d.fallbackReason}</p>}
          <ul className="mt-2 space-y-1.5">
            {d.output.actions.map((a, k) => (
              <li key={k} className="fg-decision-action text-[11px] leading-relaxed">
                <ChevronRight size={13} className="mt-0.5 shrink-0 text-muted" /><div><span className="font-medium">{d.applied[k]}</span>
                <span className="mt-1 block text-[10.5px] text-muted">{a.rationale}</span></div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}

/** Incident phases and decision points share the same playback controls as the Studio. */
function IncidentStrip({ run, rec, live, onSelect }: { run: ReturnType<typeof useCommandRun>; rec: ResponseRecord | null; live: SimResult | null; onSelect: (i: number) => void }) {
  const total = Math.max(36, live ? Math.ceil(Math.max(run.frontier, 6) / 36) * 36 : 72)
  const bands: { from: number; to: number; color: string; name: string }[] = []
  rec?.decisions.forEach((decision, index) => {
    const next = rec.decisions[index + 1]?.step ?? run.frontier
    const tone = phaseTone(decision.output.phase)
    const last = bands[bands.length - 1]
    if (last && last.name === tone.name) last.to = next
    else bands.push({ from: decision.step, to: next, ...tone })
  })
  return (
    <>
      {bands.length > 0 && <div className="fg-phase-timeline" aria-label="Müdahale evreleri">
        <div className="fg-phase-track">{bands.map((band, index) => <span key={index} title={band.name} style={{ left: band.from / total * 100 + '%', width: (band.to - band.from) / total * 100 + '%', background: band.color }} />)}</div>
        <div className="fg-phase-legend">{[...new Map(bands.map((band) => [band.name, band.color])).entries()].map(([name, color]) => <span key={name}><i style={{ background: color }} />{name}</span>)}</div>
      </div>}
      <PlaybackBar step={run.head} steps={total} playing={run.playing} onPlay={() => run.setPlaying(!run.playing)}
        onSeek={(step) => { run.setPlaying(false); run.setHead(Math.min(step, run.frontier)) }}
        onRestart={() => { run.setPlaying(false); run.setHead(0) }} speed={run.speed} onSpeed={run.setSpeed} speeds={[0.5, 1, 2, 4, 8]} disabled={!live} label="Olay zaman şeridi"
        markers={(rec?.decisions ?? []).map((decision, index) => ({ id: 'decision-' + index, step: decision.step, label: T(decision.step) + ' kararı: ' + decision.output.phase, color: decision.source === 'ai' ? 'var(--color-water)' : 'var(--color-amber)', onSelect: () => onSelect(index) }))}
        summary={<span><i className={'fg-status-dot ' + (run.status === 'running' ? 'is-active' : '')} />{run.thinking ? 'Karar değerlendiriliyor' : run.status === 'idle' ? 'Başlamaya hazır' : run.status === 'done' ? 'Çalıştırma tamamlandı' : run.status === 'stopped' ? 'Durduruldu' : 'Müdahale sürüyor'}</span>}
      />
    </>
  )
}
