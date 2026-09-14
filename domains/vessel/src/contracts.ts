import type { EntityRef } from '@twin/world'
import type { DataEnvelope } from '@twin/world-client'

/**
 * Vessel domain contract (§33: business state is defined by Scene / Domain
 * contracts; the platform only understands the envelope).
 */
export const VESSEL_CONTRACT = 'twin.vessel.state@1'

export interface VesselState {
  name?: string
  shipType?: 'bulk-carrier' | 'container' | 'crane-vessel' | 'tug' | 'other'
  /** WGS84 position. */
  longitudeDegrees: number
  latitudeDegrees: number
  /** Rotational speed over ground / course over ground. */
  sogKnots: number
  cogDegrees: number
  headingDegrees: number
  /** Navigational status code (AIS). */
  navStatus?: number
  lengthMeters?: number
}

export function vesselEntity(mmsi: string): EntityRef {
  return { namespace: 'ais', id: mmsi }
}

export function decodeVessel(envelope: DataEnvelope): VesselState | undefined {
  const p = envelope.payload as Partial<VesselState> | undefined
  if (
    !p ||
    typeof p.longitudeDegrees !== 'number' ||
    typeof p.latitudeDegrees !== 'number'
  ) {
    return undefined
  }
  return {
    name: p.name,
    shipType: p.shipType ?? 'other',
    longitudeDegrees: p.longitudeDegrees,
    latitudeDegrees: p.latitudeDegrees,
    sogKnots: p.sogKnots ?? 0,
    cogDegrees: p.cogDegrees ?? p.headingDegrees ?? 0,
    headingDegrees: p.headingDegrees ?? 0,
    navStatus: p.navStatus,
    lengthMeters: p.lengthMeters
  }
}
