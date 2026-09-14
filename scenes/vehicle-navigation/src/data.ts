import type { Site } from '@twin/world'
import type { ReferenceFrame } from '@twin/spatial'
import { frameLocalToGeodetic } from '@twin/spatial'
import { DEMO_DOCK_ROAD, DEMO_MAIN_ROAD, DEMO_YARD_ROAD, type Vec2 } from '@twin/domain-agv'

/**
 * Deterministic in-plant route network for the demo site. All geometry is
 * authored in the site frame (meters) and projected to WGS84 through the
 * frame — never hand-aligned (§37.3, §88 "业务手工移动模型对齐" is forbidden).
 */

export interface NavigationRoute {
  key: string
  name: string
  waypoints: Vec2[]
}

export interface NavigationLayout {
  readonly frame: ReferenceFrame
  /** GeoJSON FeatureCollection in WGS84 (routes + zones) for MapLibre. */
  readonly routeCollection: GeoJSON.FeatureCollection
  readonly agvStartPoints: Record<string, Vec2>
  readonly routes: readonly NavigationRoute[]
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

function toLngLat(frame: ReferenceFrame, p: Vec2): [number, number] {
  const g = frameLocalToGeodetic(frame, { x: p.x, y: 0, z: p.y })
  return [g.longitudeDegrees, g.latitudeDegrees]
}

export function createNavigationLayout(site: Site, frame: ReferenceFrame): NavigationLayout {
  const rng = mulberry32(site.id.length * 7919 + 42)

  // A3：路网单一事实源——展示路网与演示网关的 AGV 路线共用同一常量
  const mainRoad: Vec2[] = DEMO_MAIN_ROAD
  const dockRoad: Vec2[] = DEMO_DOCK_ROAD
  const yardRoad: Vec2[] = DEMO_YARD_ROAD
  const routes: NavigationRoute[] = [
    { key: 'route-main', name: '主干道', waypoints: mainRoad },
    { key: 'route-dock', name: '码头航线', waypoints: dockRoad },
    { key: 'route-yard', name: '堆场支线', waypoints: yardRoad }
  ]

  const routeFeatures: GeoJSON.Feature[] = routes.map((r) => ({
    type: 'Feature',
    properties: { key: r.key, name: r.name },
    geometry: {
      type: 'LineString',
      coordinates: r.waypoints.map((w) => toLngLat(frame, w))
    }
  }))

  // A couple of no-entry zones (hazard areas near the dock edge).
  const zones: GeoJSON.Feature[] = [
    { x: 350, y: 150, r: 60, label: '临水警戒区' },
    { x: -120, y: 60, r: 45, label: '吊装作业区' }
  ].map((z) => ({
    type: 'Feature',
    properties: { key: `zone-${z.label}`, label: z.label, radius: z.r },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          toLngLat(frame, { x: z.x - z.r, y: z.y - z.r }),
          toLngLat(frame, { x: z.x + z.r, y: z.y - z.r }),
          toLngLat(frame, { x: z.x + z.r, y: z.y + z.r }),
          toLngLat(frame, { x: z.x - z.r, y: z.y + z.r }),
          toLngLat(frame, { x: z.x - z.r, y: z.y - z.r })
        ]
      ]
    }
  }))

  const agvStartPoints: Record<string, Vec2> = {}
  for (let i = 0; i < 6; i++) {
    const route = routes[i % routes.length]
    const waypoint = route.waypoints[Math.floor(rng() * route.waypoints.length)]
    agvStartPoints[`AGV-0${i + 1}`] = { x: waypoint.x + rng() * 20, y: waypoint.y + rng() * 20 }
  }

  return {
    frame,
    routes,
    routeCollection: {
      type: 'FeatureCollection',
      features: [...routeFeatures, ...zones]
    },
    agvStartPoints
  }
}
