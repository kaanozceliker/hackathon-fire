import type { ReactNode } from 'react'
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react'
import { fmtDuration } from '../sim/geo'
import { Segmented } from './ui'

export interface PlaybackMarker { id: string; step: number; label: string; color: string; onSelect?: () => void }

export function PlaybackBar({ step, steps, stepMin = 10, playing, onPlay, onSeek, onRestart, speed, onSpeed, speeds = [0.5, 1, 2, 4], disabled = false, markers = [], summary, label = 'Simülasyon zaman çizelgesi' }: {
  step: number; steps: number; stepMin?: number; playing: boolean; onPlay: () => void; onSeek: (step: number) => void; onRestart?: () => void
  speed: number; onSpeed: (speed: number) => void; speeds?: number[]; disabled?: boolean; markers?: PlaybackMarker[]; summary?: ReactNode; label?: string
}) {
  const max = Math.max(1, steps)
  const current = Math.min(max, Math.max(0, step))
  const hours = max * stepMin / 60
  const tickEvery = [1, 2, 3, 6, 12, 24].find((n) => hours / n <= 6) ?? 24
  const ticks = Array.from({ length: Math.floor(hours / tickEvery) + 1 }, (_, i) => i * tickEvery)
  return (
    <div className="fg-playback" role="group" aria-label={label}>
      <div className="fg-playback-top">
        <button onClick={onPlay} disabled={disabled} aria-label={playing ? 'Duraklat' : 'Oynat'} className="fg-play-button">{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
        <div className="fg-clock"><span>Simülasyon saati</span><strong>T+{fmtDuration(current * stepMin)}</strong></div>
        <div className="fg-playback-steps">
          {onRestart && <button onClick={onRestart} disabled={disabled} aria-label="Başa dön" title="Başa dön"><RotateCcw size={14} /></button>}
          <button onClick={() => onSeek(Math.max(0, current - 1))} disabled={disabled || current === 0} aria-label="Bir adım geri"><SkipBack size={14} /></button>
          <button onClick={() => onSeek(Math.min(max, current + 1))} disabled={disabled || current >= max} aria-label="Bir adım ileri"><SkipForward size={14} /></button>
        </div>
        <div className="fg-playback-summary">{summary}</div>
        <Segmented label="Oynatma hızı" value={speed} onChange={onSpeed} options={speeds.map((value) => ({ value, label: `${value}×` }))} />
      </div>
      <div className="fg-playback-track">
        <input type="range" min={0} max={max} value={current} disabled={disabled} onChange={(e) => onSeek(Number(e.target.value))} style={{ ['--p' as string]: `${current / max * 100}%` }} aria-label="Simülasyon zamanı" aria-valuetext={`T+${fmtDuration(current * stepMin)}`} />
        <div className="fg-playback-markers">
          {markers.filter((marker) => marker.step >= 0 && marker.step <= max).map((marker) => <button key={marker.id} disabled={disabled} style={{ left: `${marker.step / max * 100}%`, ['--event-color' as string]: marker.color }} onClick={() => { onSeek(marker.step); marker.onSelect?.() }} aria-label={marker.label} title={marker.label} />)}
        </div>
        <div className="fg-playback-ticks">{ticks.map((hour) => <span key={hour} style={{ left: `${hour / hours * 100}%`, transform: hour === 0 ? 'none' : hour === hours ? 'translateX(-100%)' : 'translateX(-50%)' }}>{hour} sa</span>)}<span className="fg-playback-end">{hours % tickEvery ? `${hours.toLocaleString('tr-TR')} sa` : ''}</span></div>
      </div>
    </div>
  )
}
