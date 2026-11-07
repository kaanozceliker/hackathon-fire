import { useEffect, useState } from 'react'

/**
 * Light / dark theme. The palette lives in CSS variables (src/index.css); this only switches `data-theme` on <html>,
 * remembers the choice and lets components that draw with their own colours (base map) follow it.
 * First visit: the system setting.
 */

export type Theme = 'dark' | 'light'
const KEY = 'fg-theme'

function initial(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'dark' || v === 'light') return v
  } catch {
    // storage blocked: fall back to the system setting
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

let current: Theme = typeof window !== 'undefined' ? initial() : 'dark'
const listeners = new Set<(t: Theme) => void>()
if (typeof document !== 'undefined') document.documentElement.dataset.theme = current

export function setTheme(t: Theme) {
  current = t
  document.documentElement.dataset.theme = t
  try {
    localStorage.setItem(KEY, t)
  } catch {
    // not remembered; still applied
  }
  listeners.forEach((l) => l(t))
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [t, set] = useState(current)
  useEffect(() => {
    listeners.add(set)
    return () => {
      listeners.delete(set)
    }
  }, [])
  return [t, setTheme]
}
