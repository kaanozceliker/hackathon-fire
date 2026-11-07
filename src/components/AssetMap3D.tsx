import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import * as maptilersdk from '@maptiler/sdk'
import '@maptiler/sdk/dist/maptiler-sdk.css'
import { buildAssetModel, fence, type Pt } from '../lib/assetModels'
import { TreeLayer } from './TreeLayer'
import type { AssetKind } from '../sim/asset'
import type { LatLon } from '../sim/geo'
import type { Grid } from '../sim/types'

/**
 * Varlık Kalkanı in 3D: satellite imagery on terrain, the drawn area outlined, and a 3D model of the asset
 * (factory, solar farm, mine or private property) built to fill that area at its real size; 3D trees around it.
 */

const KEY = import.meta.env.VITE_MAPTILER_KEY as string | undefined
const AREA_COLOR: Record<AssetKind, string> = { fabrika: '#8d9296', ges: '#9aa86b', maden: '#b0915f', ozel: '#7fae5c' }

class AssetModelLayer implements maptilersdk.CustomLayerInterface {
  id = 'fg-asset-model'
  type = 'custom' as const
  renderingMode = '3d' as const
  private map!: maptilersdk.Map
  private renderer!: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.Camera()
  private local = new THREE.Matrix4()
  private proj = new THREE.Matrix4()
  private model: THREE.Group | null = null
  private origin!: maptilersdk.MercatorCoordinate
  private scale = 1
  private base = 0
  private poly: LatLon[]
  private kind: AssetKind

  constructor(poly: LatLon[], kind: AssetKind) {
    this.poly = poly
    this.kind = kind
  }

  onAdd(map: maptilersdk.Map, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1))
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2)
    sun.position.set(-0.5, 1, 0.35)
    this.scene.add(sun)
    const fill = new THREE.DirectionalLight(0xbcd2ff, 0.6)
    fill.position.set(0.6, 0.5, -0.5)
    this.scene.add(fill)
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true })
    this.renderer.autoClear = false
    this.build()
  }

  onRemove() {
    this.scene.clear()
    this.renderer.dispose()
  }

  set(poly: LatLon[], kind: AssetKind) {
    this.poly = poly
    this.kind = kind
    if (this.map) this.build()
  }

  /** (Re)builds the model in local metres around the area's centre, on the terrain. */
  build() {
    if (this.model) this.scene.remove(this.model)
    this.model = null
    if (this.poly.length < 3) return
    const lat = this.poly.reduce((a, p) => a + p[0], 0) / this.poly.length
    const lon = this.poly.reduce((a, p) => a + p[1], 0) / this.poly.length
    this.base = this.map.queryTerrainElevation([lon, lat]) ?? 0
    this.origin = maptilersdk.MercatorCoordinate.fromLngLat([lon, lat], this.base)
    this.scale = this.origin.meterInMercatorCoordinateUnits()
    this.local
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(this.scale, -this.scale, this.scale))
      .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2))
    const toLocal = (p: LatLon): Pt => {
      const m = maptilersdk.MercatorCoordinate.fromLngLat([p[1], p[0]], 0)
      return [(m.x - this.origin.x) / this.scale, (m.y - this.origin.y) / this.scale]
    }
    const poly = this.poly.map(toLocal)
    // terrain height at a local point, relative to the centre (cached on a 10 m lattice)
    const cache = new Map<string, number>()
    const ground = (x: number, z: number) => {
      const k = `${Math.round(x / 10)},${Math.round(z / 10)}`
      let h = cache.get(k)
      if (h === undefined) {
        const ll = new maptilersdk.MercatorCoordinate(this.origin.x + x * this.scale, this.origin.y + z * this.scale, 0).toLngLat()
        h = (this.map.queryTerrainElevation(ll) ?? this.base) - this.base
        cache.set(k, h)
      }
      return h
    }
    const g = buildAssetModel(this.kind, poly, ground)
    if (this.kind === 'ozel' || this.kind === 'fabrika') g.add(fence(poly, ground, this.kind === 'fabrika' ? 0x9aa3a8 : 0xe8e2d4))
    this.model = g
    this.scene.add(g)
    this.map.triggerRepaint()
    window.setTimeout(() => this.map.triggerRepaint(), 50)
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: maptilersdk.CustomRenderMethodInput) {
    if (!this.model) return
    this.proj.fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(this.local)
    this.camera.projectionMatrix.copy(this.proj)
    this.renderer.resetState()
    this.renderer.render(this.scene, this.camera)
  }
}

export function AssetMap3D({ grid, polygon, kind }: { grid: Grid; polygon: LatLon[]; kind: AssetKind }) {
  const el = useRef<HTMLDivElement>(null)
  const layer = useRef<AssetModelLayer | null>(null)
  const mapRef = useRef<maptilersdk.Map | null>(null)

  useEffect(() => {
    if (!KEY || !el.current || polygon.length < 3) return
    maptilersdk.config.apiKey = KEY
    const lats = polygon.map((p) => p[0])
    const lons = polygon.map((p) => p[1])
    const map = new maptilersdk.Map({
      container: el.current,
      style: maptilersdk.MapStyle.HYBRID,
      center: [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2],
      zoom: 15,
      pitch: 58,
      bearing: -25,
      maxPitch: 80,
      terrain: true,
      terrainExaggeration: 1,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
    })
    mapRef.current = map
    map.on('load', () => {
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 120, pitch: 58, bearing: -25, duration: 0, maxZoom: 18 })
      map.addSource('fg-asset-area', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...polygon.map((p) => [p[1], p[0]]), [polygon[0][1], polygon[0][0]]]] } } })
      // the area's ground, draped on the terrain by the map itself (a flat 3D plate would sink into slopes)
      map.addLayer({ id: 'fg-asset-fill', type: 'fill', source: 'fg-asset-area', paint: { 'fill-color': AREA_COLOR[kind], 'fill-opacity': 0.55 } })
      map.addLayer({ id: 'fg-asset-line', type: 'line', source: 'fg-asset-area', paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } })
      map.addLayer(new TreeLayer(grid, () => ({ result: null, step: 0 })))
      // the model needs the terrain under the area: add it once the view has settled
      map.once('idle', () => {
        const l = new AssetModelLayer(polygon, kind)
        layer.current = l
        map.addLayer(l)
      })
    })
    return () => {
      layer.current = null
      mapRef.current = null
      map.remove()
    }
    // the map is rebuilt for a new area; a new kind only rebuilds the model
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, polygon])

  useEffect(() => {
    layer.current?.set(polygon, kind)
    const map = mapRef.current
    if (map?.getLayer('fg-asset-fill')) map.setPaintProperty('fg-asset-fill', 'fill-color', AREA_COLOR[kind])
  }, [kind, polygon])

  if (!KEY)
    return (
      <div className="flex h-full items-center justify-center bg-bg p-6 text-center text-[13px] text-muted">
        3B görünüm için MapTiler anahtarı gerekiyor. .env dosyasına VITE_MAPTILER_KEY=... ekleyip geliştirme sunucusunu yeniden başlatın.
      </div>
    )
  return <div ref={el} className="h-full w-full" />
}
