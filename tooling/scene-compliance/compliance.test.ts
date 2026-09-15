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
      ['uiLayers', leftover.uiLayers],
      ['spatialFrames', leftover.spatialFrames]
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
    { id: 'hostile:forget-spatial-frame-registration', load: () => import('./fixtures/hostile-scenes').then(m => m.forgetSpatialFrameRegistration) },
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

describe('Hostile scene compliance: alias 旁路与 create-before-guard（Issue #5）', () => {
  const ALIAS_FIXTURES: Array<{ id: string; key: string; expected: string; load: () => Promise<unknown> }> = [
    {
      id: 'hostile:zombie-world-nested-selection',
      key: 'nested-selection',
      expected: 'REJECTED',
      load: () => import('./fixtures/hostile-scenes').then(m => m.zombieWorldNestedSelection)
    },
    {
      id: 'hostile:zombie-world-session-scope-alias',
      key: 'session-scope-alias',
      expected: 'SAFE',
      load: () => import('./fixtures/hostile-scenes').then(m => m.zombieWorldSessionScopeAlias)
    },
    {
      id: 'hostile:zombie-selection-current-alias',
      key: 'selection-current-alias',
      expected: 'SAFE',
      load: () => import('./fixtures/hostile-scenes').then(m => m.zombieSelectionCurrentAlias)
    },
    {
      id: 'hostile:zombie-spatial-frame-alias',
      key: 'spatial-frame-alias',
      expected: 'SAFE',
      load: () => import('./fixtures/hostile-scenes').then(m => m.zombieSpatialFrameAlias)
    },
    {
      id: 'hostile:zombie-site-origin-alias',
      key: 'site-origin-alias',
      expected: 'SAFE',
      load: () => import('./fixtures/hostile-scenes').then(m => m.zombieSiteOriginAlias)
    },
    {
      id: 'hostile:zombie-site-register-after-close',
      key: 'site-register-after-close',
      expected: 'REJECTED',
      load: () => import('./fixtures/hostile-scenes').then(m => m.zombieSiteRegisterAfterClose)
    }
  ]

  it.each(ALIAS_FIXTURES.map(f => [f.id, f.key, f.expected, f.load] as const))(
    '%s',
    async (sceneId, key, expected, load) => {
      const report = await runComplianceCycles(sceneId, load, { cycles: 2, framesPerCycle: 5 })
      expect(report.errors).toEqual([])
      expect(report.leftovers.every(l => l.contextState === 'revoked')).toBe(true)
      expect(zombieWriteProbes[key]).toBe(expected)
    },
    15_000
  )

  it('ctx.world.selection 与 ctx.selection 为同一 scoped 实例（无语义分叉）', async () => {
    await runComplianceCycles('hostile:nested-selection-identity', () =>
      import('./fixtures/hostile-scenes').then(m => m.zombieWorldNestedSelection),
      { cycles: 1, framesPerCycle: 2 }
    )
    expect(zombieWriteProbes['nested-selection-identity']).toBe('IDENTITY-OK')
  }, 15_000)
})

describe('Hostile scene compliance: write-side input alias（Issue #6）', () => {
  const INPUT_ALIAS_FIXTURES: Array<{ id: string; key: string; load: () => Promise<unknown> }> = [
    {
      id: 'hostile:zombie-world-scope-input-alias',
      key: 'world-scope-input-alias',
      load: () => import('./fixtures/hostile-scenes').then(m => m.zombieWorldScopeInputAlias)
    },
    {
      id: 'hostile:zombie-selection-primary-input-alias',
      key: 'selection-primary-input-alias',
      load: () => import('./fixtures/hostile-scenes').then(m => m.zombieSelectionPrimaryInputAlias)
    },
    {
      id: 'hostile:zombie-selection-secondary-input-alias',
      key: 'selection-secondary-input-alias',
      load: () => import('./fixtures/hostile-scenes').then(m => m.zombieSelectionSecondaryInputAlias)
    },
    {
      id: 'hostile:zombie-selection-toggle-input-alias',
      key: 'selection-toggle-input-alias',
      load: () => import('./fixtures/hostile-scenes').then(m => m.zombieSelectionToggleInputAlias)
    }
  ]

  it.each(INPUT_ALIAS_FIXTURES.map(f => [f.id, f.key, f.load] as const))(
    '%s: 卸载后修改 setter 原入参不影响 Foundation truth',
    async (sceneId, key, load) => {
      const report = await runComplianceCycles(sceneId, load, { cycles: 2, framesPerCycle: 5 })
      expect(report.errors).toEqual([])
      expect(report.leftovers.every(l => l.contextState === 'revoked')).toBe(true)
      expect(zombieWriteProbes[key]).toBe('SAFE')
    },
    15_000
  )
})

describe('Hostile scene compliance: registration ownership（Issue #7）', () => {
  const OWNERSHIP_FIXTURES: Array<{
    id: string
    checks: Array<[string, string]>
    load: () => Promise<unknown>
  }> = [
    {
      id: 'hostile:shadow-foundation-site',
      checks: [
        ['shadow-site-register', 'REJECTED'],
        ['site-baseline-after', 'SAFE']
      ],
      load: () => import('./fixtures/hostile-scenes').then(m => m.shadowFoundationSite)
    },
    {
      id: 'hostile:shadow-foundation-frame',
      checks: [
        ['shadow-frame-register', 'REJECTED'],
        ['frame-baseline-after', 'SAFE']
      ],
      load: () => import('./fixtures/hostile-scenes').then(m => m.shadowFoundationFrame)
    },
    {
      id: 'hostile:shadow-foundation-datum',
      checks: [
        ['shadow-datum-register', 'REJECTED'],
        ['datum-shadow-value', 'OK']
      ],
      load: () => import('./fixtures/hostile-scenes').then(m => m.shadowFoundationDatum)
    },
    {
      id: 'hostile:stale-registration-disposer',
      checks: [['stale-disposer', 'SAFE']],
      load: () => import('./fixtures/hostile-scenes').then(m => m.staleRegistrationDisposer)
    }
  ]

  it.each(OWNERSHIP_FIXTURES.map(f => [f.id, f.checks, f.load] as const))(
    '%s: duplicate 拒绝 + baseline 保持',
    async (sceneId, checks, load) => {
      const report = await runComplianceCycles(sceneId, load, { cycles: 2, framesPerCycle: 5 })
      expect(report.errors).toEqual([])
      expect(report.leftovers.every(l => l.contextState === 'revoked')).toBe(true)
      for (const [key, expected] of checks) {
        expect(zombieWriteProbes[key]).toBe(expected)
      }
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

/** ---------------- Issue #18：view intent generation（Last Intent Wins） */

import { deferredGate } from './src/toggleGate'

describe('Gate #2-r2：view intent generation（Issue #18）', () => {
  it('map → graphics(pending) → map → boot resolve：最终严格为 map，graphics 从未 resume', async () => {
    const gate = deferredGate()
    const result = await runToggleStress(
      'stack-yard',
      () => import('@twin/scene-stack-yard'),
      2,
      {
        useGate: gate.gate,
        onAfterToggle: async (i) => {
          if (i === 1) gate.release() // to2d 提交后才放行 boot
        }
      }
    )
    expect(result.errors).toEqual([])
    expect(result.viewEvents).toEqual(['map']) // 无 stale graphics 事件
    expect(result.viewEvents.at(-1)).toBe('map')
    expect(result.graphicsResumes).toBe(0) // graphics 从未被 resume（不复活 3D）
    expect(result.sceneStillMounted).toBe(true)
    gate.dispose()
  }, 30_000)

  it('map → graphics(pending) → map → graphics：boot resolve 后补提交，single-flight 保持', async () => {
    const gate = deferredGate()
    const result = await runToggleStress(
      'stack-yard',
      () => import('@twin/scene-stack-yard'),
      3,
      {
        useGate: gate.gate,
        onAfterToggle: async (i) => {
          if (i === 2) gate.release() // 最终 to3d 之后放行 boot
        }
      }
    )
    expect(result.errors).toEqual([])
    expect(result.viewEvents.at(-1)).toBe('graphics')
    expect(result.graphicsMounts).toBe(1) // boot single-flight
    expect(result.graphicsResumes).toBeGreaterThanOrEqual(1)
    expect(result.sceneStillMounted).toBe(true)
    gate.dispose()
  }, 30_000)
})
