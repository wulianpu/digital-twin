import * as THREE from 'three'
import { ecefToGeodetic } from '@twin/spatial'
import type {
  EnvironmentApi,
  FrameInfo,
  GraphicsContext,
  GraphicsDiagnostics,
  PickEvent,
  QualityProfile,
  SceneEngineOptions,
  WaterState
} from './types'
import { FrameLoop, type FrameCallback } from './frameLoop'
import { OrbitController } from './orbit'
import { EnvironmentSystem } from './environment'
import { GlobalEarthSystem } from './earth'
import { TilesSystem } from './tiles'
import { EntitySystem } from './entities'
import { PickingSystem } from './picking'
import { AdaptiveQuality, profileSettings } from './adaptive'
import { ContextLossGuard } from './contextLoss'

/** Floating-origin threshold in frame-local meters (§37.2). */
const FLOAT_ORIGIN_THRESHOLD_M = 20_000

/**
 * Engine runtime. Scene graph isolation (§19):
 *   THREE.Scene            ← engine owns
 *   ├── BaseWorldRoot      ← engine owns (terrain / tiles / environment / water)
 *   └── SceneMountRoot     ← the current scene's logical scope (`root`)
 * Renderer + camera are Borrowed (§20); the render loop is unique (§21).
 */
export interface EngineRuntime {
  readonly context: GraphicsContext
  readonly orbit: OrbitController
  readonly frameLoop: FrameLoop
  readonly tiles: TilesSystem
  readonly entitySystem: EntitySystem
  readonly environment: EnvironmentSystem
  readonly earth: GlobalEarthSystem | undefined
  readonly adaptive: AdaptiveQuality
  /** 问题3：为当前 mount 创建独立 SceneMountRoot（detach = 无条件脱离场景图）。 */
  createMountRoot(): { root: THREE.Group; detach(): void }
  suspend(): void
  resume(): void
  dispose(): void
}

export async function createRuntime(options: SceneEngineOptions): Promise<EngineRuntime> {
  const viewport = options.getViewport()
  if (!viewport) throw new Error('[scene-engine] graphics viewport container is unavailable')

  const maxQuality = options.maxQuality ?? 'EXHIBITION'
  let quality: QualityProfile = options.quality ?? 'STANDARD'
  const settings = profileSettings(quality)
  const globalMode = options.global === true

  const renderer = new THREE.WebGLRenderer({
    antialias: settings.antialias,
    logarithmicDepthBuffer: true,
    powerPreference: 'high-performance'
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.maxPixelRatio))
  renderer.shadowMap.enabled = settings.shadows
  renderer.setSize(viewport.clientWidth || 800, viewport.clientHeight || 600, false)
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  viewport.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(options.backgroundColor ?? 0x0a1220)

  const baseWorldRoot = new THREE.Group()
  baseWorldRoot.name = 'BaseWorldRoot'
  scene.add(baseWorldRoot)

  // 问题3：per-mount SceneMountRoot 容器——每个 mount 独立 root，
  // teardown 时可无条件 detach（§25 / Issue #1 问题3）。
  const sceneRoots = new THREE.Group()
  sceneRoots.name = 'SceneRoots'
  scene.add(sceneRoots)

  // Site mode: near/far tuned for meter-scale sites. Global mode: km units.
  const camera = new THREE.PerspectiveCamera(
    60,
    (viewport.clientWidth || 800) / (viewport.clientHeight || 600),
    globalMode ? 0.01 : 0.5,
    globalMode ? 60_000 : 300_000
  )

  const frameLoop = new FrameLoop()
  const environment = new EnvironmentSystem(baseWorldRoot, quality, options)
  const earth = globalMode ? new GlobalEarthSystem(baseWorldRoot) : undefined
  const tiles = new TilesSystem(options.tiles)

  // I4-3：配置化 tileset 接入——唯一入口仍是 TilesSystem（§48 禁止 Scene
  // 自建 TilesRenderer）；诊断随 getDiagnostics 自动输出。
  for (const url of options.tiles?.tilesetUrls ?? []) {
    void tiles
      .addTileset(url)
      .then((handle) => {
        baseWorldRoot.add(handle.group)
      })
      .catch((error) => {
        console.error(`[scene-engine] tileset 接入失败: ${url}`, error)
      })
  }
  const entitySystem = new EntitySystem()
  const adaptive = new AdaptiveQuality(quality, maxQuality, (p) => {
    quality = p
    const s = profileSettings(p)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, s.maxPixelRatio))
    renderer.shadowMap.enabled = s.shadows
  })

  let suspended = false
  const orbit = new OrbitController(renderer.domElement)

  const picking = new PickingSystem(
    renderer.domElement,
    () => sceneRoots,
    () => camera
  )

  const frameSubs = new Set<FrameCallback>()
  const pickSubs = new Set<(e: PickEvent) => void>()
  picking.onPick((event) => {
    for (const cb of [...pickSubs]) cb(event)
  })

  // Shared floating-origin offset applied to BOTH scene graph roots so the
  // camera stays numerically small (§37.2 / §65).
  const worldOffset = new THREE.Vector3()
  const orbitPose = {
    position: { x: 0, y: 0, z: 0 },
    target: { x: 0, y: 0, z: 0 }
  }
  const lookTarget = new THREE.Vector3()

  frameLoop.onFrame((info: FrameInfo) => {
    adaptive.sample(frameLoop.p95Ms)
    environment.setFrame(options.visualFixture ? 0 : info.elapsedSeconds)

    // Frame-boundary fast-path consumption (§36) — never message-driven.
    if (options.stateBuffer) {
      entitySystem.syncFromBuffer(options.stateBuffer, globalMode)
    }

    orbit.cameraPose(orbitPose)
    const p = orbitPose.position
    if (globalMode && earth) {
      // Camera-relative ECEF (§37.2): shift the world against the camera.
      earth.applyCameraOffset(p)
      worldOffset.set(-p.x, -p.y, -p.z)
      baseWorldRoot.position.copy(worldOffset)
      camera.position.set(p.x + worldOffset.x, p.y + worldOffset.y, p.z + worldOffset.z)
    } else {
      const dist2 = p.x * p.x + p.y * p.y + p.z * p.z
      if (dist2 > FLOAT_ORIGIN_THRESHOLD_M * FLOAT_ORIGIN_THRESHOLD_M) {
        worldOffset.x -= p.x
        worldOffset.y -= p.y
        worldOffset.z -= p.z
        baseWorldRoot.position.copy(worldOffset)
        sceneRoots.position.copy(worldOffset)
      }
      camera.position.set(p.x + worldOffset.x, p.y + worldOffset.y, p.z + worldOffset.z)
    }
    lookTarget.set(
      orbitPose.target.x + worldOffset.x,
      orbitPose.target.y + worldOffset.y,
      orbitPose.target.z + worldOffset.z
    )
    camera.lookAt(lookTarget)

    for (const cb of [...frameSubs]) cb(info)

    if (tiles.tilesetCount > 0) {
      tiles.frame(camera, renderer.domElement.clientWidth || 1, renderer.domElement.clientHeight || 1)
    }

    renderer.render(scene, camera)
  })

  const resize = () => {
    const w = viewport.clientWidth || 800
    const h = viewport.clientHeight || 600
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(viewport)
  resize()

  // Context loss (§75)：GPU context 可丢失，世界真值不可——由可单测的
  // ContextLossGuard 统一处理（丢失停帧 / 恢复重置并续跑）。
  const contextLossGuard = new ContextLossGuard(renderer.domElement, {
    suspendLoop: () => {
      frameLoop.stop()
    },
    resumeLoop: () => {
      if (!suspended) frameLoop.start()
    },
    resetRendererState: () => {
      renderer.resetState?.()
    }
  })

  const waterApi: EnvironmentApi = {
    get water() {
      return environment.water
    },
    getWaterState: () => environment.water,
    setWaterState: (state: WaterState) => {
      environment.setWaterState(state)
      environment.setWaterLevelLocal(resolveWaterLocalY(options, state))
    }
  }

  const context: GraphicsContext = {
    // 共享 context 的 root 指向 SceneRoots 容器（含全部挂载根）
    root: sceneRoots,
    renderScene: scene,
    camera,
    renderer,
    onFrame: (cb) => {
      frameSubs.add(cb)
      return {
        dispose: () => {
          frameSubs.delete(cb)
        }
      }
    },
    onPick: (cb) => {
      pickSubs.add(cb)
      return {
        dispose: () => {
          pickSubs.delete(cb)
        }
      }
    },
    environment: waterApi,
    global: earth,
    entities: entitySystem,
    suspend: () => {
      suspended = true
      frameLoop.stop()
    },
    resume: () => {
      if (!suspended) return
      suspended = false
      frameLoop.start()
    },
    getDiagnostics: (): GraphicsDiagnostics => ({
      quality,
      frame: {
        fps: Math.round(frameLoop.fps),
        p50Ms: round2(frameLoop.p50Ms),
        p95Ms: round2(frameLoop.p95Ms),
        frameIndex: frameLoop.frameIndex
      },
      renderer: {
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        textures: renderer.info.memory.textures,
        geometries: renderer.info.memory.geometries,
        programs: renderer.info.programs?.length ?? 0
      },
      tiles: tiles.tilesetCount > 0 ? tiles.diagnostics() : undefined,
      entityCount: entitySystem.count,
      frameCallbacks: frameSubs.size,
      assetLeases: options.getAssetLeaseCount?.() ?? 0,
      jsHeapMB: readHeapMB()
    })
  }

  frameLoop.start()

  const createMountRoot = (): { root: THREE.Group; detach(): void } => {
    const root = new THREE.Group()
    root.name = `SceneMountRoot(${sceneRoots.children.length + 1})`
    sceneRoots.add(root)
    return { root, detach: () => root.removeFromParent() }
  }

  return {
    context,
    orbit,
    frameLoop,
    tiles,
    entitySystem,
    environment,
    earth,
    adaptive,
    createMountRoot,
    suspend: () => context.suspend(),
    resume: () => context.resume(),
    dispose: () => {
      frameLoop.dispose()
      resizeObserver.disconnect()
      contextLossGuard.dispose()
      picking.dispose()
      orbit.dispose()
      tiles.dispose()
      entitySystem.clear()
      environment.dispose()
      earth?.dispose()
      baseWorldRoot.clear()
      sceneRoots.clear()
      scene.clear()
      renderer.dispose()
      renderer.domElement.remove()
      suspended = true
    }
  }
}

/**
 * Datum-aware water height (§39): levelMeters arrives with a vertical
 * reference; only convert through the registered datum chain, never assign
 * the raw number to a render Y. Unresolvable datums fall back to treating
 * the level as frame-local (documented) instead of misplacing the plane.
 */
function resolveWaterLocalY(options: SceneEngineOptions, state: WaterState): number {
  const frame = options.getActiveFrame?.()
  if (!frame) return state.levelMeters
  let level = state.levelMeters
  if (state.verticalReference !== 'ellipsoid' && options.spatial) {
    try {
      const ellipsoidal = options.spatial.toEllipsoidal({
        longitudeDegrees: 0,
        latitudeDegrees: 0,
        heightMeters: state.levelMeters,
        verticalReference: state.verticalReference
      })
      level = ellipsoidal.heightMeters
    } catch {
      return state.levelMeters
    }
  }
  const origin = frame.originECEF
  const originHeight = ecefToGeodetic({
    xMeters: origin.x,
    yMeters: origin.y,
    zMeters: origin.z
  }).heightMeters
  return level - originHeight
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function readHeapMB(): number | undefined {
  const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory
  return memory ? Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10 : undefined
}
