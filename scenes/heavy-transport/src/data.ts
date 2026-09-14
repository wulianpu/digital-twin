import type { Site } from '@twin/world'
import type { ReferenceFrame } from '@twin/spatial'
import { frameLocalToGeodetic } from '@twin/spatial'
import { routeLength, type Vec2 } from '@twin/domain-agv'
import type { ExclusionZone } from '@twin/domain-logistics'

/**
 * Heavy transport route plan (frame-local meters). The trolley preview is a
 * SCENE-PRIVATE simulation (§28): it never creates a Simulation WorldMode.
 */

export interface TransportPlan {
  readonly frame: ReferenceFrame
  readonly route: ReadonlyArray<Vec2>
  readonly routeLengthMeters: number
  readonly zones: readonly ExclusionZone[]
  readonly routeCoordinates: Array<[number, number]>
  readonly zoneFeatures: GeoJSON.FeatureCollection
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function lngLat(frame: ReferenceFrame, p: Vec2): [number, number] {
  const g = frameLocalToGeodetic(frame, { x: p.x, y: 0, z: p.y })
  return [Math.round(g.longitudeDegrees * 1e6) / 1e6, Math.round(g.latitudeDegrees * 1e6) / 1e6]
}

export function createTransportPlan(site: Site, frame: ReferenceFrame): TransportPlan {
  const rng = mulberry32(site.id.length * 31 + 5)

  // Quay-side origin to the assembly shop, via the heavy-duty corridor.
  const route: Vec2[] = [
    { x: -480, y: -480 },
    { x: -160, y: -480 },
    { x: 80, y: -380 },
    { x: 260, y: -160 },
    { x: 420, y: 60 },
    { x: 430, y: 300 }
  ]

  // Restricted zones near the corridor.
  const zones: ExclusionZone[] = [
    { id: 'zone-quay-edge', centerX: -300, centerY: -430, radiusMeters: 70, label: '岸沿限制区' },
    { id: 'zone-welding', centerX: -320, centerY: 120, radiusMeters: 90, label: '焊接车间禁行' },
    { id: 'zone-fuel', centerX: 330, centerY: 190, radiusMeters: 55, label: '油库防爆区' }
  ]
  void rng

  return {
    frame,
    route,
    routeLengthMeters: routeLength(route),
    zones,
    routeCoordinates: route.map((p) => lngLat(frame, p)),
    zoneFeatures: {
      type: 'FeatureCollection',
      features: zones.map((z) => {
        const ring = [
          { x: z.centerX - z.radiusMeters, y: z.centerY - z.radiusMeters },
          { x: z.centerX + z.radiusMeters, y: z.centerY - z.radiusMeters },
          { x: z.centerX + z.radiusMeters, y: z.centerY + z.radiusMeters },
          { x: z.centerX - z.radiusMeters, y: z.centerY + z.radiusMeters },
          { x: z.centerX - z.radiusMeters, y: z.centerY - z.radiusMeters }
        ].map((p) => lngLat(frame, p))
        return {
          type: 'Feature',
          properties: { id: z.id, label: z.label, radius: z.radiusMeters },
          geometry: { type: 'Polygon', coordinates: [ring] }
        } as GeoJSON.Feature
      })
    }
  }
}
