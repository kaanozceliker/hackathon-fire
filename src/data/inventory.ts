import raw from './inventory.json'

/** Response resources per region, from src/data/inventory.json (edit that file with real numbers). */

export interface Inventory {
  status: string
  stationCrews: (stationName: string, index: number) => number
  stationDozers: (stationName: string, index: number) => number
  helicopters: number
  heliArrivalMin: number
  planes: number
  planeArrivalMin: number
  reinforcements: { afterH: number; crews: number; dozers: number }[]
}

interface Defaults {
  istasyon_arazoz: number
  istasyon_is_makinesi: number
  is_makinesi_olan_ilk_istasyon_sayisi: number
  helikopter: number
  helikopter_varis_dk: number
  ucak: number
  ucak_varis_dk: number
  takviye: { varis_saat: number; arazoz: number; is_makinesi: number }[]
}
type RegionOverride = Partial<Defaults> & { istasyonlar?: Record<string, { arazoz?: number; is_makinesi?: number }> }

export function inventoryFor(areaId: string): Inventory {
  const d = raw.varsayilan as Defaults
  const r = ((raw.bolgeler as Record<string, RegionOverride>)[areaId] ?? {}) as RegionOverride
  const v = { ...d, ...r }
  const st = r.istasyonlar ?? {}
  return {
    status: raw._durum,
    stationCrews: (name) => st[name]?.arazoz ?? v.istasyon_arazoz,
    stationDozers: (name, i) => st[name]?.is_makinesi ?? (i < v.is_makinesi_olan_ilk_istasyon_sayisi ? Math.max(1, v.istasyon_is_makinesi) : v.istasyon_is_makinesi),
    helicopters: v.helikopter,
    heliArrivalMin: v.helikopter_varis_dk,
    planes: v.ucak,
    planeArrivalMin: v.ucak_varis_dk,
    reinforcements: v.takviye.map((t) => ({ afterH: t.varis_saat, crews: t.arazoz, dozers: t.is_makinesi })),
  }
}
