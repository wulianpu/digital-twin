import type { EntityRef } from '@twin/world'
import type { Vec3d } from '@twin/spatial'
import type { DataEnvelope } from '@twin/world-client'

/** AGV domain contract (spatial fast path consumer, §35). */
export const AGV_CONTRACT = 'twin.agv.state@1'

export interface AgvState {
  /** Site-frame pose (X=East, Y=Up, Z=-North). */
  xMeters: number
  yMeters: number
  headingDeg: number
  speedMs: number
  batteryPct: number
  taskId?: string
}

export function agvEntity(code: string): EntityRef {
  return { namespace: 'agv', id: code }
}

export function decodeAgv(envelope: DataEnvelope): AgvState | undefined {
  const p = envelope.payload as Partial<AgvState> | undefined
  if (!p || typeof p.xMeters !== 'number') return undefined
  return {
    xMeters: p.xMeters,
    yMeters: p.yMeters ?? 0,
    headingDeg: p.headingDeg ?? 0,
    speedMs: p.speedMs ?? 0,
    batteryPct: p.batteryPct ?? 100,
    taskId: p.taskId
  }
}

/**
 * Pure route math shared by navigation / transport scenes.
 * A route is a polyline of frame-local waypoints.
 */
export function routeLength(route: readonly Vec2[]): number {
  let total = 0
  for (let i = 1; i < route.length; i++) {
    total += distance(route[i - 1], route[i])
  }
  return total
}

export function pointAlongRoute(route: readonly Vec2[], meters: number): { point: Vec2; headingDeg: number } {
  let remaining = Math.max(0, meters)
  for (let i = 1; i < route.length; i++) {
    const seg = distance(route[i - 1], route[i])
    if (remaining <= seg || i === route.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, remaining / seg)
      const a = route[i - 1]
      const b = route[i]
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        headingDeg: (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI
      }
    }
    remaining -= seg
  }
  return { point: route[route.length - 1], headingDeg: 0 }
}

export interface Vec2 {
  x: number
  y: number
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** Frame-local 2D point -> Vec3d ground pose (Y=0). */
export function toGround(pose: Vec2, y = 0): Vec3d {
  return { x: pose.x, y, z: pose.y }
}

/**
 * Deterministic AGV motion along a closed route for demos / simulation.
 * `progress` advances with time; battery drains slowly per lap.
 */
export function simulateAgvOnRoute(
  route: readonly Vec2[],
  timeMs: number,
  speedMs: number,
  startOffsetMeters = 0
): AgvState {
  const total = routeLength(route)
  const travelled = (startOffsetMeters + (timeMs / 1000) * speedMs) % total
  const { point, headingDeg } = pointAlongRoute(route, travelled)
  const lap = Math.floor((startOffsetMeters + (timeMs / 1000) * speedMs) / Math.max(1, total))
  return {
    xMeters: point.x,
    yMeters: point.y,
    headingDeg,
    speedMs,
    batteryPct: Math.max(15, 100 - lap * 0.5),
    taskId: `TASK-${(lap % 8) + 1}`
  }
}

// 演示路网（A3 单一事实源）
export {
  DEMO_MAIN_ROAD,
  DEMO_DOCK_ROAD,
  DEMO_YARD_ROAD,
  DEMO_AGV_LOOP
} from './demoRoutes'
