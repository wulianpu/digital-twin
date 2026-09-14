import type { EntityRef } from '@twin/world'
import type { DataEnvelope } from '@twin/world-client'

/** Gantry crane domain contract (matches the §33 example). */
export const CRANE_CONTRACT = 'twin.crane.state@1'

export type CraneStatus = 'running' | 'idle' | 'fault'

export interface CraneState {
  status: CraneStatus
  hookHeightMeters: number
  loadTonnes: number
  /** Gantry slew along rails, frame-local meters. */
  gantryMeters: number
  /** Trolley position across the boom, frame-local meters. */
  trolleyMeters: number
  boomHeadingDeg: number
}

export function craneEntity(code: string): EntityRef {
  return { namespace: 'production', id: code }
}

export function decodeCrane(envelope: DataEnvelope): CraneState | undefined {
  const p = envelope.payload as Partial<CraneState> | undefined
  if (!p || typeof p.hookHeightMeters !== 'number') return undefined
  return {
    status: p.status ?? 'idle',
    hookHeightMeters: p.hookHeightMeters,
    loadTonnes: p.loadTonnes ?? 0,
    gantryMeters: p.gantryMeters ?? 0,
    trolleyMeters: p.trolleyMeters ?? 0,
    boomHeadingDeg: p.boomHeadingDeg ?? 0
  }
}

/** Deterministic kinematic sample for demos / simulation (pure). */
export function simulateCrane(
  base: { gantryTrackMeters: number; boomHeadingDeg: number },
  timeMs: number
): CraneState {
  const cycle = (timeMs / 30_000) % 1
  const running = cycle < 0.85
  const phase = Math.sin(cycle * Math.PI * 4)
  return {
    status: cycle > 0.82 ? 'fault' : running ? 'running' : 'idle',
    hookHeightMeters: 12 + phase * 8,
    loadTonnes: running ? 40 + phase * 15 : 0,
    gantryMeters: base.gantryTrackMeters * (0.5 + 0.35 * Math.sin(cycle * Math.PI * 2)),
    trolleyMeters: 20 + phase * 14,
    boomHeadingDeg: base.boomHeadingDeg
  }
}
