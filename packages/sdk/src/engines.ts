import type * as THREE from 'three'
import type { Map as MLMap } from 'maplibre-gl'
import type { Disposable, EntityRef, SiteId } from '@twin/world'
import type { GeodeticPosition, ReferenceFrame, Vec3d, VerticalReference } from '@twin/spatial'
import type { ViewDriver } from './types'

/**
 * Engine capability contracts (§15-17, §52-53, §64-69). They live in the SDK
 * so the dependency graph stays ONE-directional: engines depend on the SDK,
 * never the reverse. Types only — importing @twin/sdk never downloads
 * three / maplibre (CI-enforced).
 */

export type FrameInfo = {
  deltaSeconds: number
  elapsedSeconds: number
  frameIndex: number
}

export interface PickEvent {
  entity?: EntityRef
  /**
   * 命中点的 **Engine 逻辑 scene 坐标**（SITE: frame-local m；GLOBAL:
   * scene-axis ECEF km）——不含 floating-origin/camera-relative render
   * shift（Issue #29 同类坐标边界，引擎负责恢复）。无命中时为原点。
   */
  localPoint: Vec3d
}

export type MapEngineState = 'UNINITIALIZED' | 'ACTIVE' | 'SUSPENDED' | 'DISPOSED'

/** Lazy 2D capability (§16): engine boots only on the first use(). */
export interface MapAccess {
  use(): Promise<MapContext>
  readonly state: MapEngineState
  readonly currentContext: MapContext | undefined
  dispose(): void
}

export interface MapContext {
  /** Native MapLibre map — scenes use the native API directly (§22). */
  readonly instance: MLMap
  readonly container: HTMLElement
  suspend(): void
  resume(): void
  resize(): void
  getViewState(): {
    center: GeodeticPosition
    zoom: number
    bearingRadians: number
    pitchRadians: number
  }
  /** 底图/style 异常（如 glyphs 不可达）的最近记录（S2 降级可见）。 */
  styleIssues(): readonly string[]
  dispose(): void
}

export type MapViewDriver = ViewDriver & { readonly kind: 'map' }

export type SceneEngineState = 'UNINITIALIZED' | 'ACTIVE' | 'SUSPENDED' | 'DISPOSED'

export type QualityProfile = 'OFFICE' | 'STANDARD' | 'HIGH' | 'EXHIBITION'

/** Water state is FACT; rendering quality is policy (§51). */
export interface WaterState {
  levelMeters: number
  verticalReference: VerticalReference
  waveHeightMeters?: number
  currentDirectionDeg?: number
  currentSpeedMs?: number
  turbidityNtu?: number
}

export interface EnvironmentApi {
  setWaterState(state: WaterState): void
  getWaterState(): WaterState | undefined
  readonly water: WaterState | undefined
}

export interface GlobalEnvironmentApi {
  readonly enabled: true
  /**
   * 纯 placement（Issue #17-A）：把 ECEF meters 换算为场景坐标并写入
   * object.position——**不改变 parent**。Scene 对象必须保留在自己的
   * mount-owned subtree 下（§25），ownership 由 Host detach root 保证。
   * 轴变换的权威实现在 SceneEngine（单处）。
   */
  setObjectEcefPosition(object: THREE.Object3D, ecefMeters: Vec3d): void
}

export interface EntitySystemApi {
  register(entity: EntityRef, object: THREE.Object3D): Disposable
  getPosition(entity: EntityRef, out: Vec3d): boolean
  has(entity: EntityRef): boolean
  readonly count: number
}

/** GraphicsContext (§17): renderer/camera/renderScene are Borrowed (§20). */
export interface GraphicsContext {
  /** SceneMountRoot — the scene's isolated 3D scope (§19). */
  readonly root: THREE.Group
  readonly renderScene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer

  /** The ONLY high-frequency callback entry (§21). */
  onFrame(callback: (info: FrameInfo) => void): Disposable
  onPick(callback: (event: PickEvent) => void): Disposable

  readonly environment: EnvironmentApi
  readonly global: GlobalEnvironmentApi | undefined
  readonly entities: EntitySystemApi

  suspend(): void
  resume(): void
  getDiagnostics(): GraphicsDiagnostics
}

/** Lazy 3D capability (§17, §25-26). */
export interface GraphicsAccess {
  use(): Promise<GraphicsContext>
  readonly state: SceneEngineState
  readonly currentContext: GraphicsContext | undefined
  applyQuality(profile: QualityProfile): void
  suspend(): void
  resume(): void
  getDiagnostics(): GraphicsDiagnostics | undefined
  dispose(): void
}

/** 3D Tiles policy — platform-owned, explicit budget (§48-50). */
export interface TilesPolicy {
  maxBytes?: number
  maxItems?: number
  sseMultiplier?: number
  /** I4-3：引擎启动即接入的 tileset URL（唯一入口是 TilesSystem）。 */
  tilesetUrls?: readonly string[]
}

export interface TilesDiagnostics {
  cachedBytes: number
  maxBytes: number
  isFull: boolean
  loadProgress: number
  queued: number
  downloading: number
  parsing: number
  loaded: number
  visible: number
  active: number
  failed: number
}

export interface GraphicsDiagnostics {
  quality: QualityProfile
  frame: { fps: number; p50Ms: number; p95Ms: number; frameIndex: number }
  renderer: {
    drawCalls: number
    triangles: number
    textures: number
    geometries: number
    programs: number
  }
  tiles: TilesDiagnostics | undefined
  entityCount: number
  frameCallbacks: number
  assetLeases: number
  jsHeapMB: number | undefined
}

export type SceneViewDriver = ViewDriver & { readonly kind: 'scene' }

/** Active site frame accessor used by datum-aware engine placement (§39). */
export type ActiveFrameProvider = () => ReferenceFrame | undefined

export type { SiteId }
