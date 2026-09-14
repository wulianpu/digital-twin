import type { GeodeticPosition } from '@twin/spatial'
import type { SiteId, EntityRef, Disposable } from '@twin/world'
import type { ViewTarget, ViewDriver, MapAccess, MapContext, MapEngineState, MapViewDriver } from '@twin/sdk'

export type { MapAccess, MapContext, MapEngineState, MapViewDriver, Disposable }

export interface MapEngineOptions {
  /** Returns the DOM container the map should attach to. */
  getViewport(): HTMLElement | null | undefined
  /** Remote style URL; omit for the built-in offline dark style. */
  styleUrl?: string
  /** Raster tile URL template for the built-in style (offline-safe if omitted). */
  rasterTilesUrl?: string
  attribution?: string
  initialCenter?: GeodeticPosition
  initialZoom?: number
}

/** View driver consumed by the platform ViewApi (§56). */
export interface MapDriverOptions {
  getContext(): MapContext | undefined
  /** Resolve an entity to a geodetic position (app supplies business mapping). */
  resolveEntityPosition(entity: EntityRef): GeodeticPosition | undefined
  getSites(): ReadonlyMap<
    SiteId,
    { origin: GeodeticPosition; bounds?: { south: number; west: number; north: number; east: number } }
  >
  /** Fallback extent used by goToSite when the site has no bounds. */
  defaultScaleMeters?: number
}

export type { ViewDriver, ViewTarget }
