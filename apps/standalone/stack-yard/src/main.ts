import { createMapAccess } from '@twin/map-engine'
import { createGraphicsAccess } from '@twin/scene-engine'
import { runStandaloneApp } from '../../shared/bootstrap'
import { createDemoDataSource } from '../../shared/demoData'
import { SITE_CHANGEXING } from '../../shared/sites'

/**
 * Standalone Stack Yard (§59): Foundation → SceneHost → one scene.
 * The SAME scene source as the Portal's stack-yard entry — zero modification.
 * 2D-first: three stays unloaded until the user toggles 3D in-scene (§26).
 */
const source = createDemoDataSource(SITE_CHANGEXING)

void runStandaloneApp({
  title: '分段堆场 · Standalone',
  sceneId: 'stack-yard',
  site: SITE_CHANGEXING,
  entryLoader: () => import('@twin/scene-stack-yard'),
  sources: [source.live],
  gatewayTick: (timeMs) => source.tick(timeMs),
  map: (viewport) =>
    createMapAccess({
      getViewport: viewport.getContainer,
      initialCenter: SITE_CHANGEXING.origin,
      initialZoom: 15
    }),
  graphics: (viewport) =>
    createGraphicsAccess({
      getViewport: viewport.getContainer,
      spatial: viewport.spatial,
      quality: 'STANDARD',
      water: { enabled: false },
      getActiveFrame: () =>
        viewport.spatial.getFrame(`frame:${SITE_CHANGEXING.id}`)
    })
})
