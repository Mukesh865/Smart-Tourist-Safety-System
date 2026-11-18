/** Small client-side geometry for zone warnings (same maths as the server: equirectangular metres + ray casting). */
export type LatLon = [number, number]
const R = 6_371_000

function toXY(p: LatLon, origin: LatLon): [number, number] {
  const kx = (Math.PI / 180) * R * Math.cos((origin[0] * Math.PI) / 180)
  const ky = (Math.PI / 180) * R
  return [(p[1] - origin[1]) * kx, (p[0] - origin[0]) * ky]
}

export function pointInPolygon(p: LatLon, poly: LatLon[]): boolean {
  const o = p
  const pts = poly.map((q) => toXY(q, o))
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Metres from the point to the nearest polygon edge. */
export function distanceToPolygon(p: LatLon, poly: LatLon[]): number {
  const pts = poly.map((q) => toXY(q, p))
  let best = Infinity
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]
    const dx = x2 - x1, dy = y2 - y1
    const L2 = dx * dx + dy * dy
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, (-x1 * dx - y1 * dy) / L2))
    best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy))
  }
  return best
}

export interface ZoneLike { id: number; name: string; polygon: LatLon[]; risk_weight: number; no_entry: boolean }
export interface ZoneStatus { zone: ZoneLike; inside: boolean; distance: number }

/** The most relevant zone: any zone the user is inside (highest risk first), otherwise the nearest within `radius` m. */
export function zoneStatus(pos: LatLon, zones: ZoneLike[], radius = 1000): ZoneStatus | null {
  let inside: ZoneStatus | null = null
  let near: ZoneStatus | null = null
  for (const z of zones) {
    if (z.polygon.length < 3) continue
    if (pointInPolygon(pos, z.polygon)) {
      if (!inside || z.risk_weight > inside.zone.risk_weight) inside = { zone: z, inside: true, distance: 0 }
    } else {
      const d = distanceToPolygon(pos, z.polygon)
      if (d <= radius && (!near || d < near.distance)) near = { zone: z, inside: false, distance: d }
    }
  }
  return inside ?? near
}

export function haversine(a: LatLon, b: LatLon): number {
  const [la1, lo1, la2, lo2] = [a[0], a[1], b[0], b[1]].map((v) => (v * Math.PI) / 180)
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export const fmtDistance = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`)
