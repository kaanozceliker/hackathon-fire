import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react'
import { useStore } from '../state/store'
import { fmtHa } from './ui'

export function Timeline() {
  const { active, step, setStep, playing, setPlaying, speed, setSpeed, restart } = useStore()
  const steps = active.result.steps
  const stat = active.result.series[step]
  const hours = active.result.config.durationH
  // At most ~12 hour labels whatever the duration (1–72 h).
  const every = [1, 2, 3, 4, 6, 12].find((e) => hours / e <= 12) ?? 12
  const ticks = Array.from({ length: Math.floor(hours / every) + 1 }, (_, i) => i * every)
  const p = (step / steps) * 100
  return (
    <div className="border border-line2 bg-bg/95 px-3 py-2 backdrop-blur-sm" role="group" aria-label="Simülasyon zaman çizelgesi">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1">
          <button onClick={() => setPlaying(!playing)} aria-label={playing ? 'Duraklat' : 'Oynat'} className="flex h-8 w-8 items-center justify-center bg-forest text-bg hover:bg-forest/85">
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button onClick={restart} aria-label="Başa dön" title="T+0'a sıfırla" className="flex h-8 w-8 items-center justify-center border border-line2 text-muted hover:text-ink"><RotateCcw size={15} /></button>
          <button onClick={() => setStep(step - 1)} aria-label="Bir adım geri" className="flex h-8 w-7 items-center justify-center border border-line2 text-muted hover:text-ink"><SkipBack size={14} /></button>
          <button onClick={() => setStep(step + 1)} aria-label="Bir adım ileri" className="flex h-8 w-7 items-center justify-center border border-line2 text-muted hover:text-ink"><SkipForward size={14} /></button>
        </div>
        <div className="min-w-[210px] flex-1">
          <input type="range" min={0} max={steps} value={step} onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)) }} style={{ ['--p' as string]: `${p}%` }} aria-label="Simülasyon zamanı" />
          <div className="relative -mt-0.5 h-4 text-[11px] text-muted">
            {ticks.map((t) => (
              <span key={t} className="absolute top-0" style={{ left: `${(t / hours) * 100}%`, transform: t === 0 ? 'none' : t === hours ? 'translateX(-100%)' : 'translateX(-50%)' }}>{t}sa</span>
            ))}
          </div>
        </div>
        <div className="flex items-baseline gap-3 text-[12px]">
          <div>
            <div className="text-muted">Geçen süre</div>
            <div className="text-[18px] font-semibold leading-none">T+{Math.floor(stat.minutes / 60)}:{String(stat.minutes % 60).padStart(2, '0')}</div>
          </div>
          <div>
            <div className="text-muted">Etkilenen</div>
            <div className="text-[18px] font-semibold leading-none text-amber">{fmtHa(stat.affectedHa)} <span className="text-[11px] font-normal text-muted">ha</span></div>
          </div>
        </div>
        <div className="flex border border-line2" role="radiogroup" aria-label="Oynatma hızı">
          {[0.5, 1, 2, 4].map((s) => (
            <button key={s} role="radio" aria-checked={speed === s} onClick={() => setSpeed(s)} className={`px-2 py-1 text-[12px] font-medium ${speed === s ? 'bg-forest-dim text-ink' : 'text-muted hover:text-ink'}`}>{s}×</button>
          ))}
        </div>
      </div>
    </div>
  )
}
