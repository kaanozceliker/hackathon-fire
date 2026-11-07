import { Droplets, Leaf, Loader2, Mountain } from 'lucide-react'
import type { LandAuto } from '../sim/landAuto'
import type { TerrainType } from '../sim/types'

const TERRAIN_LABEL: Record<TerrainType, string> = { 'coastal-plain': 'Düz', 'rolling-hills': 'Tepelik', 'steep-mountain': 'Dik' }
const dryness = (ndmi: number) => (ndmi < 0.05 ? { label: 'Çok kuru', cls: 'text-fire' } : ndmi < 0.15 ? { label: 'Kuru', cls: 'text-amber' } : ndmi < 0.25 ? { label: 'Normal', cls: 'text-ink' } : { label: 'Nemli', cls: 'text-water' })

/** What the automatic "Arazi ve yakıt" found and where it came from. */
export function LandAutoInfo({ terrain, fuelLoad, auto, busy, originVeg }: { terrain: TerrainType; fuelLoad: number; auto: LandAuto | null; busy: boolean; originVeg: number | null }) {
  const fuel = auto?.fuel
  const d = fuel && 'ndmi' in fuel ? dryness(fuel.ndmi) : null
  return (
    <div className="space-y-2">
      <div className="border border-line2 bg-bg p-2.5">
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="flex items-center gap-1.5 text-muted"><Mountain size={14} /> Arazi</span>
          <b>{TERRAIN_LABEL[terrain]}</b>
        </div>
        <div className="mt-1 text-[11px] leading-snug text-muted">
          {auto ? (
            <>
              <div className="relative mb-1 mt-1.5 h-1.5 rounded-full bg-gradient-to-r from-[#3fa564] via-[#e3d23a] to-[#e5483d]">
                <span className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-sm bg-ink shadow" style={{ left: `calc(${Math.min(100, (auto.terrain.meanSlopePct / 40) * 100)}% - 2px)` }} />
              </div>
              <div className="relative mb-1 h-3 text-[10px]"><span className="absolute left-0">Düz</span><span className="absolute -translate-x-1/2" style={{ left: '20%' }}>%8</span><span className="absolute -translate-x-1/2" style={{ left: '55%' }}>%22</span><span className="absolute right-0">Dik</span></div>
              1,5 km içinde ortalama eğim %{Math.round(auto.terrain.meanSlopePct)}, %30'dan dik alan %{Math.round(auto.terrain.steepPct)}. Kaynak: Copernicus DEM.
            </>
          ) : 'Hesaplanıyor…'}
        </div>
      </div>
      <div className="border border-line2 bg-bg p-2.5">
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="flex items-center gap-1.5 text-muted"><Droplets size={14} /> Yakıt durumu</span>
          {busy ? <Loader2 size={14} className="animate-spin text-forest" /> : <b>{d ? <span className={d.cls}>{d.label}</span> : 'Mevsim ortalaması'} · %{Math.round(fuelLoad * 100)}</b>}
        </div>
        <div className="mt-1 text-[11px] leading-snug text-muted">
          {busy && !fuel
            ? 'Son bulutsuz Sentinel-2 geçişi okunuyor…'
            : fuel && 'ndmi' in fuel
              ? <>Bitki nem indeksi (NDMI) {fuel.ndmi.toFixed(2)}, 2 km içindeki bitki pikselleri. Sentinel-2, {fuel.date} (%{fuel.cloudPct} bulut).</>
              : fuel
                ? <>Uydu verisi alınamadı ({fuel.fallback}); ayın tipik kuruluğu kullanıldı.</>
                : null}
        </div>
      </div>
      <div className="border border-line2 bg-bg p-2.5">
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="flex items-center gap-1.5 text-muted"><Leaf size={14} /> Güncel bitki örtüsü</span>
          {busy ? <Loader2 size={14} className="animate-spin text-forest" /> : <b>{originVeg === null ? '–' : originVeg < 0.16 ? <span className="text-amber">Noktada çıplak toprak</span> : `Noktada %${Math.round(originVeg * 100)} bitki`}</b>}
        </div>
        <div className="mt-1 text-[11px] leading-snug text-muted">
          {auto?.cover
            ? <>Her hücrede bitkili piksel payı, Sentinel-2 {auto.cover.date}. Alanın %{Math.round(auto.cover.barePct)}'i çıplak; bu hücrelerde yakıt azalır ya da hiç yanmaz.</>
            : auto && !busy
              ? 'Uydu sınıflandırması alınamadı; 2021 arazi örtüsü haritası kullanılıyor.'
              : null}
        </div>
      </div>
      <p className="text-[11px] leading-snug text-muted">Tutuşma noktası, alan veya tarih değişince yeniden hesaplanır. Tarih: yüklü saatlik hava varsa onun başlangıcı, yoksa bugün. NDMI'dan yakıt çarpanına geçiş yaklaşıktır.</p>
    </div>
  )
}
