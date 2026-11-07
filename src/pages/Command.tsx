import { useEffect, useMemo, useState, type ReactNode } from 'react'
import L from 'leaflet'
import { Marker, Tooltip } from 'react-leaflet'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bot, ChevronDown, ChevronRight, Cpu, Helicopter, Loader2, Pause, Play, Plane, Save, Square, RotateCcw, Tractor, Truck } from 'lucide-react'
import { MapStage } from '../components/MapStage'
import { Legend, Panel, Segmented, SliderField, Stat, fmtHa } from '../components/ui'
import { icons } from '../components/mapIcons'
import { lineColor } from '../components/ResponseLayer'
import { regionById } from '../data/regions'
import { getInfrastructure } from '../data/infrastructure'
import { getGrid } from '../sim/gridCache'
import { compass, fmtDuration } from '../sim/geo'
import { weatherAt } from '../sim/weather'
import type { Decision, ResourceKind, ResourceStatus, ResponseRecord, SimResult } from '../sim/types'
import { useStore } from '../state/store'
import { useCommandRun, type CommanderMode } from '../state/useCommandRun'
import { aiHealth, type AiHealth } from '../lib/commanderClient'

const T = (step: number) => `T+${fmtDuration(step * 10)}`
/** Playback time, in minutes (moves in 15-minute ticks). */
const Tm = (min: number) => `T+${fmtDuration(min)}`

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
  return { color: '#8a9ba3', name: 'Diğer' }
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

function at<T extends { step: number }>(points: T[], step: number): T | null {
  let lo = 0
  let hi = points.length - 1
  let best: T | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].step <= step) {
      best = points[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

export function Command() {
  const { active, addScenario, notify } = useStore()
  const run = useCommandRun()
  const [startMin, setStartMin] = useState(30)
  const [mode, setMode] = useState<CommanderMode>('ai')
  const [health, setHealth] = useState<AiHealth | null>(null)
  const [compare, setCompare] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    aiHealth().then(setHealth)
  }, [])

  const config = active.result.config
  const region = regionById(config.areaId)
  const grid = getGrid(config.areaId)
  const infra = useMemo(() => getInfrastructure(region), [region])
  const live = run.live
  const rec = live?.response ?? null
  const head = run.head
  const stat = live ? live.series[Math.min(head, live.series.length - 1)] : null
  const aiReady = !!health?.ai
  const done = run.status === 'done' || run.status === 'stopped'

  const begin = () => {
    setSelected(null)
    setCompare(false)
    setSaved(false)
    run.start(grid, config, region.settlements, infra, startMin, mode)
  }
  const save = () => {
    if (!live) return
    addScenario(`Komuta – ${active.name.split(' – ')[0]}`, live)
    setSaved(true)
    notify('Müdahaleli senaryo kaydedildi; Analiz ve Raporlar\'da karşılaştırabilirsiniz.')
  }

  const decisions = rec ? rec.decisions.filter((d) => d.step <= head) : []
  const events = rec ? rec.events.filter((e) => e.step <= head).slice(-8).reverse() : []
  const evacuated = rec ? rec.evacuations.filter((e) => e.startStep <= head).reduce((s, e) => s + Math.round(e.population * Math.min(1, (head - e.startStep) / Math.max(1, e.doneStep - e.startStep))), 0) : 0
  const lastDecision = decisions[decisions.length - 1]
  const w = live ? weatherAt(live.config, run.headMin) : null

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:flex-row">
      {/* setup */}
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-b border-line bg-panel p-3 lg:w-[290px] lg:border-b-0 lg:border-r">
        <Panel title="Müdahale senaryosu">
          <div className="text-[14px] font-semibold">{active.name}</div>
          <div className="mt-0.5 text-[12px] text-muted">
            {region.name} · {config.weather ? 'Open-Meteo saatlik hava' : `sabit hava, rüzgar ${config.windSpeedKmh} km/sa ${compass(config.windFromDeg)}`}
          </div>
          <div className="mt-3 space-y-3">
            <SliderField label="Müdahale başlangıcı" value={startMin} min={0} max={180} step={10} unit="dk" onChange={setStartMin} hint="Yangın başladıktan kaç dakika sonra ilk karar verilir ve ekipler yola çıkar" />
            <div>
              <div className="mb-1 text-[12px] text-muted">Olay komutanı</div>
              <Segmented<CommanderMode> label="Olay komutanı" value={mode} onChange={setMode} options={[{ value: 'ai', label: 'ChatGPT (yapay zeka)' }, { value: 'rules', label: 'Kural tabanlı' }]} />
              <p className="mt-1.5 text-[11.5px] leading-snug text-muted">
                {mode === 'ai'
                  ? aiReady
                    ? `Her karar anında durum ${health!.model} modeline gönderilir; yanıt gelene kadar simülasyon bekler.`
                    : 'Sunucuda API anahtarı yok. .env dosyasına OPENAI_API_KEY ekleyip sunucuyu yeniden başlatın; o zamana kadar kararları kural tabanlı komutan verir.'
                  : 'Sabit kurallarla karar verir: küçük yangında kanatlardan söndürme, büyüyünce güvenlik sınırı, tehlikedeki yerleşimlerde tahliye.'}
              </p>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            {run.status === 'running' ? (
              <button onClick={run.stop} className="flex flex-1 items-center justify-center gap-1.5 border border-fire/60 px-3 py-2 text-[13px] font-semibold text-fire hover:bg-fire/10"><Square size={14} /> Durdur</button>
            ) : (
              <button onClick={begin} className="flex flex-1 items-center justify-center gap-1.5 bg-fire px-3 py-2 text-[13px] font-semibold text-white hover:bg-fire/90"><Play size={14} /> {done ? 'Yeniden başlat' : 'Müdahaleyi başlat'}</button>
            )}
            {run.status !== 'idle' && run.status !== 'running' && <button onClick={run.reset} aria-label="Sıfırla" className="border border-line2 px-2.5 text-muted hover:text-ink"><RotateCcw size={14} /></button>}
          </div>
        </Panel>

        {rec && <ResourcesPanel rec={rec} step={head} />}

        <p className="text-[11px] leading-snug text-muted">
          Temsili simülasyon. Söndürme etkileri basitleştirilmiştir; yapay zekanın kararları doğrulanmış yangın taktiği değildir ve gerçek bir operasyonu yönlendirmez.
        </p>
      </aside>

      {/* map + incident strip */}
      <div className="flex min-h-[620px] min-w-0 flex-1 flex-col lg:min-h-0">
        <div className="grid grid-cols-2 gap-x-5 gap-y-2 border-b border-line bg-panel px-4 py-2.5 md:grid-cols-5">
          <Stat label="Yanan alan" value={stat ? fmtHa(stat.affectedHa) : '–'} unit="ha" tone="amber" />
          <Stat label="Şu an yanan" value={stat ? fmtHa(stat.burningHa) : '–'} unit="ha" tone="fire" />
          <Stat label="Tahliye edilen" value={rec ? evacuated.toLocaleString('en-US') : '–'} unit="kişi" />
          <Stat label="Müdahalesiz olsaydı" value={done && rec ? fmtHa(rec.baseline.affectedHa) : '–'} unit={done ? 'ha' : ''} hint="Aynı yangın, aynı süre, hiç müdahale olmadan" />
          <Stat label="Kurtarılan alan" value={done && rec && live ? fmtHa(Math.max(0, rec.baseline.affectedHa - live.series[live.series.length - 1].affectedHa)) : '–'} unit={done ? 'ha' : ''} tone="forest" />
        </div>
        <div className="relative min-h-[420px] flex-1">
          <MapStage
            grid={grid}
            result={live}
            resultB={compare && run.baseline ? run.baseline : null}
            step={head}
            mode={compare && run.baseline ? 'diff' : live ? 'fire' : 'fuel'}
            fitGrid
            fitKey={config.areaId}
            hud
            response={rec && !compare ? { record: rec, step: head } : null}
            legend={
              compare ? (
                <Legend title="Müdahalenin etkisi" items={[{ color: 'rgba(217,89,38,.85)', label: 'Müdahale sayesinde yanmadı' }, { color: 'rgba(235,235,225,.55)', label: 'İki durumda da yandı' }]} />
              ) : (
                <Legend title="Müdahale" items={[
                  { color: lineColor(1), label: '1. güvenlik sınırı (soluk: planlanan)' },
                  { color: lineColor(2), label: '2. güvenlik sınırı' },
                  { color: '#ff5a4e', label: 'Aşılan sektör' },
                  { color: 'rgba(120,190,255,.8)', label: 'Su atışı', kind: 'dot' },
                  { color: '#ecf4f0', label: 'Tahliye rotası', kind: 'dash' },
                ]} />
              )
            }
            controls={
              done && run.baseline ? (
                <button onClick={() => setCompare(!compare)} aria-pressed={compare} className={`border border-line2 bg-bg/90 px-2.5 py-1 text-[12px] font-medium ${compare ? 'text-forest' : 'text-muted hover:text-ink'}`}>
                  {compare ? 'Müdahaleyi göster' : 'Müdahalesiz hâliyle karşılaştır'}
                </button>
              ) : undefined
            }
          >
            {rec &&
              !compare &&
              rec.tracks.map((tr) => {
                const p = at(tr.points, head)
                if (!p || p.status === 'unavailable') return null
                return (
                  <Marker key={tr.id} position={[p.lat, p.lon]} icon={unitIcon(tr.kind, p.status)} zIndexOffset={500}>
                    <Tooltip direction="top" offset={[0, -12]}>{tr.name} · {STATUS[p.status].label}</Tooltip>
                  </Marker>
                )
              })}
            {region.settlements.map((st) => {
              const ev = rec?.evacuations.find((e) => e.settlementId === st.id && e.startStep <= head)
              const label = !ev ? '' : head >= ev.doneStep ? ' · tahliye edildi' : ` · tahliye %${Math.round(((head - ev.startStep) / Math.max(1, ev.doneStep - ev.startStep)) * 100)}`
              return (
                <Marker key={st.id} position={st.pos} icon={icons.settlement}>
                  <Tooltip direction="right" permanent offset={[8, 0]} className="fg-label">{st.name}{label}</Tooltip>
                </Marker>
              )
            })}
            <Marker position={config.ignition} icon={icons.ignition}><Tooltip direction="top" offset={[0, -12]}>Tutuşma noktası</Tooltip></Marker>
          </MapStage>

          {/* status */}
          <div className="pointer-events-none absolute left-14 top-2 z-[600] max-w-[420px]">
            {run.status === 'idle' ? (
              <div className="border border-line2 bg-bg/92 px-3 py-2 text-[12.5px]">Müdahale zamanını ve komutanı seçip <b>Müdahaleyi başlat</b>'a basın. Yangın başlar, komutan her karar anında durumu değerlendirir.</div>
            ) : run.thinking ? (
              <div className="flex items-start gap-2 border border-water/50 bg-bg/92 px-3 py-2 text-[12.5px]">
                <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-water" />
                <span>
                  <b>{mode === 'ai' && aiReady ? 'ChatGPT değerlendiriyor' : 'Komutan değerlendiriyor'}</b> · {Tm(run.headMin)}
                  <span className="block text-muted">{run.pending?.trigger}</span>
                </span>
              </div>
            ) : (
              <div className="border border-line2 bg-bg/92 px-3 py-1.5 text-[12.5px]">
                <b>{Tm(run.headMin)}</b>
                {w && <span className="text-muted"> · rüzgar {Math.round(w.windSpeedKmh)} km/sa {compass(w.windFromDeg)}</span>}
                {lastDecision && <span> · {lastDecision.output.phase}</span>}
                {rec?.extinguishedStep !== null && rec?.extinguishedStep !== undefined && head >= rec.extinguishedStep && <span className="text-forest"> · yangın söndü</span>}
              </div>
            )}
          </div>
        </div>
        <IncidentStrip run={run} rec={rec} live={live} onSelect={(i) => { setSelected(i); run.setPlaying(false); run.setHead(rec!.decisions[i].step) }} />
      </div>

      {/* decision log */}
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-t border-line bg-bg p-3 lg:w-[390px] lg:border-l lg:border-t-0">
        {done && live && rec && (
          <Panel title="Sonuç">
            <p className="text-[13px] leading-snug">
              {rec.extinguishedStep !== null ? <>Yangın <b>{T(rec.extinguishedStep)}</b>'da söndü. </> : <>Simülasyon {T(live.steps)}'da durduruldu. </>}
              Müdahaleyle <b>{fmtHa(live.series[live.series.length - 1].affectedHa)} ha</b> yandı; müdahale olmasaydı aynı sürede <b>{fmtHa(rec.baseline.affectedHa)} ha</b> yanacaktı.
              {' '}Yangının ulaştığı yerleşim: {live.impacts.filter((i) => i.arrivalMin !== null).length} (müdahalesiz {rec.baseline.settlementsReached}).
            </p>
            <div className="mt-2 text-[12px] text-muted">{rec.decisions.length} karar · {rec.decisions.filter((d) => d.source === 'ai').length} tanesi ChatGPT'den · {rec.drops.length} su atışı · {rec.evacuations.length} tahliye</div>
            <button onClick={save} disabled={saved} className="mt-2.5 flex items-center gap-1.5 border border-forest/60 px-2.5 py-1.5 text-[12px] font-semibold text-forest hover:bg-forest-dim/40 disabled:opacity-50"><Save size={13} /> {saved ? 'Kaydedildi' : 'Analize kaydet'}</button>
          </Panel>
        )}
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

function DecisionCard({ d, open, onToggle }: { d: Decision; open: boolean; onToggle: () => void }) {
  const tone = phaseTone(d.output.phase)
  return (
    <li className="px-3 py-2.5">
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-2 text-left">
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rotate-45" style={{ background: tone.color }} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <b className="text-[13.5px]">{T(d.step)}</b>
            <span className="text-[13px]">{d.output.phase}</span>
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
        <div className="mt-2 pl-[18px]">
          <p className="text-[12.5px] leading-snug">{d.output.assessment}</p>
          {d.fallbackReason && <p className="mt-1 text-[11.5px] text-amber">Yapay zekaya ulaşılamadı: {d.fallbackReason}</p>}
          <ul className="mt-2 space-y-1.5">
            {d.output.actions.map((a, k) => (
              <li key={k} className="border-l-2 border-line2 pl-2 text-[12.5px] leading-snug">
                <span className="font-medium">{d.applied[k]}</span>
                <span className="block text-[11.5px] text-muted">{a.rationale}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}

function ResourcesPanel({ rec, step }: { rec: ResponseRecord; step: number }) {
  const rows = rec.tracks.map((t) => ({ t, p: at(t.points, step) }))
  return (
    <Panel title="Kaynaklar" pad={false}>
      <ul className="divide-y divide-line">
        {rows.map(({ t, p }) => {
          const { Icon, color } = KIND[t.kind]
          const st = STATUS[p?.status ?? 'unavailable']
          return (
            <li key={t.id} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
              <Icon size={14} style={{ color }} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <span className={`shrink-0 ${st.tone}`}>{st.label}</span>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

/** The incident strip: computed part of the run, phases as coloured bands, decisions as diamonds, the playhead. */
function IncidentStrip({ run, rec, live, onSelect }: { run: ReturnType<typeof useCommandRun>; rec: ResponseRecord | null; live: SimResult | null; onSelect: (i: number) => void }) {
  const total = Math.max(36, live ? Math.ceil(Math.max(run.frontier, 6) / 36) * 36 : 72)
  const pct = (s: number) => `${(s / total) * 100}%`
  const hours = total / 6
  const every = [1, 2, 3, 6, 12].find((e) => hours / e <= 12) ?? 12
  const bands: { from: number; to: number; color: string; name: string }[] = []
  if (rec)
    rec.decisions.forEach((d, i) => {
      const next = rec.decisions[i + 1]?.step ?? run.frontier
      const tone = phaseTone(d.output.phase)
      const last = bands[bands.length - 1]
      if (last && last.name === tone.name) last.to = next
      else bands.push({ from: d.step, to: next, ...tone })
    })
  const legend: ReactNode = [...new Map(bands.map((b) => [b.name, b.color])).entries()].map(([name, color]) => (
    <span key={name} className="flex items-center gap-1"><span className="h-2 w-3" style={{ background: color }} />{name}</span>
  ))
  return (
    <div className="border-t border-line bg-panel px-3 py-2" role="group" aria-label="Olay zaman şeridi">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <button onClick={() => run.setPlaying(!run.playing)} disabled={!live} aria-label={run.playing ? 'Duraklat' : 'Oynat'} className="flex h-8 w-8 items-center justify-center bg-forest text-bg hover:bg-forest/85 disabled:opacity-40">{run.playing ? <Pause size={16} /> : <Play size={16} />}</button>
          <div className="flex border border-line2" role="radiogroup" aria-label="Oynatma hızı">
            {[1, 2, 4, 8].map((s) => (
              <button key={s} role="radio" aria-checked={run.speed === s} onClick={() => run.setSpeed(s)} className={`px-1.5 py-1 text-[11.5px] font-medium ${run.speed === s ? 'bg-forest-dim text-ink' : 'text-muted hover:text-ink'}`}>{s}×</button>
            ))}
          </div>
        </div>
        <div className="relative h-11 min-w-0 flex-1">
          {/* track */}
          <div className="absolute inset-x-0 top-3 h-4 bg-line/60" />
          <div className="absolute left-0 top-3 h-4 bg-line2" style={{ width: pct(run.frontier) }} />
          {bands.map((b, i) => (
            <div key={i} className="absolute top-3 h-4 opacity-80" style={{ left: pct(b.from), width: pct(Math.max(0.5, b.to - b.from)), background: b.color }} title={b.name} />
          ))}
          {rec?.extinguishedStep != null && <div className="absolute top-1.5 h-7 w-0.5 bg-forest" style={{ left: pct(rec.extinguishedStep) }} title="Yangın söndü" />}
          {rec?.decisions.map((d, i) => (
            <button key={i} onClick={() => onSelect(i)} aria-label={`${T(d.step)} kararı: ${d.output.phase}`} className="absolute top-[7px] h-3 w-3 -translate-x-1/2 rotate-45 border border-bg hover:scale-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink" style={{ left: pct(d.step), background: d.source === 'ai' ? '#3b9be0' : '#e7eee9' }} />
          ))}
          {/* playhead */}
          <div className="pointer-events-none absolute top-0 h-8 w-0.5 bg-ink" style={{ left: pct(run.headMin / 10) }} />
          <input
            type="range"
            min={0}
            max={total}
            value={run.head}
            disabled={!live}
            onChange={(e) => { run.setPlaying(false); run.setHead(Number(e.target.value)) }}
            aria-label="Simülasyon zamanı"
            className="absolute inset-x-0 top-2 h-6 cursor-pointer opacity-0"
          />
          <div className="absolute inset-x-0 top-8 text-[10.5px] text-muted">
            {Array.from({ length: Math.floor(hours / every) + 1 }, (_, i) => i * every).map((h) => (
              <span key={h} className="absolute" style={{ left: pct(h * 6), transform: h === 0 ? 'none' : 'translateX(-50%)' }}>{h}sa</span>
            ))}
          </div>
        </div>
      </div>
      {bands.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[124px] text-[11px] text-muted">
          {legend}
          <span className="flex items-center gap-1"><span className="h-2 w-2 rotate-45 bg-water" />ChatGPT kararı</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rotate-45 bg-ink" />Kural kararı</span>
        </div>
      )}
    </div>
  )
}
