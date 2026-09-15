import type { SceneEntry, SceneId } from '@twin/sdk'
import { createWorldApi, type Site } from '@twin/world'
import { createSpatialApi, type SpatialApi } from '@twin/spatial'
import { createViewService, SceneHost } from '@twin/scene-host'
import {
  MockAssetApi,
  MockDataApi,
  MockGraphicsAccess,
  MockMapAccess,
  freshCounters,
  type MockCounters
} from './mockEngines'

const COMPLIANCE_SITE: Site = {
  id: 'site-compliance-a',
  name: '合规场址 A',
  origin: {
    longitudeDegrees: 121.7821,
    latitudeDegrees: 31.3622,
    heightMeters: 4.2,
    verticalReference: 'ellipsoid'
  },
  bounds: { south: 31.354, west: 121.772, north: 31.371, east: 121.793 }
}

const COMPLIANCE_SITE_B: Site = {
  id: 'site-compliance-b',
  name: '合规场址 B',
  origin: {
    longitudeDegrees: 121.6523,
    latitudeDegrees: 31.6857,
    heightMeters: 3.8,
    verticalReference: 'ellipsoid'
  },
  bounds: { south: 31.678, west: 121.643, north: 31.693, east: 121.662 }
}

export interface CycleMetrics extends MockCounters {
  uiLayers: number
  contextState: string
  /** Issue #8：teardown 后 frame registry 必须回到 baseline（fresh spatial → 0）。 */
  spatialFrames: number
}

export interface ComplianceReport {
  sceneId: SceneId
  cycles: number
  mounted: boolean
  /** Per-cycle leftover counts after teardown — must ALL be zero. */
  leftovers: CycleMetrics[]
  /** Deterministic per-cycle peak usage — must plateau (be equal). */
  peaks: CycleMetrics[]
  errors: unknown[]
}

export interface ComplianceOptions {
  cycles?: number
  framesPerCycle?: number
  /** Alternate the world scope site A/B before each mount (Gate #5). */
  alternateSites?: boolean
  unmountDeadlineMs?: number
}

export type EntryLoader = () => Promise<unknown>

/** Normalize `entry` or `{ default: entry }` module shapes. */
export async function resolveEntry(load: EntryLoader): Promise<SceneEntry> {
  const mod = (await load()) as SceneEntry | { default: SceneEntry }
  return (mod as { default?: SceneEntry }).default ?? (mod as SceneEntry)
}

/**
 * Scene Compliance harness (§72): mount → run → unmount cycles with mock
 * engines, verifying that scene-owned resources return to baseline and that
 * usage plateaus across cycles (no growth leak).
 */
export async function runComplianceCycles(
  sceneId: SceneId,
  loadEntry: EntryLoader,
  options: ComplianceOptions = {}
): Promise<ComplianceReport> {
  const cycles = options.cycles ?? 3
  const framesPerCycle = options.framesPerCycle ?? 30
  const report: ComplianceReport = {
    sceneId,
    cycles,
    mounted: false,
    leftovers: [],
    peaks: [],
    errors: []
  }

  for (let i = 0; i < cycles; i++) {
    const counters = freshCounters()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const uiContainer = document.createElement('div')
    container.appendChild(uiContainer)

    const world = createWorldApi({
      sites: [COMPLIANCE_SITE, COMPLIANCE_SITE_B],
      initialScope:
        options.alternateSites && i % 2 === 1
          ? { kind: 'site', siteId: COMPLIANCE_SITE_B.id }
          : { kind: 'site', siteId: COMPLIANCE_SITE.id }
    })
    const spatial: SpatialApi = createSpatialApi()
    const data = new MockDataApi(counters)
    const mapAccess = new MockMapAccess(counters)
    const graphicsAccess = new MockGraphicsAccess(counters)

    const host = new SceneHost({
      viewport: { ui: uiContainer },
      services: {
        world,
        spatial,
        data,
        selection: world.selection,
        view: createViewService({ getPrimary: () => 'map' }),
        assets: new MockAssetApi(),
        map: mapAccess,
        graphics: graphicsAccess
      },
      unmountDeadlineMs: options.unmountDeadlineMs ?? 2000,
      onError: (error) => {
        report.errors.push(error)
      }
    })

    const entry = await resolveEntry(loadEntry)
    const mount = await host.mount(entry, { sceneId })
    report.mounted = host.isActive

    // Run the scene: pump frames so onFrame-driven scene logic executes.
    graphicsAccess.pumpFrames(framesPerCycle)

    const peak: CycleMetrics = {
      ...counters,
      uiLayers: host.liveUiLayers,
      contextState: host.contextState ?? 'unknown',
      spatialFrames: spatial.listFrames().length
    }
    report.peaks.push(peak)

    await mount.unmount()
    const leftover: CycleMetrics = {
      ...counters,
      uiLayers: host.liveUiLayers,
      contextState: host.contextState ?? 'unknown',
      spatialFrames: spatial.listFrames().length
    }
    report.leftovers.push(leftover)

    container.remove()
  }

  return report
}

export interface ToggleStressResult {
  toggles: number
  sceneStillMounted: boolean
  selectionKept: boolean
  mapLayersStable: boolean
  frameCallbacksStable: boolean
  graphicsMounts: number
  /** Issue #18：twin-scene-view 事件序列（Last Intent Wins 验收）。 */
  viewEvents: string[]
  /** Issue #18：graphics resume/suspend 计数（final view 一致性验收）。 */
  graphicsResumes: number
  graphicsSuspends: number
  errors: unknown[]
}

/**
 * 2D/3D toggle stress (§73, Gate #2): the scene mounts ONCE; the view
 * toggles N times through its own UI buttons; selection/world state must
 * survive and resource counts must stay stable.
 */
export interface ToggleStressOptions {
  /** Issue #18：可控 deferred graphics use gate（确定性竞态）。 */
  useGate?: Promise<void>
  /** 每次 toggle 之后的钩子（用于在精确交错点释放 gate）。 */
  onAfterToggle?: (index: number) => void | Promise<void>
}

export async function runToggleStress(
  sceneId: SceneId,
  loadEntry: EntryLoader,
  toggles = 100,
  options: ToggleStressOptions = {}
): Promise<ToggleStressResult> {
  const result: ToggleStressResult = {
    toggles: 0,
    sceneStillMounted: false,
    selectionKept: false,
    mapLayersStable: false,
    frameCallbacksStable: false,
    graphicsMounts: 0,
    viewEvents: [],
    graphicsResumes: 0,
    graphicsSuspends: 0,
    errors: []
  }

  const counters = freshCounters()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const uiContainer = document.createElement('div')
  container.appendChild(uiContainer)

  const world = createWorldApi({
    sites: [COMPLIANCE_SITE],
    initialScope: { kind: 'site', siteId: COMPLIANCE_SITE.id }
  })
  const spatial = createSpatialApi()
  const data = new MockDataApi(counters)
  const mapAccess = new MockMapAccess(counters)
  const graphicsAccess = new MockGraphicsAccess(counters)
  // Issue #18：deferred use gate（确定性竞态）
  if (options.useGate) graphicsAccess.useGate = options.useGate
  // 记录 Scene 发出的视图意图事件（最后一个必须等于最终 toggle 的视图）
  uiContainer.addEventListener('twin-scene-view', (e) => {
    const detail = (e as CustomEvent).detail as { view?: string }
    if (detail?.view) result.viewEvents.push(detail.view)
  })

  const host = new SceneHost({
    viewport: { ui: uiContainer },
    services: {
      world,
      spatial,
      data,
      selection: world.selection,
      view: createViewService({ getPrimary: () => 'map' }),
      assets: new MockAssetApi(),
      map: mapAccess,
      graphics: graphicsAccess
    },
    unmountDeadlineMs: 2000,
    onError: (error) => {
      result.errors.push(error)
    }
  })

  const entry = await resolveEntry(loadEntry)
  const mount = await host.mount(entry, { sceneId })

  const selection = world.selection
  selection.setPrimary({ namespace: 'compliance', id: 'KEEP-ME' })

  const layersAfterMount = counters.mapLayers
  const buttons = () => ({
    to3d: uiContainer.querySelector<HTMLButtonElement>('[data-view-toggle="graphics"]'),
    to2d: uiContainer.querySelector<HTMLButtonElement>('[data-view-toggle="map"]')
  })

  for (let i = 0; i < toggles; i++) {
    const going3d = i % 2 === 0
    const button = going3d ? buttons().to3d : buttons().to2d
    if (!button) {
      result.errors.push(new Error(`toggle button missing (iteration ${i})`))
      break
    }
    button.click()
    // Let microtasks (dynamic imports on first entry) settle.
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    graphicsAccess.pumpFrames(1)
    result.toggles++
    await options.onAfterToggle?.(i)
  }

  // Issue #17-r2：CI 上 three chunk 的动态导入可能慢于整段点击循环——
  // 等待首次 3D boot 真正发生（上限 3s），保证 graphicsMounts 语义确定
  for (let i = 0; i < 300 && counters.graphicsUseCalls === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  // Issue #17-r2：CI 上 three chunk 导入可能慢于整段点击循环——
  // 等待首次 3D boot 真正发生（上限 3s），保证 graphicsMounts 语义确定
  for (let i = 0; i < 300 && counters.graphicsUseCalls === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  // Issue #18：让 pending boot 完成路径（commit gate / 补提交）的微任务链
  // 收敛后再读取 counters 与 viewEvents
  await new Promise((resolve) => setTimeout(resolve, 0))

  result.graphicsMounts = counters.graphicsUseCalls
  // mock 的 graphics context.suspend/resume 计入专属计数器（map 用 suspends/resumes）
  result.graphicsResumes = counters.graphicsResumes
  result.graphicsSuspends = counters.graphicsSuspends
  result.sceneStillMounted = host.isActive && mount.state === 'active'
  result.selectionKept = selection.isSelected({ namespace: 'compliance', id: 'KEEP-ME' })
  result.mapLayersStable = counters.mapLayers === layersAfterMount
  result.frameCallbacksStable = counters.frameCallbacks === 1

  await mount.unmount()
  container.remove()
  return result
}
