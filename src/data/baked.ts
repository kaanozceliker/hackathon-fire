/** Shapes of the data baked from OpenStreetMap by scripts/bake-osm.ts (see osm.generated.ts). No imports on purpose. */

export type BakedLatLon = [number, number]

export interface BakedSettlement {
  id: string
  name: string
  pos: BakedLatLon
  /** Approximate: OSM tag, a known figure, or estimated from built-up area. */
  population: number
  /** Radius of the built-up cluster around the place node, metres. */
  radiusM: number
}

export interface BakedNode {
  id: string
  name: string
  pos: BakedLatLon
  kind: 'settlement' | 'junction' | 'station' | 'access' | 'safe'
}

export interface BakedEdge {
  id: string
  name: string
  type: 'highway' | 'road' | 'forest'
  from: string
  to: string
  geom: BakedLatLon[]
}

export interface BakedWater {
  id: string
  name: string
  pos: BakedLatLon
  kind: 'sea' | 'reservoir' | 'pond' | 'stream'
  note: string
}

export interface BakedRegion {
  settlements: BakedSettlement[]
  nodes: BakedNode[]
  edges: BakedEdge[]
  water: BakedWater[]
}

/** Existing fire protection of a region (scripts/bake-existing.ts). */
export interface BakedExisting {
  /** Base64, one byte per grid cell: 0 no road, 1 minor road or forest track, 2 secondary, 3 major. */
  roads: string
  towers: { name: string; pos: BakedLatLon }[]
  ponds: { name: string; pos: BakedLatLon; kind: 'pond' | 'tank' }[]
  firebreaks: { name: string; geom: BakedLatLon[]; widthM: number }[]
}
