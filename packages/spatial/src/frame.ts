import { geodeticToEcef, ecefToGeodetic } from './wgs84'
import {
  mat3FromColumns,
  mat3MultiplyVec,
  mat3MultiplyVecTransposed,
  vec3,
  vecCross,
  vecNormalize
} from './math'
import type {
  EcefPosition,
  GeodeticPosition,
  Mat3d,
  ReferenceFrame,
  ReferenceFrameId,
  Vec3d
} from './types'

/**
 * Site Reference Frame (§37.3): X = East, Y = Up, Z = -North.
 * Right-handed; physics / navigation / kinematics all run in this frame.
 */
export function createEnuFrame(
  id: ReferenceFrameId,
  origin: GeodeticPosition
): ReferenceFrame {
  const originEcef = geodeticToEcef(origin)
  const up = vecNormalize(vec3(originEcef.xMeters, originEcef.yMeters, originEcef.zMeters))
  const k = vec3(0, 0, 1)
  let east = vecCross(k, up)
  if (Math.hypot(east.x, east.y, east.z) < 1e-9) {
    east = vec3(1, 0, 0) // at the poles
  }
  vecNormalize(east, east)
  const north = vecCross(up, east)
  // Z = -North
  const minusNorth = vec3(-north.x, -north.y, -north.z)
  const basisECEF: Mat3d = mat3FromColumns(east, up, minusNorth)
  return {
    id,
    originECEF: { x: originEcef.xMeters, y: originEcef.yMeters, z: originEcef.zMeters },
    basisECEF
  }
}

/** frame-local meters -> ECEF meters. */
export function frameLocalToEcef(frame: ReferenceFrame, local: Vec3d): EcefPosition {
  const rotated = mat3MultiplyVec(frame.basisECEF, local)
  return {
    xMeters: frame.originECEF.x + rotated.x,
    yMeters: frame.originECEF.y + rotated.y,
    zMeters: frame.originECEF.z + rotated.z
  }
}

/** ECEF meters -> frame-local meters. */
export function ecefToFrameLocal(frame: ReferenceFrame, ecef: EcefPosition): Vec3d {
  const delta = vec3(
    ecef.xMeters - frame.originECEF.x,
    ecef.yMeters - frame.originECEF.y,
    ecef.zMeters - frame.originECEF.z
  )
  return mat3MultiplyVecTransposed(frame.basisECEF, delta)
}

export function geodeticToFrameLocal(frame: ReferenceFrame, p: GeodeticPosition): Vec3d {
  return ecefToFrameLocal(frame, geodeticToEcef(p))
}

export function frameLocalToGeodetic(frame: ReferenceFrame, local: Vec3d): GeodeticPosition {
  return ecefToGeodetic(frameLocalToEcef(frame, local))
}

/** Frame-local position of another frame's origin (diagnostics / sanity). */
export function frameOriginDelta(frame: ReferenceFrame, other: ReferenceFrame): Vec3d {
  const delta = vec3(
    other.originECEF.x - frame.originECEF.x,
    other.originECEF.y - frame.originECEF.y,
    other.originECEF.z - frame.originECEF.z
  )
  return mat3MultiplyVecTransposed(frame.basisECEF, delta)
}
