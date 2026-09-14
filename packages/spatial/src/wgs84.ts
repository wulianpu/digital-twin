import { DEG2RAD, RAD2DEG } from './math'
import type { EcefPosition, GeodeticPosition } from './types'

/** WGS84 ellipsoid constants. */
export const WGS84_A = 6378137.0
export const WGS84_F = 1 / 298.257223563
export const WGS84_E2 = WGS84_F * (2 - WGS84_F)

/** Geodetic WGS84 -> ECEF (Float64, closed form). */
export function geodeticToEcef(p: GeodeticPosition): EcefPosition {
  const lon = p.longitudeDegrees * DEG2RAD
  const lat = p.latitudeDegrees * DEG2RAD
  const h = p.heightMeters
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  return {
    xMeters: (N + h) * cosLat * Math.cos(lon),
    yMeters: (N + h) * cosLat * Math.sin(lon),
    zMeters: (N * (1 - WGS84_E2) + h) * sinLat
  }
}

/**
 * ECEF -> Geodetic WGS84.
 * Iterative latitude refinement (converges to sub-millimeter in <=4 iterations
 * for any near-surface point; height is then exact given the latitude).
 */
export function ecefToGeodetic(e: EcefPosition): GeodeticPosition {
  const x = e.xMeters
  const y = e.yMeters
  const z = e.zMeters
  const lon = Math.atan2(y, x)
  const p = Math.sqrt(x * x + y * y)
  if (p === 0) {
    const lat = Math.sign(z) * (Math.PI / 2)
    const h = Math.abs(z) - WGS84_A * (1 - WGS84_E2)
    return {
      longitudeDegrees: 0,
      latitudeDegrees: lat * RAD2DEG,
      heightMeters: h,
      verticalReference: 'ellipsoid'
    }
  }
  const zScale = z / (p * (1 - WGS84_E2))
  let lat = Math.atan(zScale)
  let sinLat = Math.sin(lat)
  let N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  let h = p / Math.cos(lat) - N
  for (let i = 0; i < 4; i++) {
    lat = Math.atan(z / (p * (1 - (WGS84_E2 * N) / (N + h))))
    sinLat = Math.sin(lat)
    N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
    h = p / Math.cos(lat) - N
  }
  return {
    longitudeDegrees: lon * RAD2DEG,
    latitudeDegrees: lat * RAD2DEG,
    heightMeters: h,
    verticalReference: 'ellipsoid'
  }
}

/**
 * Initial geodetic guess for local sites. Provided for readability at call
 * sites; identical to `ecefToGeodetic` for our purposes.
 */
export function normalizeGeodetic(p: GeodeticPosition): GeodeticPosition {
  return {
    longitudeDegrees: wrapDegrees(p.longitudeDegrees, -180, 180),
    latitudeDegrees: clamp(p.latitudeDegrees, -90, 90),
    heightMeters: p.heightMeters,
    verticalReference: p.verticalReference
  }
}

function wrapDegrees(value: number, min: number, max: number): number {
  const range = max - min
  let v = value
  while (v < min) v += range
  while (v > max) v -= range
  return v
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
