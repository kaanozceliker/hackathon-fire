import { CheckCircle2, ChevronDown, Database, ExternalLink } from 'lucide-react'
import { LANDCOVER } from '../data/landcover.generated'
import { ELEVATION } from '../data/elevation.generated'
import { OSM } from '../data/osm.generated'

export function DataProvenance({ areaId }: { areaId: string }) {
  const sources = [
    { name: 'Arazi örtüsü', detail: 'ESA WorldCover · 2021 · 10 m', available: !!LANDCOVER[areaId], url: 'https://esa-worldcover.org/en' },
    { name: 'Yükselti', detail: 'Copernicus DEM · GLO-30', available: !!ELEVATION[areaId], url: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM' },
    { name: 'Yollar ve yerleşimler', detail: 'OpenStreetMap · yerel veri kopyası', available: !!OSM[areaId], url: 'https://www.openstreetmap.org/copyright' },
  ]
  return (
    <details className="group rounded-lg border border-line bg-panel">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-3 text-[13px] font-semibold [&::-webkit-details-marker]:hidden">
        <Database size={14} className="text-forest" /> Verinin dayanağı
        <span className="ml-auto text-[11px] font-normal text-muted">{sources.filter((source) => source.available).length} / {sources.length} kaynak</span>
        <ChevronDown size={14} className="text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-line p-3.5">
        {sources.map((source) => (
          <div key={source.name} className="flex items-start gap-2">
            <CheckCircle2 size={14} className={`mt-0.5 shrink-0 ${source.available ? 'text-forest' : 'text-amber'}`} />
            <div className="min-w-0 text-[12px]">
              <a href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium hover:text-forest">{source.name}<ExternalLink size={10} /></a>
              <p className="text-muted">{source.available ? source.detail : 'Kaynak verisi yok; temsili veri kullanılıyor'}</p>
            </div>
          </div>
        ))}
        <p className="border-t border-line pt-2 text-[11.5px] leading-relaxed text-muted">Arazi verileri 110 m simülasyon hücrelerine işlenir. Yerel kopyaların indirilme zamanı kayıtlı değil. Bölgesel endeks, sabit hava, nüfus, kaynak envanteri ve maliyetler temsilidir. Open-Meteo hava verisi Stüdyo’dan ayrıca yüklenebilir.</p>
      </div>
    </details>
  )
}
