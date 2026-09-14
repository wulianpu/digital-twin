import { Bench } from 'tinybench'
import { expect, it } from 'vitest'
import { createEnuFrame, ecefToFrameLocal, geodeticToEcef } from '@twin/spatial'
import { SpatialStateBuffer } from '@twin/world-client'

/**
 * 热路径微基准（§64-65，I5）：以 tinybench 直接驱动（vitest 5 已移除
 * 内建 bench API）。运行 `pnpm bench`，结果输出表格并写入
 * docs/benchmarks.md「微基线」小节。仅做健全性断言，不做吞吐阈值断言
 * （吞吐随机器波动，阈值验收在目标机器按 docs/benchmarks.md 执行）。
 */

const frame = createEnuFrame('bench', {
  longitudeDegrees: 121.7821,
  latitudeDegrees: 31.3622,
  heightMeters: 4,
  verticalReference: 'ellipsoid'
})

const bench = new Bench({ iterations: 200, time: 150 })

bench
  .add('geodeticToEcef ×1000', () => {
    for (let i = 0; i < 1000; i++) {
      geodeticToEcef({
        longitudeDegrees: 121 + i * 1e-4,
        latitudeDegrees: 31 + i * 1e-4,
        heightMeters: i,
        verticalReference: 'ellipsoid'
      })
    }
  })
  .add('ecefToFrameLocal ×1000 (site transform)', () => {
    for (let i = 0; i < 1000; i++) {
      ecefToFrameLocal(frame, {
        xMeters: -2_872_000 + i,
        yMeters: 4_680_000,
        zMeters: 3_290_000
      })
    }
  })
  .add('SpatialStateBuffer upsert ×1000', () => {
    const buffer = new SpatialStateBuffer(1024)
    for (let i = 0; i < 1000; i++) {
      buffer.upsert(`agv/${i}`, {
        x: i,
        y: i * 0.1,
        z: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
        timeMs: i,
        frameId: 'f'
      })
    }
  })

const buffer = new SpatialStateBuffer(1024)
for (let i = 0; i < 1000; i++) {
  buffer.upsert(`agv/${i}`, {
    x: i, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, timeMs: i, frameId: 'f'
  })
}
bench.add('SpatialStateBuffer interpolate ×1000', () => {
  const sample = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, frameId: 'f', timeMs: 0 }
  for (let i = 0; i < 1000; i++) {
    buffer.interpolate(`agv/${i}`, 500, sample)
  }
})

it('热路径微基准（结果打印为表格，供 docs/benchmarks.md 记录）', async () => {
  await bench.run()
  const rows = bench.tasks.map((t) => ({
    task: t.name,
    // tinybench v4：throughput = 每秒任务执行次数；latency = 单次任务毫秒
    runsPerSec: Math.round(t.result?.throughput?.mean ?? 0),
    latencyMeanMs: Number((t.result?.latency?.mean ?? 0).toFixed(4)),
    latencyP75Ms: Number((t.result?.latency?.p75 ?? 0).toFixed(4))
  }))
  console.table(rows)
  for (const row of rows) {
    expect(row.runsPerSec).toBeGreaterThan(0)
  }
  // 供自动化/文档抓取
  ;(globalThis as Record<string, unknown>).__twinMicroBench = rows
})
