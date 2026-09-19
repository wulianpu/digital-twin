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
import { dispatchCallbacks, makeFaultSink } from './callbacks'
import { OrbitController } from './orbit'
import { EnvironmentSystem } from './environment'
import { GlobalEarthSystem } from './earth'
import { TilesSystem } from './tiles'
import { EntitySystem } from './entities'
import { FLOAT_ORIGIN_THRESHOLD_M, FloatingOriginState } from './floatingOrigin'
import { PickingSystem } from './picking'
import { AdaptiveQuality, profileSettings, runtimeQualitySettings } from './adaptive'
import { ContextLossGuard } from './contextLoss'

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
  // Issue #17-r2（方案2）：GLOBAL 独立 floating-origin 层级——唯一 -camera
  // shift 的根。earth 与 global mount container 都在其下，只继承一次 -p；
  // 杜绝 ancestor(baseWorldRoot) + descendant(earth.root) 双重 -p 的回归。
  const globalWorldRoot = new THREE.Group()
  globalWorldRoot.name = 'GlobalWorldRoot'
  scene.add(globalWorldRoot)
  const globalSceneRoots = new THREE.Group()
  globalSceneRoots.name = 'GlobalSceneRoots'
  globalWorldRoot.add(globalSceneRoots)

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
  const environment = new EnvironmentSystem(
    globalMode ? globalWorldRoot : baseWorldRoot,
    quality,
    options
  )
  const earth = globalMode ? new GlobalEarthSystem(globalWorldRoot) : undefined
  const tiles = new TilesSystem(options.tiles)

  // I4-3：配置化 tileset 接入——唯一入口仍是 TilesSystem（§48 禁止 Scene
  // 自建 TilesRenderer）；诊断随 getDiagnostics 自动输出。
  // Issue #34：commit authority 只看 terminal（disposed）——suspend 是
  // transient 渲染权威，suspend 期间 resolve 的 tileset 照常 attach
  //（frameLoop 已停，无 per-frame update），resume 后自然继续。
  attachConfiguredTilesets(
    tiles,
    options.tiles?.tilesetUrls ?? [],
    (group) => {
      baseWorldRoot.add(group)
    },
    () => disposed
  )
  // Issue #29：floating-origin 状态唯一权威——EntitySystem 注入
  // render→logical 转换，getPosition() 返回逻辑 scene 坐标而非 render 坐标。
  const origin = new FloatingOriginState()
  const entitySystem = new EntitySystem(options.stateBuffer, globalMode, (v) =>
    origin.renderToLogical(v)
  )
  const adaptive = new AdaptiveQuality(quality, maxQuality, (p) => {
    quality = p
    // Issue #33：动态切档只应用 runtime-mutable knob 子集（antialias 是
    // context creation-time 选项，运行期不可切换，见 adaptive.ts 契约）
    const s = runtimeQualitySettings(p)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, s.maxPixelRatio))
    renderer.shadowMap.enabled = s.shadows
  })

  // Issue #34：suspended = transient 渲染权威（canRender）；
  // disposed = terminal 资源所有权权威（canOwnResources/isTerminal）。
  // 两者必须分离——suspend 不得作为 Engine-owned 资源的丢弃依据。
  let suspended = false
  let disposed = false
  const orbit = new OrbitController(renderer.domElement)

  const picking = new PickingSystem(
    renderer.domElement,
    // Issue #17-r2：raycast 实际的 SceneMountContainer——GLOBAL 模式下
    // mount roots 挂在 globalSceneRoots（而非 sceneRoots），保证可拾取
    () => (earth ? globalSceneRoots : sceneRoots),
    () => camera,
    // Issue #29 同类边界：hit.point 是 render-world 坐标——PickEvent.
    // localPoint 必须先恢复 Engine 逻辑坐标（floating-origin 不外泄）
    (v) => origin.renderToLogical(v)
  )

  const frameSubs = new Set<FrameCallback>()
  const pickSubs = new Set<(e: PickEvent) => void>()
  // Issue #15：Scene-facing callback fault boundary——逐个隔离、fail-stop
  // quarantine、经 sink 上报一次；Engine-owned stages 不被业务异常阻断。
  const faultSink = makeFaultSink(options.onCallbackError)
  picking.onPick((event) => {
    dispatchCallbacks(pickSubs, event, 'pick', faultSink)
  })

  // Shared floating-origin offset applied to BOTH scene graph roots so the
  // camera stays numerically small (§37.2 / §65). State lives in FloatingOriginState
  // (Issue #29)——render↔logical 转换的唯一权威。
  const worldOffset = origin.offset
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
      // Camera-relative ECEF (§37.2, Issue #17-r2)：唯一 -camera shift 层级
      // 是 globalWorldRoot——earth 与 Global SceneMountContainer 各只继承一次；
      // 同一 ECEF scene point 只减一次 camera pose（禁止双重 -p）。
      origin.set(-p.x, -p.y, -p.z)
      globalWorldRoot.position.copy(worldOffset)
      camera.position.set(p.x + worldOffset.x, p.y + worldOffset.y, p.z + worldOffset.z)
    } else {
      // Issue #30：SITE 离散 rebase——判定基于 camera 相对当前 render origin
      // 的位置（而非未重基准 logical pose）；只有真正 rebase 时才改写 root，
      // 阈值外静止期间 offset 完全稳定，不再按帧累积 -p。
      if (origin.updateSite(p, FLOAT_ORIGIN_THRESHOLD_M)) {
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

    dispatchCallbacks(frameSubs, info, 'frame', faultSink)

    // Engine-owned frame stages（Tiles / render）在 Scene callback 隔离之后
    // 无条件继续（§27：Scene 故障不得逃逸出自身故障域）
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
    // Issue #17-A：GLOBAL 模式下 mount root 挂到 earth root（camera-relative
    // shift 的正确层级），Scene 对象无需逃逸出 mount subtree 即可跟随地球；
    // detach root 仍是 mount teardown 的无条件回收路径。SITE 模式挂 sceneRoots。
    if (earth) {
      globalSceneRoots.add(root)
    } else {
      sceneRoots.add(root)
    }
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
      disposed = true // Issue #34：terminal authority 与 suspended 分离
      suspended = true // 渲染权威同步停止
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
      globalWorldRoot.clear()
      scene.clear()
      renderer.dispose()
      renderer.domElement.remove()
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

/**
 * Issue #34：configured tileset 的异步 commit authority（从 createRuntime
 * 提取，可无 WebGL 单测）。
 *
 * - terminal（runtime `isTerminal()` 或 `tiles.isDisposed`）→ late handle
 *   remove（renderer 已由 TilesSystem exactly-once 回收，#25 不回退）；
 * - 否则（ACTIVE **或 SUSPENDED**）→ attach——suspend 只停止渲染，
 *   Engine-owned 资源 ownership 不变；canOwnResources = !isTerminal()。
 */
export function attachConfiguredTilesets(
  tiles: TilesSystem,
  urls: readonly string[],
  attach: (group: THREE.Group) => void,
  isTerminal: () => boolean
): void {
  for (const url of urls) {
    void tiles
      .addTileset(url)
      .then((handle) => {
        if (isTerminal() || tiles.isDisposed) {
          handle.remove()
          return
        }
        attach(handle.group)
      })
      .catch((error) => {
        console.error(`[scene-engine] tileset 接入失败: ${url}`, error)
      })
  }
}
