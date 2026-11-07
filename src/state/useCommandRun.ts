import { useCallback, useEffect, useRef, useState } from 'react'
import { ResponseRun, ruleCommander } from '../sim/response'
import { STEP_MIN } from '../sim/engine'
import { askCommander } from '../lib/commanderClient'
import type { Infrastructure } from '../data/infrastructure'
import type { Settlement, SimConfig, SimResult } from '../sim/types'

export type CommanderMode = 'ai' | 'rules'

/** Simulation minutes per playback tick. */
export const TICK_MIN = 15
export type RunStatus = 'idle' | 'running' | 'done' | 'stopped'

/**
 * Drives a live response run for the Komuta Merkezi. The engine computes up to the next decision point; playback
 * follows; when the playhead reaches the decision point the run pauses, the commander decides (ChatGPT through the
 * server, or the rules when the AI is off or fails), the decision is applied and the run continues.
 */
export function useCommandRun() {
  const runRef = useRef<ResponseRun | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const modeRef = useRef<CommanderMode>('rules')
  const [status, setStatus] = useState<RunStatus>('idle')
  const [live, setLive] = useState<SimResult | null>(null)
  const [frontier, setFrontier] = useState(0)
  /** Playback clock in simulation minutes; it moves in 15-minute ticks (the engine steps 10 minutes). */
  const [headMin, setHeadMin] = useState(0)
  const head = Math.floor(headMin / STEP_MIN)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [pending, setPending] = useState<{ trigger: string; step: number } | null>(null)
  const [thinking, setThinking] = useState(false)
  const [baseline, setBaseline] = useState<SimResult | null>(null)
  const deciding = useRef(false)
  /** Continuous playback time in simulation minutes, for layers that animate every frame. */
  const clockRef = useRef(0)

  const pump = useCallback(() => {
    const run = runRef.current
    if (!run) return
    const a = run.advance()
    if (a.kind === 'end') {
      const fin = run.finish()
      setLive(fin)
      setBaseline(run.baselineResult)
      setFrontier(fin.steps)
      setPending(null)
      setStatus('done')
      return
    }
    setLive(run.snapshot())
    setFrontier(run.step)
    setPending({ trigger: a.trigger, step: run.step })
  }, [])

  const start = useCallback(
    (grid: SimResult['grid'], config: SimConfig, settlements: Settlement[], infra: Infrastructure, responseStartMin: number, mode: CommanderMode) => {
      abortRef.current?.abort()
      modeRef.current = mode
      runRef.current = new ResponseRun(grid, { ...config, durationH: 72 }, settlements, infra, responseStartMin)
      deciding.current = false
      setThinking(false)
      setBaseline(null)
      setHeadMin(0)
    clockRef.current = 0
      clockRef.current = 0
      setStatus('running')
      setPlaying(true)
      pump()
    },
    [pump],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    deciding.current = false
    setThinking(false)
    setPlaying(false)
    setPending(null)
    if (runRef.current) {
      const fin = runRef.current.finish()
      setLive(fin)
      setBaseline(runRef.current.baselineResult)
      setFrontier(fin.steps)
    }
    setStatus('stopped')
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    runRef.current = null
    deciding.current = false
    setThinking(false)
    setPlaying(false)
    setPending(null)
    setLive(null)
    setBaseline(null)
    setFrontier(0)
    setHeadMin(0)
    clockRef.current = 0
    setStatus('idle')
  }, [])

  // decide when the playhead reaches the pending decision point
  useEffect(() => {
    const run = runRef.current
    if (!run || !pending || head < pending.step || deciding.current || status !== 'running') return
    deciding.current = true
    setThinking(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const context = run.context(pending.trigger)
    const decide = async () => {
      if (modeRef.current === 'rules') {
        await new Promise((r) => setTimeout(r, 350))
        return { output: ruleCommander(context), source: 'rules' as const, reason: undefined }
      }
      try {
        return { output: await askCommander(context, ctrl.signal), source: 'ai' as const, reason: undefined }
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        return { output: ruleCommander(context), source: 'rules' as const, reason: (e as Error).message }
      }
    }
    decide()
      .then(({ output, source, reason }) => {
        if (ctrl.signal.aborted || runRef.current !== run) return
        run.apply(output, source, pending.trigger, reason)
        deciding.current = false
        setThinking(false)
        pump()
      })
      .catch(() => {
        deciding.current = false
      })
  }, [head, pending, status, pump])

  // playback: a continuous clock (15 simulation minutes per second at 1×) that map layers read every frame;
  // panels follow it in 15-minute ticks. It stops at the computed frontier (a decision point or the end).
  const frontierRef = useRef(frontier)
  frontierRef.current = frontier
  const statusRef = useRef(status)
  statusRef.current = status
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      const max = frontierRef.current * STEP_MIN
      const m = Math.min(max, clockRef.current + dt * TICK_MIN * speed)
      clockRef.current = m
      const shown = m >= max ? max : Math.floor(m / TICK_MIN) * TICK_MIN
      setHeadMin((prev) => (prev === shown ? prev : shown))
      if (m >= max && (statusRef.current === 'done' || statusRef.current === 'stopped')) {
        setPlaying(false)
        return
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed])

  const setHead = useCallback(
    (s: number) => {
      const m = Math.max(0, Math.min(frontier, Math.round(s))) * STEP_MIN
      clockRef.current = m
      setHeadMin(m)
    },
    [frontier],
  )

  return { status, live, baseline, frontier, head, headMin, clockRef, setHead, playing, setPlaying, speed, setSpeed, pending, thinking, start, stop, reset }
}
