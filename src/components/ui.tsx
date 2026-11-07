import type { ReactNode } from 'react'
import { Info } from 'lucide-react'

export function Panel({ title, action, children, className = '', pad = true }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`rounded-lg border border-line bg-panel shadow-[0_1px_2px_rgba(0,0,0,0.06)] ${className}`}>
      {title && (
        <header className="flex min-h-10 items-center justify-between gap-2 border-b border-line px-3.5 py-2">
          <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
          {action}
        </header>
      )}
      <div className={pad ? 'p-3.5' : ''}>{children}</div>
    </section>
  )
}

export function Stat({ label, value, unit, hint, tone = 'ink' }: { label: string; value: ReactNode; unit?: string; hint?: string; tone?: 'ink' | 'fire' | 'amber' | 'forest' | 'water' }) {
  const color = { ink: 'text-ink', fire: 'text-fire', amber: 'text-amber', forest: 'text-forest', water: 'text-water' }[tone]
  return (
    <div className="min-w-0 border-l-2 border-line2 pl-2.5" title={hint}>
      <div className="truncate text-[12px] text-muted">{label}</div>
      <div className={`text-[22px] font-semibold leading-tight ${color}`}>
        {value}
        {unit && <span className="ml-1 text-[12px] font-normal text-muted">{unit}</span>}
      </div>
    </div>
  )
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-md border border-line bg-bg p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded px-2 py-1 text-[12.5px] font-medium ${o.value === value ? 'bg-panel text-ink shadow-[0_1px_2px_rgba(0,0,0,0.18)] ring-1 ring-forest/50' : 'text-muted hover:bg-panel2 hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function SliderField({ label, value, min, max, step = 1, unit, onChange, hint, format }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void; hint?: string; format?: (v: number) => string }) {
  const p = ((value - min) / (max - min)) * 100
  return (
    <label className="block" title={hint}>
      <div className="mb-0.5 flex items-baseline justify-between text-[12.5px]">
        <span className="text-muted">{label}</span>
        <span className="font-semibold text-ink">
          {format ? format(value) : value}
          <span className="ml-0.5 font-normal text-muted">{unit}</span>
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ ['--p' as string]: `${p}%` }} />
    </label>
  )
}

export function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'amber' | 'fire' | 'forest' | 'water' }) {
  const c = {
    muted: 'border-line2 text-muted',
    amber: 'border-amber/60 text-amber',
    fire: 'border-fire/60 text-fire',
    forest: 'border-forest/60 text-forest',
    water: 'border-water/60 text-water',
  }[tone]
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] font-medium ${c}`}>{children}</span>
}

export function SimBadge({ text = 'Temsili simülasyon – örnek veriler, canlı gözlem değildir' }: { text?: string }) {
  return (
    <span title={text} className="inline-flex items-center gap-1.5 rounded-full border border-amber/40 bg-amber/10 px-2.5 py-0.5 text-[11.5px] font-medium text-amber">
      <Info size={12} />
      {text.startsWith('Temsili simülasyon') ? 'Temsili simülasyon' : text}
    </span>
  )
}

export interface LegendItem {
  color: string
  label: string
  kind?: 'box' | 'line' | 'dash' | 'dot'
}
export function Legend({ title, items }: { title?: string; items: LegendItem[] }) {
  return (
    <div className="rounded-md border border-line2 bg-bg/90 px-2.5 py-2 text-[12px] shadow-[0_2px_8px_rgba(0,0,0,0.18)] backdrop-blur-sm">
      {title && <div className="mb-1 font-semibold text-ink">{title}</div>}
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-2 text-muted">
            {it.kind === 'line' || it.kind === 'dash' ? (
              <span className="inline-block w-5" style={{ borderTop: `3px ${it.kind === 'dash' ? 'dashed' : 'solid'} ${it.color}` }} />
            ) : it.kind === 'dot' ? (
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: it.color }} />
            ) : (
              <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: it.color }} />
            )}
            {it.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

export const fmtHa = (ha: number) => (ha >= 100 ? Math.round(ha).toLocaleString('en-US') : ha.toFixed(1))
export const fmtT = (min: number) => `${Math.floor(min / 60)}sa ${String(Math.round(min % 60)).padStart(2, '0')}dk`
