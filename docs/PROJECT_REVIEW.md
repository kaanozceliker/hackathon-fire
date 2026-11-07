# ForestGuard — proje incelemesi ve teslim yol haritası

İnceleme tarihi: 7 Kasım 2026. Kapsam: mevcut kaynak kodu, kilitli bağımlılıklarla derleme, yerel simülasyon kontrolleri ve tarayıcıda kullanıcı akışları.

## 1. Ürünün işlevi ve güçlü yanı

ForestGuard; yangından önce önlem planlamayı, yangın yayılımını ve müdahaleyi, ardından etki ve rehabilitasyon değerlendirmesini bir araya getiren bir karar destek prototipi. Altı çalışma alanı var: Marmaris, İzmir, Antalya/Kemer, Çanakkale, Balıkesir/Edremit ve Menderes–Seferihisar. Bunlar il sınırlarını kapsayan tam modeller değil; merkezleri etrafındaki yerel ızgaralar.

En güçlü ürün anlatısı: **aynı başlangıç ve hava koşullarında, önlem ve müdahale kararları değiştiğinde modelde ne değişiyor?** Böyle bir karşılaştırma hem haritada görülebiliyor hem de alan, yerleşim varışı, kaynak hareketi ve emisyon üzerinden açıklanabiliyor. Mevcut mimari bunu destekliyor.

Bugünkü durum: işlevli bir demo ve eğitim prototipi. Bilimsel olarak doğrulanmış bir yangın tahmin sistemi veya internete açık üretim hizmeti olarak teslimi henüz tamamlanmış değil.

## 2. Mimari ve veri akışı

| Katman | Sorumluluk | Kritik dosyalar |
| --- | --- | --- |
| Veri hazırlama | Açık verileri indirir, yeniden örnekler ve depoya gömer | `scripts/bake-*.ts`, `src/data/*.generated.ts` |
| Arazi | Örtü, yükselti, yakıt ve tahmini tür katmanlarından çalışma ızgarası kurar | `sim/terrain.ts`, `sim/gridCache.ts`, `sim/landAuto.ts` |
| Yangın motoru | 8 komşulu hücresel yayılım; rüzgar, eğim, nem, sıcaklık, yağış, yakıt, kor sıçraması | `sim/engine.ts`, `sim/weather.ts` |
| Mevcut koruma | Yollar, emniyet şeritleri, kuleler, havuzlar ve geçmiş yanıkların etkisi | `sim/existing.ts`, `data/existingMeasures.json` |
| Müdahale | Kaynakların ulaşması, doğrudan müdahale, hat açılması, su atışı, tahliye ve müdahalesiz referans | `sim/response.ts`, `state/useCommandRun.ts` |
| Erişim | Yol ağı üzerinde erişim/tahliye rotaları ve yangına maruz kalabilecek kesimler | `sim/planner.ts`, `data/infrastructure.ts` |
| Etki | Biyokütle, emisyon, duman taşınımı, yerleşim maruziyeti ve rapor | `sim/smoke.ts`, `sim/report.ts`, `lib/pdfReport.ts` |
| Karar desteği | Önlem adayları, rehabilitasyon, varlık riski ve tatbikat puanlama | `sim/prevention.ts`, `sim/recovery.ts`, `sim/asset.ts`, `sim/drill.ts` |
| AI sunucusu | Durum özetini şemalı yanıta dönüştürür; anahtar tarayıcıya girmez | `server/commander.ts`, `lib/commanderClient.ts` |
| Oturum | Hazır/özel senaryolar, etkin sonuç, taslak, karşılaştırma ve zaman çizgisi | `state/store.tsx` |
| Görselleştirme | Leaflet + Canvas katmanları; gerektiğinde MapTiler/Three.js 3B | `components/MapStage.tsx`, `*Layer.ts`, `Map3D.tsx` |

Normal akış:

1. `StoreProvider` üç hazır Marmaris senaryosunu hesaplar; `getGrid` araziyi önbellekte tutar.
2. Stüdyo’da bölge, tutuşma, hava, süre ve yakıt seçilir. Otomatik arazi modu Sentinel-2 verisini ayrıca isteyebilir; alınamazsa mevsimsel varsayım kullanır.
3. `FireStepper`, 110 m hücrelerde 10 dakikalık adımlarla ilerler. Menderes 110 × 210, diğer alanlar 130 × 100 hücredir.
4. Planlayıcı aynı sonucun varış zamanlarını yol ağıyla birleştirir. Komuta Merkezi ise karar noktalarında durur; eylemleri uygulayıp yayılımı yeniden ilerletir.
5. Müdahale eylemlerindeki kaynak ve yerleşim kimlikleri motor tarafından denetlenir. AI yanıt veremezse kural tabanlı komutan devam edebilir.
6. Sonuç analize eklenir; karşılaştırma, duman/ekolojik etki ve Markdown/PDF raporu üretilebilir.

Tarihsel yangın akışı farklıdır: `historyReplay.ts`, Sentinel-2 geçişleri arasında tahmini yanma zamanları oluşturur. Bu oynatım fizik tabanlı geçmiş saatlik gözlem değildir. “Önlemler alınsaydı?” akışı ise ayrı bir motor çalıştırmasıdır. İki görünümün anlamını korumak gerekir.

## 3. Verinin gerçekte neyi temsil ettiği

| Veri | Mevcut durum | İyileştirme ihtiyacı |
| --- | --- | --- |
| Arazi örtüsü | ESA WorldCover 2021; kaynak 10 m, model 110 m | Kaynak yılı görünür olmalı; güncel yakıtla karıştırılmamalı |
| Yükselti | Copernicus DEM GLO-30; model ızgarasına işlenmiş | Sürüm, indirme zamanı, yeniden örnekleme ve boş veri kaydı |
| Yol/yerleşim geometrisi | OpenStreetMap yerel kopyası | Çekim zamanı, veri kapsamı ve eksik altyapı raporu |
| Nüfus | OSM etiketi/bilinen yaklaşık değer veya yapılaşmadan tahmin | Kaynak ve yıl; “etkilenen kişi” sonuçlarının belirsizliği |
| Bölgesel risk ve ulusal sıcak noktalar | `regions.ts` içinde sabit, temsili | Canlı tehlike tahmini gibi sunulmamalı |
| Sabit hava | Bölgelere atanmış örnek değerler | Kontrolün girdiyle, simülasyon sırasındaki günlük değişimle ilişkisi daha açık anlatılmalı |
| Saatlik hava | Open-Meteo tahmin/arşiv isteği; 3 × 3 örnekleme | İstek modeli, veri zamanı, servis hatası ve mekansal çözünürlük kaydı |
| Tarihsel hava | Üretilmiş dosyada arşiv verisi; ERA5 diye etiketli | Hazırlama isteği `models=era5` sabitlemiyor; kaynak modelini metadata ile doğrulamak gerekiyor |
| Ağaç/tür dağılımı | Örtü ve yükselti kuşağına göre tahmin | Ölçülmüş meşcere envanteriyle ayrılmalı |
| Yaban hayatı | GBIF gözlem kayıtları | Türün kayıtlı olması, o yangında hayvan sayısı veya kayıp ölçümü değildir |
| Kaynak envanteri ve maliyet | JSON içindeki yaklaşık varsayımlar; maliyet açıklaması 2025 referanslı | Kurumsal envanter ve tarihli birim maliyet cetveli |
| Tarihsel yanık alan | Sentinel-2 dNBR eşiğiyle türetilmiş alan | Bulut, eşik, geçiş zamanı ve alan belirsizliği; resmi sınırlarla ayrı karşılaştırma |

[WorldCover](https://esa-worldcover.org/en), [Copernicus DEM](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) ve [Open-Meteo arşiv belgeleri](https://open-meteo.com/en/docs/historical-weather-api) kaynak çözünürlüğünün model çözünürlüğünden ayrı tutulması için temel referanslardır. Özellikle hava verisini 110 m hücrelere enterpole etmek, kaynak havanın 110 m çözünürlükte ölçüldüğü anlamına gelmez.

## 4. Bu ilk geliştirme adımında tamamlananlar

| Bulgu | Uygulanan değişiklik | Sonuç |
| --- | --- | --- |
| Anahtarsız CARTO altlığı “API key required” görseli döndürüyordu | Anahtarsız 2B için OSM; tanımlı MapTiler anahtarının akışı korundu | Harita tarayıcıda görüntülendi |
| Yan panel haritayı 980 px civarına uzatıyordu | Masaüstünde ekran yüksekliğine bağlı düzen, bağımsız yan panel kaydırması; harita boyut gözlemi | 1280 × 720 görünümde harita yaklaşık 447 px yüksekliğe sığdı |
| Sayaç 70, lejant/işaretçi 65 eşiğini kullanıyordu | Eşikler ortak `lib/risk.ts` kaynağına taşındı | Sayı, renk ve lejant aynı sınıflamayı kullanıyor; mevcut veride 5/6 |
| “Son simülasyonlar” içinde hiç hesaplanmamış üç örnek kayıt vardı | Liste sadece oturumda hesaplanan hazır/özel sonuçları gösteriyor | Kayıtların kaynağı anlaşılır |
| Ana ekran sonuçları açıklamıyordu | Alan artış eğrisi, ilk yerleşim varışı, ulaşılan yerleşim sayısı ve orman/maki payı | Sabit örnek sayılar eklenmeden model sonucundan özet |
| Gerçek ve temsili girdiler tek bakışta ayırt edilemiyordu | Bölgeye göre “Verinin dayanağı” kartı | Kaynak kapsamı ve eksik indirme tarihi açık |
| Bütün sayfalar açılışta yükleniyordu | Ana sayfa dışındaki yedi bölüm `React.lazy` ile ayrıldı; sayfa yükleme ve hata durumları eklendi | Ana JS dosyasında yaklaşık %30 azalma |
| Determinizm kontrolü sadece yazdırılıyordu | Altı bölgede dört koşul için başarısız olabilen kontroller; suyun yanmaması, alan korunumu ve zaman serisi tutarlılığı | 24 koşul birleşimi, her biri iki kez hesaplanıyor |
| Çevrimdışı kontrol harici hava servisini de çağırıyordu | Canlı hava denemesi ayrı komuta alındı | Varsayılan kontroller dış ağdan bağımsız; canlı mod servis hatasını başarısız sayıyor |
| Üretim dosya sunumu hatalı URL ile çökebiliyor, bazı eksik dosyalara HTML dönebiliyordu | Ayrı statik handler; URL/yol sınırı, gerçek MIME, 404, HEAD, yöntem kontrolü | Yerel HTTP regresyon kontrolü eklendi ve geçti |
| Rapor, gerçek girdilere rağmen araziyi bütünüyle sentetik diye tanımlıyordu | Arazi girdileri ve temsili parametreler olarak düzeltildi; hücre/adım bilgisi sonuçtan alınıyor | Rapor dili hesaplanan sonuçla uyumlu |
| Tek komutla kontrol ve CI yoktu | `npm run check`, GitHub Actions iş akışı ve güncel çalıştırma notları | Kontrol sırası tekrar kullanılabilir |

Harita altlığı normal etkileşimli kullanım içindir. OSM altlığının çevrimdışı paketlenmesi bu değişikliğin parçası değildir; [OSM politikası](https://operations.osmfoundation.org/policies/tiles/) ön indirme ve çevrimdışı kullanım için bu kamu sunucusunu uygun görmez.

### Ölçümler

| Gösterge | Başlangıç | İlk geliştirme sonrası |
| --- | ---: | ---: |
| Ana JS dosyası, küçültülmüş | 3.021,18 kB | 2.101,84 kB |
| Aynı dosya, gzip | 811,54 kB | 561,14 kB |
| Determinizm kapsamı | 1 bölge × 4 koşul, bilgi amaçlı çıktı | 6 bölge × 4 koşul, hata üreten denetim |
| Marmaris örnek son alanı | 4.373 ha | 4.373 ha |
| Marmaris kural tabanlı müdahale | 691 ha; müdahalesiz 5.026 ha | Aynı değerler; tarayıcıda 12 karar ve PDF dışa aktarımı doğrulandı |

Boyutlar derleyici çıktısıdır; toplam ilk sayfa aktarımı veya açılış süresi ölçümü değildir. Ortak JS parçaları, CSS, fontlar ve harita istekleri de ilk yüklemeye katılır. Veri dosyaları hâlâ büyük; bu çalışma performans işinin tamamı değildir.

Tarayıcı doğrulaması: üretim sunucusunda sekiz bölümün açılışı; kural tabanlı komuta → sonucun analize kaydı → PDF indirme; 1280 × 720 masaüstü ve 390 × 844 mobil ana sayfa kontrol edildi. Mobilde dış sayfa genişliği 390 px, harita yüksekliği yaklaşık 473 px; yeni düzende yakalanan sıfır yükseklik sorunu giderildi. PDF çıktısı 66.387 bayt ve geçerli `%PDF-1.3` başlığıyla doğrulandı. Ücretli AI ve anahtar gerektiren 3B görünüm bu kontrollerin kapsamında değil.

Motorun yayılım, müdahale ve duman formülleri değiştirilmedi. Veri hazırlama betikleri yeniden çalıştırılmadı; kaynak veri kopyaları korunuyor.

## 5. Öncelikli kalan bulgular

| Öncelik | Bulgu | Kullanıcı/teslim etkisi | Önerilen kabul ölçütü |
| --- | --- | --- | --- |
| P0, açık yayın öncesi | AI uçlarında oturum doğrulama, istek boyutu/sıklığı ve harcama sınırı yok; sunucu istekleri uzun bekleyebilir | Kamuya açık dağıtımda kontrolsüz API kullanımı ve bekleme | Yetkisiz istek engellenir; büyük/sık istek sınırlanır; süre aşımında kurallara dönüş görünür |
| P1 | Özel sonuçlar sadece bellekte, en fazla beş; yenilemede veya altıncı kayıtta sonuç kaybı | Teslimde çalışmaları yeniden açamama | Sürüm kontrollü dışa/içe aktarım; kaydetme ve geri yükleme turunda aynı config/sonuç |
| P1 | Veri çekim zamanı, model sürümü ve varsayımların tek bir kaydı yok | Raporun nasıl üretildiği tekrar kurulamaz | Her koşuda veri manifesti, simülasyon tarihi, seed, motor sürümü ve girdi özeti |
| P1 | `simYear` sabit hava modunda takvim yılını kullanıyor | Aynı dışa aktarılmış ayarlar farklı yıllarda farklı yanık alan yakıtıyla çalışabilir | Sabit mod için de senaryoda açık referans tarihi saklanır |
| P1 | Stüdyo ilerleme çubuğu zamanlayıcıyla ilerliyor; gerçek hesap daha sonra ana iş parçacığında yapılıyor | Uzun koşulda takılma ve yanıltıcı ilerleme | Worker üzerinden gerçek adım ilerlemesi ve iptal; kullanıcı kaydırma/tıklaması yanıt verir |
| P1 | Tarihsel olayla görsel karşılaştırma var, doğruluk skoru yok | “Gerçeğe ne kadar yakın?” sorusu yanıtsız | Ayrılmış doğrulama olaylarında alan hatası, IoU/Dice ve sınır mesafesi; kayıtlı veri/parametre sürümü |
| P1 | Hava/uydu isteklerinde tutarlı iptal, süre sınırı ve tekrar deneme politikası yok | Bölge değişiminde eski yanıtın uygulanması veya yüklemede kalma riski | Geciken/bozuk/eksik yanıt ve hızlı bölge değişimi için entegrasyon kontrolleri |
| P2 | Analiz farklı alan ve sürelerin nihai sonuçlarını yan yana gösterebiliyor | Karşılaştırma tek bir müdahalenin etkisi gibi yorumlanabilir | Alan, tutuşma, süre ve hava eşleşmesi belirtilir; eşleşmeyen koşullar görünür |
| P2 | Bazı UI sayıları Türkçe, bazı grafik/rapor sayıları İngilizce biçimde | 4.373 / 4,373 gibi tutarsızlık | Ortak sayı, süre ve birim biçimleme katmanı |
| P2 | Bazı sayfalarda yerel taslaklar gezinince sıfırlanıyor; komuta çalıştırmasının yaşam döngüsü sayfaya bağlı | Kullanıcı çalışırken sekme değiştirince beklenmedik kayıp | Çalışma sürerken geçiş davranışı açık; iptal ve koruma politikası testli |
| P2 | Büyük veri ve görselleştirme modülleri hâlâ istemciye yükleniyor | Düşük donanım ve mobil cihazda açılış yükü | Bölge bazlı veri yükleme, Worker ve 3B/raporun gerektiğinde yüklenmesi; cihaz ölçümü |

P0/P1 başlıkları tamamlanmadan projeyi üretime hazır diye işaretlemek doğru olmaz. Bu turda AI sağlayıcısına ücretli model çağrısı yapılmadı; mevcut yerel sunucu anahtar bulunmadığını bildiriyordu.

## 6. Veriye dayalı geliştirme önerileri

1. **Kalibrasyon ve ayrı doğrulama kümesi.** Önce birkaç olay için arazi/hava/sınır kaynakları sabitlenmeli. Model ayarı için kullanılan olaylar ile doğruluk raporu çıkarılan olaylar ayrılmalı. Başlangıç saati bilinmiyorsa saatlik doğruluk iddiası yerine alan/sınır ölçümleri ve varsayım aralığı gösterilmeli.
2. **Duyarlılık aralıkları.** Rüzgar, nem, yakıt ve başlangıç zamanı için açıkça tanımlı değişimlerle çoklu koşu. P10/P50/P90 alan ve varış aralıkları gösterilebilir; bunlar model doğrulanmadan kalibre edilmiş tahmin olasılığı diye adlandırılmamalı. Müdahaleli/müdahalesiz çiftlerde aynı hava ve rastgelelik kullanılmalı.
3. **Karar başına ölçülebilir fayda.** Aynı koşullarda önlenen alan, yerleşime varışta kazanılan dakika, harcanan temsili bütçe ve doğaya müdahale alanı birlikte verilmeli. “Kurtarılan insan sayısı” nüfus varsayımlarından doğrudan türetilmemeli.
4. **Kaynak durumunu veriyle anlatma.** Her katmanda kaynak, tarih, kapsanan alan ve eksik veri payı. “Ölçüm”, “uzaktan algılama türevi”, “model çıktısı” ve “varsayım” ayrı nitelikler olmalı.
5. **Gözlem katmanını bağımsız ekleme.** [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/area/) gözlenen termal noktalar için sonraki bir entegrasyon olabilir. MAP_KEY ve gözlem zamanı gerekir. Bu noktalar doğrudan kesin yangın çevresi veya doğrulanmış başlangıç noktası sayılmamalı.

## 7. Görsel etkiyi güçlendirme önerileri

| Öneri | Gerekçe | Tamamlanma ölçütü |
| --- | --- | --- |
| Eşzamanlı öncesi/sonrası haritası | Önlemin nerede fark yarattığı tek bakışta anlaşılır | Aynı sınır, aynı saat, aynı ölçek; sürgü veya yan yana görünüm |
| Ortak karşılaştırma sonuç bandı | Harita, alan tasarrufu ve varış kazanımı birlikte okunur | Önlemsiz/önlemli sonuçla tutarlı 3–4 metrik ve açık birimler |
| Risk alanı ve gözlem kapsamını ayırma | Ulusal arka plan üzerindeki temsili renkler tüm ülke ölçülüyormuş izlenimi vermemeli | Kapsam maskesi/çalışma sınırı; kapsam dışında veri yok açıklaması |
| Yakın işaretçi kümelerini sadeleştirme | İzmir ve Menderes etiketleri küçük ölçekte çakışıyor | Bölgesel bakışta kısa etiket; seçim/yakınlaşmada tam ad |
| Karar ve sonuç bağlantısını vurgulama | Komuta günlüğü uzun; hangi kararın etkili olduğu kolay kayboluyor | Karar anına tıklanınca kaynak hareketi ve ilgili metrik vurgulanır |
| 3B’yi belirli soruya bağlama | Arazi eğimi ve erişim bariyerleri için anlamlı; her ekranda gerekli değil | 2B’den 3B’ye geçişte zaman/konum korunur; anahtarsız durumda anlaşılır 2B akış |
| Mobilde görev sırası | Harita + iki yan panel dar ekranda yorucu | 390 px genişlikte dış yatay taşma yok; ayarlar/harita/sonuç kolay erişilir |

## 8. Aşamalı teslim planı

| Aşama | İş paketi | Çıkış koşulu |
| --- | --- | --- |
| 1 — bu tur | Harita sorunu, ana ekran doğruluğu, sayfa yükleme, regresyon ve dokümantasyon | Derleme ve yerel kontroller geçer; temel ekranlar açılır |
| 2 — veri ve oturum | Kalıcı senaryo kaydı, dışa/içe aktarım, veri manifesti ve açık tarih | Yeniden açılan koşu aynı girdilerle tekrar üretilebilir |
| 3 — hesap ve API | Worker, gerçek ilerleme/iptal, istek yaşam döngüsü, AI erişim ve maliyet kontrolü | Ana iş parçacığı yanıt verir; API arızası kontrollü biter |
| 4 — ölçüm ve karşılaştırma | Tarihsel doğrulama, duyarlılık denemeleri, eşleşmiş referans koşular | Sürüm kayıtlı doğruluk tablosu ve varsayım aralıkları |
| 5 — sunum ve yayın | Öncesi/sonrası görünümü, mobil geçişler, uygun harita sağlayıcısı, dağıtım provası | Kabul senaryoları hedef ortamda geçer; bilinen sınırlamalar teslimde açık |

## 9. Tekrarlanabilir kontrol ve demo

```sh
npm ci
npm run check
npm run build
npm run serve
```

`check`: TypeScript, 24 koşul birleşiminde motor tutarlılığı, coğrafi uyum, rüzgar dönüşü, duman, kural komutanı ve yerel HTTP dosya sunumu. Çevrimdışı kontroller ağ sağlayıcılarını veya model doğruluğunu kanıtlamaz.

Canlı hava kontrolü ayrı ve bilinçli çalıştırılmalıdır: `npm run sim:check:live`. Harita altlığı, canlı hava ve uydu erişimi dağıtım ortamında ayrıca denenmelidir. GitHub Actions tanımı eklendi; bu yerel çalışma uzaktaki CI çalışmasının geçtiği iddiasını taşımaz.

Kısa demo sırası:

1. Ana sayfada temsili endeks ve “Verinin dayanağı” açıklamasını gösterin.
2. Hazır Marmaris senaryosunda yayılımı oynatın; Stüdyo’dan Planlayıcı’ya geçip yol/tahliye katmanlarını açıklayın.
3. Komuta Merkezi’nde “Kural tabanlı”, 30 dakika müdahale başlangıcı ve 8× oynatma seçin. Karar günlüğünü ve müdahalesiz referansı gösterin.
4. Sonucu analize kaydedin; müdahale sonucu ile referansın aynı koşullara dayandığını açıklayın ve PDF alın.
5. Tarihsel yangında uydu geçişleri ile enterpole edilmiş oynatımın farklı anlamlarını gösterin.

Anahtarsız 2B demo, ücretli AI ve 3B’den bağımsız çalışabilmeli. Teslimin bilimsel sınırı: bu sayılar mevcut modelin sonuçlarıdır; sahada doğrulanmış operasyonel tahmin olarak sunulmamalıdır.
