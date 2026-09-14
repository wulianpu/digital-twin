
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
