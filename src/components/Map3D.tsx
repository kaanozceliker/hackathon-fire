import { useEffect, useRef } from 'react'
import * as maptilersdk from '@maptiler/sdk'
import '@maptiler/sdk/dist/maptiler-sdk.css'
import { gridBounds } from '../sim/terrain'
import { trackPosition } from '../lib/tracks'
import { lineColor } from './ResponseLayer'
import { TreeLayer } from './TreeLayer'
import type { Grid, ResourceKind, ResponseRecord, Settlement, SimResult } from '../sim/types'

/**
 * 3D view on MapTiler (Satellite Hybrid style with terrain). The fire, burned area and safety lines are painted
 * into a texture laid over the terrain; resource icons move along their routes from the playback clock; buildings
 * stand as 3D blocks that show the fire reaching them.
 * Needs VITE_MAPTILER_KEY in .env (a public, browser-side key: restrict it to your domains in MapTiler Cloud).
 */

const KEY = import.meta.env.VITE_MAPTILER_KEY as string | undefined
const SCALE = 4 // texture pixels per grid cell
const RAMP = ['#fff2a8', '#ffd24a', '#ffa530', '#f77a25', '#e5502a', '#c93426', '#a52a22'].map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)])
const KIND_COLOR: Record<ResourceKind, string> = { crew: '#e5483d', dozer: '#e3a72f', heli: '#3b9be0', plane: '#7fc4f0' }
const KIND_LETTER: Record<ResourceKind, string> = { crew: 'A', dozer: 'İ', heli: 'H', plane: 'U' }
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
          const f = t < 0 ? 0 : Math.min(1, step - (t - 1))
          if (f <= 0) continue
          const end = result.burnoutStep[i]
          if (step >= end) put(i, 40, 18, 16, Math.round(200 * f))
          else {
            const c = RAMP[Math.min(RAMP.length - 1, Math.floor((Math.max(0, step - t) / Math.max(1, end - t)) * RAMP.length))]
            put(i, c[0], c[1], c[2], Math.round(235 * f))
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

    // resource icons, moved every frame
    const units = new Map<string, maptilersdk.Marker>()
    let raf = 0
    let lastPaint = 0
    let lastStep = -1
    const loop = (now: number) => {
      const { rec, clockRef } = propsRef.current
      const step = clockRef.current / 10
      if (step !== lastStep && now - lastPaint > 66) {
        lastStep = step
        lastPaint = now
        paint(step)
      }
      if (now - lastMark > 900) {
        lastMark = now
        markBuildings(step)
      }
      const seen = new Set<string>()
      for (const tr of rec?.tracks ?? []) {
        const pos = trackPosition(tr, step)
        if (!pos) continue
        seen.add(tr.id)
        let m = units.get(tr.id)
        if (!m) {
          const d = document.createElement('div')
          d.className = 'fg3d-unit'
          d.style.background = KIND_COLOR[tr.kind]
          d.style.borderRadius = tr.kind === 'heli' || tr.kind === 'plane' ? '50%' : '4px'
          d.textContent = KIND_LETTER[tr.kind]
          d.title = tr.name
          m = new maptilersdk.Marker({ element: d }).setLngLat([pos.ll[1], pos.ll[0]]).addTo(map)
          units.set(tr.id, m)
        } else m.setLngLat([pos.ll[1], pos.ll[0]])
        m.getElement().style.opacity = pos.status === 'idle' || pos.status === 'grounded' ? '0.55' : '1'
      }
      for (const [id, m] of units)
        if (!seen.has(id)) {
          m.remove()
          units.delete(id)
        }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      units.forEach((m) => m.remove())
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
