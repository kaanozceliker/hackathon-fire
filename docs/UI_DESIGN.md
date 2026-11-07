# ForestGuard arayüz yenilemesi

8 Kasım 2026

## Tasarım yaklaşımı

Yangın planlama ve eğitim akışına uygun, haritayı öne çıkaran bir çalışma alanı. Koyu grafit ve açık nötr yüzeyler, sınırlı yeşil vurgu, yangın için sıcak tonlar ve su için mavi kullanılıyor. Ana eylemler, veriler ve yardımcı araçlar ayrı görsel ağırlık taşıyor. Ortak renk, tipografi, panel, düğme ve seçim stilleri uygulamanın tüm bölümlerinde paylaşılıyor.

## Değişen deneyim

- **Stüdyo:** Katlanabilir ayar paneli, sabit konumda başlat düğmesi, dört güncel gösterge, ayrı katman araç çubuğu ve isteğe bağlı analiz paneli.
- **Tutuşma noktası:** Nokta seçimi bir düğmeyle açılıyor. Geçerli bir konum seçilince kapanıyor; Escape ile iptal edilebiliyor. Haritada gezinmek başlangıç noktasını değiştirmiyor.
- **Oynatma:** Stüdyo ve Komuta Merkezi aynı oynatma bileşenini kullanıyor. Olay işaretleri ve olay kartları ilgili zamana götürüyor. Stüdyo görsel zamanı adımlar arasında yumuşatıyor.
- **Olaylar:** Başlangıç, yerleşim varışları, rüzgar değişimi, saatlik kor sıçramaları ve aktif yanmanın sona ermesi doğrudan çalıştırma sonucundan türetiliyor. İleri bir zamandaki olay, o zamana ulaşılmadan olay akışında gösterilmiyor.
- **Yangın:** Daha sakin kor/parlama, düşük parçacık yoğunluğu, yanmış alan ve aktif yanma sınırı için ayrı çizgiler. Dumanın görsel opaklığı azaltıldı.
- **Komuta:** Haritadan ayrı durum şeridi, daha düzenli metrikler, açılabilir karar kartları ve aşama bantları. Önlemlerde ikon, öncelik, konum, maliyet ve seçim gerekçesi birlikte sunuluyor. Haritada kısa numaralı işaretler; adlar üzerine gelince veya klavyeyle odaklanınca açılıyor.
- **Tatbikat:** Seçili durumu belirgin araç kartları, haritadan ayrı hava/bütçe şeridi ve sadeleştirilmiş eylem alanı. Plan çizimi, maliyet ve puanlama korunuyor.
- **Erişim:** Açık/koyu tema, görünür klavye odağı, ortak seçim gruplarında ok tuşları ve azaltılmış hareket tercihi destekleniyor. Dar ekranda panel düzeni alt alta akıyor ve harita alanı korunuyor.

## Korunan hesaplamalar

Bu tasarım çalışması `src/sim` ve `src/state` içindeki yayılım, hava, yakıt, müdahale, maliyet veya puanlama formüllerini değiştirmiyor. Canvas ve harita katmanlarındaki değişiklikler sunuma ait. Olay kartları mevcut sonuçları okuyor; simülasyon motoruna yeni olay eklemiyor.

Araç kartları için hareket kaydına mevcut üs, hazır olma zamanı, yolculuk amacı ve devriye alanına ilk varış zamanı eklendi. Bu alanlar yalnızca sunum bilgisidir; rota ve süre hesapları aynı kalır.

## Sınır ve araç kartları düzeltmesi

- Çalışma alanı sınırı bütün ilgili 2B haritalarda dolgusuz, nötr renkte ve koyu/açık zeminde seçilen iki çizgiyle gösteriliyor. Komuta hazırlığı ve tatbikatta yeşil arazi dolgusu kaldırıldı. Stüdyo'daki isteğe bağlı Arazi katmanı nötr örtü renkleri kullanıyor.
- Araç kartları referanstaki ikon, ad, durum, sağda süre ve altında ilerleme çizgisi düzenini izliyor. Varış, istasyona/üsse dönüş, su kaynağına uçuş, su ikmali ve devriye ayrı etiketler taşıyor.
- Süreler oynatma saatine göre hesaplanıyor; 15 dakikalık zaman konumu 10 dakikalık motor adımına aşağı yuvarlanmıyor. Geri sarmada gelecekteki dönüş görevi gösterilmiyor. Bilinmeyen süreler ve aktif müdahale için temsili yüzde üretilmiyor.
- `npm run resource:check`, hazırlık, varış, dönüş, devriye, ikmal, geri sarma, değişen görev ve gece duran uçuşları kapsıyor. Ana kontrol zincirine eklendi. Mevcut komuta sonucu (691 ha / 5.026 ha / 12 karar) ayrıca sabitlendi.
- Üretim derlemesinde T+1:00'a geri sarınca ilk arazöz için **20 dk varışa**, T+13:40'ta **20 dk dönüşe** gösterildi. Koyu/açık tema ve tatbikattaki dolgusuz sınır tarayıcıda doğrulandı; konsolda hata/uyarı görülmedi.

## Doğrulama

- `npm run build` ve `npm run check` geçti. Kontroller altı bölge × dört koşulda deterministik sonuçları, komuta davranışını ve statik sunucu kapısını içeriyor.
- Marmaris varsayılan koşusu **4.373 ha**; komuta kontrolü **691 ha**, müdahalesiz referans **5.026 ha** ve **12 karar** olarak korundu.
- Tarayıcıda kural tabanlı komuta, yangın sonrası strateji, önlem kartı açma/kapatma, harita ayrıntısı, önlemli yeniden çalıştırma ve karşılaştırma denendi. Aynı örnekte önlemli koşu **99,2 ha** ile tamamlandı.
- Stüdyo oynat/duraklat, hız, olaydan zamana geçiş, başlangıç noktası seçme/iptal etme, panel açma/kapatma, katmanlar, lejant, yeniden ortalama ve açık/koyu tema denendi.
- Tatbikatta gözetleme kulesi yerleştirme, **4,4 M TL** maliyetin bütçeye yansıması ve silme doğrulandı.
- **390 × 844** mobil görünümde Stüdyo haritası **420 px** yüksekliğini koruyor; belge ve ana içerikte yatay taşma görülmedi. Ayarlara ve oynatmaya erişim denendi.
- Sekiz ana bölüm üretim derlemesiyle açıldı. Son tarayıcı geçişinde konsol hata/uyarı kaydı görülmedi.

## Kapsam sınırları

Canlı yapay zeka bağlantısı yapılandırılmadığı için AI karar kalitesi bu çalışmada test edilmedi; tarayıcı testleri kural tabanlı komutanla yapıldı. 3B görünüm ve bütün tatbikat puanlama kombinasyonları için tam kullanıcı kabul testi yapılmadı. Mevcut büyük JavaScript paketleri için derleme boyutu uyarısı sürüyor; ayrı bir performans iyileştirme adımı gerekiyor. Prototipin bilimsel doğrulama ve üretim hazırlığı konuları `PROJECT_REVIEW.md` içinde izleniyor.
