import { useState } from 'react'
import { ClipboardCheck, ShieldCheck } from 'lucide-react'
import { PreventionExam } from './drill/PreventionExam'

/** Tatbikat: the prevention exam on real areas with random fire weather. */
export function Drill() {
  const [exam, setExam] = useState<0 | 1>(0)
  const [key, setKey] = useState(0)
  const open = (e: 1) => {
    setKey((k) => k + 1)
    setExam(e)
  }
  if (exam === 1) return <PreventionExam key={key} onExit={() => setExam(0)} />
  return (
    <div className="mx-auto max-w-[980px] p-4">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted"><ClipboardCheck size={14} /> Tatbikat</div>
      <h1 className="mt-1 text-[22px] font-semibold">Kendinizi sınayın</h1>
      <p className="mt-1 max-w-[720px] text-[13.5px] leading-relaxed text-muted">Gerçek arazi, yol ve yerleşim verisi üzerinde rastgele bir yangın gününde önlem sınavı. Kararlarınız simülasyonda uygulanır; sonunda puan, hatalarınız ve daha iyi bir çözüm gösterilir. Simülasyon temsilidir, maliyetler yaklaşıktır.</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <button onClick={() => open(1)} className="group border border-line2 bg-panel p-5 text-left hover:border-forest">
          <ShieldCheck size={26} className="text-forest" />
          <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Sınav 1</div>
          <div className="text-[18px] font-semibold">Önlem</div>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">Yangın nerede çıkacak bilmiyorsunuz. Bölge ve hava durumu verilir; gözetleme kulesi, kamera, emniyet şeridi, aralama, yerleşim temizliği, yangın havuzu ve ön konuşlanmayla bütçe içinde plan yaparsınız. Sistem en olası noktalardan yangın başlatır; zararı ne kadar önlediğiniz, ne harcadığınız ve doğaya ne kadar dokunduğunuz puanlanır. Sonunda optimal plan gösterilir.</p>
          <div className="mt-4 text-[13px] font-semibold text-forest group-hover:underline">Sınava başla →</div>
        </button>
      </div>
    </div>
  )
}
