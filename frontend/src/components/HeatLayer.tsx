import L from 'leaflet'
import { useEffect } from 'react'
import { useMap } from 'react-leaflet'

/** Risk heat map using leaflet.heat. Points are [lat, lon, intensity]. */
export default function HeatLayer({ points }: { points: [number, number, number][] }) {
  const map = useMap()
  useEffect(() => {
    let layer: any
    let cancelled = false
    ;(window as any).L = L   // leaflet.heat is a classic plugin that expects a global L
    import('leaflet.heat').then(() => {
      if (cancelled) return
      try {
        layer = (L as any).heatLayer(points, { radius: 35, blur: 25, maxZoom: 15 }).addTo(map)
      } catch { /* canvas unavailable: skip the heat layer */ }
    }).catch(() => {})
    return () => { cancelled = true; if (layer) map.removeLayer(layer) }
  }, [map, points])
  return null
}
