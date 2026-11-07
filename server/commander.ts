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
  assessment: z.string().describe('2-4 cümlelik durum değerlendirmesi: ne oluyor, en büyük risk ne.'),
  phase: z.string().describe('Kısa evre adı, ör. "İlk müdahale", "1. güvenlik sınırı", "2. güvenlik sınırına geçiş", "Kontrol ve soğutma".'),
  actions: z.array(
    z.object({
      type: z.enum(['attack', 'establish_line', 'assign_line', 'air_drop', 'evacuate', 'withdraw', 'hold']),
      candidate: z.enum(['A', 'B']).nullable(),
      line_id: z.string().nullable(),
      sector: SECTOR.nullable(),
      resource_id: z.string().nullable(),
      settlement_id: z.string().nullable(),
      rationale: z.string().describe('Bu eylemin tek cümlelik gerekçesi.'),
    }),
  ),
})

const SYSTEM = `Sen ForestGuard simülasyonunda orman yangını olay komutanısın. Simülasyon temsilidir; kararların bir eğitim ve planlama aracında gösterilir, gerçek bir operasyonu yönetmez.

Her karar anında sana durumun JSON özeti gelir: yangın (sektörlere göre), şu anki ve önümüzdeki 6 saatin havası, yeni bir şey yapılmazsa 2 ve 5 saat sonraki tahmin, aday güvenlik sınırları, kurulu sınırlar, kaynaklar, yerleşimler, son olaylar ve önceki kararların. Kararını eylem listesi olarak ver.

Sektörler ateşin başladığı noktaya göre 8 pusula yönüdür: K, KD, D, GD, G, GB, B, KB.

Eylemler (her eylemde kullanılmayan alanlar null):
- attack: bir kara ekibini (arazöz ekibi veya iş makinesi; resource_id) bir sektördeki yangın kenarına doğrudan söndürmeye gönderir (sector). Küçük yangında ve kanatlarda çok etkilidir; rüzgar arttıkça etkisi düşer, 30 km/sa üstü rüzgarda yangın başında güvenli değildir ve ekip geri çekilir.
- establish_line: aday sınırlardan birini (candidate "A" = ~2 saat ileride, "B" = ~5 saat ileride) güvenlik sınırı olarak kurar. Yeni sınırın kimliği next_line_id'dir (ör. "S1"); aynı kararda assign_line ile bu kimliği kullanabilirsin.
- assign_line: bir kara ekibini bir sınırın bir sektöründe yanıcı örtüyü temizlemeye (sınır açmaya) gönderir (line_id, sector, resource_id). İş makinesi bir ekipten ~4 kat hızlı açar. Tamamlanan sektörü ekip tutar. Yangın 200 m'ye yaklaşırsa ekip kendiliğinden çekilir.
- air_drop: bir helikopter veya söndürme uçağını (resource_id) bir sektörde yangın başına tekrarlı su atışına gönderir (sector). Hava araçları sadece 06:00-20:00 arası uçar.
- evacuate: bir yerleşimin tahliyesini başlatır (settlement_id). Tahliye 30 dk + 8000 kişi başına 1 saat sürer; yangın gelmeden bitmesi gerekir.
- withdraw: bir kaynağı görevden alır (resource_id).
- hold: değişiklik yok.

İlkeler:
- Önce can güvenliği: yangının tahminen ulaşacağı veya 3 km'ye yaklaştığı yerleşimleri zamanında tahliye et; ekipleri rüzgarın sürüklediği yangın başına gönderme.
- Yangın küçükken doğrudan müdahale (attack) ile söndürmeyi dene; büyük veya rüzgarlı yangında başın önüne güvenlik sınırı kur, kanatlarda doğrudan müdahaleyi sürdür. Rüzgar artarsa veya sınır baş tarafta aşılırsa daha geniş ikinci sınıra geç.
- Görevde olan kaynağı gereksiz yere yeniden görevlendirme: her yer değişikliği yol süresi kaybettirir. Yeniden görevlendirmeyi boşta, geri çekilmiş kaynaklar veya açıkça değişen durum için yap.
- Sadece verilen kimlikleri kullan (resource_id, settlement_id, line_id, candidate). Kaynağı "henüz yok" olanı görevlendirme.
- Durum gerektirmiyorsa tek bir hold eylemi ver.
- Tüm metinler Türkçe, kısa ve somut olsun; sayıları ve saatleri verilen veriden al, uydurma.`

let client: OpenAI | null = null
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
${JSON.stringify(body.context, null, 1)}`,
      reasoning: { effort: 'medium' },
      max_output_tokens: 8000,
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

const RECOVERY_SYSTEM = `Sen Türkiye Akdeniz ve Ege ormanlarında yangın sonrası rehabilitasyon ve ağaçlandırma uzmanısın. ForestGuard simülasyonunda (temsili, eğitim ve planlama amaçlı) sönmüş bir yangının özeti sana gelir: yanan alan 8 bölgeye (yangının başladığı noktaya göre pusula sektörleri: K, KD, D, GD, G, GB, B, KB) ayrılmıştır; her bölge için yanan orman alanı, çam payı, ortalama yükselti, eğim, %30'dan dik alan payı, bakı, yanmamış ormana yakınlık (tohum kaynağı) ve yakın yerleşimler verilir. Ayrıca iklim, yangının ulaştığı yerleşimler, bölgede kayıtlı türler ve müdahale özeti gelir.

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
