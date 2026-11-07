import { Suspense, lazy, useMemo, useState } from 'react'
import L from 'leaflet'
import { Circle, CircleMarker, Marker, Polygon, Polyline, Popup, Tooltip } from 'react-leaflet'
import { AlertTriangle, Bot, Box, Building2, Check, Cpu, Droplets, Factory, Flame, Home, Loader2, Map as MapIcon, MapPin, PenLine, Pickaxe, Route, Shield, ShieldCheck, Siren, Sun, Thermometer, Trash2, Undo2, Wind, X } from 'lucide-react'
import { MapStage, WindArrow } from '../components/MapStage'
import { icons } from '../components/mapIcons'
import { Panel } from '../components/ui'
import { REGIONS, defaultConfig, regionById } from '../data/regions'
import { getGrid } from '../sim/gridCache'
import { cellOf } from '../sim/terrain'
import { compass, type LatLon } from '../sim/geo'
import { SECTORS, type Sector } from '../sim/types'
import { askAssetReport } from '../lib/commanderClient'
const AssetMap3D = lazy(() => import('../components/AssetMap3D').then((m) => ({ default: m.AssetMap3D })))
/** The four kinds of asset, with an icon and an example name. */
const KIND_CARDS: { kind: 'fabrika' | 'ges' | 'maden' | 'ozel'; icon: typeof Factory; example: string }[] = [
  { kind: 'fabrika', icon: Factory, example: 'ör. Merkez fabrika' },
  { kind: 'ges', icon: Sun, example: 'ör. Yamaç GES' },
  { kind: 'maden', icon: Pickaxe, example: 'ör. Kuzey ocağı' },
  { kind: 'ozel', icon: Home, example: 'ör. Yazlık ev' },
]
import {
  ASSET_KIND_LABEL,
  EFFORT_LABEL,
  LEVEL_COLOR,
  LEVEL_LABEL,
  WHEN_LABEL,
  analyseAsset,
  assetContext,
  fetchAssetWeather,
  levelOf,
  ruleAssetReport,
  type AssetKind,
  type AssetProfile,
  type AssetReport,
} from '../sim/asset'

const SECTOR_NAME: Record<Sector, string> = { K: 'Kuzey', KD: 'Kuzeydoğu', D: 'Doğu', GD: 'Güneydoğu', G: 'Güney', GB: 'Güneybatı', B: 'Batı', KB: 'Kuzeybatı' }

/** Short stable hash (FNV-1a) for the report cache. */
function hashText(t: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/** Point `m` metres from `p` towards `deg`. */
const towards = (p: LatLon, deg: number, m: number): LatLon => {
  const b = (deg * Math.PI) / 180
  return [p[0] + (m * Math.cos(b)) / 111320, p[1] + (m * Math.sin(b)) / (111320 * Math.cos((p[0] * Math.PI) / 180))]
}

export function AssetShield() {
  const [areaId, setAreaId] = useState(REGIONS[0].id)
  const region = regionById(areaId)
  const grid = getGrid(areaId)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AssetKind>('fabrika')
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const [drawing, setDrawing] = useState(false)
  const [poly, setPoly] = useState<LatLon[]>([])
  const [closed, setClosed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [profile, setProfile] = useState<AssetProfile | null>(null)
  const [report, setReport] = useState<{ r: AssetReport; source: 'ai' | 'rules'; model?: string; reason?: string } | null>(null)
  const [popup, setPopup] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const note = (t: string) => {
    setMsg(t)
    window.setTimeout(() => setMsg((m) => (m === t ? null : m)), 3500)
  }

  const reset = () => {
    setPoly([])
    setClosed(false)
    setView('2d')
    setProfile(null)
    setReport(null)
    setPopup(false)
  }
  const onMapClick = (lat: number, lon: number) => {
    if (!drawing) return
    if (cellOf(grid, lat, lon) < 0) return note('Varlığı çalışma alanının (kesikli çerçeve) içine çizin.')
    setPoly((p) => [...p, [lat, lon]])
  }
  const finish = () => {
    if (poly.length < 3) return note('Alan için en az üç köşe gerekli.')
    setDrawing(false)
    setClosed(true)
    // show the model on the drawn area right away
    setView('3d')
  }

  const analyse = async () => {
    if (!closed) return
    setReport(null)
    setPopup(false)
    setBusy('Hava tahmini alınıyor…')
    const c: LatLon = [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length]
    const days = await fetchAssetWeather(c)
    setBusy('Çevre analiz ediliyor, test yangınları çalışıyor…')
    await new Promise((r) => setTimeout(r, 20))
    const p = analyseAsset(areaId, poly, name.trim() || ASSET_KIND_LABEL[kind], kind, days)
    setProfile(p)
    setBusy('Yapay zeka risk profilini yazıyor…')
    const ctx = assetContext(p)
    const key = `fg-asset:${hashText(JSON.stringify(ctx))}`
    let out: { r: AssetReport; source: 'ai' | 'rules'; model?: string; reason?: string }
    try {
      const hit = localStorage.getItem(key)
      if (hit) out = JSON.parse(hit)
      else throw new Error('miss')
    } catch {
      try {
        const r = await askAssetReport(ctx)
        out = { r: r.output, source: 'ai', model: r.model }
        try {
          localStorage.setItem(key, JSON.stringify(out))
        } catch {
          // storage full: ask again next time
        }
      } catch (e) {
        out = { r: ruleAssetReport(p), source: 'rules', reason: (e as Error).message }
      }
    }
    setReport(out)
    setPopup(true)
    setBusy(null)
  }

  const wedges = useMemo(() => {
    if (!profile) return []
    return profile.sectors.map((s) => {
      const pts: LatLon[] = [profile.centroid]
      for (let a = -22.5; a <= 22.5; a += 4.5) pts.push(towards(profile.centroid, s.bearing + a, 2000))
      return { s, pts, color: LEVEL_COLOR[levelOf(s.score)] }
    })
  }, [profile])
  const prioritySet = new Set(report?.r.priority_sectors.map((x) => x.sector) ?? [])

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:flex-row">
      {/* left: the asset and the numbers */}
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-b border-line bg-panel p-3 lg:w-[310px] lg:border-b-0 lg:border-r">
        <div>
          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted"><Shield size={13} /> Varlık Kalkanı</div>
          <h2 className="mt-0.5 text-[16px] font-semibold">Varlığınızın yangın riski</h2>
          <p className="mt-1 text-[12px] leading-snug text-muted">Fabrikanızı, GES'inizi, maden sahanızı veya mülkünüzü haritada çizin; seçtiğiniz türün 3B modeli alana sığdırılır. Çevresindeki bitki örtüsü, eğim, hava ve ulaşım değerlendirilir; yapay zeka size özel bir önlem raporu hazırlar.</p>
        </div>
        <div className="space-y-2">
          <label className="block text-[12px] text-muted">Bölge
            <select value={areaId} onChange={(e) => { setAreaId(e.target.value); reset() }} className="mt-1 w-full border border-line2 bg-bg px-2 py-1.5 text-[13px] text-ink">
              {REGIONS.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <div>
            <div className="mb-1 text-[12px] text-muted">Varlığın türü</div>
            <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Varlığın türü">
              {KIND_CARDS.map(({ kind: k, icon: Icon }) => (
                <button key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`flex items-center gap-2 border px-2 py-2 text-left text-[12.5px] font-medium ${kind === k ? 'border-forest bg-forest/10 text-ink' : 'border-line2 text-muted hover:border-muted hover:text-ink'}`}>
                  <Icon size={16} className={kind === k ? 'text-forest' : ''} />
                  <span className="leading-tight">{ASSET_KIND_LABEL[k].replace(' (GES)', '')}</span>
                </button>
              ))}
            </div>
          </div>
          <label className="block text-[12px] text-muted">Varlığın adı
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={KIND_CARDS.find((c) => c.kind === kind)!.example} className="mt-1 w-full border border-line2 bg-bg px-2 py-1.5 text-[13px] text-ink" />
          </label>
          {!closed ? (
            <button onClick={() => { setDrawing(true); setPoly([]) }} className={`flex w-full items-center justify-center gap-2 border px-3 py-2 text-[13px] font-semibold ${drawing ? 'border-forest bg-forest-dim/30 text-forest' : 'border-line2 hover:border-forest hover:text-forest'}`}>
              <PenLine size={15} /> {drawing ? `Çiziliyor: ${poly.length} köşe` : 'Varlığı haritada çiz'}
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={analyse} disabled={!!busy} className="flex flex-1 items-center justify-center gap-2 bg-fire px-3 py-2 text-[13.5px] font-semibold text-white hover:bg-fire/90 disabled:opacity-60">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />} Riski değerlendir
              </button>
              <button onClick={reset} aria-label="Çizimi sil" className="border border-line2 px-2.5 text-muted hover:text-fire"><Trash2 size={15} /></button>
            </div>
          )}
          {busy && <p className="text-[11.5px] text-muted">{busy}</p>}
        </div>

        {profile && (
          <>
            <section className="border border-line bg-bg p-3">
              <div className="flex items-center gap-3">
                <div className="flex h-[64px] w-[64px] shrink-0 flex-col items-center justify-center rounded-full border-[5px]" style={{ borderColor: LEVEL_COLOR[report?.r.risk_level ?? profile.level] }}>
                  <span className="text-[20px] font-bold leading-none">{profile.score}</span>
                  <span className="text-[9px] text-muted">/100</span>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted">Risk düzeyi</div>
                  <div className="text-[18px] font-semibold" style={{ color: LEVEL_COLOR[report?.r.risk_level ?? profile.level] }}>{LEVEL_LABEL[report?.r.risk_level ?? profile.level]}</div>
                  <div className="text-[11px] text-muted">{profile.name} · {profile.areaHa} ha · {profile.assetElev} m</div>
                </div>
              </div>
            </section>
            <Panel title="Yönlere göre risk">
              <Rose profile={profile} highlight={prioritySet} />
            </Panel>
            <Panel title="Çevredeki bitki örtüsü">
              <div className="space-y-2">
                {profile.rings.map((r) => {
                  const tot = r.forestHa + r.shrubHa + r.openHa + r.builtHa + r.waterHa || 1
                  const seg = [
                    { v: r.forestHa, c: '#2f9e5c', l: 'orman' },
                    { v: r.shrubHa, c: '#8fc46a', l: 'maki' },
                    { v: r.openHa, c: '#c2b65e', l: 'açık' },
                    { v: r.builtHa, c: '#8a959b', l: 'yerleşim' },
                    { v: r.waterHa, c: '#3b78b5', l: 'su' },
                  ]
                  return (
                    <div key={r.label}>
                      <div className="flex justify-between text-[11.5px]"><span>{r.label} <span className="text-muted">{r.fromM}–{r.toM} m</span></span><b>{Math.round(((r.forestHa + r.shrubHa) / tot) * 100)}% bitki</b></div>
                      <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-line">{seg.map((x) => x.v > 0 && <div key={x.l} title={`${x.l} ${x.v} ha`} style={{ width: `${(x.v / tot) * 100}%`, background: x.c }} />)}</div>
                    </div>
                  )
                })}
                <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[10.5px] text-muted">
                  {[['#2f9e5c', 'Orman'], ['#8fc46a', 'Maki'], ['#c2b65e', 'Açık'], ['#8a959b', 'Yerleşim'], ['#3b78b5', 'Su']].map(([c, l]) => <span key={l} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: c }} />{l}</span>)}
                </div>
              </div>
            </Panel>
            <Panel title="Hava (7 gün)" action={<span className="text-[11px] text-muted">{profile.weather.source === 'forecast' ? 'Open-Meteo tahmini' : 'tahmin alınamadı'}</span>}>
              {profile.weather.days.length ? (
                <div className="grid grid-cols-7 gap-1 text-center text-[10.5px]">
                  {profile.weather.days.map((d) => {
                    const danger = d.tmax >= 30 && d.rhMin <= 30 && d.windMax >= 25
                    return (
                      <div key={d.date} className={`border px-0.5 py-1 ${danger ? 'border-fire/60 bg-fire/10' : 'border-line'}`} title={`${d.date}: ${Math.round(d.tmax)} °C, %${Math.round(d.rhMin)} nem, ${Math.round(d.windMax)} km/sa ${compass(d.windFrom)}`}>
                        <div className="text-muted">{new Date(d.date).toLocaleDateString('tr-TR', { weekday: 'short' })}</div>
                        <div className="font-semibold">{Math.round(d.tmax)}°</div>
                        <div className="text-muted">%{Math.round(d.rhMin)}</div>
                        <div className="mt-0.5 flex justify-center"><WindArrow fromDeg={d.windFrom} className="text-ink" /></div>
                        <div>{Math.round(d.windMax)}</div>
                      </div>
                    )
                  })}
                </div>
              ) : null}
              <p className="mt-2 text-[11px] leading-snug text-muted"><Wind size={11} className="mr-1 inline" />Tipik yangın sezonu rüzgarı {profile.weather.typicalKmh} km/sa, {compass(profile.weather.typicalFrom)} yönünden. {profile.weather.dangerDays ? <b className="text-fire">{profile.weather.dangerDays} gün 30-30-30 koşulunda.</b> : 'Önümüzdeki günlerde 30-30-30 koşulu yok.'}</p>
            </Panel>
            <Panel title="Erişim ve kaynaklar">
              <dl className="space-y-1.5 text-[12px]">
                <div className="flex justify-between gap-2"><dt className="flex items-center gap-1.5 text-muted"><Siren size={13} /> İtfaiye</dt><dd className="text-right">{profile.access.station ? <><b>~{profile.access.station.etaMin} dk</b> <span className="text-muted">{profile.access.station.name}</span></> : '–'}</dd></div>
                <div className="flex justify-between gap-2"><dt className="flex items-center gap-1.5 text-muted"><Route size={13} /> En yakın yol</dt><dd className="text-right"><b>{profile.access.roadM ?? '3000+'} m</b> <span className="text-muted">{profile.access.roadClass}</span></dd></div>
                <div className="flex justify-between gap-2"><dt className="flex items-center gap-1.5 text-muted"><Droplets size={13} /> Su kaynağı</dt><dd><b>{profile.access.waterM !== null ? `${(profile.access.waterM / 1000).toFixed(1)} km` : '–'}</b></dd></div>
                <div className="flex justify-between gap-2"><dt className="flex items-center gap-1.5 text-muted"><Flame size={13} /> 2 km içinde yanık</dt><dd><b>{profile.existing.burnScarHa ? `${profile.existing.burnScarHa} ha` : 'yok'}</b></dd></div>
              </dl>
            </Panel>
            <Panel title="Test yangınları">
              <ul className="space-y-1.5 text-[12px]">
                {profile.fireTests.map((f) => (
                  <li key={f.sector} className="flex justify-between gap-2">
                    <span>{SECTOR_NAME[f.sector]} yönünden, {f.startKm} km öteden</span>
                    <b className={f.arrivalMin !== null && f.arrivalMin <= 90 ? 'text-fire' : f.arrivalMin !== null ? 'text-amber' : 'text-forest'}>{f.arrivalMin !== null ? `${Math.floor(f.arrivalMin / 60)} sa ${f.arrivalMin % 60} dk` : '6 sa içinde ulaşmıyor'}</b>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[10.5px] leading-snug text-muted">Rüzgar yangını yapıya doğru iterken, 35 °C ve %20 nemde; müdahalesiz.</p>
            </Panel>
          </>
        )}
      </aside>

      {/* map */}
      <div className="relative min-h-[460px] min-w-0 flex-1">
        {drawing && (
          <div className="absolute bottom-12 left-1/2 z-[500] flex -translate-x-1/2 items-center gap-2 border border-line2 bg-bg/95 px-3 py-2 text-[12.5px]">
            <MapPin size={14} className="text-forest" /><span>Köşelere tıklayın: {poly.length}</span>
            <button onClick={finish} className="flex items-center gap-1 border border-forest/60 px-2 py-1 font-semibold text-forest hover:bg-forest-dim/40"><Check size={13} /> Bitir</button>
            <button onClick={() => setPoly((p) => p.slice(0, -1))} disabled={!poly.length} className="flex items-center gap-1 border border-line2 px-2 py-1 disabled:opacity-40"><Undo2 size={13} /> Geri al</button>
            <button onClick={() => { setDrawing(false); setPoly([]) }} className="flex items-center gap-1 border border-line2 px-2 py-1"><X size={13} /> Vazgeç</button>
          </div>
        )}
        {msg && <div className="absolute bottom-24 left-1/2 z-[600] -translate-x-1/2 border border-amber/60 bg-bg/95 px-3 py-1.5 text-[12.5px] text-amber">{msg}</div>}
        {closed && (
          <div className="absolute right-3 top-3 z-[700] flex gap-0.5 rounded-md border border-line bg-panel/95 p-0.5 text-[12.5px] shadow" role="radiogroup" aria-label="Harita görünümü">
            {([['2d', '2B harita', MapIcon], ['3d', '3B model', Box]] as const).map(([v, l, Icon]) => (
              <button key={v} role="radio" aria-checked={view === v} onClick={() => setView(v)} className={`flex items-center gap-1.5 rounded px-2.5 py-1 font-medium ${view === v ? 'bg-forest/15 text-ink' : 'text-muted hover:text-ink'}`}><Icon size={14} /> {l}</button>
            ))}
          </div>
        )}
        {closed && view === '3d' && (
          <div className="absolute inset-0 z-[600] bg-bg">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-[13px] text-muted"><Loader2 size={16} className="mr-2 animate-spin" /> 3B görünüm yükleniyor…</div>}>
              <AssetMap3D grid={grid} polygon={poly} kind={kind} />
            </Suspense>
            <div className="pointer-events-none absolute bottom-3 left-3 max-w-[340px] rounded-md border border-line bg-panel/92 px-3 py-2 text-[12px] leading-snug">
              <b>{ASSET_KIND_LABEL[kind]}</b> çizdiğiniz alana gerçek boyutunda yerleştirildi. Döndürmek için sağ tıkla sürükleyin; türü soldan değiştirebilirsiniz. Model temsilidir.
            </div>
          </div>
        )}
        {!poly.length && !drawing && (
          <div className="absolute left-14 top-2 z-[500] max-w-[330px] border border-line2 bg-bg/92 px-2.5 py-2 text-[12px]">
            Varlığınızı bulmak için haritayı yakınlaştırın ve <b>Uydu</b> görünümüne geçin, sonra soldan <b>Varlığı haritada çiz</b>'e basın.
          </div>
        )}
        <MapStage grid={grid} mode={profile ? 'fuel' : 'none'} opacity={0.55} fitGrid fitKey={areaId} pick={drawing} onMapClick={onMapClick} wind={profile ? { config: { ...defaultConfig(region), ignition: profile.centroid }, minutes: 0 } : null}>
          {region.settlements.map((st) => (
            <Marker key={st.id} position={st.pos} icon={icons.settlement}>
              <Tooltip direction="right" permanent offset={[8, 0]} className="fg-label">{st.name}</Tooltip>
            </Marker>
          ))}
          {wedges.map(({ s, pts, color }) => (
            <Polygon key={s.sector} positions={pts} pathOptions={{ color, weight: prioritySet.has(s.sector) ? 2 : 0.8, opacity: 0.8, fillColor: color, fillOpacity: 0.08 + (s.score / 100) * 0.25, dashArray: prioritySet.has(s.sector) ? undefined : '3 4' }}>
              <Tooltip sticky>{SECTOR_NAME[s.sector]}: {s.score}/100 · {s.fuelHa} ha orman ve maki · yokuş %{s.upslopePct} · rüzgar payı %{Math.round(s.windShare * 100)}</Tooltip>
            </Polygon>
          ))}
          {profile && [150, 500, 2000].map((r) => <Circle key={r} center={profile.centroid} radius={r} interactive={false} pathOptions={{ color: 'var(--color-ink)', weight: 1, opacity: 0.45, dashArray: '2 6', fill: false }} />)}
          {profile?.fireTests.map((f) => {
            const b = profile.sectors.find((s) => s.sector === f.sector)!.bearing
            const start = towards(profile.centroid, b, f.startKm * 1000)
            return (
              <span key={f.sector}>
                <Polyline positions={[start, profile.centroid]} pathOptions={{ color: '#ff8a3d', weight: 2, opacity: 0.8, dashArray: '6 6' }} interactive={false} />
                <CircleMarker center={start} radius={6} pathOptions={{ color: '#0a1014', weight: 2, fillColor: '#ff5a2a', fillOpacity: 1 }}>
                  <Tooltip direction="top" permanent className="fg-label">{f.arrivalMin !== null ? `${f.arrivalMin} dk` : 'ulaşmıyor'}</Tooltip>
                </CircleMarker>
              </span>
            )
          })}
          {poly.length > 0 && (closed || poly.length > 2
            ? <Polygon positions={poly} pathOptions={{ color: '#ffffff', weight: 2.5, fillColor: '#7fd1ff', fillOpacity: 0.35, dashArray: closed ? undefined : '5 5' }} />
            : <Polyline positions={poly} pathOptions={{ color: '#ffffff', weight: 2.5, dashArray: '5 5' }} />)}
          {drawing && poly.map((p, i) => <CircleMarker key={i} center={p} radius={4} pathOptions={{ color: '#0a1014', weight: 1, fillColor: '#fff', fillOpacity: 1 }} />)}
          {profile && report && popup && (
            <Popup position={profile.centroid} className="fg-popup" maxWidth={380} minWidth={320} eventHandlers={{ remove: () => setPopup(false) }}>
              <ReportCard profile={profile} report={report.r} compact />
            </Popup>
          )}
          {profile && report && !popup && (
            <Marker position={profile.centroid} icon={L.divIcon({ html: `<div class="fg-mtag fg-mtag-on" style="--c:${LEVEL_COLOR[report.r.risk_level]}"><span class="fg-mtag-badge">!</span><span class="fg-mtag-label">${LEVEL_LABEL[report.r.risk_level]} risk · raporu aç</span></div>`, className: 'fg-icon', iconSize: [0, 0], iconAnchor: [0, 0] })} eventHandlers={{ click: () => setPopup(true) }} />
          )}
        </MapStage>
      </div>

      {/* right: the report */}
      <aside className="w-full shrink-0 space-y-3 overflow-auto border-t border-line bg-bg p-3 lg:w-[360px] lg:border-l lg:border-t-0">
        {report && profile ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Risk profili ve önlem raporu</span>
              <span className={`flex items-center gap-1 text-[11px] ${report.source === 'ai' ? 'text-water' : 'text-muted'}`}>{report.source === 'ai' ? <Bot size={12} /> : <Cpu size={12} />}{report.source === 'ai' ? `ChatGPT${report.model ? ` · ${report.model}` : ''}` : 'Kural tabanlı'}</span>
            </div>
            <ReportCard profile={profile} report={report.r} />
            {report.reason && <p className="text-[11px] text-muted">Yapay zeka yerine kurallar: {report.reason}</p>}
          </>
        ) : (
          <div className="space-y-2 text-[12.5px] text-muted">
            <p className="flex items-center gap-2 font-semibold text-ink"><Building2 size={15} /> Nasıl çalışır?</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Bölgeyi seçin, varlığınızı haritada köşelerine tıklayarak çizin.</li>
              <li>"Riski değerlendir"e basın: 150 m, 500 m ve 2 km halkalarında bitki örtüsü, 8 yönde yakıt, eğim ve rüzgar, 7 günlük hava, yol, itfaiye ve su değerlendirilir; en riskli yönlerden test yangını çıkarılır.</li>
              <li>Yapay zeka risk profilini ve size özel önlemleri yazar; harita üzerinde açılır pencerede ve burada görünür.</li>
            </ol>
            <p className="text-[11px]">Analiz 110 m çözünürlüklü arazi verisine dayanır; bahçe, çit ve yapı malzemesi gibi ayrıntılar sahada incelenmelidir.</p>
          </div>
        )}
      </aside>
    </div>
  )
}

/** The report: headline, summary, priority sides, measures and what to do in a fire. */
function ReportCard({ profile, report, compact = false }: { profile: AssetProfile; report: AssetReport; compact?: boolean }) {
  const actions = compact ? report.actions.slice(0, 4) : report.actions
  return (
    <div className="space-y-3 text-[12.5px] leading-snug">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-bold uppercase text-[#0a1014]" style={{ background: LEVEL_COLOR[report.risk_level] }}>{LEVEL_LABEL[report.risk_level]}</span>
        <div className="text-[14px] font-semibold leading-snug">{report.headline}</div>
      </div>
      {!compact && <p className="text-muted">{report.summary}</p>}
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-70">Öncelikli cepheler</div>
        <ul className="space-y-1.5">
          {report.priority_sectors.map((p) => (
            <li key={p.sector} className="flex gap-2">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: LEVEL_COLOR[p.level] }} />
              <span><b>{SECTOR_NAME[p.sector]}</b>: {p.reason}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-70">Yapılması gerekenler</div>
        <ol className="space-y-1.5">
          {actions.map((a, i) => (
            <li key={i} className="flex gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-forest/60 text-[11px] font-semibold text-forest">{i + 1}</span>
              <span>
                <b>{a.title}</b>
                <span className="ml-1 text-[11px] opacity-70">· {a.where} · {WHEN_LABEL[a.when]} · {EFFORT_LABEL[a.effort]}</span>
                {!compact && <span className="block text-[11.5px] opacity-75">{a.reason}</span>}
              </span>
            </li>
          ))}
        </ol>
        {compact && report.actions.length > actions.length && <div className="mt-1 text-[11px] opacity-70">+{report.actions.length - actions.length} önlem daha sağdaki raporda.</div>}
      </div>
      {!compact && (
        <>
          <div className="border border-fire/40 bg-fire/5 p-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fire"><AlertTriangle size={13} /> Yangın anında</div>
            <ul className="list-disc space-y-1 pl-4">{report.emergency.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
          <p className="flex gap-1.5 text-[12px]"><Siren size={14} className="mt-0.5 shrink-0 text-muted" />{report.access_note}</p>
          <p className="flex gap-1.5 text-[11px] text-muted"><Thermometer size={13} className="mt-0.5 shrink-0" />{report.caveats}</p>
          <p className="text-[10.5px] text-muted">Hesaplanan puan {profile.score}/100. Veriler: ESA WorldCover, Copernicus DEM, OpenStreetMap, Open-Meteo, Sentinel-2.</p>
        </>
      )}
    </div>
  )
}

/** Risk by direction as a compass rose: wedge length = score, colour = level, priority sides outlined. */
function Rose({ profile, highlight }: { profile: AssetProfile; highlight: Set<Sector> }) {
  const S = 200
  const c = S / 2
  const R = 78
  const wedge = (k: number, r: number) => {
    const a0 = ((k * 45 - 22.5 - 90) * Math.PI) / 180
    const a1 = ((k * 45 + 22.5 - 90) * Math.PI) / 180
    return `M${c},${c} L${c + r * Math.cos(a0)},${c + r * Math.sin(a0)} A${r},${r} 0 0 1 ${c + r * Math.cos(a1)},${c + r * Math.sin(a1)} Z`
  }
  return (
    <div className="flex items-center gap-3">
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} className="shrink-0" role="img" aria-label="Yönlere göre risk">
        {[0.33, 0.66, 1].map((f) => <circle key={f} cx={c} cy={c} r={R * f} fill="none" stroke="var(--color-line2)" strokeWidth={0.8} />)}
        {profile.sectors.map((s, k) => {
          const lv = levelOf(s.score)
          return <path key={s.sector} d={wedge(k, Math.max(6, (s.score / 100) * R))} fill={LEVEL_COLOR[lv]} fillOpacity={0.75} stroke={highlight.has(s.sector) ? '#ffffff' : 'var(--color-panel)'} strokeWidth={highlight.has(s.sector) ? 2 : 1.5}><title>{SECTOR_NAME[s.sector]}: {s.score}/100</title></path>
        })}
        <circle cx={c} cy={c} r={5} fill="var(--color-ink)" />
        {SECTORS.map((s, k) => {
          const a = ((k * 45 - 90) * Math.PI) / 180
          return <text key={s} x={c + (R + 12) * Math.cos(a)} y={c + (R + 12) * Math.sin(a) + 3.5} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="var(--color-ink-soft)">{s}</text>
        })}
      </svg>
      <ul className="space-y-1 text-[11px]">
        {[...profile.sectors].sort((a, b) => b.score - a.score).slice(0, 4).map((s) => (
          <li key={s.sector} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: LEVEL_COLOR[levelOf(s.score)] }} /><b>{s.sector}</b> {s.score}</li>
        ))}
      </ul>
    </div>
  )
}
