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
  SpatialStateBuffer,
  WorldClient,
  createWebSocketSource,
  type DataApi,
  type DataSource,
  type ReplaySource,
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
  type EngineRuntime,
  type SceneEngineOptions,
  type SceneViewDriver
} from '@twin/scene-engine'
import {
  createModeRoutingGraphicsAccess,
  type ModeRoutingGraphicsAccess
} from './frameMode'
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
  /** Issue #31：mode-routing access——`mode`/`active` 是 frame-mode authority。 */
  graphicsAccess: ModeRoutingGraphicsAccess
  host: SceneHost
  gateway: DemoGateway
  stateBuffer: SpatialStateBuffer
  config: PortalConfig
  /** 单次 tick：驱动演示网关 / HISTORY 回放推进 / 模式同步（测试与定时器共用）。 */
  tick(): void
  /** 全局实体搜索：缓存键 + 已注册名称提供者合并（B2）。 */
  searchEntities(
    term: string,
    limit?: number
  ): Array<{ contract: string; key: string; label?: string }>
  /** 注册业务名称搜索提供者（Domain/网关侧提供可搜索字段）。 */
  registerSearchProvider(
    fn: (term: string) => Array<{ key: string; label: string }>
  ): void
  /** 历史环范围（时间线 scrubber 边界）。 */
  historyRange(): { start: number; end: number }
  connection(): ConnectionState
  workspace: {
    setContainers(c: ViewportContainers): void
    getPrimary(): 'map' | 'scene' | 'none'
    setPrimary(kind: 'map' | 'scene'): void
  }
  dispose(): Promise<void>
}

export function buildFoundation(
  options: {
    config?: PortalConfig
    onHostError?: (error: unknown, phase: string) => void
    /**
     * Issue #31：测试 DI——注入确定性 fake runtime 工厂（无 WebGL）。
     * 生产路径不传，走真实 dynamic import 的 createRuntime。
     */
    graphicsRuntimeFactory?: (options: SceneEngineOptions) => Promise<EngineRuntime>
  } = {}
): PortalFoundation {
  const config = options.config ?? loadPortalConfig()
    const onListenerError = (error: unknown, meta: { event: string }) => {
    console.error(`[portal] ${meta.event} listener failed`, error)
  }
const world = createWorldApi({
    onListenerError,
    worldId: 'portal-world',
    sites: DEMO_SITES,
    initialMode: 'live',
    initialScope: { kind: 'global' }
  })

  const spatial = createSpatialApi(onListenerError)
  // Pre-register site frames: geodetic <-> local conversions stay stable (§37).
  for (const site of DEMO_SITES) {
    spatial.ensureEnuFrame(`frame:${site.id}`, spatial.toEllipsoidal(site.origin))
  }
  // Vertical datum declaration (§39): site chart offset.
  spatial.registerVerticalOffset('chart-datum', 'ellipsoid', 2.34)

  const gateway = createDemoGateway()

  // Issue #21：Spatial Fast Path 为 Application-owned 共享运行时状态——
  // 唯一写入链路 = 当前 WorldClient 接受的 envelope（经下方 data.subscribe
  // adapter）。DemoGateway 不再拥有绕过 WorldClient 的 side effect。
  const stateBuffer = new SpatialStateBuffer(256)

  // 预置 20 分钟历史（必须在 buildHistorySource 之前落环）
  for (let t = Date.now() - 20 * 60_000; t < Date.now(); t += 1000) {
    gateway.tick('live', t)
  }

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
  function createHistorySimulationSources(): { history: ReplaySource; simulation: DataSource } {
    // 未配置服务端历史/仿真 API：使用演示录制源与确定性仿真源。
    return { history: gateway.buildHistorySource(), simulation: gateway.simulation }
  }
  const { history: historySource, simulation: simulationSource } = createHistorySimulationSources()

  // I10-3：启用陈旧检测——staleness/清扫按世界时钟判定（HISTORY/SIMULATION
  // 模式下回放数据按虚拟时间判定，不会误报），顶栏「N 项陈旧」随之生效。
  const data = new WorldClient({
    sources: [liveSource, historySource, simulationSource],
    defaultStaleAfterMs: 10_000,
    sweepIntervalMs: 30_000,
    now: () => world.time.now().epochMillis,
    // Issue #21-r2：统一 mode/timeline transition hook——Fast Path 的
    // ordering epoch 与 WorldClient 同源（History seek / mode 切换时
    // buffer 进入新 epoch，旧时间戳不再压制新 timeline）
    onTimelineChange: () => {
      stateBuffer.beginEpoch()
    },
    // Issue #19：Scene data handler 故障对 Composition Root 可观察
    //（限频：同一 handler 仅 ok→failing 转变时上报一次）
    onSubscriberError: (error, meta) => {
      console.error(
        `[portal] data subscriber failed (${meta.contract}/${meta.key}, mode=${meta.mode})`,
        error
      )
    }
  })

  // Issue #11：HISTORY 主动 seek/rewind（含 scrubber 拖动）是排序权威——
  // 每次 seek 开启新的 timeline epoch，WorldClient 重置 revision 游标，
  // 较低 revision 的历史帧不会被误判为网络旧包。
  historySource.setOnSeek(() => data.beginTimelineEpoch('history'))

  // B2：业务名称搜索提供者（演示网关注册船名索引；生产由数据层注册）。
  const searchProviders: Array<(term: string) => Array<{ key: string; label: string }>> = [
    (term) => gateway.searchVesselsByName(term)
  ]

  function searchEntitiesMerged(
    term: string,
    limit = 8
  ): Array<{ contract: string; key: string; label?: string }> {
    const merged: Array<{ contract: string; key: string; label?: string }> = []
    const seen = new Set<string>()
    const push = (contract: string, key: string, label?: string) => {
      if (seen.has(key) || merged.length >= limit) return
      seen.add(key)
      merged.push({ contract, key, label })
    }
    for (const provider of searchProviders) {
      try {
        for (const r of provider(term)) push('', r.key, r.label)
      } catch (error) {
        console.warn('[portal] search provider failed', error)
      }
    }
    for (const r of data.search(term, limit)) push(r.contract, r.key)
    return merged
  }

  // Spatial Fast Path adapter (§35): AGV envelopes feed the shared state
  // buffer OUTSIDE any reactive system; the engine reads at frame boundaries.
  data.subscribe({ contract: AGV_CONTRACT }, (env) => {
    // Issue #27：tombstone——实体离场时撤销 Fast Path 中的 pose
    if (env.op === 'delete') {
      stateBuffer.remove(env.key)
      return
    }
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

  // Issue #31（方案 B）：GLOBAL 与 SITE 是两个 app-owned GraphicsAccess——
  // `SceneEngineOptions.global` 是 boot-time 决策，单一 access 无法同时承载
  // 混合 Scene catalog（global-ships 要求 global env，SITE Scene 要求
  // frame-local meters）。frame mode 的唯一 authority 是 world.session.scope，
  // 由 frameMode router 在 mount 的 use() 时刻提交。
  //
  // Issue #32：mode-specific resource policy——禁止 `{ ...site, global: true }`
  // 式浅拷贝。common 只含 frame-neutral 能力；SITE-only 资源/策略（Fast Path
  // buffer 的 frame-local meters 语义、Site 3D Tiles、site frame、水体）只进
  // SITE runtime。
  const commonGraphicsOptions = {
    getViewport: () => containers.graphics,
    spatial,
    quality: config.defaultQuality,
    maxQuality: 'EXHIBITION' as const,
    // Issue #15：Scene callback 故障可观测（quarantine 由引擎负责，
    // 去向由 Composition Root 决定）
    onCallbackError: (error: unknown, meta: { kind: 'frame' | 'pick' }) => {
      console.error(`[portal] scene ${meta.kind} callback failed (quarantined)`, error)
    },
    getAssetLeaseCount: () => assets.leaseCount
  }
  const siteGraphicsOptions: SceneEngineOptions = {
    ...commonGraphicsOptions,
    // Fast Path buffer 语义 = SITE frame-local meters——GLOBAL 侧禁止消费
    //（EntitySystem 若以 km 语义读取 SITE-frame pose 会产生单位错误）
    stateBuffer,
    // I4-3：Site 3D Tiles——SITE runtime 是其唯一 owner；tilesMaxBytes 语义
    // 为 Portal aggregate 预算，V1 只有 SITE 消费 tiles，故全额归属 SITE，
    // aggregate ceiling 恒等于 config.tilesMaxBytes 不翻倍。
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
    }
  }
  // #32：V1 不支持 GLOBAL tiles（SITE tileset 在 ECEF-km camera-relative
  // 层级没有 placement contract）——GLOBAL 不注入 tiles/water/getActiveFrame；
  // 未来支持 GLOBAL tiles 需独立 descriptor + ECEF→scene-km placement
  // contract + 从 aggregate 预算显式分片。
  const globalGraphicsOptions: SceneEngineOptions = {
    ...commonGraphicsOptions,
    global: true
  }
  const runtimeDeps = options.graphicsRuntimeFactory
    ? { createRuntime: options.graphicsRuntimeFactory }
    : {}
  const siteGraphicsAccess = createGraphicsAccess(siteGraphicsOptions, runtimeDeps)
  const globalGraphicsAccess = createGraphicsAccess(globalGraphicsOptions, runtimeDeps)
  const graphicsAccess = createModeRoutingGraphicsAccess({
    resolveMode: () => (world.session.scope.kind === 'global' ? 'global' : 'site'),
    global: globalGraphicsAccess,
    site: siteGraphicsAccess,
    viewport: () => containers.graphics
  })

  // I4-1/I4-2：资产清单注册 + GLTFLoader 解码器装配（KTX2/DRACO/meshopt）
  // + 内存预算。解码器文件可经 VITE_ASSET_DECODER_PATH 指向本地静态目录
  // （离线部署见 docs/asset-pipeline.md）。
  const content = new ContentRegistry()
  content.registerAssetManifest(DEMO_ASSET_MANIFEST)
  const assets = createAssetApi({
    resolve: (ref) => content.getAsset(ref),
    maxTotalBytes: 256 * 1024 * 1024,
    // Issue #12-r3：enhancer 返回 disposer——DRACO/KTX2 worker 等 decoder
    // stack 资源的 ownership 转移给 manager，foundation teardown 时随
    // assets.dispose() exactly-once 回收（不再有 session 间累积的 worker）。
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
      let ktx2: { dispose(): void } | undefined
      try {
        const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js')
        const k = new KTX2Loader()
        k.setTranscoderPath(config.assetDecoderPath)
        // Issue #12-r3：KTX2 capability 不依赖装配时刻的时序偶然性——
        // renderer 未就绪时有界等待 graphics boot，超时显式 fail-fast；
        // 绝不缓存未 detectSupport 的 KTX2Loader（后续 KTX2 GLB 会确定性
        // 抛 "Missing initialization with .detectSupport(renderer)."）
        const deadline = Date.now() + 10_000
        for (;;) {
          const renderer = graphicsAccess.currentContext?.renderer
          if (renderer) {
            k.detectSupport(renderer)
            break
          }
          if (Date.now() > deadline) {
            k.dispose()
            throw new Error(
              '[portal] KTX2 decoder needs graphics boot (detectSupport); timed out waiting for renderer'
            )
          }
          await new Promise((r) => setTimeout(r, 250))
        }
        ktx2 = k
        l.setKTX2Loader?.(k)
      } catch (error) {
        console.info('[portal] KTX2 解码器不可用，压缩纹理资产将无法加载', error)
      }
      try {
        const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js')
        l.setMeshoptDecoder?.(MeshoptDecoder)
      } catch (error) {
        console.info('[portal] meshopt 解码器不可用，跳过', error)
      }
      // decoder stack ownership → AssetLeaseManager（terminal owner）
      return {
        dispose: () => {
          draco.dispose()
          ktx2?.dispose()
        }
      }
    }
  })

  // One gateway stream drives live AND simulation from the world clock;
  // HISTORY 由回放源跟随虚拟时钟推进（A1：seek 随 tick 持续驱动，
  // 时间倍速/拖动立即生效；并自动同步 WorldClient 的模式路由）。
  function foundationTick(): void {
    const time = world.time.now()
    if (data.mode !== time.mode) data.setMode(time.mode)
    if (time.mode === 'history') {
      historySource.seek(time.epochMillis)
      return
    }
    gateway.tick(time.mode === 'simulation' ? 'simulation' : 'live', time.epochMillis)
  }
  const tickTimer = setInterval(foundationTick, 250)
  tickTimer.unref?.()

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

  // Issue #31：View binding 与 graphics 读取同一 frame-mode authority
  // （router 已提交 mode）——不再有独立的静态 `global: false` 配置点，
  // 不存在 Engine=GLOBAL 但 View=SITE 的可构造正常状态。
  const binding = createSceneEngineViewBinding({
    getRuntime: () => getSceneEngineRuntime(graphicsAccess.active),
    spatial,
    global: () => graphicsAccess.mode === 'global'
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
    stateBuffer,
    config,
    tick: foundationTick,
    searchEntities(term: string, limit = 8) {
      return searchEntitiesMerged(term, limit)
    },
    registerSearchProvider(fn: (term: string) => Array<{ key: string; label: string }>) {
      searchProviders.push(fn)
    },
    historyRange() {
      return gateway.historyRange()
    },
    connection(): ConnectionState {
      const ws = configuredLiveSource
      return {
        state: ws ? ws.connectionState : 'local',
        staleCount: data.countStale()
      }
    },
    workspace,
    async dispose() {
      clearInterval(tickTimer)
      // Issue #16：Composition Root 终止顺序——先停止 Scene 生产者
      // （Host shutdown：Scene unmount / MountScope / revoke 完整序列），
      // 再销毁 consumer/owner（Data/Map/Graphics/Asset）。
      await host.shutdown()
      data.dispose()
      configuredLiveSource?.dispose()
      gateway.dispose()
      mapAccess.dispose()
      graphicsAccess.dispose()
      // Issue #12-E：会话过期/退出路径真正销毁 asset manager——
      // 已加载 GLB 的 GPU 资源全部释放，pending load 晚到也被回收
      assets.dispose()
    }
  }
}
