import { lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'
import { Dashboard } from './pages/Dashboard'

const Planner = lazy(() => import('./pages/Planner').then((page) => ({ default: page.Planner })))
const Analytics = lazy(() => import('./pages/Analytics').then((page) => ({ default: page.Analytics })))
const Command = lazy(() => import('./pages/Command').then((page) => ({ default: page.Command })))
const History = lazy(() => import('./pages/History').then((page) => ({ default: page.History })))
const Drill = lazy(() => import('./pages/Drill').then((page) => ({ default: page.Drill })))
const AssetShield = lazy(() => import('./pages/AssetShield').then((page) => ({ default: page.AssetShield })))

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Shell title="Gösterge Paneli"><Dashboard /></Shell>} />
      {/* the Simülasyon Stüdyosu moved into the Komuta Merkezi */}
      <Route path="/studio" element={<Navigate to="/command" replace />} />
      <Route path="/planner" element={<Shell title="Müdahale Planlayıcı"><Planner /></Shell>} />
      <Route path="/command" element={<Shell title="Komuta Merkezi"><Command /></Shell>} />
      <Route path="/history" element={<Shell title="Geçmişteki Yangınlar"><History /></Shell>} />
      <Route path="/varlik" element={<Shell title="Varlık Kalkanı"><AssetShield /></Shell>} />
      <Route path="/tatbikat" element={<Shell title="Tatbikat"><Drill /></Shell>} />
      <Route path="/analytics" element={<Shell title="Analiz ve Raporlar"><Analytics /></Shell>} />
      <Route path="*" element={<Shell title="Bulunamadı"><div className="p-6 text-muted">Bu sayfa mevcut değil. Bir bölüm açmak için kenar çubuğunu kullanın.</div></Shell>} />
    </Routes>
  )
}
