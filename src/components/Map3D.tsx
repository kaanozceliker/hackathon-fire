import { useEffect, useRef } from 'react'
import * as maptilersdk from '@maptiler/sdk'
import '@maptiler/sdk/dist/maptiler-sdk.css'
import { gridBounds } from '../sim/terrain'
import { lineColor } from './ResponseLayer'
import { TreeLayer } from './TreeLayer'
import { ResponseLayer3D } from './ResponseLayer3D'
import type { Grid, ResponseRecord, Settlement, SimResult } from '../sim/types'

/**
 * 3D view on MapTiler (Satellite Hybrid style with terrain). The fire, burned area and safety lines are painted
 * into a texture laid over the terrain; 3D trees dry, burn and char with it; the resources are 3D models moving
 * along their routes from the playback clock, with their water drops and sprays; buildings stand as 3D blocks
 * that show the fire reaching them.
 * Needs VITE_MAPTILER_KEY in .env (a public, browser-side key: restrict it to your domains in MapTiler Cloud).
 */

const KEY = import.meta.env.VITE_MAPTILER_KEY as string | undefined
const SCALE = 4 // texture pixels per grid cell
const RAMP = ['#fff2a8', '#ffd24a', '#ffa530', '#f77a25', '#e5502a', '#c93426', '#a52a22'].map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)])
const hexRgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

export interface Map3DProps {
  grid: Grid
  result: SimResult | null
  rec: ResponseRecord | null
  /** Playback time in minutes (continuous). */
  clockRef: { current: number }
  settlements: Settlement[]
  ignition: [number, number]
}

export function Map3D(props: Map3DProps) {
  const el = useRef<HTMLDivElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const { grid } = props

  useEffect(() => {
    if (!KEY || !el.current) return
    maptilersdk.config.apiKey = KEY
    const [[s, w], [n, e]] = gridBounds(grid)
    const map = new maptilersdk.Map({
      container: el.current,
      style: maptilersdk.MapStyle.HYBRID,
      center: [(w + e) / 2, (s + n) / 2],
      zoom: 12,
      pitch: 62,
      bearing: -20,
      terrain: true,
      terrainExaggeration: 1.4,
      // high-DPI screens draw 4× the pixels: cap it, the 3D view stays sharp enough
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
    })
    const { cols, rows } = grid
    const field = document.createElement('canvas')
    field.width = cols
    field.height = rows
    const tex = document.createElement('canvas')
    tex.width = cols * SCALE
    tex.height = rows * SCALE
    const fctx = field.getContext('2d')!
    const tctx = tex.getContext('2d')!

    const paint = (step: number) => {
      const { result, rec } = propsRef.current
      const img = fctx.createImageData(cols, rows)
      const px = img.data
      const put = (i: number, r: number, g: number, b: number, a: number) => {
        px[i * 4] = r
        px[i * 4 + 1] = g
        px[i * 4 + 2] = b
        px[i * 4 + 3] = a
      }
      if (result)
        for (let i = 0; i < cols * rows; i++) {
          const t = result.ignitionStep[i]
          if (t < 0) continue
          // just ahead of the front: dried, browned ground
          if (t > step) {
            if (t - step <= 3) put(i, 128, 98, 52, Math.round(120 * (1 - (t - step) / 3.5)))
            continue
          }
          const f = Math.min(1, step - (t - 1))
          const end = result.burnoutStep[i]
          // burned: charcoal ground (the 3D trees show the black stems on it)
          if (step >= end) put(i, 34, 30, 28, Math.round(225 * f))
          else {
            // burning: dark ground with an ember glow that fades as the cell burns out
            const k = Math.max(0, step - t) / Math.max(1, end - t)
            const c = RAMP[Math.min(RAMP.length - 1, 2 + Math.floor(k * (RAMP.length - 2)))]
            const e = 0.6 * (1 - k)
            put(i, Math.round(40 * (1 - e) + c[0] * e), Math.round(30 * (1 - e) + c[1] * e * 0.8), Math.round(26 * (1 - e) + c[2] * e * 0.5), Math.round(230 * f))
          }
        }
      if (rec)
        for (const line of rec.lines) {
          if (line.createdStep > step) continue
          const [r, g, b] = hexRgb(lineColor(line.level))
          line.cells.forEach((c, k) => {
            if (px[c * 4 + 3] > 0) return
            const br = line.breachedStep[line.sectorOf[k]]
            const built = line.builtStep[k] >= 0 && line.builtStep[k] <= step
            if (br !== null && br <= step) put(c, 255, 90, 78, built ? 230 : 120)
            else put(c, r, g, b, built ? 240 : 90)
          })
        }
      fctx.putImageData(img, 0, 0)
      tctx.clearRect(0, 0, tex.width, tex.height)
      tctx.imageSmoothingEnabled = true
      tctx.filter = 'blur(1.5px)'
      tctx.drawImage(field, 0, 0, tex.width, tex.height)
      tctx.filter = 'none'
      const src = map.getSource('fg-fire') as maptilersdk.CanvasSource | undefined
      if (src) {
        src.play()
        src.pause()
        map.triggerRepaint()
      }
    }
    paint(propsRef.current.clockRef.current / 10)

    map.on('load', () => {
      // not animated: the texture is uploaded only when the fire changes (paint), so a still map is not redrawn every frame
      map.addSource('fg-fire', { type: 'canvas', canvas: tex, coordinates: [[w, n], [e, n], [e, s], [w, s]], animate: false })
      map.addLayer({ id: 'fg-fire', type: 'raster', source: 'fg-fire', paint: { 'raster-opacity': 0.95, 'raster-fade-duration': 0 } })
      paint(propsRef.current.clockRef.current / 10)
      map.fitBounds([[w, s], [e, n]], { padding: 40, pitch: 62, bearing: -20, duration: 0 })

      // 3D buildings from MapTiler's vector tiles (OpenStreetMap footprints and heights): grey blocks that turn blue
      // under the cursor, glow orange while the fire is on them and go dark once it has passed
      // 3D trees on the forest and maquis cells (zoomed in)
      map.addLayer(new TreeLayer(grid, () => ({ result: propsRef.current.result, step: propsRef.current.clockRef.current / 10 })))
      // engines, dozers, helicopters and planes as 3D models, with drops, scooping, hose streams and dust
      map.addLayer(new ResponseLayer3D(grid, () => ({ rec: propsRef.current.rec, step: propsRef.current.clockRef.current / 10 })))
      map.addSource('fg-buildings', { type: 'vector', url: `https://api.maptiler.com/tiles/v3/tiles.json?key=${KEY}` })
      map.addLayer({
        id: 'fg-buildings',
        type: 'fill-extrusion',
        source: 'fg-buildings',
        'source-layer': 'building',
        minzoom: 13,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': [
            'case',
            ['boolean', ['feature-state', 'hover'], false], '#1e90ff',
            ['boolean', ['feature-state', 'fire'], false], '#ff7a2b',
            ['boolean', ['feature-state', 'burned'], false], '#3b2b27',
            '#d6d4cf',
          ],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, ['coalesce', ['get', 'render_height'], 6]],
          'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, ['coalesce', ['get', 'render_min_height'], 0]],
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': true,
        },
      })
      let hovered: string | number | null = null
      const setHover = (id: string | number | null) => {
        if (hovered !== null) map.setFeatureState({ source: 'fg-buildings', sourceLayer: 'building', id: hovered }, { hover: false })
        hovered = id
        if (id !== null) map.setFeatureState({ source: 'fg-buildings', sourceLayer: 'building', id }, { hover: true })
      }
      map.on('mousemove', 'fg-buildings', (ev) => {
        const f = ev.features?.[0]
        map.getCanvas().style.cursor = 'pointer'
        setHover(f?.id ?? null)
      })
      map.on('mouseleave', 'fg-buildings', () => {
        map.getCanvas().style.cursor = ''
        setHover(null)
      })
      // a building's card: its height and when the fire reaches it in this run
      map.on('click', 'fg-buildings', (ev) => {
        const f = ev.features?.[0]
        if (!f) return
        const h = Math.round(Number(f.properties?.render_height ?? 0))
        const { result } = propsRef.current
        const c = cellOfLL(ev.lngLat.lat, ev.lngLat.lng)
        const t = result && c >= 0 ? result.ignitionStep[c] : -1
        const fire = !result ? 'Simülasyon yok.' : t >= 0 ? `Yangın bu yapıya T+${Math.floor((t * 10) / 60)}:${String((t * 10) % 60).padStart(2, '0')}'da ulaşıyor.` : 'Bu çalıştırmada yangın bu yapıya ulaşmıyor.'
        new maptilersdk.Popup({ closeButton: true, offset: 8 })
          .setLngLat(ev.lngLat)
          .setHTML(`<div style="font:13px 'Barlow Semi Condensed',sans-serif;color:#17231c"><b>Yapı</b>${h ? ` · ~${h} m` : ''}<br/>${fire}</div>`)
          .addTo(map)
      })
      buildingsReady = true
    })
    let buildingsReady = false
    const cellOfLL = (lat: number, lon: number) => {
      const col = Math.floor((lon - grid.lon0) / grid.dLon)
      const row = Math.floor((grid.lat0 - lat) / grid.dLat)
      return col < 0 || row < 0 || col >= cols || row >= rows ? -1 : row * cols + col
    }
    // fire state of the buildings in view, refreshed a few times a second
    const marked = new Map<string | number, 'fire' | 'burned'>()
    let lastMark = 0
    const markBuildings = (step: number) => {
      const { result } = propsRef.current
      if (!buildingsReady || !result || !map.getLayer('fg-buildings')) return
      const seen = new Set<string | number>()
      for (const f of map.queryRenderedFeatures({ layers: ['fg-buildings'] })) {
        if (f.id === undefined || seen.has(f.id)) continue
        seen.add(f.id)
        const g = f.geometry
        const p = g.type === 'Polygon' ? g.coordinates[0][0] : g.type === 'MultiPolygon' ? g.coordinates[0][0][0] : null
        if (!p) continue
        const c = cellOfLL(p[1], p[0])
        if (c < 0) continue
        const t = result.ignitionStep[c]
        const state = t >= 0 && t <= step ? (step < result.burnoutStep[c] ? 'fire' : 'burned') : null
        if (marked.get(f.id) === state) continue
        map.setFeatureState({ source: 'fg-buildings', sourceLayer: 'building', id: f.id }, { fire: state === 'fire', burned: state === 'burned' })
        if (state) marked.set(f.id, state)
        else marked.delete(f.id)
      }
    }

    // settlements and the ignition point
    const fixed: maptilersdk.Marker[] = []
    const label = (text: string, cls: string) => {
      const d = document.createElement('div')
      d.className = cls
      d.textContent = text
      return d
    }
    for (const st of propsRef.current.settlements) fixed.push(new maptilersdk.Marker({ element: label(st.name, 'fg3d-label') }).setLngLat([st.pos[1], st.pos[0]]).addTo(map))
    const ig = propsRef.current.ignition
    fixed.push(new maptilersdk.Marker({ element: label('🔥', 'fg3d-ignition') }).setLngLat([ig[1], ig[0]]).addTo(map))

    // the fire texture and the buildings follow the playback clock; the 3D layers redraw with each frame it moves
    let raf = 0
    let lastPaint = 0
    let lastStep = -1
    let lastFrameStep = -1
    const loop = (now: number) => {
      const { clockRef } = propsRef.current
      const step = clockRef.current / 10
      if (step !== lastFrameStep) {
        lastFrameStep = step
        map.triggerRepaint()
      }
      if (step !== lastStep && now - lastPaint > 66) {
        lastStep = step
        lastPaint = now
        paint(step)
      }
      if (now - lastMark > 900) {
        lastMark = now
        markBuildings(step)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      fixed.forEach((m) => m.remove())
      map.remove()
    }
  }, [grid])

  if (!KEY)
    return (
      <div className="flex h-full items-center justify-center bg-bg p-6 text-center text-[13px] text-muted">
        3B görünüm için MapTiler anahtarı gerekiyor. .env dosyasına VITE_MAPTILER_KEY=... ekleyip geliştirme sunucusunu yeniden başlatın.
      </div>
    )
  return <div ref={el} className="h-full w-full" />
}
