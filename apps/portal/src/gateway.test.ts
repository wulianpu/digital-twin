import { describe, expect, it } from 'vitest'
import {
  AGV_CONTRACT
} from '@twin/domain-agv'
import { CRANE_CONTRACT } from '@twin/domain-crane'
import { STACK_CONTRACT } from '@twin/domain-logistics'
import {
  PRODUCTION_ALARM_CONTRACT,
  PRODUCTION_TASK_CONTRACT
} from '@twin/domain-production'
import { VESSEL_CONTRACT } from '@twin/domain-vessel'
import { createDemoGateway } from './gateway'

/**
 * I7 补强：演示网关契约覆盖——每次 tick 必须为全部演示契约产生信封，
 * AGV 位姿同步进入 Spatial Fast Path，历史环随 tick 增长。
 */

const ALL_CONTRACTS = [
  VESSEL_CONTRACT,
  CRANE_CONTRACT,
  AGV_CONTRACT,
  STACK_CONTRACT,
  PRODUCTION_TASK_CONTRACT,
  PRODUCTION_ALARM_CONTRACT
]

describe('演示网关（I7 补强）', () => {
  it('数轮 tick 覆盖全部演示契约（stack 为稀疏发射）', async () => {
    const gateway = createDemoGateway()
    const base = 1_780_000_000_000
    for (let t = 0; t < 40; t++) {
      gateway.tick('live', base + t * 1000)
    }

    for (const contract of ALL_CONTRACTS) {
      const envelopes = await gateway.live.snapshot({ contract })
      expect(envelopes.length, `contract ${contract} 应有数据`).toBeGreaterThan(0)
      for (const e of envelopes) {
        expect(e.quality).toBe('good')
        expect(e.revision).toBeGreaterThan(0)
      }
    }
    gateway.dispose()
  })

  it('tick 生成 AGV envelope（§35 fast-path 写入由 WorldClient adapter 负责）', async () => {
    // Issue #21：DemoGateway 只生成 DataEnvelope——SpatialStateBuffer 的
    // ownership 已上移到 Composition Root，gateway 不再直接写共享渲染 buffer。
    const gateway = createDemoGateway()
    gateway.tick('live', 1_780_000_000_000)
    const agv = await gateway.live.snapshot({ contract: AGV_CONTRACT })
    expect(agv.length).toBe(6) // 6 台演示 AGV
    for (const e of agv) expect(e.key).toMatch(/^agv\//)
    gateway.dispose()
  })

  it('历史环随 tick 增长并可构建回放源', async () => {
    const gateway = createDemoGateway()
    for (let t = 0; t < 10; t++) {
      gateway.tick('live', 1_780_000_000_000 + t * 1100) // 1.1s 间隔 → 每次都记帧
    }
    const history = gateway.buildHistorySource()
    expect(history.range.start).toBeGreaterThan(0)
    expect(history.range.end).toBeGreaterThan(history.range.start)

    // 仿真模式：tick 路由到仿真源而非 live 源
    gateway.tick('simulation', 5_000)
    const simEnvelopes = await gateway.simulation.snapshot({ contract: AGV_CONTRACT })
    expect(simEnvelopes.length).toBeGreaterThan(0)
    gateway.dispose()
  })

  it('tick 幂等增长 revision（去重语义的供给端）', async () => {
    const gateway = createDemoGateway()
    gateway.tick('live', 1_780_000_000_000)
    const first = await gateway.live.snapshot({ contract: AGV_CONTRACT })
    gateway.tick('live', 1_780_000_000_000 + 250)
    const second = await gateway.live.snapshot({ contract: AGV_CONTRACT })
    // snapshot 返回全缓冲：比较最新一条（缓冲按时间追加）
    expect(second.at(-1)!.revision!).toBeGreaterThan(first.at(-1)!.revision!)
    gateway.dispose()
  })
})
