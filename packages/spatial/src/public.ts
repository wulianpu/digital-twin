/**
 * @twin/spatial — Spatial Core (Architecture Freeze v1.2 §37-39).
 * Single public entry; deep imports are forbidden and CI-enforced.
 */

export type {
  Vec3d,
  Quatd,
  Mat3d,
  ReferenceFrame,
  ReferenceFrameId,
  VerticalReference,
  GeodeticPosition,
  EcefPosition,
  Pose,
  SpatialAnchor
} from './types'

export { createSpatialApi, ConflictingFrameDefinitionError } from './api'
export type { SpatialApi, SceneSpatialApi, FrameRegistration } from './api'
export {
  WGS84_A,
  WGS84_F,
  WGS84_E2,
  geodeticToEcef,
  ecefToGeodetic,
  normalizeGeodetic
} from './wgs84'
export {
  createEnuFrame,
  frameLocalToEcef,
  ecefToFrameLocal,
  geodeticToFrameLocal,
  frameLocalToGeodetic,
  frameOriginDelta
} from './frame'
export { VerticalDatumRegistry, DuplicateRegistrationError } from './datum'
export type { VerticalOffset } from './datum'
export {
  vec3,
  vecAdd,
  vecSub,
  vecScale,
  vecDot,
  vecCross,
  vecLength,
  vecNormalize,
  vecDistance,
  mat3MultiplyVec,
  mat3MultiplyVecTransposed,
  mat3FromColumns,
  quatIdentity,
  quatFromHeadingPitchRoll,
  quatNormalize,
  quatSlerp,
  DEG2RAD,
  RAD2DEG
} from './math'
export type { Disposable } from './lifecycle'
