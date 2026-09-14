// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { SceneEntry } from '@twin/sdk'
import { runComplianceCycles, runToggleStress, type ComplianceReport } from './src/runCompliance'

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
