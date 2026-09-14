import type { Mat3d, Quatd, Vec3d } from './types'

export const vec3 = (x = 0, y = 0, z = 0): Vec3d => ({ x, y, z })

export function vecAdd(a: Vec3d, b: Vec3d, out: Vec3d = vec3()): Vec3d {
  out.x = a.x + b.x
  out.y = a.y + b.y
  out.z = a.z + b.z
  return out
}

export function vecSub(a: Vec3d, b: Vec3d, out: Vec3d = vec3()): Vec3d {
  out.x = a.x - b.x
  out.y = a.y - b.y
  out.z = a.z - b.z
  return out
}

export function vecScale(a: Vec3d, s: number, out: Vec3d = vec3()): Vec3d {
  out.x = a.x * s
  out.y = a.y * s
  out.z = a.z * s
  return out
}

export function vecDot(a: Vec3d, b: Vec3d): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function vecCross(a: Vec3d, b: Vec3d, out: Vec3d = vec3()): Vec3d {
  const x = a.y * b.z - a.z * b.y
  const y = a.z * b.x - a.x * b.z
  const z = a.x * b.y - a.y * b.x
  out.x = x
  out.y = y
  out.z = z
  return out
}

export function vecLength(a: Vec3d): number {
  return Math.sqrt(vecDot(a, a))
}

export function vecNormalize(a: Vec3d, out: Vec3d = vec3()): Vec3d {
  const len = vecLength(a)
  if (len === 0) {
    out.x = 0
    out.y = 0
    out.z = 0
    return out
  }
  return vecScale(a, 1 / len, out)
}

export function vecDistance(a: Vec3d, b: Vec3d): number {
  return vecLength(vecSub(a, b))
}

/** v' = M * v (column-vector convention). */
export function mat3MultiplyVec(m: Mat3d, v: Vec3d, out: Vec3d = vec3()): Vec3d {
  const x = m.xx * v.x + m.xy * v.y + m.xz * v.z
  const y = m.yx * v.x + m.yy * v.y + m.yz * v.z
  const z = m.zx * v.x + m.zy * v.y + m.zz * v.z
  out.x = x
  out.y = y
  out.z = z
  return out
}

/** Transposed multiply: v' = M^T * v (used for ECEF -> frame-local). */
export function mat3MultiplyVecTransposed(
  m: Mat3d,
  v: Vec3d,
  out: Vec3d = vec3()
): Vec3d {
  const x = m.xx * v.x + m.yx * v.y + m.zx * v.z
  const y = m.xy * v.x + m.yy * v.y + m.zy * v.z
  const z = m.xz * v.x + m.yz * v.y + m.zz * v.z
  out.x = x
  out.y = y
  out.z = z
  return out
}

/** Build a matrix whose COLUMNS are the given axis vectors. */
export function mat3FromColumns(
  col0: Vec3d,
  col1: Vec3d,
  col2: Vec3d
): Mat3d {
  return {
    xx: col0.x,
    xy: col1.x,
    xz: col2.x,
    yx: col0.y,
    yy: col1.y,
    yz: col2.y,
    zx: col0.z,
    zy: col1.z,
    zz: col2.z
  }
}

export const quatIdentity = (): Quatd => ({ x: 0, y: 0, z: 0, w: 1 })

/** Quaternion from heading/pitch/roll radians applied ZYX (heading around Up). */
export function quatFromHeadingPitchRoll(
  headingRadians: number,
  pitchRadians: number,
  rollRadians: number
): Quatd {
  const cy = Math.cos(headingRadians / 2)
  const sy = Math.sin(headingRadians / 2)
  const cp = Math.cos(pitchRadians / 2)
  const sp = Math.sin(pitchRadians / 2)
  const cr = Math.cos(rollRadians / 2)
  const sr = Math.sin(rollRadians / 2)
  // Frame convention (§37.3): X = East, Y = Up, Z = -North.
  // Heading rotates around Up (Y), pitch around East (X), roll around -North (Z).
  return {
    x: sy * cp * cr + cy * sp * sr,
    y: cy * cp * cr + sy * sp * sr,
    z: cy * cp * sr - sy * sp * cr,
    w: cy * cp * cr - sy * sp * sr
  }
}

export function quatNormalize(q: Quatd): Quatd {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len }
}

export function quatSlerp(a: Quatd, b: Quatd, t: number): Quatd {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  if (dot < 0) {
    dot = -dot
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  if (dot > 0.9995) {
    const x = a.x + t * (bx - a.x)
    const y = a.y + t * (by - a.y)
    const z = a.z + t * (bz - a.z)
    const w = a.w + t * (bw - a.w)
    return quatNormalize({ x, y, z, w })
  }
  const theta0 = Math.acos(Math.min(1, dot))
  const theta = theta0 * t
  const sinTheta = Math.sin(theta)
  const s0 = Math.cos(theta) - (dot * sinTheta) / Math.sin(theta0)
  const s1 = sinTheta / Math.sin(theta0)
  return quatNormalize({
    x: s0 * a.x + s1 * bx,
    y: s0 * a.y + s1 * by,
    z: s0 * a.z + s1 * bz,
    w: s0 * a.w + s1 * bw
  })
}

export const DEG2RAD = Math.PI / 180
export const RAD2DEG = 180 / Math.PI
