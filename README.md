# ForestGuard

Altı çalışma bölgesinde orman yangını simülasyonu, müdahale planlama ve önlem karşılaştırma prototipi.
React + TypeScript + Vite + Tailwind + Leaflet + Recharts; isteğe bağlı MapTiler/Three.js 3B görünüm ve sunucu üzerinden yapay zeka desteği.

Arazi örtüsü, yükselti, yol ve yerleşim geometrileri açık coğrafi kaynaklardan gelir. Bölgesel tehlike endeksleri, sabit hava,
nüfuslar, müdahale envanteri ve maliyetler temsilidir. Yayılım ve duman modelleri doğrulanmış operasyonel tahmin modelleri değildir.

Ayrıntılı mimari incelemesi, bulgular ve kabul ölçütleri: [Proje incelemesi ve teslim yol haritası](docs/PROJECT_REVIEW.md).

Arayüz tasarımı ve doğrulanan kullanıcı akışları: [Arayüz yenilemesi](docs/UI_DESIGN.md).

## Çalıştırma

Node.js 22.12+ önerilir; bu çalışma Node.js 22.19 ile doğrulandı. Kilit dosyasındaki sürümleri korumak için `npm ci` kullanın.

    npm ci
    npm run dev        # http://localhost:5173
    npm run build
    npm run serve      # üretim çıktısı ve API: http://localhost:8787
    npm run check      # TypeScript + çevrimdışı motor kontrolleri + yerel HTTP sunucu kontrolleri
    npm run sim:check  # 6 bölge × 4 koşul; determinizm, tutarlılık, coğrafi uyum, rüzgar, duman, komuta
    npm run sim:check:live # ek olarak gerçek Open-Meteo isteği; ağ/API hatasında başarısız olur
    npm run server:check # dosya sunumu, MIME, HEAD, hatalı URL ve kök dışına erişim

`check` harici servislere istek göndermez; sunucu kontrolü geçici bir localhost portuna bağlantı izni gerektirir.
GitHub Actions, push/PR üzerinde `npm ci`, `npm run check` ve `npm run build` çalıştıracak şekilde tanımlıdır.

## Veri hazırlama

Hazırlanmış veri dosyaları depoda bulunduğundan demo için yeniden indirme gerekmez.
Aşağıdaki komutlar ağ kullanır ve `src/data/*.generated.ts` dosyalarını yeniden yazar; incelenmiş bir veri güncellemesi olarak çalıştırılmalıdır.

    npm run bake       # landcover, dem, osm, species, existing, burnscars sırasıyla
    npm run bake:landcover  # arazi örtüsü (ESA WorldCover) -> src/data/landcover.generated.ts
    npm run bake:dem        # yükselti (Copernicus DEM GLO-30) -> src/data/elevation.generated.ts
    npm run bake:species    # bölgede kayıtlı memeli, kuş, sürüngen, amfibi türleri (GBIF) -> src/data/species.generated.ts
    npm run bake:osm        # yerleşimler, yollar, itfaiye, toplanma alanları, su kaynakları (OpenStreetMap) -> src/data/osm.generated.ts
    npm run bake:existing   # mevcut yollar, kuleler, havuzlar ve emniyet şeritleri
    npm run bake:burnscars  # geçmiş yanık alanları (Sentinel-2)
    npm run bake:history    # tarihsel yangın ve hava serisi; toplu bake komutuna dahil değildir

Yapı: `src/sim` (motor, arazi, planlayıcı, rapor – React içermez), `src/data` (bölgeler, örnek altyapı),
`src/state` (oturum ve oynatma), `src/components`, `src/pages`; `server` (API ve üretim dosya sunucusu).
Ana sayfa doğrudan, diğer bölümler ihtiyaç anında yüklenir. 2B harita anahtarsız OpenStreetMap kullanır;
`VITE_MAPTILER_KEY` tanımlıysa MapTiler'a geçer. Uydu görünümü Esri'den yüklenir. 3B için MapTiler anahtarı gerekir.
Harita altlıkları ağ gerektirir; gömülü coğrafi veriler altlığı çevrimdışı hale getirmez.
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

## Teslim notları

- Özel senaryolar şu an oturum belleğinde tutulur; sayfa yenilenince kaybolur ve en fazla beş özel sonuç saklanır.
- Varsayılan kontroller API anahtarı veya ücretli model çağrısı gerektirmez. Yapay zeka entegrasyonu ayrıca doğrulanmalıdır.
- Anahtarsız OSM altlığı normal etkileşimli demo içindir. Kamuya açık yoğun kullanım veya çevrimdışı harita için uygun bir sağlayıcı seçilmelidir; [OSM kullanım politikası](https://operations.osmfoundation.org/policies/tiles/).
- İnternete açık AI uçları için kimlik doğrulama, istek boyutu/sıklığı, zaman aşımı ve harcama sınırları henüz eklenmedi.
- Başarılı derleme, modelin bilimsel olarak doğrulandığı veya üretim tesliminin tamamlandığı anlamına gelmez; kalan adımlar inceleme belgesindedir.

[![mühür](https://muhur-phi.vercel.app/api/rozet/ekozeka-2026/3)](https://muhur-phi.vercel.app/sergi/ekozeka-2026/3)
