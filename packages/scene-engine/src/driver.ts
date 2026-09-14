import type { ViewTarget } from '@twin/sdk'
import type { EntityRef, SiteId } from '@twin/world'
import type { SceneDriverOptions, SceneViewDriver } from './types'

/** Rough ground extent of a site, used when no explicit scale is given. */
export function siteExtentMeters(bounds?: {
  south: number
  west: number
  north: number
  east: number
}): number | undefined {
  if (!bounds) return undefined
  const dLat = Math.abs(bounds.north - bounds.south) * 111_320
  const dLon =
    Math.abs(bounds.east - bounds.west) *
    111_320 *
    Math.cos(((bounds.south + bounds.north) / 2) * (Math.PI / 180))
  return Math.max(dLat, dLon)
}

/** SceneViewDriver implements the platform ViewApi against the 3D engine. */
export function createSceneViewDriver(options: SceneDriverOptions): SceneViewDriver {
  const driver: SceneViewDriver = {
    kind: 'scene',
    async focus(entity: EntityRef): Promise<void> {
      options.getHandle()?.focusEntity(entity)
    },
    async goToSite(siteId: SiteId): Promise<void> {
      const site = options.getSites().get(siteId)
      const handle = options.getHandle()
      if (!site || !handle) return
      handle.applyGeodeticTarget(site.origin, siteExtentMeters(site.bounds))
    },
    async setTarget(target: ViewTarget): Promise<void> {
      options
        .getHandle()
        ?.applyGeodeticTarget(target.target, target.scaleMeters, target.headingRadians)
    },
    getTarget(): ViewTarget | undefined {
      return options.getHandle()?.getGeodeticTarget()
    }
  }
  return driver
}
