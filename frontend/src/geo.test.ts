import { describe, expect, test } from 'vitest'
import { distanceToPolygon, fmtDistance, haversine, pointInPolygon, zoneStatus, type LatLon, type ZoneLike } from './geo'

const LAT0 = 25.5788, LON0 = 91.8933
const M = 111_194.9
const ll = (x: number, y: number): LatLon => [LAT0 + y / M, LON0 + x / (M * Math.cos((LAT0 * Math.PI) / 180))]
const square = (cx: number, cy: number, h: number): LatLon[] => [ll(cx - h, cy - h), ll(cx + h, cy - h), ll(cx + h, cy + h), ll(cx - h, cy + h)]
const zone = (id: number, cx: number, cy: number, h: number, risk = 0.5): ZoneLike => ({ id, name: `Z${id}`, polygon: square(cx, cy, h), risk_weight: risk, no_entry: false })

describe('polygon maths', () => {
  test('inside, outside and concave shapes', () => {
    const sq = square(0, 0, 500)
    expect(pointInPolygon(ll(0, 0), sq)).toBe(true)
    expect(pointInPolygon(ll(600, 0), sq)).toBe(false)
    const L: LatLon[] = [ll(0, 0), ll(1000, 0), ll(1000, 300), ll(300, 300), ll(300, 1000), ll(0, 1000)]
    expect(pointInPolygon(ll(100, 800), L)).toBe(true)
    expect(pointInPolygon(ll(800, 800), L)).toBe(false)          // the notch of the L
  })

  test('distance to the nearest edge', () => {
    const sq = square(0, 0, 500)
    expect(distanceToPolygon(ll(700, 0), sq)).toBeCloseTo(200, -1)
    expect(distanceToPolygon(ll(0, 0), sq)).toBeCloseTo(500, -1)
    expect(distanceToPolygon(ll(800, 800), sq)).toBeCloseTo(Math.hypot(300, 300), -1)   // nearest point is a corner
  })

  test('haversine and distance formatting', () => {
    expect(haversine(ll(0, 0), ll(1000, 0))).toBeCloseTo(1000, -1)
    expect(fmtDistance(240)).toBe('240 m')
    expect(fmtDistance(1530)).toBe('1.5 km')
  })
})

describe('zoneStatus', () => {
  const zones = [zone(1, 0, 0, 300, 0.4), zone(2, 0, 0, 200, 0.9), zone(3, 2000, 0, 300)]

  test('inside several zones picks the riskiest', () => {
    const s = zoneStatus(ll(0, 0), zones)!
    expect(s.inside).toBe(true); expect(s.zone.id).toBe(2)
  })

  test('outside: nearest zone within the radius, with its distance', () => {
    const s = zoneStatus(ll(1500, 0), zones)!                    // 200 m from zone 3's western edge
    expect(s.inside).toBe(false); expect(s.zone.id).toBe(3); expect(s.distance).toBeCloseTo(200, -1)
  })

  test('nothing within the radius, and degenerate zones are ignored', () => {
    expect(zoneStatus(ll(9000, 9000), zones)).toBeNull()
    expect(zoneStatus(ll(0, 0), [{ ...zone(9, 0, 0, 10), polygon: [ll(0, 0), ll(1, 1)] }])).toBeNull()
  })
})
