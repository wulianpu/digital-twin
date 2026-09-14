import type { EntityRef } from '@twin/world'
import type { DataEnvelope } from '@twin/world-client'

/** Stack yard domain contract (分段堆场). */
export const STACK_CONTRACT = 'twin.stack.state@1'

export type StackStatus = 'stored' | 'inbound' | 'outbound' | 'maintenance'

export interface StackState {
  blockCode: string
  status: StackStatus
  weightTonnes: number
  segment: string
  dueDayOffset?: number
}

export function stackEntity(code: string): EntityRef {
  return { namespace: 'yard', id: code }
}

export function decodeStack(envelope: DataEnvelope): StackState | undefined {
  const p = envelope.payload as Partial<StackState> | undefined
  if (!p || typeof p.blockCode !== 'string') return undefined
  return {
    blockCode: p.blockCode,
    status: p.status ?? 'stored',
    weightTonnes: p.weightTonnes ?? 0,
    segment: p.segment ?? '',
    dueDayOffset: p.dueDayOffset
  }
}

/** Heavy transport / lifting domain (大件运输): route + clearance risk. */
export interface ExclusionZone {
  id: string
  /** Frame-local center. */
  centerX: number
  centerY: number
  radiusMeters: number
  label?: string
}

export interface RouteRisk {
  zoneId: string | undefined
  /** Distance from the route point to the nearest zone center. */
  clearanceMeters: number
  /** True when inside a zone (hard violation). */
  violating: boolean
}

export function assessRouteRisk(
  point: { x: number; y: number },
  zones: readonly ExclusionZone[],
  /** 运输件包络半径（米）：大件不应只测中心点（B1）。 */
  envelopeRadiusMeters = 0
): RouteRisk {
  let best: RouteRisk = { zoneId: undefined, clearanceMeters: Number.POSITIVE_INFINITY, violating: false }
  for (const zone of zones) {
    const d = Math.hypot(point.x - zone.centerX, point.y - zone.centerY)
    if (d < best.clearanceMeters) {
      best = {
        zoneId: zone.id,
        clearanceMeters: d,
        violating: d < zone.radiusMeters + envelopeRadiusMeters
      }
    }
  }
  return best
}

/** Deterministic heavy-transport progress along a route (scene-private preview, §28). */
export function simulateTransportProgress(
  routeLengthMeters: number,
  timeMs: number,
  speedMs: number
): number {
  return Math.min(routeLengthMeters, Math.max(0, (timeMs / 1000) * speedMs))
}
