import { useEffect, useRef, useState, type ReactNode } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapContainer, Pane, Rectangle, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { ChevronDown, Focus, Layers, ListFilter } from 'lucide-react'
import type { Grid, ResponseRecord, SimConfig, SimResult } from '../sim/types'
import { WindParticleLayer } from './WindParticleLayer'
import { speciesById } from '../data/vegetation'
import { SmokeLayer } from './SmokeLayer'
import { ResponseLayer } from './ResponseLayer'
import { aqiOf, computeSmoke, pmAt } from '../sim/smoke'
import { weatherAt } from '../sim/weather'
import { FireCanvasLayer, type CellInfo, type FireMode } from './FireCanvasLayer'
import { FireFxLayer } from './FireFxLayer'
import { useTheme } from '../state/theme'
import { gridBounds } from '../sim/terrain'
import { compass } from '../sim/geo'

// MapTiler when configured; standard OSM tiles otherwise (no API key required).
const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY as string | undefined
const BASEMAPS = {
  dark: MAPTILER_KEY
    ? {
        label: 'Koyu',
        url: `https://api.maptiler.com/maps/dataviz-dark/256/{z}/{x}/{y}{r}.png?key=${MAPTILER_KEY}`,
        attr: '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
      }
    : {
        label: 'Koyu',
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
  light: MAPTILER_KEY
    ? {
        label: 'Harita',
        url: `https://api.maptiler.com/maps/dataviz/256/{z}/{x}/{y}{r}.png?key=${MAPTILER_KEY}`,
        attr: '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
      }
    : {
        label: 'Harita',
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
  satellite: {
    label: 'Uydu',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  },
}

const KIND_LABEL = ['Su', 'Yerleşim', 'Seyrek / tarım', 'Maki çalılığı', 'Çam ormanı']

function FitTo({ bounds, center, zoom, fitKey }: { bounds?: L.LatLngBoundsExpression; center?: [number, number]; zoom?: number; fitKey: string }) {
  const map = useMap()
  const latestBounds = useRef(bounds)
  latestBounds.current = bounds
  // whether the current fitKey has been fitted yet (a zero-size container defers the first fit to a resize)
  const fitted = useRef(false)
  useEffect(() => {
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        map.invalidateSize({ pan: false })
        // refit only if the first fit never happened: panels changing size must not reset the user's zoom
        const size = map.getSize()
        if (!fitted.current && latestBounds.current && size.x > 0 && size.y > 0) {
          map.fitBounds(latestBounds.current, { padding: [24, 24], animate: false })
          fitted.current = true
        }
      })
    })
    observer.observe(map.getContainer())
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [map])
  useEffect(() => {
    fitted.current = false
    map.invalidateSize()
    // A hidden or zero-size container makes Leaflet compute NaN coordinates and throw; skip until it has a size.
    const size = map.getSize()
    if (size.x === 0 || size.y === 0) return
    fitted.current = true
    if (bounds) map.fitBounds(bounds, { padding: [24, 24], animate: true })
    else if (center) map.flyTo(center, zoom ?? 7, { duration: 0.8 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map])
  return null
}

function Clicks({ onClick, pick }: { onClick?: (lat: number, lon: number) => void; pick: boolean }) {
  const map = useMap()
  useEffect(() => {
    map.getContainer().classList.toggle('fg-pick', pick)
  }, [map, pick])
  useMapEvents({ click: (e) => onClick?.(e.latlng.lat, e.latlng.lng) })
  return null
}

function FireLayerBridge(props: { grid: Grid | null; result: SimResult | null; resultB: SimResult | null; step: number; mode: FireMode; perimeter: boolean; opacity?: number; clockRef?: { current: number }; zoneColors?: (string | null)[] | null; zoneHover?: number | null; onHover: (c: CellInfo | null) => void }) {
  const map = useMap()
  const layer = useRef<FireCanvasLayer | null>(null)
  useEffect(() => {
    const l = new FireCanvasLayer()
    l.addTo(map)
    layer.current = l
    return () => {
      l.remove()
      layer.current = null
    }
  }, [map])
  // glow and sparks over the burning cells (fire view only)
  const fx = useRef<FireFxLayer | null>(null)
  useEffect(() => {
    const l = new FireFxLayer()
    l.addTo(map)
    fx.current = l
    return () => {
      l.remove()
      fx.current = null
    }
  }, [map])
  const propsRef = useRef(props)
  propsRef.current = props
  useEffect(() => {
    const live = props.mode === 'fire' && !props.zoneColors ? props.result : null
    fx.current?.update(props.grid, live, () => {
      const q = propsRef.current
      return q.clockRef ? q.clockRef.current / 10 : q.step
    })
  })
  const { onHover } = props
  useMapEvents({
    mousemove: (e) => onHover(layer.current?.cellAt(e.latlng) ?? null),
    mouseout: () => onHover(null),
  })
  const stepNow = () => (props.clockRef ? props.clockRef.current / 10 : props.step)
  const draw = (step: number) => layer.current?.update({ grid: props.grid, result: props.result, resultB: props.resultB, step, mode: props.mode, perimeter: props.perimeter, opacity: props.opacity, zoneColors: props.zoneColors, zoneHover: props.zoneHover })
  useEffect(() => {
    draw(stepNow())
  })
  // with a playback clock, redraw ~30 times a second while it moves so the fire grows smoothly
  const drawRef = useRef(draw)
  drawRef.current = draw
  const { clockRef } = props
  useEffect(() => {
    if (!clockRef) return
    let raf = 0
    let last = -1
    let lastDraw = 0
    const loop = (now: number) => {
      const s = clockRef.current / 10
      if (s !== last && now - lastDraw > 33) {
        last = s
        lastDraw = now
        drawRef.current(s)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [clockRef])
  return null
}

function WindLayerBridge({ grid, wind }: { grid: Grid; wind: { config: SimConfig; minutes: number } }) {
  const map = useMap()
  const layer = useRef<WindParticleLayer | null>(null)
  useEffect(() => {
    const l = new WindParticleLayer()
    l.addTo(map)
    layer.current = l
    return () => {
      l.remove()
      layer.current = null
    }
  }, [map])
  useEffect(() => {
    layer.current?.setField(grid, wind.config, wind.minutes)
  })
  return null
}

function SmokeLayerBridge({ smoke }: { smoke: { result: SimResult; step: number } }) {
  const map = useMap()
  const layer = useRef<SmokeLayer | null>(null)
  useEffect(() => {
    const l = new SmokeLayer()
    l.addTo(map)
    layer.current = l
    return () => {
      l.remove()
      layer.current = null
    }
  }, [map])
  useEffect(() => {
    const res = smoke.result
    const w = weatherAt(res.config, smoke.step * res.stepMin)
    const to = ((w.windFromDeg + 180) * Math.PI) / 180
    layer.current?.setState(computeSmoke(res), smoke.step, [w.windSpeedKmh * Math.sin(to), w.windSpeedKmh * Math.cos(to)])
  })
  return null
}

function ResponseLayerBridge({ grid, response }: { grid: Grid; response: { record: ResponseRecord; step: number } }) {
  const map = useMap()
  const layer = useRef<ResponseLayer | null>(null)
  useEffect(() => {
    const l = new ResponseLayer()
    l.addTo(map)
    layer.current = l
    return () => {
      l.remove()
      layer.current = null
    }
  }, [map])
  useEffect(() => {
    layer.current?.setState(grid, response.record, response.step)
  })
  return null
}

export interface MapStageProps {
  grid?: Grid | null
  result?: SimResult | null
  resultB?: SimResult | null
  step?: number
  mode?: FireMode
  perimeter?: boolean
  opacity?: number
  center?: [number, number]
  zoom?: number
  fitGrid?: boolean
  fitKey: string
  pick?: boolean
  onMapClick?: (lat: number, lon: number) => void
  legend?: ReactNode
  controls?: ReactNode
  hud?: boolean
  /** Post-fire strategy colours per sector, painted on the burned area. */
  zoneColors?: (string | null)[] | null
  zoneHover?: number | null
  /** Called with the cell under the cursor (or null). */
  onHoverCell?: (c: CellInfo | null) => void
  /** Continuous playback time in minutes; when given, the fire layer animates smoothly between steps. */
  clockRef?: { current: number }
  /** Safety lines, water drops and evacuation routes of a response run at a step. */
  response?: { record: ResponseRecord; step: number } | null
  /** Animated smoke of this result at this step. */
  smoke?: { result: SimResult; step: number } | null
  /** Animated wind streaks for this scenario at this minute of the run. */
  wind?: { config: SimConfig; minutes: number } | null
  compact?: boolean
  children?: ReactNode
  className?: string
  minZoom?: number
}

export function MapStage(p: MapStageProps) {
  // the street map follows the app theme; satellite stays satellite
  const [theme] = useTheme()
  const [pickedBase, setBase] = useState<'map' | 'satellite'>('map')
  const [resetView, setResetView] = useState(0)
  const base: keyof typeof BASEMAPS = pickedBase === 'satellite' ? 'satellite' : theme === 'light' ? 'light' : 'dark'
  const [hover, setHover] = useState<CellInfo | null>(null)
  const grid = p.grid ?? null
  useEffect(() => setHover(null), [grid, p.result, p.mode])
  const bounds = grid && p.fitGrid ? gridBounds(grid) : undefined
  return (
    <div className={`fg-map-stage relative h-full w-full ${p.className ?? ''}`}>
      <MapContainer center={p.center ?? [38.5, 32]} zoom={p.zoom ?? 6} minZoom={p.minZoom ?? 5} zoomControl={!p.compact} className="h-full w-full" preferCanvas>
        <TileLayer key={base} className={!MAPTILER_KEY && base !== 'satellite' ? 'fg-osm-tiles' : undefined} url={BASEMAPS[base].url} attribution={`${BASEMAPS[base].attr} · Arazi örtüsü &copy; ESA WorldCover (CC BY 4.0) · Yükselti &copy; Copernicus DEM · Yollar ve yerleşimler &copy; OpenStreetMap (ODbL) · Hava &copy; Open-Meteo (CC BY 4.0)`} maxZoom={17} />
        <FitTo bounds={bounds} center={p.center} zoom={p.zoom} fitKey={`${p.fitKey}-${resetView}`} />
        <Clicks onClick={p.onMapClick} pick={!!p.pick} />
        {bounds && <Pane name="study-boundary" style={{ zIndex: 470, pointerEvents: 'none' }}>
          <Rectangle bounds={bounds} interactive={false} pathOptions={{ color: theme === 'light' ? '#ffffff' : '#0b151b', weight: 5, opacity: 0.8, fill: false }} />
          <Rectangle bounds={bounds} interactive={false} pathOptions={{ className: 'fg-study-boundary', color: theme === 'light' ? '#2e4851' : '#e0e9ed', weight: 2.2, opacity: 0.92, dashArray: '10 6', fill: false }} />
        </Pane>}
        {grid && (
          <FireLayerBridge
            grid={grid}
            result={p.result ?? null}
            resultB={p.resultB ?? null}
            step={p.step ?? 0}
            mode={p.mode ?? 'none'}
            perimeter={p.perimeter ?? true}
            opacity={p.opacity}
            clockRef={p.clockRef}
            zoneColors={p.zoneColors}
            zoneHover={p.zoneHover}
            onHover={(c) => {
              setHover(c)
              p.onHoverCell?.(c)
            }}
          />
        )}
        {grid && p.response && <ResponseLayerBridge grid={grid} response={p.response} />}
        {p.smoke && <SmokeLayerBridge smoke={p.smoke} />}
        {grid && p.wind && <WindLayerBridge grid={grid} wind={p.wind} />}
        {p.children}
      </MapContainer>

      <div className="fg-map-controls pointer-events-none absolute right-3 top-3 z-[500] flex flex-col items-end gap-2">
        <div className="fg-basemap-switch pointer-events-auto flex">
          <span className="flex items-center px-1.5 text-muted"><Layers size={13} /></span>
          {([['map', theme === 'light' ? 'Harita' : 'Koyu'], ['satellite', 'Uydu']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setBase(k)} aria-pressed={pickedBase === k} className={`px-2 py-1 font-medium ${pickedBase === k ? 'bg-forest-dim text-ink' : 'text-muted hover:text-ink'}`}>
              {label}
            </button>
          ))}
          <button onClick={() => setResetView((value) => value + 1)} aria-label="Çalışma alanını ortala" title="Çalışma alanını ortala" className="ml-1 border-l border-line text-muted hover:text-ink"><Focus size={13} /></button>
        </div>
        {p.controls && <div className="pointer-events-auto">{p.controls}</div>}
      </div>

      {p.legend && <details className="fg-map-legend"><summary><ListFilter size={13} /> Lejant <ChevronDown size={11} /></summary><div>{p.legend}</div></details>}

      {p.hud && grid && (
        <div className="fg-map-hud">
          {hover ? (
            <>
              <div className="font-semibold">{KIND_LABEL[hover.kind]}</div>
              {hover.species > 0 && <div className="text-forest">{speciesById(hover.species).name} <span className="text-muted">(tahmini)</span></div>}
              <div className="text-muted">
                {hover.lat.toFixed(4)}°K, {hover.lon.toFixed(4)}°D
              </div>
              {hover.kind !== 0 && (
                <div className="text-muted">
                  Rakım {Math.round(hover.elev)} m · yakıt {Math.round(hover.veg * 100)}%
                </div>
              )}
              {p.smoke && (() => {
                const pm = pmAt(computeSmoke(p.smoke.result), p.smoke.step, hover.lat, hover.lon)
                return pm >= 1 ? <div style={{ color: aqiOf(pm).color }}>PM2.5 {Math.round(pm)} µg/m³ · {aqiOf(pm).name}</div> : null
              })()}
              {hover.igniteMin !== null && <div className="text-amber">Yanma başlangıcı: T+{Math.floor(hover.igniteMin / 60)}sa {String(hover.igniteMin % 60).padStart(2, '0')}dk</div>}
            </>
          ) : (
            <div className="text-muted">Hücre ayrıntıları için haritada gezinin</div>
          )}
        </div>
      )}
    </div>
  )
}

export function WindArrow({ fromDeg, className = '' }: { fromDeg: number; className?: string }) {
  // arrow points the way the wind blows (to = from + 180)
  return (
    <svg viewBox="-12 -12 24 24" className={className} width="22" height="22" aria-label={`${compass(fromDeg)} yönünden esen rüzgar`}>
      <g transform={`rotate(${fromDeg + 180})`}>
        <path d="M0 -9 L5 3 L0 0.5 L-5 3 Z" fill="currentColor" />
        <path d="M0 0.5 V9" stroke="currentColor" strokeWidth="2" />
      </g>
    </svg>
  )
}
