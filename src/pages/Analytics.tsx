import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend as RLegend, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { Download, Printer, Trash2 } from 'lucide-react'
import { MapStage } from '../components/MapStage'
import { Panel, Segmented, fmtHa } from '../components/ui'
import { regionById } from '../data/regions'
import { compass, fmtDuration } from '../sim/geo'
import { buildReport, reportMarkdown } from '../sim/report'
import { useStore } from '../state/store'

const axis = { fill: '#8a9ba3', fontSize: 11 }
const tip = { background: '#0f171c', border: '1px solid #2f414b', fontSize: 12 }

export function Analytics() {
  const { scenarios, compareIds, toggleCompare, removeScenario, active, notify } = useStore()
  const chosen = scenarios.filter((s) => compareIds.includes(s.id))
  const [reportId, setReportId] = useState<string>('')
  const reportSc = scenarios.find((s) => s.id === (reportId || active.id)) ?? active
  const sections = useMemo(() => buildReport(reportSc.name, reportSc.result), [reportSc])

  const maxSteps = Math.max(1, ...chosen.map((s) => s.result.steps))
  const [mapT, setMapT] = useState(-1)
  const [mapMode, setMapMode] = useState<'diff' | 'a' | 'b'>('diff')
  const mapStep = mapT < 0 ? maxSteps : Math.min(mapT, maxSteps)

  const lineData = useMemo(
    () => Array.from({ length: maxSteps + 1 }, (_, i) => {
      const row: Record<string, number | undefined> = { h: (i * 10) / 60 }
      for (const s of chosen) row[s.id] = i <= s.result.steps ? Math.round(s.result.series[i].affectedHa) : undefined
      return row
    }),
    [chosen, maxSteps],
  )
  const finals = chosen.map((s) => ({ s, f: s.result.series[s.result.series.length - 1], c: s.result.config, peak: Math.max(...s.result.series.map((p) => p.rosMh)) }))
  const coverData = finals.map(({ s, f }) => ({ name: s.name.split(' – ')[0], pine: Math.round(f.pineHa), maquis: Math.round(f.maquisHa), sparse: Math.round(f.sparseHa) }))

  const [A, B] = chosen
  const sameArea = A && B && A.result.config.areaId === B.result.config.areaId
  const areaRegion = regionById((A ?? active).result.config.areaId)

  const download = () => {
    const blob = new Blob([reportMarkdown(reportSc.name, reportSc.result)], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `forestguard-rapor-${reportSc.id}.md`
    a.click()
    URL.revokeObjectURL(a.href)
    notify('Rapor Markdown olarak indirildi.')
  }

  const row = (label: string, fn: (x: (typeof finals)[number]) => string) => (
    <tr key={label} className="border-b border-line last:border-b-0">
      <th scope="row" className="py-1.5 pr-3 text-left text-[13px] font-normal text-muted">{label}</th>
      {finals.map((x) => <td key={x.s.id} className="px-2 py-1.5 text-right text-[13px] font-semibold">{fn(x)}</td>)}
    </tr>
  )

  return (
    <div className="mx-auto max-w-[1500px] space-y-3 p-3">
      <Panel title="Karşılaştırılacak senaryolar" action={<span className="text-[12px] text-muted">En fazla dört tane seçin. Yenilerini Simülasyon Stüdyosunda çalıştırın.</span>}>
        <div className="flex flex-wrap gap-2">
          {scenarios.map((s) => {
            const on = compareIds.includes(s.id)
            return (
              <span key={s.id} className={`inline-flex items-center border text-[13px] ${on ? 'border-line2 bg-panel2' : 'border-line text-muted'}`}>
                <button onClick={() => toggleCompare(s.id)} aria-pressed={on} className="flex items-center gap-2 px-2.5 py-1.5 hover:text-ink">
                  <span className="h-2.5 w-2.5" style={{ background: on ? s.color : 'transparent', border: `2px solid ${s.color}` }} />
                  {s.name}
                </button>
                {!s.preset && <button onClick={() => removeScenario(s.id)} aria-label={`${s.name} senaryosunu kaldır`} className="border-l border-line px-1.5 py-1.5 text-muted hover:text-fire"><Trash2 size={13} /></button>}
              </span>
            )
          })}
        </div>
      </Panel>

      {chosen.length === 0 ? (
        <Panel><p className="text-[13px] text-muted">Grafikleri ve karşılaştırmaları görmek için yukarıdan en az bir senaryo seçin.</p></Panel>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Zamana göre tahmini etkilenen alan (hektar)">
              <div className="h-[290px]">
                <ResponsiveContainer>
                  <LineChart data={lineData} margin={{ top: 8, right: 16, left: -6, bottom: 0 }}>
                    <CartesianGrid stroke="#233139" vertical={false} />
                    <XAxis dataKey="h" type="number" domain={[0, maxSteps / 6]} tick={axis} tickFormatter={(v) => `${v}sa`} stroke="#2f414b" />
                    <YAxis tick={axis} stroke="#2f414b" width={52} tickFormatter={(v) => `${v.toLocaleString('en-US')}`} label={{ value: 'hektar', angle: -90, position: 'insideLeft', fill: '#8a9ba3', fontSize: 11, dx: 14 }} />
                    <RTooltip contentStyle={tip} labelFormatter={(v) => `T+${Number(v).toFixed(1)} sa`} formatter={(v, k) => [`${Number(v).toLocaleString('en-US')} ha`, scenarios.find((s) => s.id === k)?.name ?? String(k)]} />
                    <RLegend formatter={(v) => <span style={{ color: '#c8d3cd', fontSize: 12 }}>{scenarios.find((s) => s.id === v)?.name}</span>} />
                    {chosen.map((s) => <Line key={s.id} dataKey={s.id} stroke={s.color} strokeWidth={2} dot={false} isAnimationActive={false} activeDot={{ r: 4, stroke: '#0f171c', strokeWidth: 2 }} />)}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <Panel title="Senaryo karşılaştırması">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px]">
                  <thead>
                    <tr className="border-b border-line2">
                      <th />
                      {finals.map((x) => <th key={x.s.id} className="px-2 pb-1.5 text-right text-[12px] font-semibold"><span className="mr-1.5 inline-block h-2.5 w-2.5" style={{ background: x.s.color }} />{x.s.name.split(' – ')[0]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {row('Rüzgar', (x) => `${x.c.windSpeedKmh} km/sa ${compass(x.c.windFromDeg)}`)}
                    {row('Nem', (x) => `%${x.c.humidityPct}`)}
                    {row('Sıcaklık', (x) => `${x.c.temperatureC} °C`)}
                    {row('Etkilenen alan', (x) => `${fmtHa(x.f.affectedHa)} ha`)}
                    {row('Etkilenen orman', (x) => `${fmtHa(x.f.forestHa)} ha`)}
                    {row('Çevre uzunluğu', (x) => `${x.f.perimeterKm.toFixed(1)} km`)}
                    {row('En yüksek cephe hızı', (x) => `${Math.round(x.peak).toLocaleString('en-US')} m/sa`)}
                    {row('En uzak nokta', (x) => `${x.f.maxRadiusKm.toFixed(1)} km`)}
                    {row('Ulaşılan yerleşimler', (x) => `${x.s.result.impacts.filter((i) => i.arrivalMin !== null).length} / ${x.s.result.impacts.length}`)}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Etkilenen orman örtüsü">
              <div className="h-[250px]">
                <ResponsiveContainer>
                  <BarChart data={coverData} margin={{ top: 8, right: 16, left: -6, bottom: 0 }} barCategoryGap="28%">
                    <CartesianGrid stroke="#233139" vertical={false} />
                    <XAxis dataKey="name" tick={axis} stroke="#2f414b" />
                    <YAxis tick={axis} stroke="#2f414b" width={52} />
                    <RTooltip contentStyle={tip} cursor={{ fill: 'rgba(255,255,255,.04)' }} formatter={(v, k) => [`${Number(v).toLocaleString('en-US')} ha`, String(k)]} />
                    <RLegend formatter={(v) => <span style={{ color: '#c8d3cd', fontSize: 12 }}>{v}</span>} />
                    <Bar dataKey="pine" name="Çam ormanı" stackId="a" fill="#2f9e5c" stroke="#0f171c" strokeWidth={2} isAnimationActive={false} />
                    <Bar dataKey="maquis" name="Maki çalılığı" stackId="a" fill="#8fc46a" stroke="#0f171c" strokeWidth={2} isAnimationActive={false} />
                    <Bar dataKey="sparse" name="Seyrek ve diğer" stackId="a" fill="#b8ad5a" stroke="#0f171c" strokeWidth={2} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <Panel title="Potansiyel etkilenen yerleşimler" action={<span className="text-[12px] text-muted">Yangının yerleşim sınırına ulaşma zamanı</span>}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px]">
                  <thead>
                    <tr className="border-b border-line2">
                      <th className="pb-1.5 text-left text-[12px] font-semibold">Yerleşim</th>
                      {finals.map((x) => <th key={x.s.id} className="px-2 pb-1.5 text-right text-[12px] font-semibold"><span className="mr-1.5 inline-block h-2.5 w-2.5" style={{ background: x.s.color }} />{x.s.name.split(' – ')[0]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {areaRegion.settlements.map((st, i) => (
                      <tr key={st.id} className="border-b border-line last:border-b-0">
                        <th scope="row" className="py-1.5 pr-3 text-left text-[13px] font-normal">{st.name} <span className="text-[11px] text-muted">{st.population.toLocaleString('en-US')}</span></th>
                        {finals.map((x) => {
                          if (x.c.areaId !== areaRegion.id) return <td key={x.s.id} className="px-2 text-right text-[12px] text-muted">farklı alan</td>
                          const a = x.s.result.impacts[i].arrivalMin
                          return <td key={x.s.id} className={`px-2 py-1.5 text-right text-[13px] ${a === null ? 'text-forest' : a < 360 ? 'font-semibold text-fire' : 'font-semibold text-amber'}`}>{a === null ? 'Ulaşılmadı' : `T+${fmtDuration(a)}`}</td>
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <Panel
            title="Haritada yayılım karşılaştırması"
            action={
              <Segmented<'diff' | 'a' | 'b'> label="Harita senaryosu" value={mapMode} onChange={setMapMode} options={[{ value: 'a', label: A ? A.name.split(' – ')[0] : 'Birinci' }, { value: 'b', label: B ? B.name.split(' – ')[0] : 'İkinci' }, { value: 'diff', label: 'Bindirme' }]} />
            }
            pad={false}
          >
            {!A || !B || !sameArea ? (
              <p className="p-3 text-[13px] text-muted">Haritada karşılaştırmak için aynı orman alanından iki senaryo seçin.</p>
            ) : (
              <div className="grid lg:grid-cols-[1fr_260px]">
                <div className="h-[430px]">
                  <MapStage
                    grid={A.result.grid}
                    result={mapMode === 'b' ? B.result : A.result}
                    resultB={mapMode === 'diff' ? B.result : null}
                    step={mapStep}
                    mode={mapMode === 'diff' ? 'diff' : 'fire'}
                    fitGrid
                    fitKey={`${A.id}${B.id}`}
                    hud
                  />
                </div>
                <div className="space-y-3 border-t border-line p-3 lg:border-l lg:border-t-0">
                  <div>
                    <div className="mb-1 flex justify-between text-[12px] text-muted"><span>Zaman</span><span className="font-semibold text-ink">T+{fmtDuration(mapStep * 10)}</span></div>
                    <input type="range" min={0} max={maxSteps} value={mapStep} onChange={(e) => setMapT(Number(e.target.value))} style={{ ['--p' as string]: `${(mapStep / maxSteps) * 100}%` }} aria-label="Karşılaştırma zamanı" />
                  </div>
                  {mapMode === 'diff' ? (
                    <ul className="space-y-1.5 text-[12.5px]">
                      <li className="flex items-center gap-2"><span className="h-3 w-4" style={{ background: 'rgba(57,135,229,.8)' }} /> Yalnızca {A.name.split(' – ')[0]} senaryosunda yanan</li>
                      <li className="flex items-center gap-2"><span className="h-3 w-4" style={{ background: 'rgba(217,89,38,.85)' }} /> Yalnızca {B.name.split(' – ')[0]} senaryosunda yanan</li>
                      <li className="flex items-center gap-2"><span className="h-3 w-4" style={{ background: 'rgba(235,235,225,.55)' }} /> Her ikisinde de yanan</li>
                    </ul>
                  ) : <p className="text-[12.5px] text-muted">Tek bir senaryonun yangın durumu gösteriliyor. İkisinin nerede farklılaştığını görmek için Bindirme'ye geçin.</p>}
                  <div className="border-t border-line pt-2 text-[12.5px]">
                    {[A, B].map((s) => (
                      <div key={s.id} className="flex justify-between py-0.5"><span><span className="mr-1.5 inline-block h-2.5 w-2.5" style={{ background: s.color }} />{s.name.split(' – ')[0]}</span><b>{fmtHa(s.result.series[Math.min(mapStep, s.result.steps)].affectedHa)} ha</b></div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Panel>
        </>
      )}

      <Panel
        title="Rapor özeti"
        action={
          <div className="flex items-center gap-2">
            <select aria-label="Rapor senaryosu" value={reportSc.id} onChange={(e) => setReportId(e.target.value)} className="max-w-[240px] border border-line2 bg-bg px-2 py-1 text-[12px]">
              {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button onClick={download} className="flex items-center gap-1.5 border border-line2 px-2 py-1 text-[12px] hover:text-forest"><Download size={13} /> İndir</button>
            <button onClick={() => window.print()} className="flex items-center gap-1.5 border border-line2 px-2 py-1 text-[12px] hover:text-forest"><Printer size={13} /> Yazdır</button>
          </div>
        }
      >
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
          {sections.map((s) => (
            <section key={s.title}>
              <h4 className="mb-1.5 border-b border-line pb-1 text-[13px] font-semibold text-forest">{s.title}</h4>
              <ul className="list-disc space-y-1.5 pl-4 text-[13px] leading-snug">
                {s.lines.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </section>
          ))}
        </div>
      </Panel>
    </div>
  )
}
