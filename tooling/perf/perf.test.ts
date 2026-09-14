import { describe, expect, it, vi } from 'vitest'
import {
  PerfCapture,
  SoakDriver,
  analyzePlateau,
  summarizeSamples,
  type DiagnosticsSnapshot
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
