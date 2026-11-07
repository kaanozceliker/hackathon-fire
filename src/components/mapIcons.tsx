import L from 'leaflet'
import { renderToStaticMarkup } from 'react-dom/server'
import { Flame, Droplets, Siren, DoorOpen, ShieldCheck, Home } from 'lucide-react'
import type { ReactElement } from 'react'
import { riskBand } from '../lib/risk'

function badge(icon: ReactElement, bg: string, size = 22, ring = '#0a1014', round = true): L.DivIcon {
  const html = `<div style="width:${size}px;height:${size}px;background:color-mix(in srgb,${bg} 30%,${ring});border:1.5px solid ${bg};border-radius:${round ? '7px' : '5px'};display:flex;align-items:center;justify-content:center;color:#eef4f1;box-shadow:0 2px 7px rgba(0,0,0,.3)">${renderToStaticMarkup(icon)}</div>`
  return L.divIcon({ html, className: 'fg-icon', iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
}

export const icons = {
  station: badge(<Siren size={12} />, '#c2352c', 22, '#0a1014', false),
  water: badge(<Droplets size={12} />, '#2a7fc0'),
  access: badge(<DoorOpen size={12} />, '#8a6d1d', 20, '#0a1014', false),
  safe: badge(<ShieldCheck size={12} />, '#2c8a52'),
  settlement: badge(<Home size={11} />, '#44525a', 18),
  fireSmall: badge(<Flame size={12} />, '#d4501f', 22),
  ignition: L.divIcon({
    html: `<div style="position:relative;width:26px;height:26px"><div class="fg-pulse" style="position:absolute;inset:0"></div><div style="position:absolute;inset:3px;background:#e5483d;border:2px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff">${renderToStaticMarkup(<Flame size={11} />)}</div></div>`,
    className: 'fg-icon',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  }),
  regionDot: (risk: number, selected: boolean) => {
    const c = riskBand(risk).color
    const s = selected ? 30 : 24
    return L.divIcon({
      html: `<div style="width:${s}px;height:${s}px;border-radius:50%;background:${c};border:2px solid ${selected ? '#fff' : '#0a1014'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:#0a1014">${risk}</div>`,
      className: 'fg-icon',
      iconSize: [s, s],
      iconAnchor: [s / 2, s / 2],
    })
  },
}
