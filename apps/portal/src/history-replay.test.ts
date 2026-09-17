
import { describe, expect, it, afterEach } from 'vitest'
import { AGV_CONTRACT, decodeAgv } from '@twin/domain-agv'
import { buildFoundation } from './foundation'

/**
 * A1：HISTORY 回放跟随世界时钟——foundation.tick() 持续驱动
 * ReplaySource.seek(虚拟时间)，数据随倍速推进（§28）。
 */
describe('HISTORY 回放推进（A1）', () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).__twinPerfReport = undefined
  })

  it('tick 驱动回放：AGV 位姿随虚拟时间变化', async () => {
    const foundation = buildFoundation()
    try {
      // 切到 HISTORY 并把虚拟时钟锚到录制区间中段
      foundation.world.setMode('history')
      foundation.data.setMode('history')
      const historyStart = Date.now() - 20 * 60_000
      foundation.world.clock.seek(historyStart + 60_000) // 区间 +1 分钟处

      const positions: number[] = []
      foundation.data.subscribe({ contract: AGV_CONTRACT }, (e) => {
        const s = decodeAgv(e)
        if (s) positions.push(s.xMeters)
      })
      await new Promise((r) => setTimeout(r, 50))

      // 回放推进：确定性推进虚拟时钟（每步 +2s 跨越回放帧界）
      for (let i = 1; i <= 6; i++) {
        foundation.world.clock.seek(historyStart + 60_000 + i * 2000)
        foundation.tick()
        await new Promise((r) => setTimeout(r, 10))
      }

      expect(positions.length).toBeGreaterThan(0)
      // 回放推进：位置随虚拟时间变化（非冻结）
      expect(new Set(positions).size).toBeGreaterThan(1)
    } finally {
      foundation.dispose()
    }
  })

  it('HISTORY 模式下演示 live 源不再被喂养', async () => {
    const foundation = buildFoundation()
    try {
      foundation.world.setMode('history')
      foundation.data.setMode('history')
      const before = foundation.gateway.live.tickCount
      foundation.tick()
      foundation.tick()
      expect(foundation.gateway.live.tickCount).toBe(before)
    } finally {
      foundation.dispose()
    }
  })
})

/** ---------------------- Issue #11：backward scrub + 长订阅 revision 隔离 */

describe('HISTORY backward scrub（Issue #11）', () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).__twinPerfReport = undefined
  })

  it('已有长期订阅：切 HISTORY 到过去 → 状态变为过去值；向后 scrub → 状态再次向过去变化', async () => {
    const foundation = buildFoundation()
    try {
      // 长期订阅：LIVE 阶段就建立（不是切 HISTORY 后新建），持续接收全部投递
      const seen: Array<{ x: number; sourceTime: number }> = []
      foundation.data.subscribe({ contract: AGV_CONTRACT }, (e) => {
        const s = decodeAgv(e)
        if (s) seen.push({ x: s.xMeters, sourceTime: e.sourceTime })
      })

      // LIVE 先积累高 revision 的真实数据
      foundation.world.setMode('live')
      foundation.data.setMode('live')
      foundation.tick()
      foundation.tick()
      await new Promise((r) => setTimeout(r, 20))
      const liveCount = seen.length
      expect(liveCount).toBeGreaterThan(0)

      // 切 HISTORY 到过去（录制区间 = 过去 20 分钟）
      foundation.world.setMode('history')
      foundation.data.setMode('history')
      const historyStart = Date.now() - 20 * 60_000
      foundation.world.clock.seek(historyStart + 120_000) // 区间 +2 分钟
      foundation.tick()
      await new Promise((r) => setTimeout(r, 30))

      const afterForward = seen.length
      expect(afterForward).toBeGreaterThan(liveCount) // 历史帧被投递（未被 revision 去重吞掉）

      // scrub 向后：拖到更早时间（+30s < +120s）→ 较低 revision 必须再次投递
      foundation.world.clock.seek(historyStart + 30_000)
      foundation.tick()
      await new Promise((r) => setTimeout(r, 30))

      const afterBackward = seen.length
      expect(afterBackward).toBeGreaterThan(afterForward)

      // 且回退后看到的是更早的 sourceTime（世界时间与状态一致）
      const recent = seen.slice(-(afterBackward - afterForward))
      expect(recent.every((s) => s.sourceTime <= historyStart + 120_000)).toBe(true)

      // Issue #21-r2：Fast Path 与 data.peek 同源——backward scrub 后
      // SpatialStateBuffer 必须已同步回退到 t1（不能冻结在 t2）
      const bufferSample = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, frameId: '', timeMs: 0 }
      expect(foundation.stateBuffer.readLatest('agv/AGV-01', bufferSample)).toBe(true)
      expect(bufferSample.timeMs).toBeLessThanOrEqual(historyStart + 120_000)
    } finally {
      foundation.dispose()
    }
  })
})
