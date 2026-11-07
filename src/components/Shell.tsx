import { useState, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { BarChart3, ChevronsLeft, ChevronsRight, Flame, LayoutDashboard, PlayCircle, Route, Siren, TreePine, History as HistoryIcon } from 'lucide-react'
import { useStore } from '../state/store'
import { SimBadge } from './ui'

const NAV = [
  { to: '/', label: 'Gösterge Paneli', icon: LayoutDashboard },
  { to: '/studio', label: 'Simülasyon Stüdyosu', icon: Flame },
  { to: '/planner', label: 'Müdahale Planlayıcı', icon: Route },
  { to: '/command', label: 'Komuta Merkezi', icon: Siren },
  { to: '/history', label: 'Geçmişteki Yangınlar', icon: HistoryIcon },
  { to: '/analytics', label: 'Analiz ve Raporlar', icon: BarChart3 },
]

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(typeof window !== 'undefined' && window.innerWidth < 900)
  const { scenarios, active, setActive, restart, setPlaying, toast } = useStore()
  const nav = useNavigate()
  const runDemo = () => {
    setActive('demo')
    restart()
    nav('/studio')
    window.setTimeout(() => setPlaying(true), 250)
  }
  return (
    <div className="flex h-full bg-bg">
      <aside className={`flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-150 ${collapsed ? 'w-[52px]' : 'w-[208px]'}`}>
        <div className="flex h-12 items-center gap-2 border-b border-line px-3">
          <TreePine size={22} className="shrink-0 text-forest" />
          {!collapsed && (
            <div className="leading-none">
              <div className="text-[17px] font-bold tracking-tight">ForestGuard</div>
              <div className="mt-0.5 text-[11px] text-muted">Orman yangını simülasyonu</div>
            </div>
          )}
        </div>
        <nav className="flex-1 py-2" aria-label="Ana menü">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              title={label}
              className={({ isActive }) => `flex items-center gap-3 border-l-2 px-3.5 py-2.5 text-[14px] font-medium transition-colors ${isActive ? 'border-forest bg-forest-dim/50 text-ink' : 'border-transparent text-muted hover:bg-panel2 hover:text-ink'}`}
            >
              <Icon size={18} className="shrink-0" />
              {!collapsed && label}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-2 border-t border-line p-2">
          <button onClick={runDemo} title="Marmaris demo senaryosunu yeniden oynat" className={`flex w-full items-center justify-center gap-2 bg-forest px-2 py-2 text-[13px] font-semibold text-bg hover:bg-forest/85 ${collapsed ? 'px-0' : ''}`}>
            <PlayCircle size={16} />
            {!collapsed && 'Marmaris demosunu oynat'}
          </button>
          <button onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Kenar çubuğunu genişlet' : 'Kenar çubuğunu daralt'} className="flex w-full items-center justify-center py-1 text-muted hover:text-ink">
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel px-4 py-1.5">
          <h1 className="text-[16px] font-semibold">{title}</h1>
          <label className="ml-auto flex items-center gap-2 text-[12px] text-muted">
            Senaryo
            <select value={active.id} onChange={(e) => setActive(e.target.value)} className="max-w-[260px] border border-line2 bg-bg px-2 py-1 text-[13px] text-ink">
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <SimBadge />
        </header>
        <main className="relative min-h-0 flex-1 overflow-auto">{children}</main>
      </div>

      {toast && (
        <div role="status" className="fixed bottom-20 left-1/2 z-[2000] -translate-x-1/2 border border-line2 bg-panel2 px-3 py-2 text-[13px] shadow-lg">{toast}</div>
      )}
    </div>
  )
}
