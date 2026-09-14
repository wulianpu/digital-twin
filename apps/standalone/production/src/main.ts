import { createMapAccess } from '@twin/map-engine'
import { createGraphicsAccess } from '@twin/scene-engine'
import { SpatialStateBuffer, type WorldClient } from '@twin/world-client'
import { AGV_CONTRACT, decodeAgv } from '@twin/domain-agv'
import { quatFromHeadingPitchRoll, DEG2RAD } from '@twin/spatial'
import { runStandaloneApp } from '../../shared/bootstrap'
import { createDemoDataSource } from '../../shared/demoData'
import { SITE_CHANGEXING } from '../../shared/sites'

/**
 * Standalone Production Twin (Spike B standalone run): full 2D + 3D +
 * spatial fast path (state buffer) + water, with the shared scene source.
 */
const source = createDemoDataSource(SITE_CHANGEXING)
const stateBuffer = new SpatialStateBuffer(128)

// Spatial fast path adapter (§35): AGV envelopes feed the buffer outside any
// reactive system; the engine consumes poses at frame boundaries.
function adaptAgvEnvelopes(client: WorldClient): void {
  client.subscribe({ contract: AGV_CONTRACT }, (env) => {
    const s = decodeAgv(env)
    if (!s) return
    const q = quatFromHeadingPitchRoll(s.headingDeg * DEG2RAD, 0, 0)
    stateBuffer.upsert(env.key, {
      x: s.xMeters,
      y: 0,
      z: s.yMeters,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      timeMs: env.sourceTime,
      frameId: `frame:${SITE_CHANGEXING.id}`
    })
  })
}

void runStandaloneApp({
  title: '生产数字孪生 · Standalone',
  sceneId: 'production',
  site: SITE_CHANGEXING,
  entryLoader: () => import('@twin/scene-production'),
  sources: [source.live],
  gatewayTick: (timeMs) => source.tick(timeMs),
  dataAdapter: adaptAgvEnvelopes,
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
      stateBuffer,
      quality: 'STANDARD',
      tiles: { maxBytes: 512 * 1024 * 1024, maxItems: 4096, sseMultiplier: 12 },
      water: { enabled: true, halfSizeMeters: 4000 },
      getActiveFrame: () => viewport.spatial.getFrame(`frame:${SITE_CHANGEXING.id}`)
    })
})
