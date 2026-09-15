import { describe, expect, it, vi } from 'vitest'
import {
  PerfCapture,
  SoakDriver,
  analyzePlateau,
  analyzeResourcePlateaus,
  DEFAULT_RESOURCE_THRESHOLDS,
  summarizeSamples,
  type DiagnosticsSnapshot,
  type SoakSample
} from './src/index'

function snapshot(overrides: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    fps: 60,
    p50Ms: 16,
    p95Ms: 20,
    drawCalls: 100,
    triangles: 50_000,
    ...overrides
  }
}

describe('PerfCapture（I5-1）', () => {
  it('tick 驱动采样并汇总（fps/p50/p95 最差观测、heap 增长）', () => {
    let frame = 0
    let fakeNow = 0
    const capture = new PerfCapture({
      label: 'unit',
      durationMs: 1000,
      now: () => fakeNow,
      getDiagnostics: () =>
        snapshot({
          fps: frame === 0 ? 58 : 60,
          p50Ms: 16,
          p95Ms: frame === 0 ? 20 : 33, // 一次尖峰
          jsHeapMB: frame === 0 ? 100 : 120,
          tilesBytes: 1024
        })
    })
    capture.start() // t=0 基线采样（frame=0）
    fakeNow = 500
    frame = 1
    capture.sample(500)
    fakeNow = 1200
    capture.sample(1200) // 超过 duration → 自动收尾

    const report = capture.report()
    expect(report.summary.sampleCount).toBe(3)
    expect(report.summary.durationMs).toBe(1200)
    expect(report.summary.fps.min).toBe(58)
    expect(report.summary.frameMs.p95Worst).toBe(33)
    expect(report.summary.jsHeapMB.growthMB).toBe(20)
    expect(report.summary.tilesBytes.max).toBe(1024)
    expect(capture.isRunning).toBe(false) // 已自动收尾
  })

  it('诊断不可用时跳过采样，不产生脏数据', () => {
    const capture = new PerfCapture({
      label: 'idle',
      durationMs: 100,
      getDiagnostics: () => undefined
    })
    capture.start()
    expect(capture.sample(0)).toBeUndefined()
    const report = capture.report()
    expect(report.summary.sampleCount).toBe(0)
  })

  it('summarizeSamples 为纯函数（空样本安全）', () => {
    const report = summarizeSamples('empty', '2026-01-01T00:00:00Z', 1000, [])
    expect(report.summary.sampleCount).toBe(0)
    expect(report.summary.jsHeapMB.growthMB).toBeUndefined()
  })
})

describe('SoakDriver / plateau（I5-3）', () => {
  it('驱动循环并采样 heap，cycle 异常被记录不中断', async () => {
    let cycles = 0
    const driver = new SoakDriver({
      totalCycles: 4,
      runCycle: async (cycle) => {
        cycles = cycle
        if (cycle === 3) throw new Error('boom')
      },
      sampleHeap: () => 100 + cycles
    })
    const report = await driver.run()
    expect(report.totalCycles).toBe(4)
    expect(report.completedCycles).toBe(3)
    expect(report.samples[2].error).toContain('boom')
    expect(report.samples[3].heapMB).toBe(104)
  })

  it('plateau：平稳序列判稳，增长序列判不稳', () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({
      cycle: i + 1,
      tMs: i * 100,
      heapMB: 100 + (i % 2) // 抖动 ±1MB
    }))
    expect(analyzePlateau(flat).detected).toBe(true)

    // 下降趋势同样健康（§71 关心增长性泄漏，而非归零）
    const falling = Array.from({ length: 20 }, (_, i) => ({
      cycle: i + 1,
      tMs: i * 100,
      heapMB: 120 - i
    }))
    expect(analyzePlateau(falling).detected).toBe(true)

    const growing = Array.from({ length: 20 }, (_, i) => ({
      cycle: i + 1,
      tMs: i * 100,
      heapMB: 100 + i * 2 // 每轮 +2MB
    }))
    const plateau = analyzePlateau(growing)
    expect(plateau.detected).toBe(false)
    expect(plateau.slopeMBPerCycle).toBeCloseTo(2, 1)
    expect(plateau.secondHalfAvgMB! - plateau.firstHalfAvgMB!).toBeGreaterThan(10)
  })

  it('runCycle 可接入任意装配（回调计数）', async () => {
    const runCycle = vi.fn(async () => {})
    const driver = new SoakDriver({ totalCycles: 3, runCycle })
    await driver.run()
    expect(runCycle).toHaveBeenCalledTimes(3)
  })
})


/** ---------------- Issue #13：资源 plateau analyzer（intentional-leak 回归） */

function resourceSamples(
  frameCallbacks: (cycle: number) => number,
  textures: (cycle: number) => number = () => 12,
  cycles = 20
): SoakSample[] {
  return Array.from({ length: cycles }, (_, i) => ({
    cycle: i + 1,
    tMs: i * 1000,
    heapMB: 10,
    resources: {
      frameCallbacks: frameCallbacks(i + 1),
      textures: textures(i + 1)
    }
  }))
}

describe('Soak 资源 plateau gate（Issue #13 intentional-leak 回归）', () => {
  it('每轮多留一个 frame callback（intentional leak）→ analyzer 判泄漏', () => {
    const { plateaus, pass } = analyzeResourcePlateaus(
      resourceSamples((cycle) => cycle),
      DEFAULT_RESOURCE_THRESHOLDS
    )
    expect(pass).toBe(false)
    expect(plateaus.frameCallbacks?.detected).toBe(false)
    expect(plateaus.frameCallbacks?.slopePerCycle).toBeCloseTo(1, 3)
    // 健康的 counter 不受影响
    expect(plateaus.textures?.detected).toBe(true)
  })

  it('资源平稳（plateau 语义）→ pass；下降亦为健康', () => {
    const stable = analyzeResourcePlateaus(
      resourceSamples(() => 3, (cycle) => 12 - cycle * 0.1),
      DEFAULT_RESOURCE_THRESHOLDS
    )
    expect(stable.pass).toBe(true)
    expect(stable.plateaus.frameCallbacks?.detected).toBe(true)
    expect(stable.plateaus.textures?.detected).toBe(true)
  })

  it('SoakDriver 端到端：泄漏 counter 使 report.pass = false', async () => {
    // 直接构造驱动循环：每轮 frameCallbacks +1（scene-owned 资源泄漏）
    let callbacks = 0
    const leakDriver = new SoakDriver({
      totalCycles: 12,
      runCycle: async () => {
        callbacks++
      },
      sampleHeap: () => 10,
      sampleResources: () => ({ assetLeases: 0, frameCallbacks: callbacks })
    })
    const report = await leakDriver.run()
    expect(report.resources.pass).toBe(false)
    expect(report.pass).toBe(false)
    expect(report.resources.plateaus.frameCallbacks?.slopePerCycle).toBeCloseTo(1, 3)

    // 对照：无泄漏 → pass
    const cleanDriver = new SoakDriver({
      totalCycles: 12,
      runCycle: async () => {},
      sampleHeap: () => 10,
      sampleResources: () => ({ assetLeases: 2, frameCallbacks: 3 })
    })
    const cleanReport = await cleanDriver.run()
    expect(cleanReport.resources.pass).toBe(true)
    expect(cleanReport.pass).toBe(true)
  })

  it('样本数 < 4 的 counter 不参与判定（warmup 噪声）', () => {
    const sparse = analyzeResourcePlateaus([
      { cycle: 1, tMs: 0, heapMB: 1, resources: { textures: 5 } },
      { cycle: 2, tMs: 1, heapMB: 1, resources: { textures: 50 } },
      { cycle: 3, tMs: 2, heapMB: 1, resources: { textures: 500 } }
    ])
    expect(sparse.plateaus.textures).toBeUndefined()
    expect(sparse.pass).toBe(true)
  })
})
