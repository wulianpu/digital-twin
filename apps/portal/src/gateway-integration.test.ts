import { describe, expect, it } from 'vitest'
import { AGV_CONTRACT, decodeAgv } from '@twin/domain-agv'
import { loadPortalConfig } from './config'
import { buildFoundation } from './foundation'

/**
 * Issue #21：生产 source replacement 集成回归——
 * 配置 VITE_GATEWAY_WS_URL 后（WorldClient live source = WebSocket），
 * DEMO timer 的 gateway.tick('live') 不得再改变 live Fast Path truth。
 */

type FakeWS = {
  sent: string[]
  dispatchMessage: (data: unknown) => void
  close: () => void
}

function installFakeWebSocket(): { sockets: FakeWS[]; restore: () => void } {
  const sockets: FakeWS[] = []
  class FakeWS {
    sent: string[] = []
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((e: { data: unknown }) => void) | null = null
    constructor(_url: string) {
      sockets.push(this)
      // 连接建立（微任务，等 foundation 同步装配完成）
      queueMicrotask(() => this.onopen?.())
    }
    send(data: string) {
      this.sent.push(data)
    }
    close() {}
    dispatchMessage(data: unknown) {
      this.onmessage?.({ data })
    }
  }
  ;(globalThis as Record<string, unknown>).WebSocket = FakeWS
  return {
    sockets,
    restore: () => {
      delete (globalThis as Record<string, unknown>).WebSocket
    }
  }
}

function realAgvFrame(sourceTime: number): string {
  return JSON.stringify([
    {
      contract: AGV_CONTRACT,
      key: 'agv/AGV-01',
      sourceTime,
      ingestTime: sourceTime + 30,
      quality: 'good',
      revision: 1,
      payload: {
        xMeters: 10,
        yMeters: 20,
        headingDeg: 90,
        speedMs: 1.5,
        batteryPct: 88
      }
    }
  ])
}

describe('生产 Gateway 替换后的 Fast Path authority（Issue #21）', () => {
  it('配置 WS live source 后：真实 envelope 进入 buffer；DEMO tick 不再覆写', async () => {
    const fake = installFakeWebSocket()
    const foundation = buildFoundation({
      config: {
        ...loadPortalConfig({}),
        gatewayWsUrl: 'ws://gateway.test/live'
      }
    })
    try {
      // WorldClient 向 WS 发送 subscribe（证明 live source 已替换为 WS）
      await new Promise((r) => setTimeout(r, 20))
      const socket = fake.sockets.at(-1)
      expect(socket?.sent.length).toBeGreaterThan(0)

      // 真实 AGV envelope：sourceTime 落后浏览器墙钟（常见网络延迟）
      const sourceTime = Date.now() - 500
      socket!.dispatchMessage(realAgvFrame(sourceTime))
      await new Promise((r) => setTimeout(r, 20))

      const pose = (key: string) => {
        const env = foundation.data.peek(AGV_CONTRACT, key)
        if (!env) return undefined
        const s = decodeAgv(env)
        return s ? { x: s.xMeters, y: s.yMeters, sourceTime: env.sourceTime } : undefined
      }
      expect(pose('agv/AGV-01')).toMatchObject({ x: 10, y: 20, sourceTime })

      // DEMO tick：gateway.tick('live') 仍会运行（HISTORY/SIM fixture 依赖它），
      // 但 demo envelope 不再进入 WorldClient（live source 已替换），
      // 也不再直接改写 Fast Path truth
      foundation.tick()
      foundation.tick()
      await new Promise((r) => setTimeout(r, 20))

      expect(pose('agv/AGV-01')).toMatchObject({ x: 10, y: 20, sourceTime })
    } finally {
      fake.restore()
      foundation.dispose()
    }
  })
})
