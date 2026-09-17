/**
 * @twin/scene-engine — Three.js 3D engine (Foundation, §2.3, §17-21, §46-51).
 *
 * IMPORTANT: this public entry must NOT statically import `three` or
 * `3d-tiles-renderer`. The engine boots lazily behind `use()` so 2D-first
 * scenes only download three when the user actually enters 3D
 * (§25, §26, §64) — CI-enforced by the architecture tests.
 */

import type { GeodeticPosition, SpatialApi, Vec3d } from '@twin/spatial'
import { ecefToGeodetic, geodeticToEcef } from '@twin/spatial'
import type {
  GraphicsAccess,
  GraphicsDiagnostics,
  QualityProfile,
  SceneEngineOptions,
  SceneEngineState,
  SceneViewHandle
} from './types'
import type { EngineRuntime } from './runtime'
import { AssetLeaseManager } from './resources'
import type { AssetApiOptions } from './resources'
import { createSceneViewDriver, siteExtentMeters } from './driver'

/** Lazy GraphicsAccess: engine + three download only on first use() (§25). */
const runtimes = new WeakMap<GraphicsAccess, EngineRuntime>()

/** Internal-only boot factory seam（Issue #14 方案 E）：确定性 deferred 竞态测试。 */
export interface GraphicsAccessDeps {
  createRuntime?: (options: SceneEngineOptions) => Promise<EngineRuntime>
}

/** use() 交付的 GraphicsContext 形状（runtime context + per-mount root）。 */
type BootedGraphicsContext = Awaited<ReturnType<GraphicsAccess['use']>>

export function createGraphicsAccess(
  options: SceneEngineOptions,
  deps: GraphicsAccessDeps = {}
): GraphicsAccess {
  let state: SceneEngineState = 'UNINITIALIZED'
  let disposed = false
  // Issue #14：attempt identity（generation）+ terminal monotonicity——
  // 失败可重试（reject 只清本 attempt 的 pending slot）；
  // dispose 后 DISPOSED 永不复活，late runtime exactly-once 回收。
  let generation = 0
  let bootAttempt: { generation: number; promise: Promise<EngineRuntime> } | undefined

  async function boot(attempt: number): Promise<EngineRuntime> {
    try {
      let rt: EngineRuntime
      const create = deps.createRuntime
      if (create) {
        rt = await create(options)
      } else {
        const mod = await import('./runtime')
        if (attempt !== generation || disposed) throw abortedError()
        rt = await mod.createRuntime(options)
      }
      return commit(attempt, rt)
    } catch (error) {
      // #14-C：reject 只清属于本 attempt 的 pending slot（identity 比较）；
      // 未 dispose 时回到可重试的 UNINITIALIZED。
      if (bootAttempt && bootAttempt.generation === attempt) bootAttempt = undefined
      if (!disposed) state = 'UNINITIALIZED'
      throw error
    }
  }

  function commit(attempt: number, rt: EngineRuntime): EngineRuntime {
    // #14-B：destructive commit 前重校验 attempt——stale/disposed 时
    // 迟到的 runtime 被 exactly-once dispose，不写入 WeakMap、不复活 state。
    if (attempt !== generation || disposed) {
      rt.dispose()
      throw new Error('[scene-engine] boot attempt aborted (access disposed)')
    }
    runtimes.set(access, rt)
    state = 'ACTIVE'
    return rt
  }

  function abortedError(): Error {
    return new Error('[scene-engine] boot attempt aborted (access disposed)')
  }

  async function fromAttempt(
    attempt: { generation: number; promise: Promise<EngineRuntime> }
  ): Promise<BootedGraphicsContext> {
    const rt = await attempt.promise
    // await 后重校验 terminal / generation authority
    if (disposed || attempt.generation !== generation) {
      throw abortedError()
    }
    // 每次 use() 分配新的 mount-owned root
    const mount = rt.createMountRoot()
    return { ...rt.context, root: mount.root }
  }

  const access: GraphicsAccess = {
    get state() {
      return state
    },
    get currentContext() {
      if (disposed) return undefined // 终态不变量
      return runtimes.get(access)?.context
    },
  /**
   * 问题3：每次 use() 交付独立 mount root 的 GraphicsContext——
   * Scene unmount/throw/timeout 时宿主可无条件 detach 该 mount root。
   * 其余能力（camera/renderer/environment/entities）为引擎级共享。
   */
  use(): Promise<BootedGraphicsContext> {
    if (disposed || state === 'DISPOSED') {
      return Promise.reject(new Error('[scene-engine] access disposed'))
    }
    // #14：同 generation 内并发 use() 共享同一次 **runtime boot**（single-flight）
    let attempt = bootAttempt
    if (!attempt || attempt.generation !== generation) {
      const gen = ++generation
      attempt = { generation: gen, promise: boot(gen) }
      bootAttempt = attempt
    }
    // #14-r2（复审）：single-flight 只针对 EngineRuntime——
    // SceneMountRoot 是 **per-use / per-SceneMount 独占**资源（§25），
    // 每次 use() 成功后都分配全新 root，绝不共享 BootedGraphicsContext。
    return fromAttempt(attempt)
  },
    applyQuality(profile: QualityProfile) {
      runtimes.get(access)?.adaptive.force(profile)
    },
    suspend() {
      runtimes.get(access)?.suspend()
    },
    resume() {
      runtimes.get(access)?.resume()
    },
    getDiagnostics(): GraphicsDiagnostics | undefined {
      return runtimes.get(access)?.context.getDiagnostics()
    },
    dispose() {
      if (disposed) return // 幂等
      disposed = true
      state = 'DISPOSED'
      generation++ // 使所有 pending attempt 失去 commit authority
      bootAttempt = undefined
      const rt = runtimes.get(access)
      if (rt) {
        rt.dispose()
        runtimes.delete(access)
      }
    }
  }
  return access
}

/** Composition-root helper: the booted runtime behind an access, if any. */
export function getSceneEngineRuntime(access: GraphicsAccess): EngineRuntime | undefined {
  return runtimes.get(access)
}

export function createAssetApi(options: AssetApiOptions): AssetLeaseManager {
  return new AssetLeaseManager(options)
}
export { SpatialStateBuffer } from '@twin/world-client'
export { UnsupportedAssetKindError } from './resources'

/**
 * App-level binding that turns a live EngineRuntime into the geodetic-level
 * handle the ViewDriver consumes. Works in site mode (frame-local meters)
 * and global mode (ECEF km, camera-relative) alike.
 */
export function createSceneEngineViewBinding(args: {
  getRuntime(): EngineRuntime | undefined
  spatial?: SpatialApi
  /**
   * Issue #31：frame mode authority 必须与 getRuntime() 同源——传静态
   * boolean 会复制出第二个可分叉的配置点（Engine=GLOBAL 但 View=SITE）。
   * 传读取同一 mode authority 的 getter；每次 handle() 重新求值。
   */
  global?: boolean | (() => boolean)
}): { handle(): SceneViewHandle | undefined } {
  return {
    handle() {
      const rt = args.getRuntime()
      if (!rt) return undefined
      const global =
        typeof args.global === 'function' ? args.global() : args.global === true
      const spatial = args.spatial
      return {
        focusEntity(entityRef, defaultRangeMeters = 150) {
          const tmp: Vec3d = { x: 0, y: 0, z: 0 }
          if (!rt.entitySystem.getPosition(entityRef, tmp)) return false
          rt.orbit.focus(tmp, global ? defaultRangeMeters / 1000 : defaultRangeMeters)
          return true
        },
        applyGeodeticTarget(target: GeodeticPosition, scaleMeters, headingRadians) {
          void headingRadians
          if (global) {
            const ecef = geodeticToEcef(target)
            rt.orbit.focus(
              { x: ecef.xMeters / 1000, y: ecef.zMeters / 1000, z: -ecef.yMeters / 1000 },
              scaleMeters !== undefined ? scaleMeters / 1000 : undefined
            )
          } else {
            const local = spatial ? tryLocal(spatial, target) : ({ x: 0, y: 0, z: 0 } as Vec3d)
            rt.orbit.focus(local, scaleMeters)
          }
        },
        getGeodeticTarget() {
          const t = rt.orbit.state.target
          let target: GeodeticPosition | undefined
          if (global) {
            target = ecefToGeodetic({
              xMeters: t.x * 1000,
              yMeters: -t.z * 1000,
              zMeters: t.y * 1000
            })
          } else {
            if (!spatial) return undefined
            try {
              target = spatial.localToGeodetic(t)
            } catch {
              return undefined
            }
          }
          return {
            target,
            scaleMeters: global ? rt.orbit.state.distance * 1000 : rt.orbit.state.distance
          }
        }
      }
    }
  }
}

function tryLocal(spatial: SpatialApi, target: GeodeticPosition): Vec3d {
  try {
    return spatial.geodeticToLocal(target)
  } catch {
    return { x: 0, y: 0, z: 0 }
  }
}

export { createSceneViewDriver, siteExtentMeters }
export { ContextLossGuard } from './contextLoss'
export type { ContextLossHooks } from './contextLoss'
export type {
  GraphicsAccess,
  GraphicsContext,
  GraphicsDiagnostics,
  QualityProfile,
  SceneEngineOptions,
  SceneEngineState,
  SceneDriverOptions,
  SceneViewDriver,
  SceneViewHandle,
  TilesPolicy,
  TilesDiagnostics,
  WaterState,
  EnvironmentApi,
  GlobalEnvironmentApi,
  EntitySystemApi,
  FrameInfo,
  PickEvent,
  Disposable,
  MapAccess,
  MapContext,
  MapEngineState,
  MapViewDriver
} from './types'
export type { EngineRuntime } from './runtime'
export type { AssetApiOptions, AssetSource, LoadedAsset } from './resources'
export { AdaptiveQuality, profileSettings } from './adaptive'
export { FrameLoop } from './frameLoop'
export type { FrameCallback } from './frameLoop'
export { OrbitController } from './orbit'
export { TilesSystem } from './tiles'
export type { TilesRendererLike, TilesRendererFactory } from './tiles'
export { EntitySystem } from './entities'
export { PickingSystem } from './picking'
export { EnvironmentSystem } from './environment'
export { GlobalEarthSystem } from './earth'
