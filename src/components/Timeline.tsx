import { useMemo } from 'react'
import { useStore } from '../state/store'
import { fmtHa } from './ui'
import { PlaybackBar } from './PlaybackBar'
import { simulationEvents } from './SimulationEvents'

export function Timeline({ disabled = false }: { disabled?: boolean }) {
  const { active, step, setStep, playing, setPlaying, speed, setSpeed, restart } = useStore()
  const result = active.result
  const markers = useMemo(() => simulationEvents(result).filter((event) => event.kind !== 'spot').map((event) => ({ id: event.id, step: event.step, color: event.color, label: event.title })), [result])
  return (
    <PlaybackBar step={step} steps={result.steps} stepMin={result.stepMin} playing={playing} onPlay={() => setPlaying(!playing)} onSeek={(next) => { setPlaying(false); setStep(next) }} onRestart={restart} speed={speed} onSpeed={setSpeed} markers={disabled ? [] : markers} disabled={disabled}
      summary={<span><i className={`fg-status-dot ${playing ? 'is-active' : ''}`} />{playing ? 'Oynatılıyor' : step === result.steps ? 'Oynatma tamamlandı' : 'Duraklatıldı'}<b>{fmtHa(result.series[step].affectedHa)} <small>ha</small></b></span>} />
  )
}
