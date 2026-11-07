import { Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'
import { Dashboard } from './pages/Dashboard'
import { Studio } from './pages/Studio'
import { Planner } from './pages/Planner'
import { Analytics } from './pages/Analytics'
import { Command } from './pages/Command'
import { History } from './pages/History'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Shell title="Gösterge Paneli"><Dashboard /></Shell>} />
      <Route path="/studio" element={<Shell title="Simülasyon Stüdyosu"><Studio /></Shell>} />
      <Route path="/planner" element={<Shell title="Müdahale Planlayıcı"><Planner /></Shell>} />
      <Route path="/command" element={<Shell title="Komuta Merkezi"><Command /></Shell>} />
      <Route path="/history" element={<Shell title="Geçmişteki Yangınlar"><History /></Shell>} />
      <Route path="/analytics" element={<Shell title="Analiz ve Raporlar"><Analytics /></Shell>} />
      <Route path="*" element={<Shell title="Bulunamadı"><div className="p-6 text-muted">Bu sayfa mevcut değil. Bir bölüm açmak için kenar çubuğunu kullanın.</div></Shell>} />
    </Routes>
  )
}
