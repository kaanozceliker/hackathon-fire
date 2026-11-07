import { useEffect, useMemo, useRef, useState } from 'react'
import { ImageOverlay, Marker, Polyline, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import { ArrowLeft, Bot, Check, Flame, Loader2, Pause, PenLine, Play, RotateCcw, Siren, Undo2, User, X } from 'lucide-react'
import { MapStage } from '../../components/MapStage'
import { icons } from '../../components/mapIcons'
import { Panel } from '../../components/ui'
import { ResponseRun, type CommanderContext } from '../../sim/response'
import { lineCells } from '../../sim/existing'
import { cellCenter, gridBounds } from '../../sim/terrain'
import { fmtDuration, type LatLon } from '../../sim/geo'
import { SECTORS, type CommanderAction, type Sector, type SimResult } from '../../sim/types'
import { getGrid, getInfrastructure, judgeResponse, newScenario, regionById, runWithRules, type ResponseVerdict } from '../../sim/drill'
import { MistakeList, ScoreCard, WeatherChips } from './shared'
import { UnitsLayer } from '../Command'

type Order = { kind: 'none' } | { kind: 'attack'; sector: Sector } | { kind: 'line'; lineId: string; sector: Sector } | { kind: 'drop'; sector: Sector } | { kind: 'withdraw' }
const encode = (o: Order) => (o.kind === 'none' ? '' : o.kind === 'withdraw' ? 'withdraw' : o.kind === 'line' ? `line|${o.lineId}|${o.sector}` : `${o.kind}|${o.sector}`)
const decode = (v: string): Order => {
  if (!v) return { kind: 'none' }
  if (v === 'withdraw') return { kind: 'withdraw' }
  const [k, a, b] = v.split('|')
  if (k === 'line') return { kind: 'line', lineId: a, sector: b as Sector }
  return { kind: k as 'attack' | 'drop', sector: a as Sector }
}
const T = (min: number) => `T+${fmtDuration(min)}`
const LINE_COLOR = { A: '#e3a23a', B: '#b58cff', C: '#4fd1e0' } as const

/** Burnable cells of a line candidate as a transparent image over the grid. */
function cellsImage(cols: number, rows: number, cells: number[], color: string): string {
  const cv = document.createElement('canvas')
  cv.width = cols
  cv.height = rows
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = color
  for (const c of cells) ctx.fillRect(c % cols, (c / cols) | 0, 1, 1)
  return cv.toDataURL()
}

export function ResponseExam({ onExit }: { onExit: () => void }) {
  const [sc, setSc] = useState(() => newScenario(2))
  const region = regionById(sc.areaId)
  const grid = getGrid(sc.areaId)
  const infra = useMemo(() => getInfrastructure(region), [region])
  const runRef = useRef<ResponseRun | null>(null)
  const [phase, setPhase] = useState<'brief' | 'decide' | 'busy' | 'result'>('brief')
  const [snap, setSnap] = useState<SimResult | null>(null)
  const [ctx, setCtx] = useState<CommanderContext | null>(null)
  const [trigger, setTrigger] = useState('')
  const [orders, setOrders] = useState<Record<string, Order>>({})
  const [evac, setEvac] = useState<Set<string>>(new Set())
  const [establish, setEstablish] = useState<'A' | 'B' | 'C' | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [custom, setCustom] = useState<LatLon[]>([])
  const [lastApplied, setLastApplied] = useState<string[]>([])
  const [result, setResult] = useState<{ you: SimResult; rules: SimResult; verdict: ResponseVerdict } | null>(null)
  const [view, setView] = useState<'you' | 'rules'>('you')
  // result replay: either response run, step by step, with its decisions
  const [play, setPlay] = useState<{ step: number; on: boolean; speed: number }>({ step: 0, on: false, speed: 1 })
  const replay = phase === 'result' && result ? (view === 'you' ? result.you : result.rules) : null
  useEffect(() => {
    if (!play.on || !replay) return
    const id = window.setInterval(() => {
      setPlay((p) => (p.step >= replay.steps ? { ...p, on: false } : { ...p, step: Math.min(replay.steps, p.step + 1) }))
    }, 180 / play.speed)
    return () => window.clearInterval(id)
  }, [play.on, play.speed, replay])
  const watch = (v: 'you' | 'rules') => {
    setView(v)
    setPlay({ step: 0, on: true, speed: play.speed })
  }

  const yieldUi = () => new Promise<void>((r) => setTimeout(r, 20))

  const toDecision = async () => {
    const run = runRef.current!
    setPhase('busy')
    await yieldUi()
    const a = run.advance()
    if (a.kind === 'end') {
      const you = run.finish()
      setSnap(you)
      await yieldUi()
      const rules = runWithRules(grid, sc.config, region.settlements, infra, sc.reportMin, { noTowerGain: true })
      setResult({ you, rules, verdict: judgeResponse(you, rules, region.settlements) })
      setView('you')
      setPlay({ step: you.steps, on: false, speed: 1 })
      setPhase('result')
      return
    }
    setSnap(run.snapshot())
    setCtx(run.context(a.trigger))
    setTrigger(a.trigger)
    setOrders({})
    setEvac(new Set())
    setEstablish(null)
    setCustom([])
    setDrawing(false)
    setPhase('decide')
  }

  const start = async () => {
    runRef.current = new ResponseRun(grid, sc.config, region.settlements, infra, sc.reportMin, { noTowerGain: true })
    setLastApplied([])
    await toDecision()
  }

  const submit = async (hold = false) => {
    const run = runRef.current
    if (!run || !ctx) return
    const actions: CommanderAction[] = []
    const base = { candidate: null, line_id: null, sector: null, resource_id: null, settlement_id: null, rationale: 'Kullanıcı kararı' }
    if (!hold) {
      if (establish) {
        if (establish === 'C') run.setCustomLine(lineCells(grid, custom))
        actions.push({ ...base, type: 'establish_line', candidate: establish })
      }
      for (const [rid, o] of Object.entries(orders)) {
        if (o.kind === 'attack') actions.push({ ...base, type: 'attack', resource_id: rid, sector: o.sector })
        else if (o.kind === 'line') actions.push({ ...base, type: 'assign_line', resource_id: rid, line_id: o.lineId, sector: o.sector })
        else if (o.kind === 'drop') actions.push({ ...base, type: 'air_drop', resource_id: rid, sector: o.sector })
        else if (o.kind === 'withdraw') actions.push({ ...base, type: 'withdraw', resource_id: rid })
      }
      for (const id of evac) actions.push({ ...base, type: 'evacuate', settlement_id: id })
    }
    if (!actions.length) actions.push({ ...base, type: 'hold' })
    run.apply({ assessment: 'Tatbikat: kullanıcı kararı', phase: '', actions }, 'human', trigger)
    setLastApplied(run.decisions[run.decisions.length - 1].applied)
    await toDecision()
  }

  const restart = (same: boolean) => {
    if (!same) setSc(newScenario(2))
    runRef.current = null
    setSnap(null)
    setCtx(null)
    setResult(null)
    setPhase('brief')
  }

  const run = runRef.current
  const candidates = phase === 'decide' && run ? run.lineCandidates : []
  const candImgs = useMemo(() => candidates.map((c) => ({ id: c.id, url: cellsImage(grid.cols, grid.rows, c.cells, LINE_COLOR[c.id]) })), [candidates, grid])
  const shown = phase === 'result' && result ? (view === 'you' ? result.you : result.rules) : snap
  const step = shown ? (phase === 'result' ? Math.min(play.step, shown.steps) : shown.steps) : 0
  const clock = useRef(0)
  clock.current = step * 10
  const newLineId = ctx?.next_line_id ?? 'S1'
  const lineOptions = [...(ctx?.lines.map((l) => l.id) ?? []), ...(establish ? [newLineId] : [])]
  const nowMin = run ? run.step * 10 : 0
  const origin = cellCenter(grid, snap?.originCell ?? 0)
  const frontKm = ctx ? Math.max(0.6, ...ctx.fire.sectors.map((s) => s.front_km_from_origin)) + 0.6 : 1

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:flex-row">
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-b border-line bg-panel p-3 lg:w-[300px] lg:border-b-0 lg:border-r">
        <button onClick={onExit} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink"><ArrowLeft size={13} /> Tatbikat menüsü</button>
        {phase === 'result' && result ? (
          <>
            <ScoreCard title="Sınav sonucu" score={result.verdict.score} grade={result.verdict.grade} parts={result.verdict.parts} />
            <Panel title="Hatalar ve doğrular"><MistakeList items={result.verdict.mistakes} /></Panel>
          </>
        ) : (
          <>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Sınav 2 · Müdahale</div>
              <h2 className="mt-0.5 text-[16px] font-semibold">{region.name}</h2>
              <p className="mt-1 text-[12px] leading-snug text-muted">Olay komutanısınız. Yangın {T(sc.reportMin)}'da ihbar edildi. Elinizdeki ekiplerle yangını söndürün, gerekirse güvenlik sınırı kurun ve yerleşimleri zamanında tahliye edin.</p>
            </div>
            {ctx && (
              <Panel title={`Durum · ${ctx.time.T} (${ctx.time.local_time})`}>
                <div className="space-y-1 text-[12.5px]">
                  <div className="text-amber">{trigger}</div>
                  <div className="flex justify-between"><span className="text-muted">Toplam alan</span><b>{ctx.fire.total_ha} ha</b></div>
                  <div className="flex justify-between"><span className="text-muted">Şu an yanan</span><b>{ctx.fire.burning_ha} ha</b></div>
                  <div className="flex justify-between"><span className="text-muted">Cephe hızı</span><b>{ctx.fire.front_speed_m_per_h} m/sa {ctx.fire.spreading_toward ? `→ ${ctx.fire.spreading_toward}` : ''}</b></div>
                  <div className="flex justify-between"><span className="text-muted">Müdahalesiz 2 / 5 sa sonra</span><b>{ctx.forecast_without_new_actions.area_in_2h_ha} / {ctx.forecast_without_new_actions.area_in_5h_ha} ha</b></div>
                  <div className="flex justify-between"><span className="text-muted">Rüzgar</span><b>{ctx.weather_now.wind_kmh} km/sa {ctx.weather_now.wind_from}</b></div>
                  <div className="flex justify-between"><span className="text-muted">Gün ışığı</span><b>{ctx.time.daylight ? 'var (hava araçları uçar)' : 'yok (hava araçları yerde)'}</b></div>
                </div>
              </Panel>
            )}
            {ctx && (
              <Panel title="Sektörler" pad={false}>
                <table className="w-full text-[12px]">
                  <thead><tr className="border-b border-line2 text-[11px] text-muted"><th className="px-2 py-1 text-left font-medium">Sektör</th><th className="px-2 text-right font-medium">Cephe</th><th className="px-2 text-right font-medium">Son 1 sa</th><th className="px-2 text-right font-medium">Yanan</th></tr></thead>
                  <tbody>
                    {ctx.fire.sectors.map((s) => (
                      <tr key={s.sector} className="border-b border-line last:border-b-0"><td className="px-2 py-1 font-semibold">{s.sector}</td><td className="px-2 text-right">{s.front_km_from_origin} km</td><td className={`px-2 text-right ${s.growth_km_last_hour > 0.4 ? 'text-fire' : ''}`}>+{s.growth_km_last_hour} km</td><td className="px-2 text-right">{s.burning_ha} ha</td></tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}
            {lastApplied.length > 0 && phase === 'decide' && (
              <Panel title="Son kararınızın sonucu">
                <ul className="list-disc space-y-1 pl-4 text-[12px] leading-snug text-muted">{lastApplied.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </Panel>
            )}
          </>
        )}
      </aside>

      <div className="relative min-h-[460px] min-w-0 flex-1">
        <div className="absolute left-14 right-3 top-2 z-[500] flex flex-wrap items-center gap-2">
          <WeatherChips config={sc.config} />
          {phase !== 'brief' && <span className="border border-line2 bg-bg/92 px-2 py-1 text-[12px]">Simülasyon zamanı: <b>{T(phase === 'result' ? step * 10 : nowMin)}</b></span>}
        </div>
        {phase === 'brief' && (
          <div className="absolute inset-0 z-[900] flex items-center justify-center bg-bg/70 p-4">
            <div className="w-[420px] border border-fire/50 bg-panel p-5">
              <div className="flex items-center gap-2 text-[15px] font-semibold text-fire"><Siren size={18} /> Yangın ihbarı</div>
              <p className="mt-2 text-[13.5px] leading-relaxed">{region.name} bölgesinde orman yangını. Yangın başladıktan <b>{sc.reportMin} dakika</b> sonra ihbar edildi. Hava sıcak ve rüzgarlı: {sc.config.temperatureC} °C, %{sc.config.humidityPct} nem, {sc.config.windSpeedKmh} km/sa rüzgar.</p>
              <p className="mt-2 text-[12.5px] leading-snug text-muted">Her karar anında ekiplere görev verin (doğrudan müdahale, sınır açma, su atışı), güvenlik sınırı kurun veya kendiniz çizin, yerleşimleri tahliye edin. Sonunda sistem komutanıyla karşılaştırılacaksınız.</p>
              <button onClick={start} className="mt-4 flex w-full items-center justify-center gap-2 bg-fire px-3 py-2.5 text-[14px] font-semibold text-white hover:bg-fire/90"><Flame size={16} /> Olay yerine bak ve komutayı al</button>
            </div>
          </div>
        )}
        {phase === 'busy' && <div className="absolute inset-0 z-[800] flex items-center justify-center bg-bg/40"><div className="flex items-center gap-2 border border-line2 bg-panel px-4 py-3 text-[13px]"><Loader2 size={16} className="animate-spin text-forest" /> Yangın ilerliyor…</div></div>}
        {drawing && (
          <div className="absolute bottom-12 left-1/2 z-[500] flex -translate-x-1/2 items-center gap-2 border border-line2 bg-bg/95 px-3 py-2 text-[12.5px]">
            <span>Sınır çizimi: {custom.length} nokta</span>
            <button onClick={() => { if (custom.length > 1) { setEstablish('C'); setDrawing(false) } }} className="flex items-center gap-1 border border-forest/60 px-2 py-1 font-semibold text-forest"><Check size={13} /> Bitir</button>
            <button onClick={() => setCustom((c) => c.slice(0, -1))} className="flex items-center gap-1 border border-line2 px-2 py-1"><Undo2 size={13} /> Geri al</button>
            <button onClick={() => { setCustom([]); setDrawing(false) }} className="flex items-center gap-1 border border-line2 px-2 py-1"><X size={13} /> Vazgeç</button>
          </div>
        )}
        {phase === 'result' && replay && (
          <div className="absolute bottom-12 left-1/2 z-[500] flex w-[min(560px,90%)] -translate-x-1/2 items-center gap-2 border border-line2 bg-bg/95 px-3 py-2 text-[12px]">
            <button onClick={() => setPlay((p) => ({ ...p, on: !p.on, step: p.step >= replay.steps ? 0 : p.step }))} aria-label={play.on ? 'Durdur' : 'Oynat'} className="flex h-7 w-7 shrink-0 items-center justify-center border border-forest/60 text-forest">{play.on ? <Pause size={14} /> : <Play size={14} />}</button>
            <input type="range" min={0} max={replay.steps} value={step} onChange={(e) => setPlay((p) => ({ ...p, step: Number(e.target.value), on: false }))} aria-label="Oynatma zamanı" className="min-w-0 flex-1" style={{ ['--p' as string]: `${(step / Math.max(1, replay.steps)) * 100}%` }} />
            <b className="w-[58px] shrink-0 text-right tabular-nums">{T(step * 10)}</b>
            {[1, 2, 4].map((sp) => <button key={sp} onClick={() => setPlay((p) => ({ ...p, speed: sp }))} aria-pressed={play.speed === sp} className={`border px-1.5 py-0.5 ${play.speed === sp ? 'border-forest text-forest' : 'border-line2 text-muted'}`}>{sp}×</button>)}
          </div>
        )}
        <MapStage
          grid={grid}
          result={shown}
          step={step}
          mode={shown ? 'fire' : 'fuel'}
          fitGrid
          fitKey={`${sc.seed}`}
          pick={drawing}
          onMapClick={(lat, lon) => drawing && setCustom((c) => [...c, [lat, lon]])}
          response={shown?.response ? { record: shown.response, step } : null}
          wind={{ config: sc.config, minutes: phase === 'result' ? 0 : nowMin }}
        >
          {candImgs.filter((c) => c.id !== 'C' || establish === 'C').map((c) => (
            <ImageOverlay key={c.id} url={c.url} bounds={gridBounds(grid)} zIndex={455} opacity={establish === c.id ? 0.95 : 0.45} className="fg-pixelated" />
          ))}
          {custom.length > 0 && <Polyline positions={custom} pathOptions={{ color: LINE_COLOR.C, weight: 4, dashArray: establish === 'C' ? undefined : '6 5' }} />}
          {region.settlements.map((st) => (
            <Marker key={st.id} position={st.pos} icon={icons.settlement}>
              <Tooltip direction="right" permanent offset={[8, 0]} className="fg-label">{st.name}</Tooltip>
            </Marker>
          ))}
          {ctx && phase === 'decide' && SECTORS.map((s, k) => {
            const ang = (k * 45 * Math.PI) / 180
            const pos: LatLon = [origin[0] + (frontKm * Math.cos(ang)) / 111.32, origin[1] + (frontKm * Math.sin(ang)) / (111.32 * Math.cos((origin[0] * Math.PI) / 180))]
            return <Marker key={s} position={pos} interactive={false} icon={L.divIcon({ html: `<span style="font:700 11px Inter,sans-serif;color:#ffd24a;text-shadow:0 0 3px #000">${s}</span>`, className: 'fg-icon', iconSize: [22, 14], iconAnchor: [11, 7] })} />
          })}
          {shown?.response && <UnitsLayer rec={shown.response} clockRef={clock} />}
        </MapStage>
      </div>

      <aside className="w-full shrink-0 space-y-3 overflow-auto border-t border-line bg-bg p-3 lg:w-[370px] lg:border-l lg:border-t-0">
        {phase === 'result' && result ? (
          <>
            <Panel title="Karşılaştırma" pad={false}>
              <table className="w-full text-[12.5px]">
                <thead><tr className="border-b border-line2 text-[11px] text-muted"><th /><th className="px-2 py-1.5 text-right font-medium">Müdahalesiz</th><th className="px-2 py-1.5 text-right font-medium">Siz</th><th className="px-2 py-1.5 text-right font-medium">Sistem</th></tr></thead>
                <tbody>
                  <tr className="border-b border-line"><th scope="row" className="px-2 py-1.5 text-left font-normal text-muted">Yanan alan</th><td className="px-2 text-right">{Math.round(result.verdict.none.ha)} ha</td><td className="px-2 text-right font-semibold">{Math.round(result.verdict.you.ha)} ha</td><td className="px-2 text-right font-semibold text-forest">{Math.round(result.verdict.rules.ha)} ha</td></tr>
                  <tr className="border-b border-line"><th scope="row" className="px-2 py-1.5 text-left font-normal text-muted">Ulaşılan yerleşim</th><td className="px-2 text-right">{result.verdict.none.settlements}</td><td className="px-2 text-right font-semibold">{result.verdict.you.settlements}</td><td className="px-2 text-right font-semibold text-forest">{result.verdict.rules.settlements}</td></tr>
                  <tr><th scope="row" className="px-2 py-1.5 text-left font-normal text-muted">Söndü</th><td className="px-2 text-right">–</td><td className="px-2 text-right font-semibold">{result.verdict.you.outH !== null ? `${result.verdict.you.outH.toFixed(1)} sa` : 'sönmedi'}</td><td className="px-2 text-right font-semibold text-forest">{result.verdict.rules.outH !== null ? `${result.verdict.rules.outH.toFixed(1)} sa` : 'sönmedi'}</td></tr>
                </tbody>
              </table>
            </Panel>
            <div className="flex gap-1.5">
              <button onClick={() => watch('you')} aria-pressed={view === 'you'} className={`flex flex-1 items-center justify-center gap-1.5 border px-2 py-1.5 text-[12px] ${view === 'you' ? 'border-forest bg-forest-dim/30' : 'border-line2'}`}><User size={13} /> Sizin müdahaleniz</button>
              <button onClick={() => watch('rules')} aria-pressed={view === 'rules'} className={`flex flex-1 items-center justify-center gap-1.5 border px-2 py-1.5 text-[12px] ${view === 'rules' ? 'border-forest bg-forest-dim/30' : 'border-line2'}`}><Bot size={13} /> Sistem komutanını izle</button>
            </div>
            {replay && <ReplayLog run={replay} step={step} who={view} onJump={(st) => setPlay((p) => ({ ...p, step: st, on: false }))} />}
            <div className="flex gap-2">
              <button onClick={() => restart(true)} className="flex flex-1 items-center justify-center gap-1.5 border border-line2 px-2 py-2 text-[12.5px] hover:text-forest"><RotateCcw size={13} /> Aynı yangını tekrar dene</button>
              <button onClick={() => restart(false)} className="flex flex-1 items-center justify-center gap-1.5 border border-line2 px-2 py-2 text-[12.5px] hover:text-forest"><Flame size={13} /> Yeni sınav</button>
            </div>
          </>
        ) : ctx && phase === 'decide' ? (
          <>
            <Panel title="Güvenlik sınırı">
              <div className="space-y-1.5">
                {ctx.line_candidates.filter((c) => c.id !== 'C').map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-start gap-2 text-[12.5px]">
                    <input type="radio" name="line" checked={establish === c.id} onChange={() => setEstablish(c.id)} className="mt-1" />
                    <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: LINE_COLOR[c.id] }} /><b>{c.id} sınırını kur</b> · yangın ~{c.fire_reaches_it_in_h} saatte ulaşır, {c.length_km} km{c.settlements_inside.length ? `, içinde kalan: ${c.settlements_inside.join(', ')}` : ''}</span>
                  </label>
                ))}
                <div className="flex items-center gap-2 text-[12.5px]">
                  <input type="radio" name="line" checked={establish === 'C'} onChange={() => (custom.length > 1 ? setEstablish('C') : setDrawing(true))} />
                  <button onClick={() => { setCustom([]); setDrawing(true); setEstablish(null) }} className="flex items-center gap-1 border border-line2 px-2 py-1 hover:text-forest"><PenLine size={13} /> Kendi sınırını çiz</button>
                  {establish === 'C' && <span className="text-forest">{custom.length} noktalı sınır seçildi</span>}
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted"><input type="radio" name="line" checked={establish === null} onChange={() => setEstablish(null)} /> Yeni sınır kurma</label>
                {ctx.lines.length > 0 && (
                  <ul className="mt-1 space-y-0.5 border-t border-line pt-1.5 text-[11.5px] text-muted">
                    {ctx.lines.map((l) => <li key={l.id}><b className="text-ink">{l.id}</b>: {l.sectors.map((s) => `${s.sector} %${s.built_pct}${s.breached ? ' aşıldı' : ''}`).join(', ')}</li>)}
                  </ul>
                )}
                {establish && <p className="text-[11px] text-muted">Yeni sınırın kimliği <b>{newLineId}</b>; aşağıda ekipleri bu sınırın sektörlerine atayabilirsiniz.</p>}
              </div>
            </Panel>

            <Panel title="Ekipler ve hava araçları" pad={false}>
              <ul className="divide-y divide-line">
                {ctx.resources.map((r) => {
                  const air = r.type === 'helikopter' || r.type.includes('uçağı')
                  const unavailable = r.status === 'henüz yok'
                  const burning = ctx.fire.sectors.filter((s) => s.burning_ha > 0).map((s) => s.sector)
                  return (
                    <li key={r.id} className="px-2.5 py-1.5">
                      <div className="flex items-baseline justify-between gap-2 text-[12px]">
                        <b>{r.name}</b>
                        <span className="text-[11px] text-muted">{r.status}{r.task ? ` · ${r.task}` : ''}{r.eta ? ` · ${r.eta}` : ''}</span>
                      </div>
                      <select aria-label={`${r.name} görevi`} disabled={unavailable} value={encode(orders[r.id] ?? { kind: 'none' })} onChange={(e) => setOrders((o) => ({ ...o, [r.id]: decode(e.target.value) }))} className="mt-1 w-full border border-line2 bg-panel px-1.5 py-1 text-[12px] disabled:opacity-50">
                        <option value="">{unavailable ? 'Henüz bölgede değil' : 'Görevi değiştirme'}</option>
                        {!air && burning.map((s) => <option key={`a${s}`} value={`attack|${s}`}>Doğrudan müdahale: {s} sektörü</option>)}
                        {!air && lineOptions.flatMap((l) => SECTORS.map((s) => <option key={`l${l}${s}`} value={`line|${l}|${s}`}>Sınır aç: {l} / {s}</option>))}
                        {air && burning.map((s) => <option key={`d${s}`} value={`drop|${s}`}>Su atışı: {s} sektörü</option>)}
                        <option value="withdraw">Geri çek</option>
                      </select>
                    </li>
                  )
                })}
              </ul>
            </Panel>

            <Panel title="Yerleşimler ve tahliye" pad={false}>
              <ul className="divide-y divide-line">
                {ctx.settlements.map((s) => {
                  const started = s.evacuation !== 'yok' && s.evacuation !== 'başlamadı'
                  return (
                    <li key={s.id} className="flex items-start gap-2 px-2.5 py-1.5 text-[12px]">
                      <input type="checkbox" aria-label={`${s.name} tahliye`} disabled={started} checked={started || evac.has(s.id)} onChange={(e) => setEvac((v) => { const n = new Set(v); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n })} className="mt-0.5" />
                      <span className="flex-1"><b>{s.name}</b> <span className="text-muted">{s.population.toLocaleString('tr-TR')} kişi · yangına {s.distance_to_fire_km} km</span><span className={`block text-[11px] ${s.forecast_fire_arrival ? 'text-fire' : 'text-muted'}`}>{s.forecast_fire_arrival ? `Tahmini varış ${s.forecast_fire_arrival}` : 'Yakın tahminde ulaşmıyor'} · tahliye: {s.evacuation}</span></span>
                    </li>
                  )
                })}
              </ul>
            </Panel>

            <div className="sticky bottom-0 space-y-2 bg-bg pb-1 pt-1">
              <button onClick={() => submit(false)} className="flex w-full items-center justify-center gap-2 bg-fire px-3 py-2.5 text-[14px] font-semibold text-white hover:bg-fire/90"><Check size={16} /> Kararları uygula ve devam et</button>
              <button onClick={() => submit(true)} className="w-full border border-line2 px-3 py-2 text-[12.5px] hover:text-forest">Değişiklik yok, bir sonraki karara geç</button>
            </div>
          </>
        ) : (
          <p className="text-[12.5px] text-muted">Komutayı almak için ihbar penceresindeki düğmeye basın.</p>
        )}
      </aside>
    </div>
  )
}

/** The decisions and events of a response run up to the replay step; a click jumps to that moment. */
function ReplayLog({ run, step, who, onJump }: { run: SimResult; step: number; who: 'you' | 'rules'; onJump: (step: number) => void }) {
  const r = run.response!
  const decisions = r.decisions.filter((d) => d.output.actions.some((x) => x.type !== 'hold'))
  const holds = r.decisions.length - decisions.length
  const events = r.events.filter((e) => e.step <= step).slice(-6).reverse()
  const listRef = useRef<HTMLOListElement | null>(null)
  const current = decisions.filter((d) => d.step <= step).length - 1
  useEffect(() => {
    listRef.current?.querySelector(`[data-k="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])
  return (
    <>
      <Panel title={who === 'you' ? 'Kararlarınız' : 'Sistem komutanının kararları'} action={<span className="text-[11px] text-muted">{decisions.length} karar · {holds} kez değişiklik yok</span>} pad={false}>
        <ol ref={listRef} className="max-h-[340px] divide-y divide-line overflow-auto">
          {decisions.map((d, k) => {
            const past = d.step <= step
            return (
              <li key={k} data-k={k} className={`cursor-pointer px-2.5 py-2 text-[12px] hover:bg-panel2 ${k === current ? 'border-l-2 border-forest bg-forest-dim/15' : ''} ${past ? '' : 'opacity-45'}`} onClick={() => onJump(d.step)}>
                <div className="flex items-baseline justify-between gap-2">
                  <b>{T(d.step * 10)}</b>
                  {d.output.phase && <span className="text-[11px] text-forest">{d.output.phase}</span>}
                </div>
                <div className="mt-0.5 text-[11px] text-amber">{d.trigger}</div>
                {who === 'rules' && d.output.assessment && <p className="mt-1 leading-snug">{d.output.assessment}</p>}
                <ul className="mt-1 space-y-0.5 text-muted">
                  {d.applied.map((t, i) => {
                    const why = who === 'rules' ? d.output.actions[i]?.rationale : ''
                    return <li key={i}>• {t}{why ? <span className="block pl-2.5 text-[11px] italic">{why}</span> : null}</li>
                  })}
                </ul>
              </li>
            )
          })}
        </ol>
      </Panel>
      <Panel title={`Olaylar · ${T(step * 10)}`}>
        {events.length ? (
          <ul className="space-y-1 text-[12px]">{events.map((e, i) => <li key={i}><b className="tabular-nums">{T(e.step * 10)}</b> <span className="text-muted">{e.text}</span></li>)}</ul>
        ) : <p className="text-[12px] text-muted">Bu ana kadar olay yok.</p>}
      </Panel>
    </>
  )
}
