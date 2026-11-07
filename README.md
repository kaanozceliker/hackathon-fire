# ForestGuard

Orman yangını simülasyonu ve müdahale planlama prototipi (React + TypeScript + Vite + Tailwind + Leaflet + Recharts).
Tüm veriler temsili örnek verilerdir; simülasyon basitleştirilmiş bir hücresel otomattır, doğrulanmış bir model değildir.

    npm install
    npm run dev        # http://localhost:5173
    npm run build
    npm run sim:check  # motorun determinizm ve tutarlılık kontrolü
    npm run bake       # tüm gerçek veriyi yeniden indirir (sırasıyla aşağıdaki üç betik)
    npm run bake:landcover  # arazi örtüsü (ESA WorldCover) -> src/data/landcover.generated.ts
    npm run bake:dem        # yükselti (Copernicus DEM GLO-30) -> src/data/elevation.generated.ts
    npm run bake:species    # bölgede kayıtlı memeli, kuş, sürüngen, amfibi türleri (GBIF) -> src/data/species.generated.ts
    npm run bake:osm        # yerleşimler, yollar, itfaiye, toplanma alanları, su kaynakları (OpenStreetMap) -> src/data/osm.generated.ts

Yapı: `src/sim` (motor, arazi, planlayıcı, rapor – React içermez), `src/data` (bölgeler, örnek altyapı),
`src/state` (store), `src/components`, `src/pages`. Harita katmanları çalışma anında CARTO / Esri'den yüklenir.
Gerçek veri kaynakları (koda gömülü, `npm run bake` ile yenilenir):
- Arazi örtüsü: ESA WorldCover 10 m 2021 (© ESA WorldCover project / Copernicus Sentinel verisi, CC BY 4.0)
- Yükselti: Copernicus DEM GLO-30 (© DLR e.V. 2010-2014 ve © Airbus Defence and Space GmbH 2014-2018, Avrupa Birliği ve ESA tarafından COPERNICUS kapsamında sağlanır)
- Yerleşimler, yol ağı, itfaiye istasyonları, toplanma alanları, su kaynakları: © OpenStreetMap katkıcıları (ODbL 1.0)
- Yaban hayatı tür kayıtları: GBIF.org gözlem verisi (`npm run bake:species`).
- Saatlik hava (Stüdyo'da "Open-Meteo" modu, çalışma anında çekilir): Open-Meteo tahmin ve ERA5 arşivi (CC BY 4.0). Izgarada 3×3 noktadan alınır, hücrelere enterpole edilir.

Hâlâ temsili olanlar: sabit moddaki örnek hava değerleri (`data/regions.ts`), aktif yangınlar (`SIMULATED_FIRES`, ileride NASA FIRMS),
bölge risk endeksleri ve yerleşim nüfusları (yaklaşık). `sim:check` Faz 1 kapısını da denetler: yerleşimler ve varsayılan tutuşma
noktaları karada, yolların su hücresine düşen payı %2'nin altında. Faz 2 kapısı: rüzgar dönünce yayılım yönü yeni rüzgar yönüne döner ve rapor dönüşü yazar.

Duman ve emisyon (`src/sim/smoke.ts`, tarama modeli): yanan biyokütle × emisyon faktörü (Andreae ve Merlet 2001) ile CO₂, CO ve PM2.5;
duman 550 m'lik, yangın ızgarasının 3 katı genişlikte bir alanda saatlik rüzgarla taşınır, gece/gündüz değişen karışım yüksekliğine
karıştırılır, büyük yangınlarda bir kısmı yukarı taşınır. Yerleşim etkisi ABD EPA PM2.5 endeksi kategorileriyle verilir. Ölçüm yerine geçmez.


Komuta Merkezi (`/command`): yangın canlı ilerler; karar anlarında yapay zeka olay komutanı (OpenAI, ChatGPT API) durumu değerlendirip
müdahale kararları verir, motor bu kararların etkisini hesaplar. Anahtar yalnızca sunucuda kullanılır (`server/commander.ts`);
`.env.example` dosyasını `.env` olarak kopyalayıp `OPENAI_API_KEY` (ve isteğe bağlı `OPENAI_MODEL`, varsayılan `gpt-5.5`) girin.
Anahtar yoksa veya API hata verirse kararları kural tabanlı komutan verir. Üretimde: `npm run build`, ardından `npm run serve`.
