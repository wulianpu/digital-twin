import type { MapViewDriver, MapDriverOptions } from './types'
import type { EntityRef, SiteId } from '@twin/world'
import type { GeodeticPosition } from '@twin/spatial'
import type { ViewTarget } from '@twin/sdk'

/**
 * Approximate MapLibre zoom for a desired ground extent.
 * MapLibre uses 512px tiles: metersPerPixel ≈ 78271.517·cos(lat)/2^zoom.
 */
export function zoomForScaleMeters(scaleMeters: number, latitudeDegrees: number, viewportPixels = 512): number {
  const mpp = Math.max(1e-6, scaleMeters / Math.max(64, viewportPixels))
  const zoom = Math.log2((78271.517 * Math.cos((latitudeDegrees * Math.PI) / 180)) / mpp)
  return Math.min(22, Math.max(0, zoom))
}

export function scaleMetersForZoom(zoom: number, latitudeDegrees: number, viewportPixels = 512): number {
  const mpp = (78271.517 * Math.cos((latitudeDegrees * Math.PI) / 180)) / 2 ** zoom
  return mpp * Math.max(64, viewportPixels)
}

/** MapViewDriver implements the platform ViewApi against MapLibre (§56). */
export function createMapViewDriver(options: MapDriverOptions): MapViewDriver {
  function withMap<T>(fn: (map: import('maplibre-gl').Map) => T): T | undefined {
    const ctx = options.getContext()
    if (!ctx) return undefined
    return fn(ctx.instance)
  }

  const driver: MapViewDriver = {
    kind: 'map',
    async focus(entity: EntityRef): Promise<void> {
      const p = options.resolveEntityPosition(entity)
      if (!p) return
      withMap((map) => {
        map.flyTo({ center: [p.longitudeDegrees, p.latitudeDegrees], zoom: Math.max(map.getZoom(), 8), duration: 600 })
      })
    },
    async goToSite(siteId: SiteId): Promise<void> {
      const site = options.getSites().get(siteId)
      if (!site) return
      withMap((map) => {
        if (site.bounds) {
          map.fitBounds(
            [
              [site.bounds.west, site.bounds.south],
              [site.bounds.east, site.bounds.north]
            ],
            { padding: 48, duration: 600 }
          )
        } else {
          map.flyTo({ center: [site.origin.longitudeDegrees, site.origin.latitudeDegrees], zoom: 14, duration: 600 })
        }
      })
    },
    async setTarget(target: ViewTarget): Promise<void> {
      withMap((map) => {
        const zoom =
          target.scaleMeters !== undefined
            ? zoomForScaleMeters(target.scaleMeters, target.target.latitudeDegrees, map.getCanvas().clientWidth)
            : map.getZoom()
        map.flyTo({
          center: [target.target.longitudeDegrees, target.target.latitudeDegrees],
          zoom,
          bearing: target.headingRadians !== undefined ? (target.headingRadians * 180) / Math.PI : map.getBearing(),
          duration: 600
        })
      })
    },
    getTarget(): ViewTarget | undefined {
      return withMap((map) => {
        const c = map.getCenter()
        const target: GeodeticPosition = {
          longitudeDegrees: c.lng,
          latitudeDegrees: c.lat,
          heightMeters: 0,
          verticalReference: 'ellipsoid'
        }
        return {
          target,
          scaleMeters: scaleMetersForZoom(map.getZoom(), c.lat, map.getCanvas().clientWidth)
        }
      })
    }
  }
  return driver
}
