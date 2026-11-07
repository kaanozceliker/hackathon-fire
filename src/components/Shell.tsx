import { useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { BarChart3, ChevronsLeft, ChevronsRight, Flame, LayoutDashboard, PlayCircle, Route, Siren, History as HistoryIcon, ClipboardCheck, Moon, Shield, Sun, Info } from 'lucide-react'
import { useStore } from '../state/store'
import { useTheme } from '../state/theme'
import { SimBadge } from './ui'

/** Menu in three groups, each item with a one-line description of what it is for. */
const GROUPS: { title: string; items: { to: string; label: string; hint: string; icon: typeof Flame }[] }[] = [
  {
    title: 'Planla',
    items: [
      { to: '/', label: 'Gösterge Paneli', hint: 'Bölgelerin risk durumu', icon: LayoutDashboard },
      { to: '/studio', label: 'Simülasyon Stüdyosu', hint: 'Yangını başlat, yayılımı izle', icon: Flame },
      { to: '/planner', label: 'Müdahale Planlayıcı', hint: 'Erişim ve tahliye rotaları', icon: Route },
      { to: '/varlik', label: 'Varlık Kalkanı', hint: 'Evinizin, işyerinizin riski', icon: Shield },
    ],
  },
  {
    title: 'Müdahale et',
    items: [
      { to: '/command', label: 'Komuta Merkezi', hint: 'Ekipleri ve kararları yönet', icon: Siren },
      { to: '/tatbikat', label: 'Tatbikat', hint: 'Önlem planınızı sınayın', icon: ClipboardCheck },
    ],
  },
  {
    title: 'Değerlendir',
    items: [
      { to: '/history', label: 'Geçmişteki Yangınlar', hint: 'Gerçek yangınlar, uydu verisi', icon: HistoryIcon },
      { to: '/analytics', label: 'Analiz ve Raporlar', hint: 'Karşılaştır, rapor indir', icon: BarChart3 },
    ],
  },
]

/** What each page is for, under its title. */
const PURPOSE: Record<string, string> = {
  '/': 'Orman alanlarının yangın riski ve son senaryolar',
  '/studio': 'Haritada bir tutuşma noktası seçin, havayı ayarlayın ve yangının yayılımını izleyin',
  '/planner': 'Ekiplerin yangına erişim rotaları ve yerleşimlerin tahliye yolları',
  '/command': 'Yangına müdahaleyi yapay zeka ya da kural tabanlı komutanla yönetin',
  '/history': 'Gerçek bir yangın uydu verisiyle; önlemler alınsaydı ne olurdu',
  '/analytics': 'Senaryoları karşılaştırın, raporu PDF olarak indirin',
  '/tatbikat': 'Bütçeyle önlem planı yapın, sistem en olası noktalardan yangın başlatsın',
  '/varlik': 'Haritada varlığınızı çizin, çevresine göre risk profili ve önlem raporu alın',
}

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(typeof window !== 'undefined' && window.innerWidth < 900)
  const { scenarios, active, setActive, restart, setPlaying, toast } = useStore()
  const nav = useNavigate()
  const { pathname } = useLocation()
  const [theme, setTheme] = useTheme()
  const runDemo = () => {
    setActive('demo')
    restart()
    nav('/studio')
    window.setTimeout(() => setPlaying(true), 250)
  }
  return (
    <div className="flex h-full bg-bg">
      <aside className={`flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-150 ${collapsed ? 'w-[60px]' : 'w-[244px]'}`}>
        {/* brand */}
        <div className={`flex h-14 items-center gap-2.5 ${collapsed ? 'justify-center px-0' : 'px-4'}`}>
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-forest/15 text-forest">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3l5 7h-3l4 6H6l4-6H7l5-7z" fill="currentColor" />
              <rect x="11" y="16" width="2" height="5" rx="1" fill="currentColor" />
            </svg>
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-panel bg-fire" />
          </span>
          {!collapsed && (
            <div className="min-w-0 leading-tight">
              <div className="text-[17px] font-bold tracking-tight">ForestGuard</div>
              <div className="text-[11.5px] text-muted">Orman yangını karar desteği</div>
            </div>
          )}
        </div>

        {/* menu */}
        <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 pb-3 pt-2" aria-label="Ana menü">
          {GROUPS.map((g) => (
            <div key={g.title}>
              {!collapsed ? <div className="px-2.5 pb-1 text-[11.5px] font-semibold text-muted">{g.title}</div> : <div className="mx-3 mb-2 border-t border-line" />}
              <ul className="space-y-0.5">
                {g.items.map(({ to, label, hint, icon: Icon }) => (
                  <li key={to}>
                    <NavLink
                      to={to}
                      end={to === '/'}
                      title={collapsed ? `${label} – ${hint}` : undefined}
                      className={({ isActive }) =>
                        `group relative flex items-center gap-3 rounded-lg px-2.5 py-2 ${collapsed ? 'justify-center' : ''} ${isActive ? 'bg-forest/12 text-ink' : 'text-muted hover:bg-panel2 hover:text-ink'}`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-forest" />}
                          <Icon size={18} className={`shrink-0 ${isActive ? 'text-forest' : ''}`} />
                          {!collapsed && (
                            <span className="min-w-0">
                              <span className="block truncate text-[14px] font-semibold leading-tight">{label}</span>
                              <span className="block truncate text-[11.5px] leading-tight text-muted">{hint}</span>
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="space-y-1.5 border-t border-line p-2.5">
          <button onClick={runDemo} title="Marmaris demo senaryosunu baştan oynat" className={`flex w-full items-center justify-center gap-2 rounded-lg bg-forest py-2 text-[13px] font-semibold text-white hover:bg-forest/85 ${collapsed ? 'px-0' : 'px-2'}`}>
            <PlayCircle size={16} />
            {!collapsed && 'Demoyu oynat'}
          </button>
          <button onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Menüyü genişlet' : 'Menüyü daralt'} className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] text-muted hover:bg-panel2 hover:text-ink">
            {collapsed ? <ChevronsRight size={16} /> : <><ChevronsLeft size={16} /> Daralt</>}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-panel px-5 py-2">
          <div className="min-w-0">
            <h1 className="text-[17px] font-semibold leading-tight">{title}</h1>
            {PURPOSE[pathname] && <p className="truncate text-[12.5px] leading-tight text-muted">{PURPOSE[pathname]}</p>}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[12.5px] text-muted">
              <span className="hidden sm:inline">Senaryo</span>
              <select value={active.id} onChange={(e) => setActive(e.target.value)} className="max-w-[240px] border border-line2 bg-bg px-2.5 py-1.5 text-[13px] text-ink">
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <SimBadge />
            <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Açık temaya geç' : 'Koyu temaya geç'} title={theme === 'dark' ? 'Açık tema' : 'Koyu tema'} className="flex h-9 w-9 items-center justify-center rounded-full border border-line2 text-muted hover:border-muted hover:text-ink">
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>
        <main className="relative min-h-0 flex-1 overflow-auto">{children}</main>
      </div>

      {toast && (
        <div role="status" className="fg-toast fixed bottom-20 left-1/2 z-[2000] flex max-w-[min(520px,90vw)] -translate-x-1/2 items-start gap-2 rounded-lg border border-line2 bg-panel px-3.5 py-2.5 text-[13px] shadow-[0_8px_28px_rgba(0,0,0,0.35)]">
          <Info size={15} className="mt-0.5 shrink-0 text-forest" />
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}
