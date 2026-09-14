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

export function createGraphicsAccess(options: SceneEngineOptions): GraphicsAccess {
  let state: SceneEngineState = 'UNINITIALIZED'
  let bootPromise: Promise<EngineRuntime> | undefined

  async function boot(): Promise<EngineRuntime> {
    const mod = await import('./runtime')
    const rt = await mod.createRuntime(options)
    runtimes.set(access, rt)
    state = 'ACTIVE'
    return rt
  }

  const access: GraphicsAccess = {
    get state() {
      return state
    },
    get currentContext() {
      return runtimes.get(access)?.context
    },
  /**
   * 问题3：每次 use() 交付独立 mount root 的 GraphicsContext——
   * Scene unmount/throw/timeout 时宿主可无条件 detach 该 mount root。
   * 其余能力（camera/renderer/environment/entities）为引擎级共享。
   */
  use() {
    if (state === 'DISPOSED') {
      return Promise.reject(new Error('[scene-engine] access disposed'))
    }
    bootPromise ??= boot()
    return bootPromise.then((rt) => {
      const mount = rt.createMountRoot()
      return { ...rt.context, root: mount.root }
    })
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
      runtimes.get(access)?.dispose()
      runtimes.delete(access)
      bootPromise = undefined
      state = 'DISPOSED'
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

/**
 * App-level binding that turns a live EngineRuntime into the geodetic-level
 * handle the ViewDriver consumes. Works in site mode (frame-local meters)
 * and global mode (ECEF km, camera-relative) alike.
 */
export function createSceneEngineViewBinding(args: {
  getRuntime(): EngineRuntime | undefined
  spatial?: SpatialApi
  global?: boolean
}): { handle(): SceneViewHandle | undefined } {
  return {
    handle() {
      const rt = args.getRuntime()
      if (!rt) return undefined
      const global = args.global === true
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
