import type * as THREE from 'three'
import type { Disposable, Site } from '@twin/world'
import type { SpatialApi, GeodeticPosition, Vec3d } from '@twin/spatial'
import type { SpatialStateBuffer } from '@twin/world-client'
import type { ContentRegistry } from '@twin/content'
import type {
  FrameInfo,
  PickEvent,
  MapEngineState,
  MapAccess,
  MapContext,
  MapViewDriver,
  SceneEngineState,
  QualityProfile,
  WaterState,
  EnvironmentApi,
  GlobalEnvironmentApi,
  EntitySystemApi,
  GraphicsContext,
  GraphicsAccess,
  GraphicsDiagnostics,
  TilesPolicy,
  TilesDiagnostics,
  SceneViewDriver
} from '@twin/sdk'

/**
 * SceneEngine options & binding contracts. The engine capability types
 * (GraphicsContext / GraphicsAccess / ...) are defined ONCE in @twin/sdk;
 * this module re-exports them and adds engine-implementation options.
 */

export type {
  FrameInfo,
  PickEvent,
  MapEngineState,
  MapAccess,
  MapContext,
  MapViewDriver,
  SceneEngineState,
  QualityProfile,
  WaterState,
  EnvironmentApi,
  GlobalEnvironmentApi,
  EntitySystemApi,
  GraphicsContext,
  GraphicsAccess,
  GraphicsDiagnostics,
  TilesPolicy,
  TilesDiagnostics,
  SceneViewDriver,
  Disposable,
  Site
}

export interface SceneEngineOptions {
  getViewport(): HTMLElement | null | undefined
  spatial?: SpatialApi
  /** Spatial fast path consumed at frame boundaries (§35-36). */
  stateBuffer?: SpatialStateBuffer
  content?: ContentRegistry
  quality?: QualityProfile
  maxQuality?: QualityProfile
  tiles?: TilesPolicy
  /** Global ECEF globe mode (no site frame; units = km). */
  global?: boolean
  /** Active site frame provider (site mode). */
  getActiveFrame?(): import('@twin/sdk').ReferenceFrame | undefined
  water?: { enabled?: boolean; halfSizeMeters?: number }
  backgroundColor?: number
  /** Injected lease counter for diagnostics (asset manager lives in the app). */
  getAssetLeaseCount?(): number
  /** 视觉回归 fixture 模式（I9-6）：冻结水体动画时间，确定性渲染。 */
  visualFixture?: boolean
  /**
   * Issue #15：Scene callback fault boundary 的上报通道（Composition Root
   * 决定去向：console/telemetry/恢复动作）。缺省为内部 console.error。
   */
  onCallbackError?: (error: unknown, meta: { kind: 'frame' | 'pick' }) => void
}

export interface SceneViewHandle {
  focusEntity(entity: { namespace: string; id: string }, defaultRangeMeters?: number): boolean
  applyGeodeticTarget(
    target: GeodeticPosition,
    scaleMeters?: number,
    headingRadians?: number
  ): void
  getGeodeticTarget(): import('@twin/sdk').ViewTarget | undefined
}

export interface SceneDriverOptions {
  getHandle(): SceneViewHandle | undefined
  getSites(): ReadonlyMap<
    string,
    { origin: GeodeticPosition; bounds?: { south: number; west: number; north: number; east: number } }
  >
}

export type { Vec3d, THREE }
