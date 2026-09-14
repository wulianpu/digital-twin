/**
 * Spatial Core types (Architecture Freeze v1.2 §37 / §38).
 *
 * Spatial Core MUST NOT depend on THREE, MapLibre, Vue or the DOM.
 * All real-world quantities are Float64 (JS number) meters / radians / degrees.
 */

export interface Vec3d {
  x: number
  y: number
  z: number
}

export interface Quatd {
  x: number
  y: number
  z: number
  w: number
}

/** Row-major 3x3 matrix stored as explicit fields. */
export interface Mat3d {
  xx: number
  xy: number
  xz: number
  yx: number
  yy: number
  yz: number
  zx: number
  zy: number
  zz: number
}

export type ReferenceFrameId = string

/**
 * A rigid frame: `ecef = originECEF + basisECEF * local`.
 * Columns of `basisECEF` are the frame axes expressed in ECEF.
 */
export interface ReferenceFrame {
  readonly id: ReferenceFrameId
  readonly originECEF: Vec3d
  readonly basisECEF: Mat3d
}

export type VerticalReference =
  | 'ellipsoid'
  | 'msl'
  | 'site-datum'
  | 'chart-datum'
  | 'tidal-datum'

export interface GeodeticPosition {
  longitudeDegrees: number
  latitudeDegrees: number
  heightMeters: number
  verticalReference: VerticalReference
}

export interface EcefPosition {
  xMeters: number
  yMeters: number
  zMeters: number
}

export interface Pose {
  frameId: ReferenceFrameId
  positionMeters: Vec3d
  orientation: Quatd
}

export interface SpatialAnchor {
  frameId: ReferenceFrameId
  pose: Pose
}
