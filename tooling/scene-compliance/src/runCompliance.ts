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
  errors: unknown[]
}

/**
 * 2D/3D toggle stress (§73, Gate #2): the scene mounts ONCE; the view
 * toggles N times through its own UI buttons; selection/world state must
 * survive and resource counts must stay stable.
 */
export async function runToggleStress(
  sceneId: SceneId,
  loadEntry: EntryLoader,
  toggles = 100
): Promise<ToggleStressResult> {
  const result: ToggleStressResult = {
    toggles: 0,
    sceneStillMounted: false,
    selectionKept: false,
    mapLayersStable: false,
    frameCallbacksStable: false,
    graphicsMounts: 0,
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
  }

  result.graphicsMounts = counters.graphicsUseCalls
  result.sceneStillMounted = host.isActive && mount.state === 'active'
  result.selectionKept = selection.isSelected({ namespace: 'compliance', id: 'KEEP-ME' })
  result.mapLayersStable = counters.mapLayers === layersAfterMount
  result.frameCallbacksStable = counters.frameCallbacks === 1

  await mount.unmount()
  container.remove()
  return result
}
