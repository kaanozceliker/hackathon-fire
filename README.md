# ForestGuard

Orman yangını simülasyonu ve müdahale planlama prototipi (React + TypeScript + Vite + Tailwind + Leaflet + Recharts).
Tüm veriler temsili örnek verilerdir; simülasyon basitleştirilmiş bir hücresel otomattır, doğrulanmış bir model değildir.

    npm install
    npm run dev        # http://localhost:5173
    npm run build
    npm run sim:check  # motorun determinizm ve tutarlılık kontrolü
    npm run bake:landcover  # gerçek arazi örtüsünü (ESA WorldCover) yeniden indirip src/data/landcover.generated.ts'e yazar

Yapı: `src/sim` (motor, arazi, planlayıcı, rapor – React içermez), `src/data` (bölgeler, örnek altyapı),
`src/state` (store), `src/components`, `src/pages`. Harita katmanları çalışma anında CARTO / Esri'den yüklenir.
Arazi örtüsü (su, yapılaşma, orman, maki) ESA WorldCover 10 m 2021 verisinden gelir (© ESA WorldCover project / Copernicus Sentinel verisi, CC BY 4.0); yükselti hâlâ sentetiktir.
Gelecekte değiştirilebilecek noktalar: `getGrid` (Copernicus DEM), `runSimulation` (sunucu tarafı model),
`data/regions.ts` hava durumu (Open-Meteo), `SIMULATED_FIRES` (NASA FIRMS), `data/infrastructure.ts` (OpenStreetMap).
