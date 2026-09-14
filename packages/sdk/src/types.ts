import type { EntityRef, SiteId, WorldApi, SelectionApi } from '@twin/world'
import type { DataApi } from '@twin/world-client'
import type { SpatialApi, GeodeticPosition } from '@twin/spatial'
import type { AssetRef } from '@twin/content'
import type { MapAccess } from './engines'
import type { GraphicsAccess } from './engines'

/**
 * Scene SDK contracts (Architecture Freeze v1.2 §7, §13-14, §55-57, §43).
 * This package defines WHAT scenes may use; implementations live in the
 * owning Foundation packages (world / world-client / spatial / scene-host /
 * map-engine / scene-engine).
 */

export type { Disposable } from '@twin/world'

/** ---------------------------------------------------------------- View */

export type ViewKind = 'map' | 'scene'

export interface MapViewState {
  kind: 'map'
  center: GeodeticPosition
  zoom: number
  bearingRadians: number
  pitchRadians: number
}

export interface SceneViewState {
  kind: 'scene'
  target: GeodeticPosition
  rangeMeters: number
  headingRadians: number
  pitchRadians: number
  rollRadians: number
}

export type ViewState = MapViewState | SceneViewState

/** Engine-neutral observation target usable across 2D and 3D. */
export interface ViewTarget {
  target: GeodeticPosition
  /** Approximate ground extent of interest in meters. */
  scaleMeters?: number
  headingRadians?: number
}

export interface ViewApi {
  focus(entity: EntityRef): Promise<void>
  goToSite(siteId: SiteId): Promise<void>
  getTarget(): ViewTarget | undefined
  setTarget(target: ViewTarget): Promise<void>
  /** Which engine currently owns observation ('none' before first engine use). */
  readonly primary: ViewKind | 'none'
}

export interface ViewDriver {
  focus(entity: EntityRef): Promise<void>
  goToSite(siteId: SiteId): Promise<void>
  setTarget(target: ViewTarget): Promise<void>
  getTarget(): ViewTarget | undefined
}

/** -------------------------------------------------------------- Assets */

export interface AssetLease {
  readonly ref: AssetRef
  readonly version: string
  /** Loaded asset object (e.g. a THREE.Object3D for GLB assets). */
  readonly object: unknown
  /** Estimated GPU/CPU bytes for budget diagnostics. */
  readonly estimatedBytes: number
  release(): void
}

export interface AssetApi {
  acquire(ref: AssetRef): Promise<AssetLease>
  /** Number of currently held leases (diagnostics / compliance). */
  readonly leaseCount: number
}

/** ----------------------------------------------------------------- UI */

export interface UiLayerOptions {
  /** Stack order hint; higher layers render above lower ones. */
  order?: number
  className?: string
}

export interface UiLayer {
  readonly element: HTMLElement
  dispose(): void
}

export interface UiApi {
  /** Container element the application provides for scene UI. */
  readonly container: HTMLElement
  /** Create a scene-namespaced DOM layer; auto-tracked by the SceneHost. */
  createLayer(options?: UiLayerOptions): UiLayer
}

/** -------------------------------------------------------- Scene model */

export type SceneId = string

/** Application-owned scene description (§7.1). Deliberately minimal. */
export interface SceneDefinition {
  readonly id: SceneId
  readonly name: string
  readonly description?: string
  readonly icon?: string
  readonly permissions?: readonly string[]
  load(): Promise<SceneEntry>
}

/** The one program entry of a scene (§7.2). */
export interface SceneEntry {
  mount(context: SceneContext): Promise<SceneMount>
}

/** One running instance of a scene (§7.3). */
export interface SceneMount {
  unmount(): void | Promise<void>
}

/**
 * Foundation capabilities granted to one scene mount (§14). The context is
 * REVOKED after unmount (§13): stale async callbacks must not be able to
 * write back into the platform.
 */
export interface SceneContext {
  readonly sceneId: SceneId

  // Platform semantics (§14)
  readonly world: WorldApi
  readonly spatial: SpatialApi
  readonly data: DataApi
  /** One business selection shared by every engine (§57). */
  readonly selection: SelectionApi
  readonly view: ViewApi
  readonly assets: AssetApi
  readonly ui: UiApi

  // Engine capabilities — demand-driven (§8, §16-17)
  readonly map?: MapAccess
  readonly graphics?: GraphicsAccess

  /** Aborts with the mount lifecycle (§13: abort cancels work). */
  readonly signal: AbortSignal
}

/** Thrown when a revoked SceneContext is touched after unmount. */
export class SceneUnmountedError extends Error {
  constructor(sceneId: SceneId, property: string) {
    super(
      `[scene-host] SceneContext("${sceneId}") was revoked after unmount; ` +
        `access to "${property}" is rejected to prevent zombie scene writes (§13).`
    )
    this.name = 'SceneUnmountedError'
  }
}

/** MapLibre / source id namespacing convention (§24): `<sceneId>:<localId>`. */
export function sceneScopedId(sceneId: SceneId, localId: string): string {
  return `${sceneId}:${localId}`
}

export function isSceneScopedId(id: string, sceneId: SceneId): boolean {
  return id.startsWith(`${sceneId}:`)
}
