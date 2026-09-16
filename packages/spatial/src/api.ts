import { VerticalDatumRegistry, DuplicateRegistrationError } from './datum'
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
 * Registry entry owner kind（Issue #9）：'app' = Composition Root ensure
 * 的平台级 baseline（可被 registerEnuFrame 借用）；'registration' = 由
 * registerFrame / registerEnuFrame 创建、绑定 token 生命周期的注册项。
 */
interface FrameEntry {
  readonly owner: 'app' | 'registration'
  readonly token: object
  readonly frame: ReferenceFrame
}

/**
 * Platform semantics for the spatial capability. Implemented WITHOUT any
 * engine dependency; engines adapt on top.
 */
export interface SpatialApi {
  readonly activeFrameId: ReferenceFrameId | undefined
  listFrames(): readonly ReferenceFrame[]
  getFrame(id: ReferenceFrameId): ReferenceFrame | undefined
  registerFrame(frame: ReferenceFrame): Disposable
  registerEnuFrame(id: ReferenceFrameId, origin: GeodeticPosition): FrameRegistration
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

/**
 * 带 owner handle 的 frame 注册（Issue #8）：Scene 创建的 frame 必须可被
 * MountScope 回收。frame 为借用（app-owned 已存在）时 dispose 为 no-op。
 */
export interface FrameRegistration extends Disposable {
  readonly frame: ReferenceFrame
}

/**
 * Issue #8-C：同 id 不同空间定义 fail-fast——配置顺序错误不得静默使用
 * 错误的空间基准。
 */
export class ConflictingFrameDefinitionError extends Error {
  readonly id: ReferenceFrameId
  constructor(id: ReferenceFrameId) {
    super(
      `[spatial] conflicting definition for frame "${id}"（同 id 不同 origin/datum，禁止静默复用旧 frame）`
    )
    this.name = 'ConflictingFrameDefinitionError'
    this.id = id
  }
}

/** Issue #8：Scene-facing Spatial 契约——不暴露 app-lifetime ensure 能力；
 * Scene 需要 frame 时走 registerEnuFrame（返回 owner handle，Host 可回收）。 */
export type SceneSpatialApi = Omit<SpatialApi, 'ensureEnuFrame'>

const EPSILON = 1e-9

function sameDefinition(a: ReferenceFrame, b: ReferenceFrame): boolean {
  const vecClose = (x: Vec3d, y: Vec3d) =>
    Math.abs(x.x - y.x) < EPSILON &&
    Math.abs(x.y - y.y) < EPSILON &&
    Math.abs(x.z - y.z) < EPSILON
  const matClose =
    Math.abs(a.basisECEF.xx - b.basisECEF.xx) < EPSILON &&
    Math.abs(a.basisECEF.xy - b.basisECEF.xy) < EPSILON &&
    Math.abs(a.basisECEF.xz - b.basisECEF.xz) < EPSILON &&
    Math.abs(a.basisECEF.yx - b.basisECEF.yx) < EPSILON &&
    Math.abs(a.basisECEF.yy - b.basisECEF.yy) < EPSILON &&
    Math.abs(a.basisECEF.yz - b.basisECEF.yz) < EPSILON &&
    Math.abs(a.basisECEF.zx - b.basisECEF.zx) < EPSILON &&
    Math.abs(a.basisECEF.zy - b.basisECEF.zy) < EPSILON &&
    Math.abs(a.basisECEF.zz - b.basisECEF.zz) < EPSILON
  return vecClose(a.originECEF, b.originECEF) && matClose
}

export interface SpatialApiOptions {
  /**
   * Issue #20：listener fault boundary 的上报通道（限频同 #19：仅
   * ok→failing 转变时上报一次）。缺省降级 console.error。
   */
  onListenerError?: (error: unknown, meta: { event: string }) => void
}

export function createSpatialApi(onListenerError?: (error: unknown, meta: { event: string }) => void): SpatialApi {
  // Issue #7：registration identity——disposer 绑定注册身份而非仅绑定 key
  // Issue #9：entry 记录 owner kind——'app'（Composition Root ensure）才允许
  // no-op borrow；'registration'（registerFrame / registerEnuFrame 创建）是
  // registration-owned，重复注册一律 fail-fast，杜绝伪 borrow lease。
  const frames = new Map<ReferenceFrameId, FrameEntry>()
  const datum = new VerticalDatumRegistry()
  let activeFrameId: ReferenceFrameId | undefined
  const listeners = new Set<(id: ReferenceFrameId | undefined) => void>()
  // Issue #20：listener fault boundary——逐隔离 + 限频（ok→failing 转变上报一次）
  const failing = new WeakMap<(id: ReferenceFrameId | undefined) => void, true>()
  const notify = (id: ReferenceFrameId | undefined): void => {
    for (const cb of [...listeners]) {
      try {
        cb(id)
        failing.delete(cb)
      } catch (error) {
        if (failing.has(cb)) continue // 已上报，限频
        failing.set(cb, true)
        try {
          onListenerError?.(error, { event: 'spatial.activeFrameChanged' })
        } catch {
          /* sink 自身异常不得击穿 dispatch */
        }
      }
    }
  }

  const api: SpatialApi = {
    get activeFrameId() {
      return activeFrameId
    },
    listFrames: () => [...frames.values()].map((entry) => entry.frame),
    getFrame: (id) => frames.get(id)?.frame,
    registerFrame(frame) {
      // Issue #5：registry 存 frozen 深拷贝——调用方对象后续变化不影响空间事实
      const stored = freezeFrame({
        id: frame.id,
        originECEF: { ...frame.originECEF },
        basisECEF: { ...frame.basisECEF }
      })
      // Issue #7：互斥注册——duplicate id fail-fast，无任何瞬时副作用
      if (frames.has(frame.id)) {
        throw new DuplicateRegistrationError('frame', frame.id)
      }
      const token: object = {}
      frames.set(frame.id, { owner: 'registration', token, frame: stored })
      let disposed = false
      return {
        dispose: () => {
          if (disposed) return
          disposed = true
          removeFrame(frame.id, token)
        }
      }
    },
    registerEnuFrame(id, origin) {
      // Issue #8 + #9：Scene 拥有 owner handle 的 frame 注册——
      // 仅 app-owned 同定义 → 借用（dispose no-op）；
      // registration-owned existing（无论来自 registerFrame 还是
      // registerEnuFrame）→ DuplicateRegistrationError，不返回伪 lease；
      // 同 id 不同定义 → fail-fast；新 id → scene-owned registration。
      const desired = createEnuFrame(id, datum.toEllipsoidal(origin))
      const existing = frames.get(id)
      if (existing) {
        if (!sameDefinition(existing.frame, desired)) {
          throw new ConflictingFrameDefinitionError(id)
        }
        if (existing.owner !== 'app') {
          throw new DuplicateRegistrationError('frame', id)
        }
        return { frame: existing.frame, dispose: () => {} }
      }
      const token: object = {}
      frames.set(id, { owner: 'registration', token, frame: desired })
      let disposed = false
      return {
        frame: desired,
        dispose: () => {
          if (disposed) return
          disposed = true
          removeFrame(id, token)
        }
      }
    },
    ensureEnuFrame(id, origin) {
      // Issue #8-C + #9-C：ensure 是 Composition Root 的幂等引导语义——
      // 同 id 不同定义不得静默返回旧 frame；registration-owned entry
      // 不得被隐式提升为 app-lifetime baseline（fail-fast）。
      const desired = createEnuFrame(id, datum.toEllipsoidal(origin))
      const existing = frames.get(id)
      if (existing) {
        if (existing.owner !== 'app') {
          throw new DuplicateRegistrationError('frame', id)
        }
        if (!sameDefinition(existing.frame, desired)) {
          throw new ConflictingFrameDefinitionError(id)
        }
        return existing.frame
      }
      frames.set(id, { owner: 'app', token: {}, frame: desired })
      return desired
    },
    setActiveFrame(id) {
      if (activeFrameId === id) return
      if (id !== undefined && !frames.has(id)) {
        throw new Error(`[spatial] cannot activate unknown frame "${id}"`)
      }
      activeFrameId = id
      notify(id)
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

  function removeFrame(id: ReferenceFrameId, token: object): void {
    // Issue #7：compare-and-delete——stale disposer 不得删除后来 owner 的 frame
    if (frames.get(id)?.token !== token) return
    frames.delete(id)
    // Issue #7-D：active frame 不允许指向不存在的 registry entry
    if (activeFrameId === id) {
      activeFrameId = undefined
      notify(undefined)
    }
  }

  function requireFrame(): ReferenceFrame {
    if (activeFrameId === undefined) {
      throw new Error(
        '[spatial] no active reference frame. Call setActiveFrame() (site scope) or use geodetic/ECEF values directly (global scope).'
      )
    }
    return frames.get(activeFrameId)!.frame
  }

  return api
}
