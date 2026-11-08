/**
 * Server side of the AI incident commander. The browser sends the situation summary of a decision point; this
 * asks an OpenAI model (ChatGPT API, Responses API with a strict JSON schema) for the decision and returns it.
 * The API key stays here, never in the browser. Model: OPENAI_MODEL, default gpt-5.5.
 *
 * Endpoints (mounted by vite.config.ts in dev and preview, or by server/index.ts on its own):
 *   GET  /api/commander/health  -> { ai: boolean, model }
 *   POST /api/commander         -> body { context } -> CommanderOutput, or an error the client answers with its rules
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'

const model = () => process.env.OPENAI_MODEL || 'gpt-5.5'

const SECTOR = z.enum(['K', 'KD', 'D', 'GD', 'G', 'GB', 'B', 'KB'])
const Output = z.object({
  assessment: z.string().describe('Tek kısa cümle: durum ve en büyük risk.'),
  phase: z.string().describe('Kısa evre adı, ör. "İlk müdahale", "1. güvenlik sınırı", "2. güvenlik sınırına geçiş", "Kontrol ve soğutma".'),
  // only the changes to rule_suggestion: everything left out is applied as the rules suggest (short output = fast answer)
  actions: z.array(
    z.object({
      type: z.enum(['attack', 'establish_line', 'assign_line', 'air_drop', 'evacuate', 'withdraw', 'hold']),
      candidate: z.enum(['A', 'B']).nullable(),
      line_id: z.string().nullable(),
      sector: SECTOR.nullable(),
      resource_id: z.string().nullable(),
      settlement_id: z.string().nullable(),
      rationale: z.string().describe('En fazla 12 kelimelik gerekçe.'),
    }),
  ),
})

const SYSTEM = `Sen ForestGuard simülasyonunda orman yangını olay komutanısın. Simülasyon temsilidir; kararların bir eğitim ve planlama aracında gösterilir, gerçek bir operasyonu yönetmez.

Her karar anında sana durumun JSON özeti gelir: yangın (sektörlere göre), şu anki ve önümüzdeki 6 saatin havası, yeni bir şey yapılmazsa 2 ve 5 saat sonraki tahmin, aday güvenlik sınırları, kurulu sınırlar, kaynaklar, yerleşimler, son olaylar ve önceki kararların. Ayrıca rule_suggestion: aynı an için test edilmiş kural tabanlı komutanın kararı.

ÇIKTI: actions listesine YALNIZCA rule_suggestion'dan FARKLI olan eylemleri yaz. Yazmadığın her şey rule_suggestion'daki gibi uygulanır. Öneri iyiyse actions boş liste olsun. Kısa yaz: hızlı yanıt önemli.

Sektörler ateşin başladığı noktaya göre 8 pusula yönüdür: K, KD, D, GD, G, GB, B, KB.

Eylemler (her eylemde kullanılmayan alanlar null):
- attack: bir kara ekibini (arazöz ekibi veya iş makinesi; resource_id) bir sektördeki yangın kenarına doğrudan söndürmeye gönderir (sector). Küçük yangında ve kanatlarda çok etkilidir; rüzgar arttıkça etkisi düşer, 30 km/sa üstü rüzgarda yangın başında güvenli değildir ve ekip geri çekilir.
- establish_line: aday sınırlardan birini (candidate "A" = ~2 saat ileride, "B" = ~5 saat ileride) güvenlik sınırı olarak kurar. Yeni sınırın kimliği next_line_id'dir (ör. "S1"); aynı kararda assign_line ile bu kimliği kullanabilirsin.
- assign_line: bir kara ekibini bir sınırın bir sektöründe yanıcı örtüyü temizlemeye (sınır açmaya) gönderir (line_id, sector, resource_id). İş makinesi bir ekipten ~4 kat hızlı açar. Tamamlanan sektörü ekip tutar. Yangın 200 m'ye yaklaşırsa ekip kendiliğinden çekilir.
- air_drop: bir helikopter veya söndürme uçağını (resource_id) bir sektörde yangın başına tekrarlı su atışına gönderir (sector). Hava araçları sadece 06:00-20:00 arası uçar.
- evacuate: bir yerleşimin tahliyesini başlatır (settlement_id). Tahliye 30 dk + 8000 kişi başına 1 saat sürer; yangın gelmeden bitmesi gerekir.
- withdraw: bir kaynağı görevden alır (resource_id).
- hold: değişiklik yok.

Amaç: yanan alanı ve süreyi en aza indirmek, can kaybını sıfırda tutmak.

rule_suggestion senin TEMELİN. Yalnızca verilerle daha iyi olduğunu gösterebildiğin yerde değiştir (ör. sektördeki büyüme, rüzgar tahmini, sınırın aşılması); bir kaynağın görevini değiştirmek için o kaynak için yeni eylemi yaz.

Kesin kurallar:
- Görevdeki kaynağı yeniden görevlendirme ve withdraw verme; her yer değişikliği yol süresi kaybettirir. İstisna: o kaynağın sektörü söndüyse veya sınırı aşıldıysa.
- Hava araçları gündüz yangının başına (spreading_toward sektörü) su atar; en hızlı büyüyen sektör başa eşittir.
- Rüzgar 20 km/sa üstündeyse kara ekiplerini başa değil kanatlara (başın iki yanı) ve arkaya gönder.
- Yangın 400 ha üstünde veya rüzgar ≥30 km/sa ise başın önüne güvenlik sınırı kur: candidate "B" (5 saat ileride) seç; "A" (2 saat) genelde inşa bitmeden aşılır, sadece yangın küçük ve rüzgar zayıfsa A'yı seç. İş makinelerini bu sınırın baş sektörüne ata.
- Sınır baş tarafta aşıldıysa hemen yeni bir B sınırı kur.
- Önce can güvenliği: forecast_fire_arrival dolu olan veya yangına 3 km'den yakın her yerleşimi tahliye et.
- Sadece verilen kimlikleri kullan (resource_id, settlement_id, line_id, candidate). "henüz yok" durumundaki kaynağı görevlendirme.
- Tüm metinler Türkçe, kısa ve somut olsun; sayıları ve saatleri verilen veriden al, uydurma.`

let client: OpenAI | null = null

/** The rules' suggestion without its wording: the model needs the actions, not the texts (shorter input). */
function compactContext(ctx: unknown): unknown {
  const c = ctx as { rule_suggestion?: { phase?: string; actions?: Record<string, unknown>[] } }
  if (!c?.rule_suggestion?.actions) return ctx
  const actions = c.rule_suggestion.actions.map((a) => Object.fromEntries(Object.entries(a).filter(([k, v]) => k !== 'rationale' && v !== null)))
  return { ...c, rule_suggestion: { phase: c.rule_suggestion.phase, actions } }
}
const hasKey = () => !!process.env.OPENAI_API_KEY

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export async function commanderHandler(req: IncomingMessage, res: ServerResponse, next?: () => void) {
  const url = req.url ?? ''
  if (req.method === 'GET' && url.endsWith('/health')) return send(res, 200, { ai: hasKey(), model: model() })
  if (req.method !== 'POST') return next ? next() : send(res, 404, { error: 'not found' })
  if (!hasKey()) return send(res, 503, { error: 'Sunucuda OPENAI_API_KEY tanımlı değil.' })
  let body: { context?: unknown }
  try {
    body = (await readJson(req)) as { context?: unknown }
  } catch {
    return send(res, 400, { error: 'Geçersiz JSON.' })
  }
  if (!body.context) return send(res, 400, { error: 'context eksik.' })
  client ??= new OpenAI()
  try {
    const response = await client.responses.parse({
      model: model(),
      instructions: SYSTEM,
      input: `Karar anı. Durum:
${JSON.stringify(compactContext(body.context))}`,
      // most of the wait is the model thinking. "none": ~2 s a decision and still better than the rules (it starts
      // from their decision and only writes changes); COMMANDER_EFFORT=low in .env thinks more, ~4 s a decision
      reasoning: { effort: (process.env.COMMANDER_EFFORT as 'none' | 'low' | 'medium' | undefined) ?? 'none' },
      max_output_tokens: 3000,
      text: { format: zodTextFormat(Output, 'komutan_karari') },
    })
    const refusal = response.output
      .flatMap((o) => (o.type === 'message' ? o.content : []))
      .find((c) => c.type === 'refusal')
    if (refusal) return send(res, 422, { error: 'Model bu karar anını yanıtlamadı (refusal).' })
    if (!response.output_parsed) return send(res, 502, { error: `Yanıt şemaya uymadı (durum: ${response.status}${response.incomplete_details ? `, ${response.incomplete_details.reason}` : ''}).` })
    return send(res, 200, { output: response.output_parsed, usage: response.usage })
  } catch (e) {
    if (e instanceof OpenAI.AuthenticationError) return send(res, 503, { error: 'OpenAI API anahtarı geçersiz.' })
    if (e instanceof OpenAI.RateLimitError) return send(res, 429, { error: 'OpenAI istek sınırına veya kotaya takıldı, biraz sonra tekrar deneyin.' })
    if (e instanceof OpenAI.NotFoundError) return send(res, 502, { error: `Model bulunamadı: ${model()}. .env içindeki OPENAI_MODEL değerini kontrol edin.` })
    if (e instanceof OpenAI.APIError) return send(res, 502, { error: `OpenAI API hatası ${e.status ?? ''}: ${e.message}` })
    return send(res, 500, { error: (e as Error).message })
  }
}

// ---------------------------------------------------------------- post-fire strategy

const ZONE_SECTOR = z.enum(['K', 'KD', 'D', 'GD', 'G', 'GB', 'B', 'KB'])
const Plan = z.object({
  summary: z.string().describe('3-5 cümlelik genel strateji: neler yandı, en büyük riskler, öncelik sırası.'),
  zones: z.array(
    z.object({
      sector: ZONE_SECTOR,
      action: z.enum(['dogal_yenilenme', 'dikim', 'erozyon_onlemi', 'izleme']),
      species: z.array(z.string()).describe('Önerilen türler, Türkçe ve bilimsel adıyla; izleme ise boş.'),
      timing: z.string().describe('Ne zaman yapılmalı.'),
      rationale: z.string().describe('Bu bölge için verideki sayılara dayanan gerekçe.'),
    }),
  ),
  prevention: z.array(z.object({ measure: z.string(), where: z.string(), rationale: z.string() })).describe('Bölgede yeniden yangın çıkmaması ve yayılmaması için önlemler.'),
  phases: z.array(z.object({ phase: z.enum(['ilk_72_saat', 'ilk_3_ay', 'ilk_yil', 'yil_1_5']), actions: z.array(z.string()) })),
  monitoring: z.array(z.string()),
  caveats: z.string().describe('Belirsizlikler ve sahada doğrulanması gerekenler.'),
})

const RECOVERY_SYSTEM = `Sen Türkiye Akdeniz ve Ege ormanlarında yangın sonrası rehabilitasyon ve ağaçlandırma uzmanısın. ForestGuard simülasyonunda (temsili, eğitim ve planlama amaçlı) sönmüş bir yangının özeti sana gelir: yanan alan 8 bölgeye (yangının başladığı noktaya göre pusula sektörleri: K, KD, D, GD, G, GB, B, KB) ayrılmıştır; her bölge için yanan orman alanı, çam payı, ortalama yükselti, eğim, %30'dan dik alan payı, bakı, yanmamış ormana yakınlık (tohum kaynağı), yakın yerleşimler ve yanan alanın tahmini tür bileşimi (species_burned: tür, oran, yangın sonrası yenilenme biçimi; bölgenin yükselti kuşaklarına göre tahmindir) verilir. Eylem ve tür seçiminde bu bileşimi ve türlerin yenilenme biçimini kullan: kızılçam tohumla kendiliğinden yenilenir, karaçam/sedir/göknar dikim ister, meşe ve maki kökten sürgün verir, sığla korunmalı. Ayrıca iklim, yangının ulaştığı yerleşimler, bölgede kayıtlı türler ve müdahale özeti gelir.

Görevin bir yangın sonrası stratejisi hazırlamak:
- zones: veride geçen HER bölge için tek eylem seç: dogal_yenilenme (kızılçam gibi tohumla kendiliğinden yenilenen ve tohum kaynağı yakın alanlar; koruma ve otlatma yasağı), dikim (tohum kaynağı uzak, maki veya bozuk alan), erozyon_onlemi (dik yamaçlar; önce kontur dal çiti, yamaç ıslahı, sonra dikim), izleme (yanan orman alanı çok küçük). Türleri yükselti kuşağına ve bakıya uygun seç (ör. alçak kesimlerde kızılçam ve maki türleri, yukarıda karaçam, sedir), mümkünse yangına dirençli karışık kuşaklar öner.
- prevention: bölgede yeniden yangın çıkmaması ve yayılmaması için somut önlemler (yerleşim–orman ara yüzü, yangın emniyet yolları, su depoları, gözetleme, eğitim vb.), nerede uygulanacağıyla.
- phases: ilk_72_saat, ilk_3_ay, ilk_yil, yil_1_5 için eylem listeleri (soğutma ve güvenlik, erozyon ve sel önlemi, otlatma yasağı, yaban hayatı, dikim, tamamlama, izleme).
- monitoring: izleme göstergeleri.
- caveats: sahada doğrulanması gerekenler.

Sayıları ve adları verilen veriden al, uydurma. Metinler Türkçe, kısa ve uygulanabilir olsun.`

export async function recoveryHandler(req: IncomingMessage, res: ServerResponse, next?: () => void) {
  if (req.method !== 'POST') return next ? next() : send(res, 404, { error: 'not found' })
  if (!hasKey()) return send(res, 503, { error: 'Sunucuda OPENAI_API_KEY tanımlı değil.' })
  let body: { context?: unknown }
  try {
    body = (await readJson(req)) as { context?: unknown }
  } catch {
    return send(res, 400, { error: 'Geçersiz JSON.' })
  }
  if (!body.context) return send(res, 400, { error: 'context eksik.' })
  client ??= new OpenAI()
  try {
    const response = await client.responses.parse({
      model: model(),
      instructions: RECOVERY_SYSTEM,
      input: `Yangın sonrası durum:\n${JSON.stringify(body.context, null, 1)}`,
      reasoning: { effort: 'medium' },
      max_output_tokens: 12000,
      text: { format: zodTextFormat(Plan, 'yangin_sonrasi_strateji') },
    })
    if (!response.output_parsed) return send(res, 502, { error: `Yanıt şemaya uymadı (durum: ${response.status}).` })
    return send(res, 200, { output: response.output_parsed, model: model() })
  } catch (e) {
    if (e instanceof OpenAI.AuthenticationError) return send(res, 503, { error: 'OpenAI API anahtarı geçersiz.' })
    if (e instanceof OpenAI.RateLimitError) return send(res, 429, { error: 'OpenAI istek sınırına veya kotaya takıldı.' })
    if (e instanceof OpenAI.APIError) return send(res, 502, { error: `OpenAI API hatası ${e.status ?? ''}: ${e.message}` })
    return send(res, 500, { error: (e as Error).message })
  }
}

// ---------------------------------------------------------------- prevention ("Bugün ne yapabiliriz?")

const Prevention = z.object({
  summary: z.string().describe('3-4 cümle: ilk yangından çıkan ders ve seçilen önlem paketinin mantığı.'),
  selected: z.array(z.object({ id: z.string(), priority: z.number().int(), rationale: z.string() })).describe('Seçilen aday önlemlerin kimlikleri (yalnızca verilenlerden), öncelik sırası (1 = en önce) ve gerekçesi.'),
  expected_effect: z.string().describe('Beklenen etki, nitel olarak.'),
  caveats: z.string(),
})

const PREVENTION_SYSTEM = `Sen orman yangını önleme ve risk azaltma uzmanısın. ForestGuard simülasyonunda (temsili, eğitim ve planlama amaçlı) bir yangın yaşandı. Sana ilk yangının özeti ve bugünden uygulanabilecek aday önlemler gelir: her adayın kimliği, türü, yeri, alanı, temsili maliyeti (bin TL) ve ilk yangında o yerde ne olduğu (evidence).

Görevin bir sonraki yangında tahribatı en çok azaltacak önlem paketini seçmek:
- Yalnızca verilen aday kimliklerinden seç; 3 ile 8 arası önlem seç.
- Can güvenliğini (yangının ulaştığı yerleşimler) ve yangının ana yayılma eksenini önceliklendir; erken tespit ve ilk müdahale güçlendirmesini değerlendir.
- Maliyet/etki dengesini gözet; gereksiz tekrar eden önlemleri seçme.
- Her seçim için ilk yangındaki sayılara dayanan kısa gerekçe yaz.
Seçtiğin önlemler simülasyonda uygulanıp aynı yangın yeniden çalıştırılacak ve sonuç karşılaştırılacak. Metinler Türkçe, kısa ve somut olsun; sayıları uydurma.`

export async function preventionHandler(req: IncomingMessage, res: ServerResponse, next?: () => void) {
  if (req.method !== 'POST') return next ? next() : send(res, 404, { error: 'not found' })
  if (!hasKey()) return send(res, 503, { error: 'Sunucuda OPENAI_API_KEY tanımlı değil.' })
  let body: { context?: unknown }
  try {
    body = (await readJson(req)) as { context?: unknown }
  } catch {
    return send(res, 400, { error: 'Geçersiz JSON.' })
  }
  if (!body.context) return send(res, 400, { error: 'context eksik.' })
  client ??= new OpenAI()
  try {
    const response = await client.responses.parse({
      model: model(),
      instructions: PREVENTION_SYSTEM,
      input: `İlk yangın ve aday önlemler:\n${JSON.stringify(body.context, null, 1)}`,
      reasoning: { effort: 'medium' },
      max_output_tokens: 6000,
      text: { format: zodTextFormat(Prevention, 'onlem_paketi') },
    })
    if (!response.output_parsed) return send(res, 502, { error: `Yanıt şemaya uymadı (durum: ${response.status}).` })
    return send(res, 200, { output: response.output_parsed, model: model() })
  } catch (e) {
    if (e instanceof OpenAI.AuthenticationError) return send(res, 503, { error: 'OpenAI API anahtarı geçersiz.' })
    if (e instanceof OpenAI.RateLimitError) return send(res, 429, { error: 'OpenAI istek sınırına veya kotaya takıldı.' })
    if (e instanceof OpenAI.APIError) return send(res, 502, { error: `OpenAI API hatası ${e.status ?? ''}: ${e.message}` })
    return send(res, 500, { error: (e as Error).message })
  }
}

// ---------------------------------------------------------------- end-of-run report

const Report = z.object({
  headline: z.string().describe('Tek cümlelik manşet: en önemli sonuç, en fazla 20 kelime.'),
  executive_summary: z.string().describe('2-3 kısa cümlelik yönetici özeti.'),
  key_findings: z.array(z.object({ title: z.string().describe('En fazla 5 kelime.'), value: z.string().describe('Kısa sayı ve birim, ör. "5.385 ha", "T+3:40", "%62".'), detail: z.string().describe('Tek kısa cümle, en fazla 15 kelime.') })).describe('3-6 temel bulgu; her biri verideki bir sayıya dayanır.'),
  risks: z.array(z.object({ title: z.string().describe('En fazla 6 kelime.'), severity: z.enum(['yuksek', 'orta', 'dusuk']), category: z.enum(['can', 'saglik', 'altyapi', 'doga']), detail: z.string().describe('Tek kısa cümle.') })).describe('Can, sağlık, altyapı ve doğa açısından en önemli riskler.'),
  recommendations: z.array(z.object({ action: z.string().describe('Emir kipinde, en fazla 8 kelime.'), when: z.enum(['hemen', 'ilk_6_saat', 'yangin_suresince', 'yangin_sonrasi', 'gelecek_sezon']), rationale: z.string().describe('Tek kısa cümle.') })).describe('Öncelik sırasına göre 3-7 öneri.'),
  public_message: z.string().describe('Yerleşimlerde yaşayanlara yönelik 2 cümlelik sade bilgilendirme.'),
  caveats: z.string().describe('Simülasyonun sınırları ve doğrulanması gerekenler.'),
})

const REPORT_SYSTEM = `Sen orman yangını analisti ve afet iletişimi uzmanısın. ForestGuard simülasyonunda (temsili, eğitim ve planlama amaçlı) bir yangın simülasyonu bitti. Sana kural tabanlı raporun bölümleri gelir: senaryo, hava, yangın davranışı, risk altındaki yerleşimler, emisyonlar, dumanın insanlara ve yaban hayatına etkisi, varsa müdahale ve komuta kararları, erişim önerileri.

Görevin bu verilerden karar vericiler için kısa ve anlaşılır bir değerlendirme raporu yazmak:
- Yalnızca verilen sayıları, adları ve saatleri kullan; uydurma, yuvarlarken anlamı değiştirme.
- Verinin söylediğini tekrar etme; önemini ve birbirleriyle ilişkisini açıkla (ör. rüzgar dönüşü hangi yerleşimi tehdit ediyor, duman hangi grubu etkiliyor).
- Önerileri öncelik sırasıyla, somut ve uygulanabilir yaz.
- Simülasyonun temsili olduğunu caveats içinde belirt.
Rapor grafiklerle birlikte gösterilecek: sayıları grafikler zaten gösteriyor, metni kısa tut; uzun paragraf yazma.
- key_findings, ekranda zaten kutucuklarda duran toplam alan, orman alanı, ulaşılan yerleşim sayısı, en hızlı cephe, CO₂ salımı ve en yüksek PM2.5 değerlerini TEKRAR ETMESİN. Bunun yerine bunlardan çıkan sonuçları ver: hangi yerleşim kaç saatte tehlikeye girdi, rüzgar dönüşünün etkisi, tahliye için kalan süre, en uzun sağlıksız duman süresi, hangi yolun ilk kesildiği gibi.
Metinler Türkçe, sade ve kısa olsun.`

export async function reportHandler(req: IncomingMessage, res: ServerResponse, next?: () => void) {
  if (req.method !== 'POST') return next ? next() : send(res, 404, { error: 'not found' })
  if (!hasKey()) return send(res, 503, { error: 'Sunucuda OPENAI_API_KEY tanımlı değil.' })
  let body: { context?: unknown }
  try {
    body = (await readJson(req)) as { context?: unknown }
  } catch {
    return send(res, 400, { error: 'Geçersiz JSON.' })
  }
  if (!body.context) return send(res, 400, { error: 'context eksik.' })
  client ??= new OpenAI()
  try {
    const response = await client.responses.parse({
      model: model(),
      instructions: REPORT_SYSTEM,
      input: `Simülasyon raporu verileri:\n${JSON.stringify(body.context, null, 1)}`,
      reasoning: { effort: 'low' },
      max_output_tokens: 8000,
      text: { format: zodTextFormat(Report, 'simulasyon_raporu') },
    })
    if (!response.output_parsed) return send(res, 502, { error: `Yanıt şemaya uymadı (durum: ${response.status}).` })
    return send(res, 200, { output: response.output_parsed, model: model() })
  } catch (e) {
    if (e instanceof OpenAI.AuthenticationError) return send(res, 503, { error: 'OpenAI API anahtarı geçersiz.' })
    if (e instanceof OpenAI.RateLimitError) return send(res, 429, { error: 'OpenAI istek sınırına veya kotaya takıldı.' })
    if (e instanceof OpenAI.APIError) return send(res, 502, { error: `OpenAI API hatası ${e.status ?? ''}: ${e.message}` })
    return send(res, 500, { error: (e as Error).message })
  }
}

// ---------------------------------------------------------------- Tatbikat: the optimal prevention plan

const DRILL_SYSTEM = `Sen orman yangını önleme planlama uzmanısın. ForestGuard tatbikat sınavında (temsili, eğitim amaçlı) bir kullanıcı, yangının nerede çıkacağını bilmeden önlem planı yaptı. Şimdi en optimal planı sen göstereceksin.

Sana bölge, hava, bütçe, zarar değerleri (yanan orman hektarı, diğer alan, yangının ulaştığı yerleşim başına TL), önlemsiz durumda en olası yangınların sonuçları ve aday önlemler gelir: her adayın kimliği, türü, boyutu, maliyeti (TL), doğaya etkisi (eşdeğer hektar) ve gerekçesi.

Görevin: beklenen zarar azalması − önlem maliyeti en yüksek olacak, doğaya en az dokunan önlem setini seçmek.
- Yalnızca verilen aday kimliklerinden seç; bütçeyi aşma.
- Aynı alanı izleyen iki gözetleme seçme; kamera ucuzsa ve yeterliyse kuleyi seçme.
- Yangının ulaştığı yerleşimlerin çevre temizliği genellikle en verimli önlemdir.
- Gereğinden fazla önlem alma: önlediği zarardan pahalı bir önlemi seçme. Doğaya büyük müdahale (geniş aralama, uzun geniş şerit) ancak açıkça gerekçeliyse.
- Her seçim için verideki sayılara dayanan tek cümlelik gerekçe yaz; summary'de neden bu setin optimal olduğunu ve neyi bilerek seçmediğini 2-3 cümleyle anlat.
Metinler Türkçe, kısa ve somut olsun; sayıları uydurma.`

export async function drillHandler(req: IncomingMessage, res: ServerResponse, next?: () => void) {
  if (req.method !== 'POST') return next ? next() : send(res, 404, { error: 'not found' })
  if (!hasKey()) return send(res, 503, { error: 'Sunucuda OPENAI_API_KEY tanımlı değil.' })
  let body: { context?: unknown }
  try {
    body = (await readJson(req)) as { context?: unknown }
  } catch {
    return send(res, 400, { error: 'Geçersiz JSON.' })
  }
  if (!body.context) return send(res, 400, { error: 'context eksik.' })
  client ??= new OpenAI()
  try {
    const response = await client.responses.parse({
      model: model(),
      instructions: DRILL_SYSTEM,
      input: `Tatbikat verisi:\n${JSON.stringify(body.context, null, 1)}`,
      reasoning: { effort: 'low' },
      max_output_tokens: 16000,
      text: { format: zodTextFormat(Prevention, 'optimal_plan') },
    })
    if (!response.output_parsed) return send(res, 502, { error: `Yanıt şemaya uymadı (durum: ${response.status}).` })
    return send(res, 200, { output: response.output_parsed, model: model() })
  } catch (e) {
    if (e instanceof OpenAI.AuthenticationError) return send(res, 503, { error: 'OpenAI API anahtarı geçersiz.' })
    if (e instanceof OpenAI.RateLimitError) return send(res, 429, { error: 'OpenAI istek sınırına veya kotaya takıldı.' })
    if (e instanceof OpenAI.APIError) return send(res, 502, { error: `OpenAI API hatası ${e.status ?? ''}: ${e.message}` })
    return send(res, 500, { error: (e as Error).message })
  }
}

// ---------------------------------------------------------------- Varlık Kalkanı: risk profile of one asset

const SECTOR_ENUM = z.enum(['K', 'KD', 'D', 'GD', 'G', 'GB', 'B', 'KB'])
const LEVEL_ENUM = z.enum(['dusuk', 'orta', 'yuksek', 'cok_yuksek'])
const AssetReport = z.object({
  risk_level: LEVEL_ENUM,
  headline: z.string().describe('Tek cümle: en önemli tehdit ve hangi cephe, ör. "Güneybatıdaki yoğun bitki örtüsü ve hakim rüzgar nedeniyle bu cephe öncelikli incelenmeli."'),
  summary: z.string().describe('2-3 cümlelik genel değerlendirme; test yangınının ulaşma süresini ve itfaiyenin varış süresini kullan.'),
  priority_sectors: z.array(z.object({ sector: SECTOR_ENUM, level: LEVEL_ENUM, reason: z.string().describe('Tek cümle, verideki sayılarla.') })).describe('En riskli 2-4 yön, en riskliden başlayarak.'),
  actions: z.array(z.object({
    title: z.string().describe('Emir kipinde, somut, en fazla 10 kelime.'),
    where: z.string().describe('Yapı, yakın çevre (0-30 m), 30-100 m kuşak, bir cephe (ör. "Güneybatı cephesi") veya giriş yolu.'),
    when: z.enum(['hemen', 'sezon_oncesi', 'yangin_sezonu', 'surekli']),
    effort: z.enum(['dusuk', 'orta', 'yuksek']),
    reason: z.string().describe('Tek cümle, bu varlığa özgü gerekçe.'),
  })).describe('Öncelik sırasıyla 4-8 önlem.'),
  emergency: z.array(z.string()).describe('Yangın anında yapılacak 3-5 madde.'),
  access_note: z.string().describe('İtfaiye erişimi ve su kaynağı hakkında tek cümle.'),
  caveats: z.string(),
})

const ASSET_SYSTEM = `Sen orman-yerleşim ara yüzünde (WUI) yapıların yangın riskini değerlendiren bir uzmansın. ForestGuard "Varlık Kalkanı" aracında bir kullanıcı haritada kendi varlığını (ev, işyeri, tesis) çizdi. Sana bu varlığın çevresinin sayısal analizi gelir:
- halkalar: 0-150 m, 150-500 m, 500-2000 m içinde orman, maki, açık alan, yerleşim, su (ha) ve ortalama yakıt;
- 8 yön (yönden gelen): 2 km içinde orman+maki, 300 m içinde bitki, yapıya doğru yokuş yüzdesi (pozitifse yangın yokuş yukarı yapıya koşar), rüzgarın o yönden esme payı, puan;
- 7 günlük hava tahmini ve bölgenin tipik yangın sezonu rüzgarı, 30-30-30 günleri (≥30 °C, ≤%30 nem, ≥30 km/sa rüzgar civarı);
- erişim: en yakın yol, itfaiye istasyonu ve yolla varış süresi, en yakın su kaynağı;
- daha önce yanmış alan, gözetleme kulesi;
- test yangınları: en riskli yönlerden ~1,5 km öteden çıkan yangının yapıya ulaşma süresi.

Görevin varlık sahibine anlaşılır bir risk profili ve önlem raporu yazmak:
- headline: en önemli tehdidi yön adıyla söyle (ör. "Güneybatıdaki yoğun bitki örtüsü ve hakim rüzgar koşulları nedeniyle bu cephe öncelikli incelenmeli").
- Varlığın türüne göre düşün (type ve type_vulnerabilities): fabrika, güneş enerji santrali (GES), maden sahası ya da özel mülk için riskler ve önlemler farklıdır; en az iki önlem bu türe özgü olsun.
- Önlemler somut olsun: yakın çevrede yanmaz alan (0-30 m), 30-100 m kuşakta yakıt azaltma ve ağaç taçlarını açma, çatı/oluk/havalandırma kor koruması, odun ve yanıcı malzemeyi uzaklaştırma, itfaiye erişim yolu, su deposu, kuru ot biçme vb. Her önlemi bu varlığın verisine bağla.
- Yönleri Türkçe tam adla yaz (Kuzey, Kuzeydoğu, Doğu, Güneydoğu, Güney, Güneybatı, Batı, Kuzeybatı).
- Sayıları verilen veriden al, uydurma. Risk düzeyini hesaplanan puana yakın tut, ancak gerekçeliyse bir basamak değiştirebilirsin.
- Metinler Türkçe, kısa ve uygulanabilir olsun; varlık sahibi uzman değildir.`

export async function assetHandler(req: IncomingMessage, res: ServerResponse, next?: () => void) {
  if (req.method !== 'POST') return next ? next() : send(res, 404, { error: 'not found' })
  if (!hasKey()) return send(res, 503, { error: 'Sunucuda OPENAI_API_KEY tanımlı değil.' })
  let body: { context?: unknown }
  try {
    body = (await readJson(req)) as { context?: unknown }
  } catch {
    return send(res, 400, { error: 'Geçersiz JSON.' })
  }
  if (!body.context) return send(res, 400, { error: 'context eksik.' })
  client ??= new OpenAI()
  try {
    const response = await client.responses.parse({
      model: model(),
      instructions: ASSET_SYSTEM,
      input: `Varlık analizi:\n${JSON.stringify(body.context, null, 1)}`,
      reasoning: { effort: 'low' },
      max_output_tokens: 12000,
      text: { format: zodTextFormat(AssetReport, 'varlik_risk_raporu') },
    })
    if (!response.output_parsed) return send(res, 502, { error: `Yanıt şemaya uymadı (durum: ${response.status}).` })
    return send(res, 200, { output: response.output_parsed, model: model() })
  } catch (e) {
    if (e instanceof OpenAI.AuthenticationError) return send(res, 503, { error: 'OpenAI API anahtarı geçersiz.' })
    if (e instanceof OpenAI.RateLimitError) return send(res, 429, { error: 'OpenAI istek sınırına veya kotaya takıldı.' })
    if (e instanceof OpenAI.APIError) return send(res, 502, { error: `OpenAI API hatası ${e.status ?? ''}: ${e.message}` })
    return send(res, 500, { error: (e as Error).message })
  }
}
