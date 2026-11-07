import { useMemo, useState } from 'react'
import { Circle, CircleMarker, Marker, Polygon, Polyline, Tooltip } from 'react-leaflet'
import { ArrowLeft, Bot, Check, Cpu, Droplets, Eye, Flame, Home, Loader2, Milestone, RotateCcw, Sparkles, Trash2, Trees, Truck, Undo2, Video, X } from 'lucide-react'
import { MapStage } from '../../components/MapStage'
import { icons } from '../../components/mapIcons'
import { Panel, Segmented } from '../../components/ui'
import { cellOf } from '../../sim/terrain'
import { haversineM, type LatLon } from '../../sim/geo'
import { askDrillOptimal } from '../../lib/commanderClient'
import COSTS from '../../data/drillCosts.json'
import {
  BUDGET_TL,
  COST_NOTE,
  TOOLS,
  getGrid,
  judgePlan,
  measureCellsFor,
  measureCost,
  newScenario,
  optimalContext,
  optionCandidates,
  regionById,
  ruleOptimal,
  runPlan,
  tlFmt,
  type DrillMeasure,
  type FireOutcome,
  type ToolId,
  type Verdict,
} from '../../sim/drill'
import { MistakeList, ScoreCard, WeatherChips } from './shared'

const TOOL_ICON: Record<ToolId, typeof Eye> = { kule: Eye, kamera: Video, serit: Milestone, aralama: Trees, yerlesim: Home, havuz: Droplets, konuslanma: Truck }
const A = COSTS.araclar
const UNIT: Record<ToolId, string> = {
  kule: `${tlFmt(A.kule.kurulumTL)} + ${tlFmt(A.kule.sezonTL)}/sezon`,
  kamera: `${tlFmt(A.kamera.kurulumTL)} + ${tlFmt(A.kamera.sezonTL)}/sezon`,
  serit: `${tlFmt(A.serit.kmTL_30m)}/km (30 m)`,
  aralama: `${tlFmt(A.aralama.haTL)}/ha`,
  yerlesim: `${tlFmt(A.yerlesim.haTL)}/ha`,
  havuz: tlFmt(A.havuz.kurulumTL),
  konuslanma: `${tlFmt(A.konuslanma.sezonTL)}/sezon`,
}

type Optimal = { plan: DrillMeasure[]; fires: FireOutcome[]; verdict: Verdict; source: 'ai' | 'rules'; model?: string; reason?: string; summary: string; rationale: Record<string, string> }

export function PreventionExam({ onExit }: { onExit: () => void }) {
  const [sc, setSc] = useState(() => newScenario(1))
  const region = regionById(sc.areaId)
  const grid = getGrid(sc.areaId)
  const [plan, setPlan] = useState<DrillMeasure[]>([])
  const [tool, setTool] = useState<ToolId | null>(null)
  const [draft, setDraft] = useState<LatLon[]>([])
  const [width, setWidth] = useState<30 | 60 | 100>(30)
  const [msg, setMsg] = useState<string | null>(null)
  const [phase, setPhase] = useState<'plan' | 'running' | 'result'>('plan')
  const [progress, setProgress] = useState(0)
  const [fires, setFires] = useState<FireOutcome[] | null>(null)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [fireIdx, setFireIdx] = useState(0)
  const [optimal, setOptimal] = useState<Optimal | null>(null)
  const [optBusy, setOptBusy] = useState(false)
  const [showOpt, setShowOpt] = useState(false)

  const costs = useMemo(() => plan.map((m) => measureCost(grid, m)), [plan, grid])
  const total = costs.reduce((s, c) => s + c.tl, 0)
  const nature = costs.reduce((s, c) => s + c.natureHa, 0)
  const note = (t: string) => {
    setMsg(t)
    window.setTimeout(() => setMsg((m) => (m === t ? null : m)), 3500)
  }

  const add = (m: Omit<DrillMeasure, 'cells' | 'id'>) => {
    const id = `${m.tool}-${Date.now().toString(36)}`
    const cells = measureCellsFor(grid, { ...m, id }, region.settlements)
    if (!cells.length) return note('Bu önlem burada hiçbir bitki örtüsüne denk gelmiyor.')
    setPlan((p) => [...p, { ...m, id, cells }])
  }

  const onMapClick = (lat: number, lon: number) => {
    if (phase !== 'plan' || !tool) return
    const c = cellOf(grid, lat, lon)
    if (c < 0) return note('Çalışma alanının (kesikli çerçeve) içine tıklayın.')
    const kind = TOOLS[tool].kind
    if (kind === 'line' || kind === 'area') return setDraft((d) => [...d, [lat, lon]])
    if (grid.kind[c] === 0) return note('Bu nokta su. Karada bir yer seçin.')
    if (kind === 'settlement') {
      const st = region.settlements.reduce((a, b) => (haversineM(b.pos, [lat, lon]) < haversineM(a.pos, [lat, lon]) ? b : a))
      if (haversineM(st.pos, [lat, lon]) > st.radiusM + 1500) return note('Bir yerleşimin üzerine tıklayın.')
      if (plan.some((m) => m.tool === 'yerlesim' && m.settlementId === st.id)) return note(`${st.name} zaten planda.`)
      return add({ tool, points: [st.pos], settlementId: st.id, label: st.name })
    }
    add({ tool, points: [[lat, lon]] })
  }

  const finishDraft = () => {
    if (!tool) return
    const kind = TOOLS[tool].kind
    if (kind === 'line' && draft.length < 2) return note('Şerit için en az iki nokta gerekli.')
    if (kind === 'area' && draft.length < 3) return note('Alan için en az üç köşe gerekli.')
    add({ tool, points: draft, widthM: tool === 'serit' ? width : undefined })
    setDraft([])
  }

  const yieldUi = () => new Promise<void>((r) => setTimeout(r, 20))
  const simulate = async () => {
    setPhase('running')
    setProgress(0)
    await yieldUi()
    const out = await runPlan(sc, plan, async (d, t) => {
      setProgress(d / t)
      await yieldUi()
    })
    setFires(out)
    setVerdict(judgePlan(grid, plan, out, region.settlements, sc.config.windFromDeg))
    setFireIdx(0)
    setPhase('result')
  }

  const showOptimal = async () => {
    if (!fires) return
    setOptBusy(true)
    await yieldUi()
    const cands = optionCandidates(grid, sc, fires, region.settlements)
    let ids: string[]
    let source: 'ai' | 'rules' = 'ai'
    let model: string | undefined
    let reason: string | undefined
    let summary = ''
    const rationale: Record<string, string> = {}
    try {
      const r = await askDrillOptimal(optimalContext(sc, fires, cands))
      ids = r.output.selected.map((x) => x.id).filter((id) => cands.some((c) => c.id === id))
      r.output.selected.forEach((x) => (rationale[x.id] = x.rationale))
      summary = r.output.summary
      model = r.model
    } catch (e) {
      ids = ruleOptimal(cands, fires)
      source = 'rules'
      reason = (e as Error).message
      summary = 'Yapay zeka kullanılamadı; adaylar önledikleri tahmini zararın maliyetine oranına göre bütçe içinde seçildi.'
      cands.filter((c) => ids.includes(c.id)).forEach((c) => (rationale[c.id] = c.evidence))
    }
    const oplan = cands.filter((c) => ids.includes(c.id)).map((c) => c.measure)
    const ofires = await runPlan(sc, oplan, async () => yieldUi(), fires.map((f) => f.without))
    setOptimal({ plan: oplan, fires: ofires, verdict: judgePlan(grid, oplan, ofires, region.settlements, sc.config.windFromDeg), source, model, reason, summary, rationale })
    setShowOpt(true)
    setOptBusy(false)
  }

  const restart = (same: boolean) => {
    if (!same) setSc(newScenario(1))
    setPlan([])
    setDraft([])
    setTool(null)
    setFires(null)
    setVerdict(null)
    setOptimal(null)
    setShowOpt(false)
    setPhase('plan')
  }

  const shownPlan = showOpt && optimal ? optimal.plan : plan
  const fireView = showOpt && optimal ? optimal.fires[fireIdx] : fires?.[fireIdx]

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:flex-row">
      {/* left: tools, or the score */}
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-b border-line bg-panel p-3 lg:w-[300px] lg:border-b-0 lg:border-r">
        <button onClick={onExit} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink"><ArrowLeft size={13} /> Tatbikat menüsü</button>
        {phase !== 'result' ? (
          <>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Sınav 1 · Önlem</div>
              <h2 className="mt-0.5 text-[16px] font-semibold">{region.name}</h2>
              <p className="mt-1 text-[12px] leading-snug text-muted">Yangının nerede çıkacağını bilmiyorsunuz. Bu havada en olası noktalardan çıkacak yangınlara karşı bütçeyle önlem planı yapın.</p>
            </div>
            <div className="space-y-1.5" role="radiogroup" aria-label="Önlem araçları">
              {(Object.keys(TOOLS) as ToolId[]).map((id) => {
                const T = TOOLS[id]
                const Icon = TOOL_ICON[id]
                const on = tool === id
                return (
                  <button key={id} role="radio" aria-checked={on} onClick={() => { setTool(on ? null : id); setDraft([]) }} className={`w-full border px-2.5 py-2 text-left ${on ? 'border-forest bg-forest-dim/30' : 'border-line2 bg-bg hover:border-muted'}`}>
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: `${T.color}22`, color: T.color }}><Icon size={15} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold">{T.label}</div>
                        <div className="text-[11px] text-muted">{UNIT[id]}</div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
            {tool && (
              <div className="border border-forest/50 bg-forest-dim/20 px-2.5 py-2 text-[11.5px] leading-snug">
                <div className="font-semibold">{TOOLS[tool].label}</div>
                <div className="mt-0.5 text-muted">{TOOLS[tool].effect}</div>
                <div className="mt-1 text-forest">{TOOLS[tool].how}</div>
              </div>
            )}
            {tool === 'serit' && (
              <div>
                <div className="mb-1 text-[12px] text-muted">Şerit genişliği</div>
                <Segmented<'30' | '60' | '100'> label="Şerit genişliği" value={String(width) as '30' | '60' | '100'} onChange={(v) => setWidth(Number(v) as 30 | 60 | 100)} options={[{ value: '30', label: '30 m' }, { value: '60', label: '60 m' }, { value: '100', label: '100 m' }]} />
              </div>
            )}
            <p className="text-[10.5px] leading-snug text-muted">{COST_NOTE}</p>
          </>
        ) : verdict && (
          <>
            <ScoreCard title="Sınav sonucu" score={verdict.score} grade={verdict.grade} parts={verdict.parts} />
            <Panel title="Hatalar ve doğrular">
              <MistakeList items={verdict.mistakes} />
            </Panel>
          </>
        )}
      </aside>

      {/* map */}
      <div className="relative min-h-[460px] min-w-0 flex-1">
        <div className="absolute left-14 right-3 top-2 z-[500] flex flex-wrap items-center gap-2">
          <WeatherChips config={sc.config} />
          {phase === 'plan' && (
            <div className="flex items-center gap-2 border border-line2 bg-bg/92 px-2 py-1 text-[12px]">
              <span>Bütçe</span>
              <div className="h-1.5 w-28 rounded-full bg-line"><div className={`h-full rounded-full ${total > BUDGET_TL ? 'bg-fire' : 'bg-forest'}`} style={{ width: `${Math.min(100, (total / BUDGET_TL) * 100)}%` }} /></div>
              <b className={total > BUDGET_TL ? 'text-fire' : ''}>{tlFmt(total)}</b><span className="text-muted">/ {tlFmt(BUDGET_TL)}</span>
            </div>
          )}
        </div>
        {phase === 'plan' && tool && (TOOLS[tool].kind === 'line' || TOOLS[tool].kind === 'area') && (
          <div className="absolute bottom-12 left-1/2 z-[500] flex -translate-x-1/2 items-center gap-2 border border-line2 bg-bg/95 px-3 py-2 text-[12.5px]">
            <span>{TOOLS[tool].label}: {draft.length} nokta</span>
            <button onClick={finishDraft} className="flex items-center gap-1 border border-forest/60 px-2 py-1 font-semibold text-forest hover:bg-forest-dim/40"><Check size={13} /> Bitir</button>
            <button onClick={() => setDraft((d) => d.slice(0, -1))} disabled={!draft.length} className="flex items-center gap-1 border border-line2 px-2 py-1 disabled:opacity-40"><Undo2 size={13} /> Geri al</button>
            <button onClick={() => setDraft([])} className="flex items-center gap-1 border border-line2 px-2 py-1"><X size={13} /> Vazgeç</button>
          </div>
        )}
        {msg && <div className="absolute bottom-16 left-1/2 z-[600] -translate-x-1/2 border border-amber/60 bg-bg/95 px-3 py-1.5 text-[12.5px] text-amber">{msg}</div>}
        {phase === 'running' && (
          <div className="absolute inset-0 z-[900] flex items-center justify-center bg-bg/60">
            <div className="w-[340px] border border-line2 bg-panel p-4">
              <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold"><Loader2 size={16} className="animate-spin text-forest" /> Yangınlar başlatılıyor</div>
              <div className="h-2 bg-line"><div className="h-full bg-forest transition-[width]" style={{ width: `${progress * 100}%` }} /></div>
              <div className="mt-2 text-[12px] text-muted">En olası {sc.ignitions.length} noktadan çıkan yangınlar önce önlemsiz, sonra planınızla simüle ediliyor; müdahaleyi sistem komutanı yürütüyor.</div>
            </div>
          </div>
        )}
        <MapStage
          grid={grid}
          result={phase === 'result' && fireView ? fireView.without : null}
          resultB={phase === 'result' && fireView ? fireView.withPlan : null}
          step={phase === 'result' && fireView ? Math.max(fireView.without.steps, fireView.withPlan.steps) : 0}
          mode={phase === 'result' ? 'diff' : 'fuel'}
          fitGrid
          fitKey={`${sc.seed}`}
          pick={phase === 'plan' && !!tool}
          hud={phase === 'plan'}
          onMapClick={onMapClick}
          wind={phase === 'plan' ? { config: sc.config, minutes: 0 } : null}
          legend={phase === 'result' ? (
            <ul className="space-y-1 border border-line2 bg-bg/92 p-2 text-[11.5px]">
              <li className="flex items-center gap-2"><span className="h-3 w-4" style={{ background: 'rgba(57,135,229,.8)' }} /> {showOpt ? 'Optimal plan' : 'Planınız'} sayesinde yanmadı</li>
              <li className="flex items-center gap-2"><span className="h-3 w-4" style={{ background: 'rgba(235,235,225,.55)' }} /> Her iki durumda da yandı</li>
              <li className="flex items-center gap-2"><span className="h-3 w-4" style={{ background: 'rgba(217,89,38,.85)' }} /> Yalnızca önlemli durumda yandı</li>
            </ul>
          ) : undefined}
        >
          {region.settlements.map((st) => (
            <Marker key={st.id} position={st.pos} icon={icons.settlement}>
              <Tooltip direction="right" permanent offset={[8, 0]} className="fg-label">{st.name}</Tooltip>
            </Marker>
          ))}
          {shownPlan.map((m) => <MeasureShape key={m.id} m={m} ringM={(region.settlements.find((x) => x.id === m.settlementId)?.radiusM ?? 750) + COSTS.araclar.yerlesim.halkaM} />)}
          {draft.length > 0 && tool && (TOOLS[tool].kind === 'area' && draft.length > 2
            ? <Polygon positions={draft} pathOptions={{ color: TOOLS[tool].color, dashArray: '5 5', weight: 2, fillOpacity: 0.15 }} />
            : <Polyline positions={draft} pathOptions={{ color: tool ? TOOLS[tool].color : '#fff', dashArray: '5 5', weight: 3 }} />)}
          {draft.map((p, i) => <CircleMarker key={i} center={p} radius={4} pathOptions={{ color: '#0a1014', weight: 1, fillColor: '#fff', fillOpacity: 1 }} />)}
          {phase === 'result' && (showOpt && optimal ? optimal.fires : fires ?? []).map((f, i) => (
            <CircleMarker key={i} center={f.ignition} radius={i === fireIdx ? 9 : 6} pathOptions={{ color: '#0a1014', weight: 2, fillColor: '#ff5a2a', fillOpacity: 1 }}>
              <Tooltip direction="top" permanent={i === fireIdx}>Yangın {i + 1}</Tooltip>
            </CircleMarker>
          ))}
        </MapStage>
      </div>

      {/* right: the plan, or the comparison */}
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-t border-line bg-bg p-3 lg:w-[330px] lg:border-l lg:border-t-0">
        {phase !== 'result' ? (
          <>
            <Panel title={`Önlem planı · ${plan.length}`} action={plan.length ? <button onClick={() => setPlan([])} className="flex items-center gap-1 text-[11px] text-muted hover:text-fire"><Trash2 size={12} /> Temizle</button> : undefined}>
              {!plan.length ? (
                <p className="text-[12.5px] text-muted">Soldan bir araç seçip haritaya yerleştirin.</p>
              ) : (
                <ul className="space-y-1.5">
                  {plan.map((m, i) => {
                    const Icon = TOOL_ICON[m.tool]
                    return (
                      <li key={m.id} className="flex items-center gap-2 text-[12.5px]">
                        <Icon size={14} style={{ color: TOOLS[m.tool].color }} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{TOOLS[m.tool].label}{m.label ? ` · ${m.label}` : ''}<span className="block text-[11px] text-muted">{costs[i].size}</span></span>
                        <b className="tabular-nums">{tlFmt(costs[i].tl)}</b>
                        <button onClick={() => setPlan((p) => p.filter((x) => x.id !== m.id))} aria-label="Önlemi sil" className="text-muted hover:text-fire"><X size={14} /></button>
                      </li>
                    )
                  })}
                </ul>
              )}
              <div className="mt-3 space-y-1 border-t border-line pt-2 text-[12.5px]">
                <div className="flex justify-between"><span className="text-muted">Toplam maliyet</span><b className={total > BUDGET_TL ? 'text-fire' : ''}>{tlFmt(total)}</b></div>
                <div className="flex justify-between"><span className="text-muted">Doğaya dokunan alan</span><b>~{nature.toFixed(1)} ha</b></div>
              </div>
            </Panel>
            <button onClick={simulate} disabled={phase === 'running'} className="flex w-full items-center justify-center gap-2 bg-fire px-3 py-2.5 text-[15px] font-semibold text-white hover:bg-fire/90 disabled:opacity-60">
              <Flame size={17} /> Planı bitir ve yangını başlat
            </button>
            <p className="text-[11px] leading-snug text-muted">Sistem bu havada en olası {sc.ignitions.length} noktadan (yoğun yakıt, yol ve köy yakınlığı) yangın başlatacak. İhbar {COSTS.ihbarDk}. dakikada gelir; gözetleme yangını görürse daha erken.</p>
          </>
        ) : verdict && fires && (
          <>
            <Panel title="Karşılaştırma" pad={false}>
              <table className="w-full text-[12.5px]">
                <thead><tr className="border-b border-line2 text-[11px] text-muted"><th /><th className="px-2 py-1.5 text-right font-medium">Önlemsiz</th><th className="px-2 py-1.5 text-right font-medium">Sizin planınız</th>{optimal && <th className="px-2 py-1.5 text-right font-medium">Optimal</th>}</tr></thead>
                <tbody>
                  {([
                    ['Yanan alan (ort.)', (v: Verdict) => `${Math.round(v.burnedWith)} ha`, `${Math.round(verdict.burnedWithout)} ha`],
                    ['Yanan orman', (v: Verdict) => `${Math.round(v.forestWith)} ha`, `${Math.round(verdict.forestWithout)} ha`],
                    ['Ulaşılan yerleşim', (v: Verdict) => v.settlementsWith.toFixed(1), verdict.settlementsWithout.toFixed(1)],
                    ['Yangın zararı', (v: Verdict) => tlFmt(v.lossWith), tlFmt(verdict.lossWithout)],
                    ['Önlem maliyeti', (v: Verdict) => tlFmt(v.planTL), '–'],
                    ['Doğaya dokunan', (v: Verdict) => `${v.natureHa.toFixed(0)} ha`, '–'],
                    ['Net kazanç', (v: Verdict) => tlFmt(v.netTL), '–'],
                    ['Puan', (v: Verdict) => `${v.score} (${v.grade})`, '–'],
                  ] as [string, (v: Verdict) => string, string][]).map(([k, f, none]) => (
                    <tr key={k} className="border-b border-line last:border-b-0">
                      <th scope="row" className="px-2 py-1.5 text-left font-normal text-muted">{k}</th>
                      <td className="px-2 text-right">{none}</td>
                      <td className="px-2 text-right font-semibold">{f(verdict)}</td>
                      {optimal && <td className="px-2 text-right font-semibold text-forest">{f(optimal.verdict)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <div className="flex flex-wrap gap-1.5">
              {fires.map((_, i) => (
                <button key={i} onClick={() => setFireIdx(i)} aria-pressed={fireIdx === i} className={`border px-2 py-1 text-[12px] ${fireIdx === i ? 'border-forest bg-forest-dim/30' : 'border-line2'}`}>Yangın {i + 1}</button>
              ))}
              {optimal && <button onClick={() => setShowOpt(!showOpt)} className="ml-auto border border-line2 px-2 py-1 text-[12px]">{showOpt ? 'Kendi planımı göster' : 'Optimal planı göster'}</button>}
            </div>
            <Panel title="Önlemleriniz">
              <ul className="space-y-1.5 text-[12.5px]">
                {plan.map((m, i) => {
                  const u = verdict.perMeasure[i]
                  return (
                    <li key={m.id} className="flex gap-2">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${u.useful ? 'bg-forest' : 'bg-fire'}`} />
                      <span><b>{TOOLS[m.tool].label}</b>{m.label ? ` · ${m.label}` : ''} ({tlFmt(costs[i].tl)}): <span className="text-muted">{u.note}</span></span>
                    </li>
                  )
                })}
                {!plan.length && <li className="text-muted">Plan boştu.</li>}
              </ul>
            </Panel>
            {!optimal ? (
              <button onClick={showOptimal} disabled={optBusy} className="flex w-full items-center justify-center gap-2 border border-forest/60 bg-forest-dim/20 px-3 py-2 text-[13px] font-semibold text-forest hover:bg-forest-dim/40 disabled:opacity-60">
                {optBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {optBusy ? 'Optimal plan hesaplanıyor…' : 'En optimal sonucu göster'}
              </button>
            ) : (
              <Panel title="Optimal plan" action={<span className={`flex items-center gap-1 text-[11px] ${optimal.source === 'ai' ? 'text-water' : 'text-muted'}`}>{optimal.source === 'ai' ? <Bot size={12} /> : <Cpu size={12} />}{optimal.source === 'ai' ? `ChatGPT${optimal.model ? ` · ${optimal.model}` : ''}` : 'Kural tabanlı'}</span>}>
                <p className="text-[12.5px] leading-snug">{optimal.summary}</p>
                <ul className="mt-2 space-y-1.5 text-[12px]">
                  {optimal.plan.map((m) => {
                    const Icon = TOOL_ICON[m.tool]
                    return (
                      <li key={m.id} className="flex gap-2">
                        <Icon size={14} style={{ color: TOOLS[m.tool].color }} className="mt-0.5 shrink-0" />
                        <span><b>{TOOLS[m.tool].label}</b>{m.settlementId ? ` · ${region.settlements.find((s) => s.id === m.settlementId)?.name}` : ''} ({tlFmt(measureCost(grid, m).tl)}): <span className="text-muted">{optimal.rationale[m.id] ?? ''}</span></span>
                      </li>
                    )
                  })}
                </ul>
                {optimal.reason && <p className="mt-2 text-[11px] text-muted">Yapay zeka yerine kurallar: {optimal.reason}</p>}
              </Panel>
            )}
            <div className="flex gap-2">
              <button onClick={() => restart(true)} className="flex flex-1 items-center justify-center gap-1.5 border border-line2 px-2 py-2 text-[12.5px] hover:text-forest"><RotateCcw size={13} /> Aynı bölgeyi tekrar dene</button>
              <button onClick={() => restart(false)} className="flex flex-1 items-center justify-center gap-1.5 border border-line2 px-2 py-2 text-[12.5px] hover:text-forest"><Flame size={13} /> Yeni sınav</button>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}

/** A placed measure on the map. */
function MeasureShape({ m, ringM }: { m: DrillMeasure; ringM: number }) {
  const T = TOOLS[m.tool]
  const tip = <Tooltip sticky>{T.label}{m.label ? ` · ${m.label}` : ''}</Tooltip>
  if (T.kind === 'line') return <Polyline positions={m.points} pathOptions={{ color: T.color, weight: Math.max(3, (m.widthM ?? 30) / 15), opacity: 0.95 }}>{tip}</Polyline>
  if (T.kind === 'area') return <Polygon positions={m.points} pathOptions={{ color: T.color, weight: 2, fillOpacity: 0.25 }}>{tip}</Polygon>
  if (T.kind === 'settlement') return <Circle center={m.points[0]} radius={ringM} pathOptions={{ color: T.color, weight: 2, dashArray: '4 4', fillOpacity: 0.12 }}>{tip}</Circle>
  const range = m.tool === 'kule' ? COSTS.araclar.kule.gorusKm : m.tool === 'kamera' ? COSTS.araclar.kamera.gorusKm : 0
  return (
    <>
      {range > 0 && <Circle center={m.points[0]} radius={range * 1000} interactive={false} pathOptions={{ color: T.color, weight: 1, opacity: 0.6, dashArray: '3 6', fill: false }} />}
      <CircleMarker center={m.points[0]} radius={8} pathOptions={{ color: '#0a1014', weight: 2, fillColor: T.color, fillOpacity: 1 }}>{tip}</CircleMarker>
    </>
  )
}
