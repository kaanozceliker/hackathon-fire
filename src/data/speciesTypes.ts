/** Shapes of the data baked from GBIF by scripts/bake-species.ts. No imports on purpose. */

export type SpeciesClass = 'mammal' | 'bird' | 'reptile' | 'amphibian'

export interface BakedSpecies {
  scientific: string
  /** Turkish common name when GBIF has one, else English, else null. */
  name: string | null
  /** IUCN Red List code (LC, NT, VU, EN, CR, …) when GBIF has one. */
  iucn: string | null
  records: number
}

export interface BakedSpeciesRegion {
  classes: { key: SpeciesClass; species: number; records: number; top: BakedSpecies[] }[]
}
