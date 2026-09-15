import { VerticalDatumRegistry } from './datum'
import {
  createEnuFrame,
  ecefToFrameLocal,
  freezeFrame,
  frameLocalToEcef,
  frameLocalToGeodetic,
  geodeticToFrameLocal
} from './frame'
import type { Disposable } from './lifecycle'
import type {
  EcefPosition,
  GeodeticPosition,
  ReferenceFrame,
  ReferenceFrameId,
  Vec3d,
  VerticalReference
} from './types'

/**
 * Platform semantics for the spatial capability (SceneContext.spatial).
 * Implemented WITHOUT any engine dependency; engines adapt on top.
 */
export interface SpatialApi {
  readonly activeFrameId: ReferenceFrameId | undefined
  listFrames(): readonly ReferenceFrame[]
  getFrame(id: ReferenceFrameId): ReferenceFrame | undefined
  registerFrame(frame: ReferenceFrame): Disposable
  ensureEnuFrame(id: ReferenceFrameId, origin: GeodeticPosition): ReferenceFrame
  setActiveFrame(id: ReferenceFrameId | undefined): void
  onActiveFrameChanged(cb: (id: ReferenceFrameId | undefined) => void): Disposable

  /** Active-frame conversions. Throws if no active frame is set. */
  geodeticToLocal(p: GeodeticPosition): Vec3d
  localToGeodetic(local: Vec3d): GeodeticPosition
  ecefToLocal(ecef: EcefPosition): Vec3d
  localToEcef(local: Vec3d): EcefPosition

  registerVerticalOffset(
    from: VerticalReference,
    to: VerticalReference,
    meters: number
  ): Disposable
  /** Normalize a position's height into the ellipsoidal datum (§39). */
  toEllipsoidal(p: GeodeticPosition): GeodeticPosition
}

export function createSpatialApi(): SpatialApi {
  const frames = new Map<ReferenceFrameId, ReferenceFrame>()
  const datum = new VerticalDatumRegistry()
  let activeFrameId: ReferenceFrameId | undefined
  const listeners = new Set<(id: ReferenceFrameId | undefined) => void>()

  const api: SpatialApi = {
    get activeFrameId() {
      return activeFrameId
    },
    listFrames: () => [...frames.values()],
    getFrame: (id) => frames.get(id),
    registerFrame(frame) {
      // Issue #5：registry 存 frozen 深拷贝——调用方对象后续变化不影响空间事实
      const stored = freezeFrame({
        id: frame.id,
        originECEF: { ...frame.originECEF },
        basisECEF: { ...frame.basisECEF }
      })
      frames.set(frame.id, stored)
      return {
        dispose: () => {
          frames.delete(frame.id)
        }
      }
    },
    ensureEnuFrame(id, origin) {
      const existing = frames.get(id)
      if (existing) return existing
      const frame = createEnuFrame(id, datum.toEllipsoidal(origin))
      frames.set(id, frame)
      return frame
    },
    setActiveFrame(id) {
      if (activeFrameId === id) return
      if (id !== undefined && !frames.has(id)) {
        throw new Error(`[spatial] cannot activate unknown frame "${id}"`)
      }
      activeFrameId = id
      for (const cb of listeners) cb(id)
    },
    onActiveFrameChanged(cb) {
      listeners.add(cb)
      return {
        dispose: () => {
          listeners.delete(cb)
        }
      }
    },
    geodeticToLocal(p) {
      return geodeticToFrameLocal(requireFrame(), datum.toEllipsoidal(p))
    },
    localToGeodetic(local) {
      return frameLocalToGeodetic(requireFrame(), local)
    },
    ecefToLocal(ecef) {
      return ecefToFrameLocal(requireFrame(), ecef)
    },
    localToEcef(local) {
      return frameLocalToEcef(requireFrame(), local)
    },
    registerVerticalOffset(from, to, meters) {
      const unregister = datum.register({ from, to, meters })
      return {
        dispose: () => {
          unregister()
        }
      }
    },
    toEllipsoidal(p) {
      return datum.toEllipsoidal(p)
    }
  }

  function requireFrame(): ReferenceFrame {
    if (activeFrameId === undefined) {
      throw new Error(
        '[spatial] no active reference frame. Call setActiveFrame() (site scope) or use geodetic/ECEF values directly (global scope).'
      )
    }
    return frames.get(activeFrameId)!
  }

  return api
}
