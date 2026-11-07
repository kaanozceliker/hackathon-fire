import type { ResponseRecord, ResourceStatus } from '../sim/types'
import { haversineM } from '../sim/geo'
import { activeMove } from './tracks'

type Track = ResponseRecord['tracks'][number]
export interface ResourceActivity {
  label: string
  value: string
  caption: string
  remainingMin: number | null
  finishMin: number | null
  progress: number | null
  tone: 'muted' | 'water' | 'forest' | 'amber' | 'fire'
}

const STATES: Record<ResourceStatus, [string, string, ResourceActivity['tone']]> = {
  unavailable: ['Görevlendirme bekleniyor', 'Bekliyor', 'muted'],
  idle: ['Yeni görev için hazır', 'Hazır', 'muted'],
  enroute: ['Göreve intikal', 'Yolda', 'water'],
  mopping: ['Çevre devriyesi ve soğutma', 'Görevde', 'water'],
  attacking: ['Yangına doğrudan müdahale', 'Görevde', 'forest'],
  building: ['Güvenlik sınırı açılıyor', 'Görevde', 'amber'],
  holding: ['Güvenlik sınırı korunuyor', 'Görevde', 'forest'],
  dropping: ['Havadan söndürme görevinde', 'Görevde', 'water'],
  retreated: ['Geri çekildi · yeni görev bekliyor', 'Bekliyor', 'fire'],
  grounded: ['Gece koşulları · hava aracı yerde', 'Yerde', 'muted'],
}

/** Reads the journey at the playhead, never the last journey of the completed run. */
export function resourceActivity(track: Track, step: number, stepMin = 10): ResourceActivity {
  let point: Track['points'][number] | undefined
  for (let i = track.points.length - 1; i >= 0; i--) {
    if (track.points[i].step <= step) { point = track.points[i]; break }
  }
  const timed = (label: string, caption: string, from: number, to: number, tone: ResourceActivity['tone']): ResourceActivity => {
    const remainingMin = Math.max(1, Math.ceil((to - step) * stepMin - 1e-6))
    return { label, value: String(remainingMin), caption, remainingMin, finishMin: to * stepMin,
      progress: Math.max(0, Math.min(1, (step - from) / Math.max(1e-6, to - from))), tone }
  }
  const readyAt = track.availableFromStep ?? track.points.find((p) => p.status !== 'unavailable')?.step
  if (readyAt !== undefined && step < readyAt) return timed('Göreve hazırlık', 'hazır olana', 0, readyAt, 'muted')

  const move = activeMove(track.moves, step)
  // Night grounding and retreat can interrupt a previously recorded route.
  if (move && point?.status !== 'grounded' && point?.status !== 'retreated') {
    const air = track.kind === 'heli' || track.kind === 'plane'
    const end = move.path.at(-1)
    const base = track.base ?? (track.points[0] ? [track.points[0].lat, track.points[0].lon] as [number, number] : undefined)
    const purpose = move.purpose ?? (end && base && haversineM(end, base) < 30 ? 'return' : 'dispatch')
    if (purpose === 'return') return timed(air ? 'Üsse dönüyor' : 'İstasyona dönüyor', 'dönüşe', move.fromStep, move.toStep, 'amber')
    if (purpose === 'water') return timed('Su kaynağına uçuş', 'ikmal noktasına', move.fromStep, move.toStep, 'water')
    if (purpose === 'refill') return timed('Su ikmali yapılıyor', 'ikmal bitişine', move.fromStep, move.toStep, 'water')
    if (purpose === 'drop') return timed('Yangın alanına geri uçuş', 'varışa', move.fromStep, move.toStep, 'water')
    if (purpose === 'patrol') {
      if (move.arrivalStep !== undefined && step < move.arrivalStep) return timed('Soğutma alanına intikal', 'varışa', move.fromStep, move.arrivalStep, 'water')
      return timed('Çevre devriyesi ve soğutma', 'rota sonuna', move.arrivalStep ?? move.fromStep, move.toStep, 'water')
    }
    return timed(air ? 'Yangın alanına uçuş' : 'Olay yerine intikal', 'varışa', move.fromStep, move.toStep, 'water')
  }
  const [label, value, tone] = STATES[point?.status ?? 'unavailable']
  return { label, value, tone, caption: 'model durumu', remainingMin: null, finishMin: null, progress: null }
}
