// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { SceneEntry } from '@twin/sdk'
import { runComplianceCycles, runToggleStress, type ComplianceReport } from './src/runCompliance'
import { zombieWriteProbes } from './fixtures/hostile-scenes'

/**
 * Scene Compliance (§72) + Freeze Gates #1/#2/#4/#5.
 * Every catalog scene must survive mount → run → unmount cycles with all
 * scene-owned resources returning to baseline.
 */

interface SceneModule {
  default: SceneEntry
}

const SCENES: Array<{ id: string; load: () => Promise<SceneModule> }> = [
  { id: 'global-ships', load: () => import('@twin/scene-global-ships') },
  { id: 'vehicle-navigation', load: () => import('@twin/scene-vehicle-navigation') },
  { id: 'stack-yard', load: () => import('@twin/scene-stack-yard') },
  { id: 'production', load: () => import('@twin/scene-production') },
  { id: 'heavy-transport', load: () => import('@twin/scene-heavy-transport') }
]

function expectClean(report: ComplianceReport): void {
  const nonzero: string[] = []
  for (const [i, leftover] of report.leftovers.entries()) {
    const checks: Array<[string, number]> = [
      ['mapLayers', leftover.mapLayers],
      ['mapSources', leftover.mapSources],
      ['mapListeners', leftover.mapListeners],
      ['frameCallbacks', leftover.frameCallbacks],
      ['pickCallbacks', leftover.pickCallbacks],
      ['dataSubscriptions', leftover.dataSubscriptions],
      ['uiLayers', leftover.uiLayers]
    ]
    for (const [name, value] of checks) {
      if (value !== 0) nonzero.push(`cycle ${i}: ${name} = ${value}`)
    }
    if (leftover.contextState !== 'revoked') {
      nonzero.push(`cycle ${i}: context not revoked (${leftover.contextState})`)
    }
  }
  expect(nonzero).toEqual([])
}

function expectPlateau(report: ComplianceReport): void {
  const first = report.peaks[0]
  const drift: string[] = []
  for (const [i, peak] of report.peaks.entries()) {
    for (const key of [
      'mapLayers',
      'mapSources',
      'mapListeners',
      'frameCallbacks',
      'dataSubscriptions',
      'graphicsUseCalls'
    ] as const) {
      if (peak[key] !== first[key]) {
        drift.push(`cycle ${i}: ${key} ${first[key]} -> ${peak[key]}`)
      }
    }
  }
  expect(drift).toEqual([])
}

describe('Scene Compliance: mount/run/unmount cycles (§72, Gate #4)', () => {
  it.each(SCENES.map((s) => [s.id, s.load] as const))(
    '%s returns scene-owned resources to baseline',
    async (sceneId, load) => {
      const report = await runComplianceCycles(sceneId, load, {
        cycles: 3,
        framesPerCycle: 20
      })
      expect(report.errors).toEqual([])
      expect(report.mounted).toBe(true)
      expectClean(report)
      expectPlateau(report)
    },
    30_000
  )
})

describe('Gate #5: Site A / Site B alternation plateaus', () => {
  it('stack-yard cycles across two sites without growth', async () => {
    const report = await runComplianceCycles('stack-yard', () => import('@twin/scene-stack-yard'), {
      cycles: 6,
      alternateSites: true,
      framesPerCycle: 10
    })
    expect(report.errors).toEqual([])
    expectClean(report)
    expectPlateau(report)
  }, 40_000)

  it('production cycles across two sites without growth', async () => {
    const report = await runComplianceCycles('production', () => import('@twin/scene-production'), {
      cycles: 6,
      alternateSites: true,
      framesPerCycle: 10
    })
    expect(report.errors).toEqual([])
    expectClean(report)
    expectPlateau(report)
  }, 40_000)
})

describe('Hostile scene compliance（Issue #1 问题5）', () => {
  const HOSTILE_FIXTURES = [
    { id: 'hostile:forget-data-sub', load: () => import('./fixtures/hostile-scenes').then(m => m.forgetDataSubscription) },
    { id: 'hostile:forget-asset-lease', load: () => import('./fixtures/hostile-scenes').then(m => m.forgetAssetLease) },
    { id: 'hostile:forget-frame-callback', load: () => import('./fixtures/hostile-scenes').then(m => m.forgetFrameCallback) },
    { id: 'hostile:forget-pick-callback', load: () => import('./fixtures/hostile-scenes').then(m => m.forgetPickCallback) },
    { id: 'hostile:unmount-throws', load: () => import('./fixtures/hostile-scenes').then(m => m.unmountThrows) },
    { id: 'hostile:zombie-cached-context', load: () => import('./fixtures/hostile-scenes').then(m => m.zombieCachedContext) },
  ]

  it.each(HOSTILE_FIXTURES.map(f => [f.id, f.load] as const))(
    '%s: Host 兜底回收全部资源',
    async (sceneId, load) => {
      const report = await runComplianceCycles(sceneId, load, { cycles: 2, framesPerCycle: 5 })
      // Host 兜底：即使 scene 忘记清理，Host 也能回收全部
      expect(report.leftovers.every(l => l.contextState === 'revoked')).toBe(true)
    },
    15_000
  )

  it('unmount-hangs：deadline 兜底后 baseline', async () => {
    const report = await runComplianceCycles('hostile:unmount-hangs', async () => {
      return import('./fixtures/hostile-scenes').then(m => m.unmountHangs)
    }, { cycles: 2, framesPerCycle: 5, unmountDeadlineMs: 500 })
    // 超时后 Host 仍然完成 teardown
    expect(report.leftovers.every(l => l.contextState === 'revoked')).toBe(true)
  }, 15_000)
})

describe('Hostile scene compliance: 非 Engine capability 生命周期隔离（Issue #4）', () => {
  const LISTENER_FIXTURES = [
    { id: 'hostile:forget-selection-listener', load: () => import('./fixtures/hostile-scenes').then(m => m.forgetSelectionListener) },
    { id: 'hostile:forget-world-session-listener', load: () => import('./fixtures/hostile-scenes').then(m => m.forgetWorldSessionListener) },
    { id: 'hostile:forget-spatial-listener', load: () => import('./fixtures/hostile-scenes').then(m => m.forgetSpatialListener) }
  ]

  it.each(LISTENER_FIXTURES.map(f => [f.id, f.load] as const))(
    '%s: Host track 兜底释放，无 teardown 噪音',
    async (sceneId, load) => {
      const report = await runComplianceCycles(sceneId, load, { cycles: 2, framesPerCycle: 5 })
      expect(report.errors).toEqual([])
      expect(report.leftovers.every(l => l.contextState === 'revoked')).toBe(true)
    },
    15_000
  )

  const ZOMBIE_FIXTURES: Array<{ id: string; key: string; load: () => Promise<unknown> }> = [
    { id: 'hostile:zombie-selection-write', key: 'selection', load: () => import('./fixtures/hostile-scenes').then(m => m.zombieSelectionWrite) },
    { id: 'hostile:zombie-world-scope-write', key: 'world-scope', load: () => import('./fixtures/hostile-scenes').then(m => m.zombieWorldScopeWrite) },
    { id: 'hostile:zombie-world-clock-write', key: 'world-clock', load: () => import('./fixtures/hostile-scenes').then(m => m.zombieWorldClockWrite) },
    { id: 'hostile:zombie-spatial-frame-write', key: 'spatial-frame', load: () => import('./fixtures/hostile-scenes').then(m => m.zombieSpatialFrameWrite) },
    { id: 'hostile:zombie-view-write', key: 'view', load: () => import('./fixtures/hostile-scenes').then(m => m.zombieViewWrite) }
  ]

  it.each(ZOMBIE_FIXTURES.map(f => [f.id, f.key, f.load] as const))(
    '%s: stale write 被 SceneScopeClosedError 拒绝',
    async (sceneId, key, load) => {
      const report = await runComplianceCycles(sceneId, load, { cycles: 2, framesPerCycle: 5 })
      expect(report.errors).toEqual([])
      expect(report.leftovers.every(l => l.contextState === 'revoked')).toBe(true)
      // Issue #4 核心验收：unmount 后的缓存引用写必须被拒，而非静默生效
      expect(zombieWriteProbes[key]).toBe('REJECTED')
    },
    15_000
  )
})

describe('Gate #2: production 2D ↔ 3D toggle ×100', () => {
  it('toggles 100 times with the scene mounted once', async () => {
    const result = await runToggleStress('production', () => import('@twin/scene-production'), 100)
    expect(result.errors).toEqual([])
    expect(result.toggles).toBe(100)
    expect(result.sceneStillMounted).toBe(true)
    expect(result.selectionKept).toBe(true)
    expect(result.graphicsMounts).toBe(1) // 3D engine boots exactly once
    expect(result.mapLayersStable).toBe(true)
    expect(result.frameCallbacksStable).toBe(true)
  }, 60_000)

  it('stack-yard toggles survive identically', async () => {
    const result = await runToggleStress('stack-yard', () => import('@twin/scene-stack-yard'), 20)
    expect(result.errors).toEqual([])
    expect(result.sceneStillMounted).toBe(true)
    expect(result.selectionKept).toBe(true)
    expect(result.graphicsMounts).toBe(1)
    expect(result.mapLayersStable).toBe(true)
  }, 60_000)
})
