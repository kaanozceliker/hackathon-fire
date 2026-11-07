import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { defaultConfig, regionById, REGIONS } from '../data/regions'
import { runSimulation } from '../sim/engine'
import { getGrid } from '../sim/gridCache'
import type { SimConfig, SimResult } from '../sim/types'

export interface Scenario {
  id: string
  name: string
  color: string
  result: SimResult
  createdAt: number
  preset: boolean
}

// Categorical series colours follow the validated dark-surface slot order (blue, orange, aqua, yellow, magenta, violet).
const CUSTOM_COLORS = ['#c98500', '#d55181', '#9085e9', '#e66767', '#3987e5']

function runFor(config: SimConfig): SimResult {
  const region = regionById(config.areaId)
  return runSimulation(getGrid(config.areaId), config, region.settlements)
}

function initialScenarios(): Scenario[] {
  const mugla = REGIONS[0]
  const base = defaultConfig(mugla)
  const mk = (id: string, name: string, color: string, patch: Partial<SimConfig>): Scenario => ({
    id,
    name,
    color,
    createdAt: Date.now(),
    preset: true,
    result: runFor({ ...base, ...patch }),
  })
  return [
    mk('demo', 'Marmaris demosu – karayel', '#3987e5', {}),
    mk('A', 'Senaryo A – orta', '#d95926', { windSpeedKmh: 15, humidityPct: 45, temperatureC: 28 }),
    mk('B', 'Senaryo B – aşırı', '#199e70', { windSpeedKmh: 35, humidityPct: 18, temperatureC: 37 }),
  ]
}

interface Store {
  scenarios: Scenario[]
  active: Scenario
  setActive: (id: string) => void
  draft: SimConfig
  patchDraft: (p: Partial<SimConfig>) => void
  setDraftArea: (areaId: string) => void
  loadPreset: (patch: Partial<SimConfig>) => void
  dirty: boolean
  step: number
  setStep: (s: number) => void
  playing: boolean
  setPlaying: (p: boolean) => void
  speed: number
  setSpeed: (s: number) => void
  restart: () => void
  progress: number | null
  startSimulation: () => void
  compareIds: string[]
  toggleCompare: (id: string) => void
  selectedRegionId: string
  setSelectedRegionId: (id: string) => void
  removeScenario: (id: string) => void
  toast: string | null
  notify: (m: string) => void
  demoPlayed: boolean
  markDemoPlayed: () => void
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [scenarios, setScenarios] = useState<Scenario[]>(initialScenarios)
  const [activeId, setActiveId] = useState('demo')
  const [draft, setDraft] = useState<SimConfig>(() => scenarios[0].result.config)
  const [step, setStepRaw] = useState(() => scenarios[0].result.steps)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [progress, setProgress] = useState<number | null>(null)
  const [compareIds, setCompareIds] = useState<string[]>(['A', 'B'])
  const [selectedRegionId, setSelectedRegionId] = useState('mugla')
  const [toast, setToast] = useState<string | null>(null)
  const [demoPlayed, setDemoPlayed] = useState(false)
  const customCount = useRef(0)

  const active = scenarios.find((s) => s.id === activeId) ?? scenarios[0]
  const steps = active.result.steps

  const setStep = useCallback((s: number) => setStepRaw(Math.max(0, Math.min(steps, Math.round(s)))), [steps])

  // playback
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => {
      setStepRaw((s) => {
        if (s >= steps) {
          setPlaying(false)
          return steps
        }
        return s + 1
      })
    }, 1000 / (5 * speed))
    return () => window.clearInterval(id)
  }, [playing, speed, steps])

  const notify = useCallback((m: string) => {
    setToast(m)
    window.setTimeout(() => setToast((t) => (t === m ? null : t)), 3200)
  }, [])

  const setActive = useCallback(
    (id: string) => {
      const sc = scenarios.find((s) => s.id === id)
      if (!sc) return
      setActiveId(id)
      setDraft(sc.result.config)
      setPlaying(false)
      setStepRaw(sc.result.steps)
    },
    [scenarios],
  )

  const startSimulation = useCallback(() => {
    if (progress !== null) return
    setPlaying(false)
    setProgress(0)
    const cfg = draft
    let p = 0
    const tick = window.setInterval(() => {
      p += 0.09 + Math.random() * 0.05
      if (p < 1) {
        setProgress(p)
        return
      }
      window.clearInterval(tick)
      const result = runFor(cfg)
      customCount.current += 1
      const id = `run-${customCount.current}`
      const sc: Scenario = {
        id,
        name: `Özel çalıştırma ${customCount.current} – ${regionById(cfg.areaId).name}`,
        color: CUSTOM_COLORS[(customCount.current - 1) % CUSTOM_COLORS.length],
        result,
        createdAt: Date.now(),
        preset: false,
      }
      setScenarios((list) => {
        const customs = list.filter((s) => !s.preset)
        const keep = customs.length >= 5 ? list.filter((s) => s.id !== customs[0].id) : list
        return [...keep, sc]
      })
      setActiveId(id)
      setStepRaw(0)
      setProgress(null)
      setPlaying(true)
      setSpeed(2)
    }, 90)
  }, [draft, progress])

  const patchDraft = useCallback((p: Partial<SimConfig>) => setDraft((d) => ({ ...d, ...p })), [])
  const setDraftArea = useCallback((areaId: string) => setDraft(defaultConfig(regionById(areaId))), [])
  const loadPreset = useCallback((patch: Partial<SimConfig>) => setDraft((d) => ({ ...d, ...patch })), [])

  const value = useMemo<Store>(
    () => ({
      scenarios,
      active,
      setActive,
      draft,
      patchDraft,
      setDraftArea,
      loadPreset,
      dirty: JSON.stringify(draft) !== JSON.stringify(active.result.config),
      step: Math.min(step, steps),
      setStep,
      playing,
      setPlaying: (p: boolean) => {
        if (p && step >= steps) setStepRaw(0)
        setPlaying(p)
      },
      speed,
      setSpeed,
      restart: () => {
        setPlaying(false)
        setStepRaw(0)
      },
      progress,
      startSimulation,
      compareIds,
      toggleCompare: (id: string) =>
        setCompareIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 4 ? [...c.slice(1), id] : [...c, id])),
      selectedRegionId,
      setSelectedRegionId,
      removeScenario: (id: string) => {
        setScenarios((list) => list.filter((s) => s.id !== id || s.preset))
        setCompareIds((c) => c.filter((x) => x !== id))
        if (activeId === id) setActive('demo')
      },
      toast,
      notify,
      demoPlayed,
      markDemoPlayed: () => setDemoPlayed(true),
    }),
    [scenarios, active, setActive, draft, patchDraft, setDraftArea, loadPreset, step, steps, setStep, playing, speed, progress, startSimulation, compareIds, selectedRegionId, toast, notify, demoPlayed, activeId],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const v = useContext(Ctx)
  if (!v) throw new Error('StoreProvider missing')
  return v
}
