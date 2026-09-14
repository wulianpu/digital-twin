import type { ViewApi, ViewDriver, ViewKind, ViewTarget } from '@twin/sdk'
import type { EntityRef, SiteId } from '@twin/world'

export interface ViewServiceOptions {
  mapDriver?: ViewDriver | undefined
  sceneDriver?: ViewDriver | undefined
  /** Which engine is currently primary (driven by scene view toggles). */
  getPrimary(): ViewKind | 'none'
}

/**
 * ViewApi implementation (§56). Delegates to the driver of the currently
 * primary engine; View is orthogonal to Scene (§27) — switching view never
 * touches scene or world state.
 */
export function createViewService(options: ViewServiceOptions): ViewApi {
  function activeDriver(): ViewDriver | undefined {
    const primary = options.getPrimary()
    if (primary === 'map') return options.mapDriver
    if (primary === 'scene') return options.sceneDriver
    return undefined // 'none': no engine active yet — navigation is a no-op
  }

  return {
    get primary() {
      return options.getPrimary()
    },
    async focus(entity: EntityRef): Promise<void> {
      await activeDriver()?.focus(entity)
    },
    async goToSite(siteId: SiteId): Promise<void> {
      await activeDriver()?.goToSite(siteId)
    },
    getTarget(): ViewTarget | undefined {
      return activeDriver()?.getTarget()
    },
    async setTarget(target: ViewTarget): Promise<void> {
      await activeDriver()?.setTarget(target)
    }
  }
}
