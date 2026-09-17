import type { SceneEntry, ViewKind } from '@twin/sdk'
import {
  createWorldApi,
  type Site,
  type WorldApi
} from '@twin/world'
import { createSpatialApi, type SpatialApi } from '@twin/spatial'
import { WorldClient, type DataSource } from '@twin/world-client'
import { createViewService, SceneHost, type SceneHostOptions } from '@twin/scene-host'
import type { MapAccess } from '@twin/map-engine'
import type { GraphicsAccess } from '@twin/scene-engine'
import '@twin/ui/styles.css'
import './standalone.css'

export interface StandaloneOptions {
  title: string
  site: Site
  entryLoader: () => Promise<{ default: SceneEntry }>
  sceneId: string
  sources: DataSource[]
  gatewayTick?: (timeMs: number) => void
  /** App-level adapters (e.g. spatial fast path) wired against the client. */
  dataAdapter?: (client: WorldClient) => void
  map?: (viewport: { getContainer(): HTMLElement | null | undefined }) => MapAccess
  graphics?: (viewport: {
    getContainer(): HTMLElement | null | undefined
    spatial: SpatialApi
    world: WorldApi
  }) => GraphicsAccess
  unmountDeadlineMs?: number
}

/**
 * Standalone bootstrap (§59): create Foundation → create SceneHost →
 * load ONE scene → mount. No SceneCoordinator, no portal shell. The exact
 * same scene source runs under the Portal without modification (§58).
 */
export async function runStandaloneApp(options: StandaloneOptions): Promise<() => void> {
  document.title = options.title

  // Minimal layout: header + viewport. Plain DOM on purpose — scenes must
  // not assume any particular application framework around them (§58).
  document.body.innerHTML = ''
  const shell = document.createElement('div')
  shell.id = 'app'
  shell.innerHTML = `
    <header class="standalone-header">
      <span class="standalone-title">${escapeHtml(options.title)}</span>
      <span class="standalone-badge">Standalone</span>
    </header>
    <main class="twin-viewport" data-mode="map">
      <div class="twin-viewport-layer standalone-map"></div>
      <div class="twin-viewport-layer standalone-graphics" style="display:none"></div>
      <div class="twin-viewport-layer twin-viewport-ui standalone-ui"></div>
    </main>
  `
  document.body.appendChild(shell)

  const mapContainer = shell.querySelector<HTMLElement>('.standalone-map')!
  const graphicsContainer = shell.querySelector<HTMLElement>('.standalone-graphics')!
  const uiContainer = shell.querySelector<HTMLElement>('.standalone-ui')!

  // 2D-first standalone apps keep graphics hidden until the scene enters 3D.
  const observer = new MutationObserver(() => {
    const graphicsVisible = graphicsContainer.childElementCount > 0
    graphicsContainer.style.display = graphicsVisible ? 'block' : 'none'
  })
  observer.observe(graphicsContainer, { childList: true })

    const onListenerError = (error: unknown, meta: { event: string }) => {
    console.error(`[standalone] ${meta.event} listener failed`, error)
  }
const world = createWorldApi({
    onListenerError,
    sites: [options.site],
    initialScope: { kind: 'site', siteId: options.site.id }
  })
  const spatial = createSpatialApi(onListenerError)
  spatial.ensureEnuFrame(`frame:${options.site.id}`, spatial.toEllipsoidal(options.site.origin))
  spatial.setActiveFrame(`frame:${options.site.id}`)

  const data = new WorldClient({
    sources: options.sources,
    sweepIntervalMs: 0,
    onSubscriberError: (error, meta) => {
      console.error(
        `[standalone] data subscriber failed (${meta.contract}/${meta.key}, mode=${meta.mode})`,
        error
      )
    }
  })
  options.dataAdapter?.(data)
  if (options.gatewayTick) {
    const tickTimer = setInterval(() => options.gatewayTick!(Date.now()), 250)
    tickTimer.unref?.()
  }

  const mapAccess = options.map?.({ getContainer: () => mapContainer })
  const graphicsAccess = options.graphics?.({
    getContainer: () => graphicsContainer,
    spatial,
    world
  })

  const primary: ViewKind = mapAccess ? 'map' : 'scene'
  const view = createViewService({
    getPrimary: () => primary,
    mapDriver: undefined,
    sceneDriver: undefined
  })

  const hostOptions: SceneHostOptions = {
    viewport: { ui: uiContainer },
    services: {
      world,
      spatial,
      data,
      selection: world.selection,
      view,
      assets: stubAssets(),
      ...(mapAccess ? { map: mapAccess } : {}),
      ...(graphicsAccess ? { graphics: graphicsAccess } : {})
    },
    unmountDeadlineMs: options.unmountDeadlineMs ?? 3000,
    onError: (error, phase) => {
      console.error(`[standalone:${options.sceneId}:${phase}]`, error)
    }
  }
  const host = new SceneHost(hostOptions)

  const entry = await options.entryLoader()
  await host.mount(entry.default ?? entry, { sceneId: options.sceneId })

  // Safety net: tear down when the tab goes away (dev convenience).
  window.addEventListener('beforeunload', () => {
    void host.unmount()
  })

  // Issue #16-r2：与 Portal 相同的 ownership 反向终止顺序——
  // 1) await host.shutdown()（Scene unmount / MountScope / revoke 完整序列，
  //    且 Host 进入 terminal：杜绝后续任何 mount 复活）
  // 2) 之后才销毁 Data/Map/Graphics owner
  return async () => {
    observer.disconnect()
    await host.shutdown()
    data.dispose()
    mapAccess?.dispose()
    graphicsAccess?.dispose()
  }
}

function stubAssets() {
  return {
    leaseCount: 0,
    acquire: async () => {
      throw new Error('[standalone] asset api not configured in this demo app')
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
