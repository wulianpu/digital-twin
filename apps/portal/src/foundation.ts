import {
  createWorldApi,
  entityKey,
  type WorldApi,
  type SelectionApi
} from '@twin/world'
import {
  createSpatialApi,
  frameLocalToGeodetic,
  quatFromHeadingPitchRoll,
  DEG2RAD,
  type SpatialApi
} from '@twin/spatial'
import {
  WorldClient,
  createWebSocketSource,
  type DataApi,
  type DataSource,
  type WebSocketSource
} from '@twin/world-client'
import {
  createMapAccess,
  createMapViewDriver,
  type MapAccess,
  type MapViewDriver
} from '@twin/map-engine'
import {
  createAssetApi,
  createGraphicsAccess,
  createSceneEngineViewBinding,
  createSceneViewDriver,
  getSceneEngineRuntime,
  type GraphicsAccess,
  type SceneViewDriver
} from '@twin/scene-engine'
import { createViewService, SceneHost } from '@twin/scene-host'
import type { ViewApi } from '@twin/sdk'
import { ContentRegistry } from '@twin/content'
import { AGV_CONTRACT, decodeAgv } from '@twin/domain-agv'
import { DEMO_SITES, SITE_CHANGEXING } from './sites'
import { createDemoGateway, type DemoGateway } from './gateway'
import { loadPortalConfig, type PortalConfig } from './config'
import { DEMO_ASSET_MANIFEST } from './assets/demo-manifest'

export interface ViewportContainers {
  map: HTMLElement | undefined
  graphics: HTMLElement | undefined
}

/** 连接状态（I3-3）：顶栏指示的数据源。 */
export type ConnectionState = {
  /** local = 内置演示网关；其余为平台网关 WS 传输状态。 */
  state: 'local' | 'connecting' | 'open' | 'closed'
  /** 本地缓存中已降级（陈旧）的信封数量。 */
  staleCount: number
}

/**
 * Composition Root (§6): the Portal decides what to run and wires
 * Foundation capabilities together. Scenes never see any of this.
 */
export interface PortalFoundation {
  world: WorldApi
  spatial: SpatialApi
  data: DataApi
  selection: SelectionApi
  view: ViewApi
  mapAccess: MapAccess
  graphicsAccess: GraphicsAccess
  host: SceneHost
  gateway: DemoGateway
  config: PortalConfig
  connection(): ConnectionState
  workspace: {
    setContainers(c: ViewportContainers): void
    getPrimary(): 'map' | 'scene' | 'none'
    setPrimary(kind: 'map' | 'scene'): void
  }
  dispose(): void
}

export function buildFoundation(
  options: { config?: PortalConfig; onHostError?: (error: unknown, phase: string) => void } = {}
): PortalFoundation {
  const config = options.config ?? loadPortalConfig()
  const world = createWorldApi({
    worldId: 'portal-world',
    sites: DEMO_SITES,
    initialMode: 'live',
    initialScope: { kind: 'global' }
  })

  const spatial = createSpatialApi()
  // Pre-register site frames: geodetic <-> local conversions stay stable (§37).
  for (const site of DEMO_SITES) {
    spatial.ensureEnuFrame(`frame:${site.id}`, spatial.toEllipsoidal(site.origin))
  }
  // Vertical datum declaration (§39): site chart offset.
  spatial.registerVerticalOffset('chart-datum', 'ellipsoid', 2.34)

  const gateway = createDemoGateway()

  // I1-2: a configured platform gateway replaces the DEMO live source only;
  // history/simulation keep the demo sources until the server APIs land (I3).
  let configuredLiveSource: WebSocketSource | undefined
  let liveSource: DataSource = gateway.live
  if (config.gatewayWsUrl) {
    configuredLiveSource = createWebSocketSource({ url: config.gatewayWsUrl })
    liveSource = configuredLiveSource
    console.info(
      `[portal] using platform gateway ${config.gatewayWsUrl} (demo gateway still drives history/simulation)`
    )
  }

  // I3-4：历史/仿真源的**唯一生产替换点**。接服务端 API 后只改这个函数
  // （协议 docs/gateway-protocol.md §7/§8），WorldClient 与 Scene 零修改。
  function createHistorySimulationSources(): { history: DataSource; simulation: DataSource } {
    // 未配置服务端历史/仿真 API：使用演示录制源与确定性仿真源。
    return { history: gateway.buildHistorySource(), simulation: gateway.simulation }
  }
  const { history, simulation } = createHistorySimulationSources()

  const data = new WorldClient({
    sources: [liveSource, history, simulation],
    sweepIntervalMs: 0
  })

  // Spatial Fast Path adapter (§35): AGV envelopes feed the shared state
  // buffer OUTSIDE any reactive system; the engine reads at frame boundaries.
  data.subscribe({ contract: AGV_CONTRACT }, (env) => {
    const s = decodeAgv(env)
    if (!s) return
    const q = quatFromHeadingPitchRoll(s.headingDeg * DEG2RAD, 0, 0)
    gateway.stateBuffer.upsert(env.key, {
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

  const containers: ViewportContainers = { map: undefined, graphics: undefined }
  let primary: 'map' | 'scene' | 'none' = 'none'
  const workspace = {
    setContainers(c: ViewportContainers) {
      containers.map = c.map
      containers.graphics = c.graphics
    },
    getPrimary: () => primary,
    setPrimary(kind: 'map' | 'scene') {
      primary = kind
    }
  }

  const mapAccess = createMapAccess({
    getViewport: () => containers.map,
    styleUrl: config.mapStyleUrl,
    rasterTilesUrl: config.rasterTilesUrl,
    initialCenter: SITE_CHANGEXING.origin,
    initialZoom: 14
  })

  const graphicsAccess = createGraphicsAccess({
    getViewport: () => containers.graphics,
    spatial,
    stateBuffer: gateway.stateBuffer,
    quality: config.defaultQuality,
    maxQuality: 'EXHIBITION',
    // I4-3：真实 3D Tiles 入口（经 TilesSystem，诊断随 getDiagnostics 输出）。
    tiles: {
      maxBytes: config.tilesMaxBytes,
      maxItems: 4096,
      sseMultiplier: 12,
      ...(config.tilesTilesetUrl ? { tilesetUrls: [config.tilesTilesetUrl] } : {})
    },
    water: { enabled: true, halfSizeMeters: 4000 },
    getActiveFrame: () => {
      const scope = world.session.scope
      if (scope.kind !== 'site') return undefined
      return spatial.getFrame(`frame:${scope.siteId}`)
    },
    getAssetLeaseCount: () => assets.leaseCount
  })

  // I4-1/I4-2：资产清单注册 + GLTFLoader 解码器装配（KTX2/DRACO/meshopt）
  // + 内存预算。解码器文件可经 VITE_ASSET_DECODER_PATH 指向本地静态目录
  // （离线部署见 docs/asset-pipeline.md）。
  const content = new ContentRegistry()
  content.registerAssetManifest(DEMO_ASSET_MANIFEST)
  const assets = createAssetApi({
    resolve: (ref) => content.getAsset(ref),
    maxTotalBytes: 256 * 1024 * 1024,
    gltfLoaderEnhancer: async (loader) => {
      const l = loader as {
        setDRACOLoader(d: unknown): void
        setKTX2Loader?(k: unknown): void
        setMeshoptDecoder?(d: unknown): void
      }
      const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js')
      const draco = new DRACOLoader()
      draco.setDecoderPath(config.assetDecoderPath)
      l.setDRACOLoader(draco)
      try {
        const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js')
        const ktx2 = new KTX2Loader()
        ktx2.setTranscoderPath(config.assetDecoderPath)
        const renderer = graphicsAccess.currentContext?.renderer
        if (renderer) ktx2.detectSupport(renderer)
        l.setKTX2Loader?.(ktx2)
      } catch (error) {
        console.info('[portal] KTX2 解码器不可用，压缩纹理资产将无法加载', error)
      }
      try {
        const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js')
        l.setMeshoptDecoder?.(MeshoptDecoder)
      } catch (error) {
        console.info('[portal] meshopt 解码器不可用，跳过', error)
      }
    }
  })

  // One gateway stream drives live AND simulation from the world clock.
  const tickTimer = setInterval(() => {
    const time = world.time.now()
    gateway.tick(time.mode === 'simulation' ? 'simulation' : 'live', time.epochMillis)
  }, 250)
  tickTimer.unref?.()

  // Pre-seed 20 minutes of history so History mode has material immediately.
  for (let t = Date.now() - 20 * 60_000; t < Date.now(); t += 1000) {
    gateway.tick('live', t)
  }

  const siteMap = new Map(
    DEMO_SITES.map((s) => [s.id, { origin: s.origin, bounds: s.bounds }])
  )

  const mapDriver: MapViewDriver = createMapViewDriver({
    getContext: () => mapAccess.currentContext,
    resolveEntityPosition: (entity) => {
      // App-level business mapping: AGV entity -> geodetic via data cache.
      const e = data.peek(AGV_CONTRACT, entityKey(entity))
      const s = e ? decodeAgv(e) : undefined
      if (!s) return undefined
      const scope = world.session.scope
      const frameId =
        scope.kind === 'site' ? `frame:${scope.siteId}` : `frame:${SITE_CHANGEXING.id}`
      const frame = spatial.getFrame(frameId)
      if (!frame) return undefined
      const g = frameLocalToGeodetic(frame, { x: s.xMeters, y: 0, z: s.yMeters })
      return {
        longitudeDegrees: g.longitudeDegrees,
        latitudeDegrees: g.latitudeDegrees,
        heightMeters: 0,
        verticalReference: 'ellipsoid'
      }
    },
    getSites: () => siteMap
  })

  const binding = createSceneEngineViewBinding({
    getRuntime: () => getSceneEngineRuntime(graphicsAccess),
    spatial,
    global: false
  })
  const sceneDriver: SceneViewDriver = createSceneViewDriver({
    getHandle: binding.handle,
    getSites: () => siteMap
  })

  const view = createViewService({
    mapDriver,
    sceneDriver,
    getPrimary: workspace.getPrimary
  })

  const host = new SceneHost({
    viewport: {
      ui: () => document.querySelector<HTMLElement>('.twin-viewport-ui')!
    },
    services: {
      world,
      spatial,
      data,
      selection: world.selection,
      view,
      assets,
      map: mapAccess,
      graphics: graphicsAccess
    },
    unmountDeadlineMs: 3000,
    onError: (error, phase) => {
      console.error(`[portal:scene-host:${phase}]`, error)
      options.onHostError?.(error, phase)
    }
  })

  return {
    world,
    spatial,
    data,
    selection: world.selection,
    view,
    mapAccess,
    graphicsAccess,
    host,
    gateway,
    config,
    connection(): ConnectionState {
      const ws = configuredLiveSource
      return {
        state: ws ? ws.connectionState : 'local',
        staleCount: data.countStale()
      }
    },
    workspace,
    dispose() {
      clearInterval(tickTimer)
      data.dispose()
      configuredLiveSource?.dispose()
      gateway.dispose()
      mapAccess.dispose()
      graphicsAccess.dispose()
    }
  }
}
