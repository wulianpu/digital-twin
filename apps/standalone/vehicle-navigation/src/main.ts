import { createMapAccess } from '@twin/map-engine'
import { runStandaloneApp } from '../../shared/bootstrap'
import { createDemoDataSource } from '../../shared/demoData'
import { SITE_CHANGEXING } from '../../shared/sites'

/**
 * 2D-ONLY standalone application (Freeze Gate #7):
 * this composition root never imports @twin/scene-engine or three — the
 * production build of this app must contain no 3D runtime at all
 * (verified by `pnpm check:2d-only`).
 */
const source = createDemoDataSource(SITE_CHANGEXING)

void runStandaloneApp({
  title: '行车导航 · Standalone (2D-only)',
  sceneId: 'vehicle-navigation',
  site: SITE_CHANGEXING,
  entryLoader: () => import('@twin/scene-vehicle-navigation'),
  sources: [source.live],
  gatewayTick: (timeMs) => source.tick(timeMs),
  map: (viewport) =>
    createMapAccess({
      getViewport: viewport.getContainer,
      initialCenter: SITE_CHANGEXING.origin,
      initialZoom: 15.5
    })
})
