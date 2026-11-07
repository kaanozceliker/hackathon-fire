import { Component, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Link } from 'react-router-dom'

/** Keep navigation and the in-memory scenarios available if one page fails to load or render. */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="mx-auto my-12 max-w-md rounded-xl border border-line2 bg-panel p-6">
        <AlertTriangle size={24} className="mb-3 text-amber" />
        <h2 className="text-lg font-semibold">Bu bölüm açılamadı</h2>
        <p className="mt-2 text-sm text-muted">Başka bir bölüme geçebilirsiniz. Yükleme sorunu sürerse sayfayı yenileyin; yenileme bu oturumdaki özel senaryoları sıfırlar.</p>
        <div className="mt-4 flex flex-wrap gap-2 text-sm">
          <Link to="/" className="rounded-md bg-forest px-3 py-2 font-semibold text-white">Gösterge paneline dön</Link>
          <button onClick={() => window.location.reload()} className="flex items-center gap-1.5 border border-line2 px-3 py-2"><RotateCcw size={14} /> Sayfayı yenile</button>
        </div>
      </div>
    )
  }
}
