/**
 * Tree and shrub species of the study areas, assigned cell by cell from the regional vegetation zones.
 *
 * WorldCover tells forest from shrubland but not species. Species are therefore estimated from the vegetation belts
 * described for these forests (Mediterranean and Aegean altitudinal zonation used in Turkish forestry: Calabrian pine
 * in the lowlands, black pine higher up, cedar / fir / juniper in the mountain belt, oaks in transitions and on cool
 * slopes, oriental sweetgum along wet valley floors) using elevation, aspect and distance to water.
 * Fuel loads and flammability are approximate literature values for Mediterranean fuel types.
 * Everything here is an estimate ("tahmini"), not a stand map.
 */

export interface Species {
  id: number
  name: string
  scientific: string
  /** Fine fuel consumed in a fire at full density, t/ha (approximate). */
  fuelTHa: number
  /** Relative ease of spread compared with Calabrian pine (1). */
  flammability: number
  /** How the stand comes back after fire. */
  regen: 'tohum' | 'dikim' | 'surgun'
  regenNote: string
  shrub: boolean
}

export const SPECIES_LIST: Species[] = [
  { id: 0, name: '—', scientific: '', fuelTHa: 0, flammability: 0, regen: 'surgun', regenNote: '', shrub: false },
  { id: 1, name: 'Kızılçam', scientific: 'Pinus brutia', fuelTHa: 25, flammability: 1, regen: 'tohum', regenNote: 'Kozalakları yangında açılır; tohum kaynağı yakınsa 1–3 yılda kendiliğinden yenilenir.', shrub: false },
  { id: 2, name: 'Karaçam', scientific: 'Pinus nigra', fuelTHa: 22, flammability: 0.85, regen: 'dikim', regenNote: 'Yangından sonra tohumla yenilenmesi zayıftır; dikim gerekir.', shrub: false },
  { id: 3, name: 'Toros sediri', scientific: 'Cedrus libani', fuelTHa: 20, flammability: 0.7, regen: 'dikim', regenNote: 'Kendiliğinden yenilenmesi yavaştır; fidanla dikim gerekir.', shrub: false },
  { id: 4, name: 'Göknar', scientific: 'Abies cilicica / A. nordmanniana subsp. equi-trojani', fuelTHa: 20, flammability: 0.6, regen: 'dikim', regenNote: 'Yangına hassastır, kendiliğinden yenilenmez; gölgeli serin yamaçlarda dikim gerekir.', shrub: false },
  { id: 5, name: 'Meşe', scientific: 'Quercus spp.', fuelTHa: 15, flammability: 0.6, regen: 'surgun', regenNote: 'Kök ve kütükten sürgün verir; çoğunlukla kendiliğinden toparlanır.', shrub: false },
  { id: 6, name: 'Sığla', scientific: 'Liquidambar orientalis', fuelTHa: 12, flammability: 0.45, regen: 'dikim', regenNote: 'Nesli tehlikedeki endemik tür; dere yataklarında koruma ve dikim öncelikli.', shrub: false },
  { id: 7, name: 'Ardıç', scientific: 'Juniperus spp.', fuelTHa: 15, flammability: 0.8, regen: 'dikim', regenNote: 'Çok yavaş yenilenir; dikim gerekir.', shrub: false },
  { id: 8, name: 'Maki (kermes meşesi, pırnal, sandal, mersin)', scientific: 'Quercus coccifera, Q. ilex, Arbutus, Myrtus', fuelTHa: 30, flammability: 1.05, regen: 'surgun', regenNote: 'Kökten sürgün verir; 3–7 yılda örtü geri gelir.', shrub: true },
  { id: 9, name: 'Frigana / seyrek çalı', scientific: 'Sarcopoterium, Cistus spp.', fuelTHa: 8, flammability: 0.9, regen: 'surgun', regenNote: 'Hızla geri gelir.', shrub: true },
]

export const speciesById = (id: number) => SPECIES_LIST[id] ?? SPECIES_LIST[0]

/** Elevation belts per area (m): where lowland pine ends, where the mountain belt starts, and its conifer. */
interface Belts {
  pineTop: number
  mountainFrom: number
  mountain: number
  wetValley: boolean
}
const BELTS: Record<string, Belts> = {
  mugla: { pineTop: 700, mountainFrom: 1100, mountain: 2, wetValley: true },
  izmir: { pineTop: 650, mountainFrom: 1000, mountain: 2, wetValley: false },
  antalya: { pineTop: 900, mountainFrom: 1300, mountain: 3, wetValley: false },
  canakkale: { pineTop: 500, mountainFrom: 900, mountain: 2, wetValley: false },
  balikesir: { pineTop: 550, mountainFrom: 1000, mountain: 4, wetValley: false },
}

/**
 * Species of a cell. kind: WorldCover-derived cover (3 shrub, 4 forest; others get 0).
 * aspectNorth: 1 on north-facing slopes, -1 on south-facing; nearWater: within ~300 m of water.
 */
export function speciesFor(areaId: string, kind: number, elev: number, aspectNorth: number, nearWater: boolean, noise: number): number {
  if (kind !== 3 && kind !== 4) return 0
  const b = BELTS[areaId] ?? BELTS.mugla
  if (kind === 3) return elev > b.mountainFrom ? 9 : 8
  if (b.wetValley && nearWater && elev < 200) return 6
  if (elev < b.pineTop) return aspectNorth > 0.5 && noise > 0.7 ? 5 : 1
  if (elev < b.mountainFrom) return aspectNorth > 0.3 && noise > 0.55 ? 5 : noise > 0.35 ? 2 : 1
  if (areaId === 'antalya' && elev > 1600 && noise < 0.25) return 7
  if (aspectNorth > 0.3 && (b.mountain === 4 || areaId === 'antalya') && noise > 0.5) return 4
  return b.mountain
}
