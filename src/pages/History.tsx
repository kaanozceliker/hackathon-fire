import { useEffect, useMemo, useRef, useState } from 'react'
import { ImageOverlay, Marker, Tooltip } from 'react-leaflet'
import { icons } from '../components/mapIcons'
import { ASSUMED_START_HOUR, REPLAY_STEP_MIN, buildReplay } from '../sim/historyReplay'
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { ExternalLink, Lightbulb, Loader2, Pause, Play } from 'lucide-react'
import { MapStage, WindArrow } from '../components/MapStage'
import { Legend, Panel, Stat } from '../components/ui'
import { compass } from '../sim/geo'
import { HISTORY_FIRES } from '../data/history.generated'
import { MeasuresOverlay, PreventionPanel } from './Command'
import { WHATIF_REGION, runWhatIf, whatIfConfig } from '../sim/historyWhatIf'
import { buildCandidates, measuresToRun, preventionContext, rulePrevention, type Measure, type PreventionPlan } from '../sim/prevention'
import { askPrevention } from '../lib/commanderClient'
import { getGrid } from '../sim/gridCache'
import { getInfrastructure } from '../data/infrastructure'
import { regionById } from '../data/regions'
import type { SimResult } from '../sim/types'

/**
 * Geçmişteki Yangınlar: how a real fire actually spread, from open data only.
 * Burned area at each cloud-free Sentinel-2 pass (dNBR), hourly ERA5 weather; facts from news reports.
 */

const PASS_COLORS = ['#c0392b', '#ee7a2b', '#f2c14e', '#e7e0b0']

const FACTS: Record<string, { text: string; sources: { label: string; url: string }[] }[]> = {
  'izmir-2025-06-29': [
    { text: '29 Haziran 2025\'te İzmir\'de başladı; Menderes ve Seferihisar ilçelerini etkiledi.', sources: [{ label: 'Sözcü, 29 Haziran 2025', url: 'https://www.sozcu.com.tr/turkiye-de-orman-yanginlari-29-haziran-2025-p189047' }, { label: 'Yeni Asır', url: 'https://www.yeniasir.com.tr/izmir/2025/06/29/izmirde-yakan-birincilik' }] },
    { text: 'Yangın üç gün sürdü; söndükten sonra dağlarda geniş bir siyah örtü kaldı.', sources: [{ label: 'NTV', url: 'https://www.ntv.com.tr/turkiye/galeri-izmirin-cigerleri-yandi-daglar-siyaha-burundu,UNHhnp0cEU6tcKtD1GN2Dg' }] },
    { text: 'Müdahaleye uçak ve helikopterlerle yüzlerce personel katıldı; çok sayıda ev tahliye edildi.', sources: [{ label: 'Politikam', url: 'https://www.politikam.com/izmir-yaniyor-seferihisarda-korkutan-orman-yangini' }, { label: 'NTV', url: 'https://www.ntv.com.tr/turkiye/izmirde-orman-yangini-alevler-buyudu-tahliyelersuruyor,8-GEEfa5GUOVzIqoEBawSQ' }] },
  ],
}

const WHATIF_RESPONSE_MIN = 30

/** Short stable hash of a text (FNV-1a), for cache keys. */
function hashText(t: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}
function readCache<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}
function writeCache(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage full or blocked: the next run asks again
  }
}

function WhatIfComparison({ real, before, after }: { real: number; before: SimResult; after: SimResult }) {
  const ha = (r: SimResult) => Math.round(r.series[r.series.length - 1].affectedHa)
  const settl = (r: SimResult) => r.impacts.filter((i) => i.arrivalMin !== null).length
  const outH = (r: SimResult) => (r.response?.extinguishedStep != null ? (r.response.extinguishedStep * 10) / 60 : null)
  const out = (r: SimResult) => { const h = outH(r); return h === null ? '–' : `${Math.round(h)} sa` }
  const a = ha(before)
  const b = ha(after)
  const pct = a ? Math.round(((a - b) / a) * 100) : 0
  return (
    <div>
      <p className="mb-2 text-[13px] leading-snug">
        Önlemler yangından önce alınmış olsaydı simülasyonda yanan alan <b className={pct >= 0 ? 'text-forest' : 'text-fire'}>%{Math.abs(pct)} {pct >= 0 ? 'daha az' : 'daha fazla'}</b> olurdu: {a.toLocaleString('en-US')} ha yerine {b.toLocaleString('en-US')} ha.
      </p>
      <table className="w-full text-[12.5px]">
        <thead><tr className="border-b border-line2 text-[11.5px] text-muted"><th /><th className="px-1.5 pb-1 text-right font-medium">Gerçek</th><th className="px-1.5 pb-1 text-right font-medium">Önlemsiz</th><th className="px-1.5 pb-1 text-right font-medium">Önlemli</th></tr></thead>
        <tbody>
          <tr className="border-b border-line"><th scope="row" className="py-1.5 pr-1 text-left font-normal text-muted">Yanan alan</th><td className="px-1.5 text-right">{real.toLocaleString('en-US')} ha</td><td className="px-1.5 text-right">{a.toLocaleString('en-US')} ha</td><td className={`px-1.5 text-right font-semibold ${b <= a ? 'text-forest' : 'text-fire'}`}>{b.toLocaleString('en-US')} ha</td></tr>
          <tr className="border-b border-line"><th scope="row" className="py-1.5 pr-1 text-left font-normal text-muted">Ulaşılan yerleşim</th><td className="px-1.5 text-right">–</td><td className="px-1.5 text-right">{settl(before)}</td><td className={`px-1.5 text-right font-semibold ${settl(after) <= settl(before) ? 'text-forest' : 'text-fire'}`}>{settl(after)}</td></tr>
          <tr><th scope="row" className="py-1.5 pr-1 text-left font-normal text-muted">Son alevin sönmesi</th><td className="px-1.5 text-right">~3 gün</td><td className="px-1.5 text-right">{out(before)}</td><td className={`px-1.5 text-right font-semibold ${(outH(after) ?? 1e9) <= (outH(before) ?? 1e9) ? 'text-forest' : ''}`}>{out(after)}</td></tr>
        </tbody>
      </table>
      <p className="mt-2 text-[11px] leading-snug text-muted">Simülasyonlar aynı tahmini başlangıç noktası ve saatinden, gerçek saatlik havayla (ERA5), 30. dakikada başlayan kural tabanlı müdahaleyle çalıştı; tek fark önlemler. Önlem programı yangın alanının tamamını kapsar: yerleşim çevreleri, ana eksende birkaç saatte bir emniyet şeridi, ormanda aralama, gözetleme, ön konuşlanma ve yangın havuzu. Son alevin sönmesi, ekiplerin söndürmesi ya da yangının yanacak alan bulamaması olabilir; yavaşlayan bir yangın doğal sınırına daha geç varabilir. Gerçek değer Sentinel-2 ölçümüdür. Haritada görünümler arasında geçiş yapabilirsiniz.</p>
    </div>
  )
}

export function History() {
  const fire = HISTORY_FIRES[0]
  const w = fire.weather
  const passIdx = useMemo(() => fire.passes.map((p) => w.time.indexOf(`${p.date}T12:00`)), [fire, w])
  const replay = useMemo(() => buildReplay(fire), [fire])
  const [view, setView] = useState<'sim' | 'uydu' | 'onlemsiz' | 'onlemli'>('sim')
  // "Önlemler alınsaydı?": the fire run in our engine on its real area as it was, then with prevention measures
  const [whatIf, setWhatIf] = useState<{ before: SimResult; after: SimResult; cands: Measure[]; plan: PreventionPlan; source: 'ai' | 'rules'; model?: string; reason?: string } | null>(null)
  const [wiStep, setWiStep] = useState<string | null>(null)
  const [openMeasure, setOpenMeasure] = useState<string | null>(null)
  const wiGrid = useMemo(() => getGrid(WHATIF_REGION), [])
  const runWhatIfFlow = async () => {
    const yieldUi = () => new Promise((r) => setTimeout(r, 30))
    const startIso = `${fire.started}T${String(ASSUMED_START_HOUR).padStart(2, '0')}:00`
    const cfg = whatIfConfig(fire, startIso)
    const infra = getInfrastructure(regionById(WHATIF_REGION))
    setWiStep('Yangın önlemsiz olarak simüle ediliyor…')
    await yieldUi()
    const before = runWhatIf(cfg, WHATIF_RESPONSE_MIN)
    setWiStep('Önlemler belirleniyor…')
    await yieldUi()
    // the whole burned area gets a prevention programme; the AI (or the rules) set the priorities
    const cands = buildCandidates(before, infra, true)
    const ctx = preventionContext(before, cands, WHATIF_RESPONSE_MIN)
    let plan: PreventionPlan
    let source: 'ai' | 'rules' = 'ai'
    let model: string | undefined
    let reason: string | undefined
    // the AI answer is cached per fire and context: the same question is not sent twice
    const cacheKey = `fg-whatif-plan:${fire.id}:${hashText(JSON.stringify(ctx))}`
    const cached = readCache<{ output: PreventionPlan; model?: string }>(cacheKey)
    try {
      const r = cached ?? (await askPrevention(ctx))
      if (!cached) writeCache(cacheKey, { output: r.output, model: r.model })
      plan = { ...r.output, selected: r.output.selected.filter((x) => cands.some((c) => c.id === x.id)) }
      model = r.model
    } catch (e) {
      plan = rulePrevention(ctx)
      source = 'rules'
      reason = (e as Error).message
    }
    // every candidate is part of the programme: those not ranked follow after the chosen ones
    const ranked = new Set(plan.selected.map((x) => x.id))
    plan = { ...plan, selected: [...plan.selected, ...cands.filter((c) => !ranked.has(c.id)).map((c, i) => ({ id: c.id, priority: plan.selected.length + i + 1, rationale: c.evidence }))] }
    setWiStep('Yangın önlemlerle yeniden simüle ediliyor…')
    await yieldUi()
    const { opts, startGainMin } = measuresToRun(cands, plan.selected.map((x) => x.id), wiGrid, infra)
    const after = runWhatIf(cfg, Math.max(0, WHATIF_RESPONSE_MIN - startGainMin), opts)
    setWhatIf({ before, after, cands, plan, source, model, reason })
    setWiStep(null)
    setView('onlemli')
    seek(replay.startOffsetMin)
    setPlaying(true)
  }
  const engineView = view === 'onlemsiz' || view === 'onlemli'
  const engineResult = whatIf ? (view === 'onlemsiz' ? whatIf.before : view === 'onlemli' ? whatIf.after : null) : null
  // playback clock in minutes since the start of the weather series; panels follow it in 10-minute ticks
  const clockRef = useRef(replay.startOffsetMin)
  const [tMin, setTMin] = useState(replay.startOffsetMin)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(2)
  const endMin = Math.min((w.time.length - 1) * 60, replay.startOffsetMin + replay.endMin)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      const m = Math.min(endMin, clockRef.current + dt * 60 * speed) // 1× = one hour per second
      clockRef.current = m
      setTMin((prev) => (Math.floor(prev / 10) === Math.floor(m / 10) ? prev : m))
      if (m >= endMin) {
        setPlaying(false)
        return
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, endMin])
  const seek = (m: number) => {
    clockRef.current = m
    setTMin(m)
  }
  const hour = Math.min(w.time.length - 1, Math.floor(tMin / 60))
  // the replay's own clock: steps since the estimated ignition
  const simClock = useMemo(() => ({ get current() { return Math.max(0, clockRef.current - replay.startOffsetMin) } }), [replay])
  const simStep = Math.max(0, Math.floor((tMin - replay.startOffsetMin) / REPLAY_STEP_MIN))
  const burnedNow = useMemo(() => {
    let c = 0
    for (const t of replay.result.ignitionStep) if (t >= 0 && t <= simStep) c++
    return Math.round((c * fire.cellM * fire.cellM) / 10000)
  }, [replay, simStep, fire])
  const burningNow = useMemo(() => {
    let c = 0
    const r = replay.result
    for (let i = 0; i < r.ignitionStep.length; i++) if (r.ignitionStep[i] >= 0 && r.ignitionStep[i] <= simStep && r.burnoutStep[i] > simStep) c++
    return Math.round((c * fire.cellM * fire.cellM) / 10000)
  }, [replay, simStep, fire])

  // the latest satellite pass at or before the selected hour
  const shownPass = passIdx.reduce((best, idx, k) => (idx >= 0 && idx <= hour ? k : best), -1)

  const url = useMemo(() => {
    const bin = atob(fire.firstPass)
    const c = document.createElement('canvas')
    c.width = fire.cols
    c.height = fire.rows
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(fire.cols, fire.rows)
    for (let i = 0; i < bin.length; i++) {
      const k = bin.charCodeAt(i)
      if (!k || k - 1 > shownPass) continue
      const h = PASS_COLORS[k - 1]
      img.data.set([parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 215], i * 4)
    }
    ctx.putImageData(img, 0, 0)
    return c.toDataURL()
  }, [fire, shownPass])

  const chart = useMemo(
    () =>
      w.time.map((t, i) => ({
        i,
        t,
        wind: w.windKmh[i],
        gust: w.gustKmh[i],
        hum: w.humidityPct[i],
        burned: fire.passes.find((_, k) => passIdx[k] === i)?.burnedHa,
      })),
    [w, fire, passIdx],
  )
  const final = fire.passes[fire.passes.length - 1].burnedHa
  const label = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)} ${s.slice(11, 16)}`
  const clockLabel = (m: number) => `${label(w.time[Math.min(w.time.length - 1, Math.floor(m / 60))] ?? '').slice(0, 6)}${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m % 60 / 10) * 10).padStart(2, '0')}`

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:flex-row">
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-b border-line bg-panel p-3 lg:w-[310px] lg:border-b-0 lg:border-r">
        <Panel title="İzmir, Haziran 2025">
          <div className="text-[15px] font-semibold">{fire.name}</div>
          <div className="mt-0.5 text-[12px] text-muted">Başlangıç {label(`${fire.started}T00:00`).slice(0, 5)}.2025 · son uydu ölçümüne göre {final.toLocaleString('en-US')} ha</div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5">
            {fire.passes.map((p, k) => (
              <Stat key={p.date} label={`${p.date.slice(8, 10)}.${p.date.slice(5, 7)} uydu geçişi`} value={p.burnedHa.toLocaleString('en-US')} unit="ha" tone={k === 0 ? 'fire' : 'amber'} />
            ))}
          </div>
        </Panel>
        <Panel title="Önlemler alınsaydı?">
          {!whatIf ? (
            <>
              <p className="text-[12.5px] leading-snug text-muted">Bu yangını kendi motorumuzla, gerçek arazi ve o günlerin saatlik havasıyla önce olduğu gibi, sonra "Bugün ne yapabiliriz?" önlemleri yangından önce alınmış olarak çalıştırır ve gerçekle karşılaştırır.</p>
              <button onClick={runWhatIfFlow} disabled={!!wiStep} className="mt-2.5 flex w-full items-center justify-center gap-2 border border-amber/60 bg-amber/10 px-3 py-2 text-[13px] font-semibold text-amber hover:bg-amber/20 disabled:opacity-60">
                {wiStep ? <Loader2 size={14} className="animate-spin" /> : <Lightbulb size={14} />} {wiStep ?? 'Önlemlerle simüle et'}
              </button>
            </>
          ) : (
            <WhatIfComparison real={final} before={whatIf.before} after={whatIf.after} />
          )}
        </Panel>
        {whatIf && <PreventionPanel prev={whatIf} cellM={wiGrid.cellM} canRun={false} onRun={() => {}} onOpen={(id) => { setOpenMeasure(id); setView('onlemli') }} open={openMeasure} />}
        <Panel title="Kaynaklardan">
          <ul className="space-y-2">
            {(FACTS[fire.id] ?? []).map((f, i) => (
              <li key={i} className="text-[12.5px] leading-snug">
                {f.text}
                <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px]">
                  {f.sources.map((s) => (
                    <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-water hover:underline">{s.label}<ExternalLink size={10} /></a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <p className="text-[11px] leading-snug text-muted">
          Haritadaki akıcı yayılım bir tahmindir: başlangıç saati bilinmediği için 29 Haziran 12:00 varsayıldı, başlangıç noktası ilk gün rüzgarına göre yanmış alanın rüzgar üstü ucu alındı; her hücrenin tutuşma zamanı, uydu geçişleri arasında önceden yanmış alana uzaklığına göre dağıtıldı. Uydu ölçümleri ile tutarlıdır, ama saatlik ayrıntı gerçek gözlem değildir.{' '}
          Yanmış alan, Sentinel-2 uydusunun yangından önceki (25 Haziran) ve sonraki bulutsuz geçişleri karşılaştırılarak (NBR yanma indeksi farkı, dNBR &gt; 0,27) 100 m hücrelerle hesaplandı; renkler bir hücrenin ilk hangi geçişte yanmış görüldüğünü gösterir. Uydu bölgeden günde en fazla bir kez, öğle saatlerinde geçtiği için ilerleme saat saat değil geçişler arasında izlenir. Hava: Open-Meteo arşivi (ERA5), saatlik. Resmî yanan alan rakamlarından farklı olabilir.
        </p>
      </aside>

      <div className="flex min-h-[600px] min-w-0 flex-1 flex-col lg:min-h-0">
        <div className="relative min-h-[440px] flex-1">
          <MapStage
            fitKey={fire.id}
            center={fire.centre}
            zoom={11}
            grid={view === 'sim' ? replay.grid : engineView && engineResult ? wiGrid : null}
            result={view === 'sim' ? replay.result : engineResult}
            step={simStep}
            clockRef={view === 'sim' || engineView ? simClock : undefined}
            mode={view === 'sim' || (engineView && engineResult) ? 'fire' : 'none'}
            legend={
              view !== 'uydu' ? (
                <Legend title="Tahmini yayılım" items={[{ color: '#ffd24a', label: 'Yeni tutuşan' }, { color: '#e5502a', label: 'Yanıyor' }, { color: '#46181a', label: 'Yanmış' }, { color: '#ffe9b0', label: 'Yangın çevresi', kind: 'line' }]} />
              ) : (
              <Legend
                title="İlk yanmış görüldüğü uydu geçişi"
                items={fire.passes.map((p, k) => ({ color: PASS_COLORS[k], label: `${p.date.slice(8, 10)}.${p.date.slice(5, 7)}.2025 · ${p.burnedHa.toLocaleString('en-US')} ha` }))}
              />
              )
            }
            controls={
              <div className="flex flex-col items-end gap-1.5">
              <div className="flex border border-line2 bg-bg/90 text-[12px]" role="radiogroup" aria-label="Görünüm">
                {([['sim', 'Gerçek (tahmini akış)'], ['uydu', 'Uydu ölçümü'], ...(whatIf ? ([['onlemsiz', 'Simülasyon: önlemsiz'], ['onlemli', 'Simülasyon: önlemli']] as const) : [])] as const).map(([k, l]) => (
                  <button key={k} role="radio" aria-checked={view === k} onClick={() => setView(k)} className={`px-2.5 py-1 font-medium ${view === k ? 'bg-forest-dim text-ink' : 'text-muted hover:text-ink'}`}>{l}</button>
                ))}
              </div>
              <div className="flex items-center gap-2 border border-line2 bg-bg/90 px-2.5 py-1.5 text-[12.5px]">
                <WindArrow fromDeg={w.windFromDeg[hour]} className="text-ink" />
                <span>
                  <b>{Math.round(w.windKmh[hour])}</b> km/sa {compass(w.windFromDeg[hour])} yönünden <span className="text-muted">· hamle {Math.round(w.gustKmh[hour])}</span>
                </span>
              </div>
              </div>
            }
          >
            {view === 'uydu' && <ImageOverlay url={url} bounds={fire.bounds} className="fg-pixelated" zIndex={450} />}
            {view === 'onlemli' && whatIf && <MeasuresOverlay grid={wiGrid} measures={whatIf.cands} plan={whatIf.plan} open={openMeasure} setOpen={setOpenMeasure} faded />}
            {view !== 'uydu' && <Marker position={replay.ignition} icon={icons.ignition}><Tooltip direction="top" offset={[0, -12]}>Tahmini başlangıç noktası ({fire.started.slice(8, 10)}.{fire.started.slice(5, 7)} {String(ASSUMED_START_HOUR).padStart(2, '0')}:00, saat tahmini)</Tooltip></Marker>}
          </MapStage>
          <div className="pointer-events-none absolute left-14 top-2 z-[600] border border-line2 bg-bg/92 px-3 py-1.5 text-[12.5px]">
            <b>{clockLabel(tMin)}</b>
            {view === 'sim' && <span> · tahmini {burnedNow.toLocaleString('en-US')} ha yanmış, {burningNow.toLocaleString('en-US')} ha yanıyor</span>}
            <span className="text-muted"> · {shownPass < 0 ? 'henüz uydu ölçümü yok' : `son uydu ölçümü ${fire.passes[shownPass].date.slice(8, 10)}.${fire.passes[shownPass].date.slice(5, 7)} 12:10 · ${fire.passes[shownPass].burnedHa.toLocaleString('en-US')} ha`}</span>
          </div>
        </div>

        <div className="border-t border-line bg-panel px-3 py-2">
          <div className="flex items-center gap-3">
            <button onClick={() => { if (clockRef.current >= endMin) seek(replay.startOffsetMin); setPlaying(!playing) }} aria-label={playing ? 'Duraklat' : 'Oynat'} className="flex h-8 w-8 shrink-0 items-center justify-center bg-forest text-bg hover:bg-forest/85">{playing ? <Pause size={16} /> : <Play size={16} />}</button>
            <div className="flex border border-line2" role="radiogroup" aria-label="Oynatma hızı">
              {[1, 2, 4, 8].map((x) => (
                <button key={x} role="radio" aria-checked={speed === x} onClick={() => setSpeed(x)} className={`px-1.5 py-1 text-[11.5px] font-medium ${speed === x ? 'bg-forest-dim text-ink' : 'text-muted hover:text-ink'}`}>{x}×</button>
              ))}
            </div>
            <input type="range" min={0} max={(w.time.length - 1) * 60} step={10} value={tMin} onChange={(e) => { setPlaying(false); seek(Number(e.target.value)) }} aria-label="Zaman" className="flex-1" style={{ ['--p' as string]: `${(tMin / ((w.time.length - 1) * 60)) * 100}%` }} />
            <span className="w-24 shrink-0 text-right text-[12px] text-muted">{clockLabel(tMin)}</span>
          </div>
          <div className="mt-1 h-[120px]">
            <ResponsiveContainer>
              <ComposedChart data={chart} margin={{ top: 6, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="var(--color-line)" vertical={false} />
                <XAxis dataKey="i" type="number" domain={[0, w.time.length - 1]} tick={{ fill: 'var(--color-muted)', fontSize: 11 }} tickFormatter={(i) => label(w.time[i] ?? '').slice(0, 5)} ticks={w.time.map((_, i) => i).filter((i) => i % 24 === 0)} stroke="var(--color-line2)" />
                <YAxis yAxisId="w" tick={{ fill: 'var(--color-muted)', fontSize: 11 }} stroke="var(--color-line2)" width={36} />
                <YAxis yAxisId="ha" orientation="right" tick={{ fill: 'var(--color-muted)', fontSize: 11 }} stroke="var(--color-line2)" width={44} />
                <RTooltip contentStyle={{ background: 'var(--color-panel)', border: '1px solid var(--color-line2)', fontSize: 12 }} labelFormatter={(i) => label(w.time[Number(i)] ?? '')} formatter={(v, k) => [k === 'burned' ? `${Number(v).toLocaleString('en-US')} ha` : k === 'hum' ? `%${v}` : `${Math.round(Number(v))} km/sa`, k === 'burned' ? 'Yanmış alan (uydu)' : k === 'hum' ? 'Nem' : k === 'gust' ? 'Hamle' : 'Rüzgar']} />
                <Bar yAxisId="ha" dataKey="burned" fill="#ee7a2b" barSize={6} isAnimationActive={false} />
                <Line yAxisId="w" dataKey="wind" stroke="var(--color-ink)" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                <Line yAxisId="w" dataKey="gust" stroke="var(--color-muted)" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
                <Line yAxisId="w" dataKey="hum" stroke="#3b9be0" strokeWidth={1.4} dot={false} isAnimationActive={false} />
                <ReferenceLine yAxisId="w" x={tMin / 60} stroke="var(--color-ink)" strokeDasharray="3 3" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-3 text-[11px] text-muted">
            <span><span className="mr-1 inline-block h-0.5 w-3 bg-ink align-middle" />Rüzgar (km/sa)</span>
            <span><span className="mr-1 inline-block h-0.5 w-3 border-t border-dashed border-muted align-middle" />Hamle</span>
            <span><span className="mr-1 inline-block h-0.5 w-3 bg-water align-middle" />Nem (%)</span>
            <span><span className="mr-1 inline-block h-2 w-2 bg-orange align-middle" />Uydu geçişinde yanmış alan (ha)</span>
          </div>
        </div>
      </div>
    </div>
  )
}
