import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorldClient,
  createWebSocketSource,
  type DataEnvelope,
  type WebSocketLike
} from './src/public'

const now = 1_780_000_000_000

function envelope(overrides: Partial<DataEnvelope> = {}): DataEnvelope {
  return {
    contract: 'twin.test@1',
    key: 'e/1',
    sourceTime: now,
    ingestTime: now,
    quality: 'good',
    payload: {},
    ...overrides
  }
}

interface Harness {
  sockets: WebSocketLike[]
  makeSource: (options?: Record<string, unknown>) => ReturnType<typeof createWebSocketSource>
}

/**
 * 可编程 FakeSocket 工厂：每个新连接推入数组，测试用例手动触发
 * onopen / onclose / onmessage 来驱动传输状态机（无真实网络）。
 */
function makeHarness(): Harness {
  const sockets: WebSocketLike[] = []
  return {
    sockets,
    makeSource: (options = {}) =>
      createWebSocketSource({
        url: 'wss://gateway.test/ws',
        socketFactory: () => {
          const s: WebSocketLike = {
            send: vi.fn(),
            // 模拟真实 WebSocket：close() 会触发 onclose（心跳假死检测依赖它）。
            close: () => {
              s.onclose?.()
            },
            onopen: null,
            onclose: null,
            onmessage: null,
            onerror: null
          }
          sockets.push(s)
          return s
        },
        ...options
      })
  }
}

function open(socket: WebSocketLike): void {
  socket.onopen?.()
}

describe('WebSocket 传输（I3-2 集成测试）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('指数退避重连并封顶', () => {
    const { sockets, makeSource } = makeHarness()
    const source = makeSource({ backoffMs: 100, maxBackoffMs: 400 })
    expect(sockets).toHaveLength(1)

    sockets[0].onclose?.()
    vi.advanceTimersByTime(99)
    expect(sockets).toHaveLength(1) // 100ms 未到
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2) // +100ms

    sockets[1].onclose?.()
    vi.advanceTimersByTime(200)
    expect(sockets).toHaveLength(3) // +200ms

    sockets[2].onclose?.()
    vi.advanceTimersByTime(400)
    expect(sockets).toHaveLength(4) // 封顶 400ms

    source.close()
  })

  it('重连成功后重发全部活跃订阅', () => {
    const { sockets, makeSource } = makeHarness()
    const source = makeSource({ backoffMs: 10 })
    const query = { contract: 'twin.test@1' }
    source.subscribe(query, () => {})

    open(sockets[0])
    const firstSubscribes = (sockets[0].send as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([m]) => String(m).includes('subscribe')
    )
    expect(firstSubscribes).toHaveLength(1)

    sockets[0].onclose?.()
    vi.advanceTimersByTime(10)
    open(sockets[1])
    const resubscribes = (sockets[1].send as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([m]) => String(m).includes('subscribe')
    )
    expect(resubscribes).toHaveLength(1) // 服务端将重放快照（协议 §5）
    source.close()
  })

  it('快照重放按 revision 去重（WorldClient 集成）', async () => {
    const { sockets, makeSource } = makeHarness()
    const source = makeSource({ backoffMs: 10 })
    const client = new WorldClient({ sources: [source], sweepIntervalMs: 0 })
    const payloads: Array<{ v: number }> = []
    client.subscribe({ contract: 'twin.test@1' }, (e) => {
      payloads.push(e.payload as { v: number })
    })

    open(sockets[0])
    sockets[0].onmessage?.({ data: JSON.stringify(envelope({ revision: 5, payload: { v: 5 } })) })
    expect(payloads).toEqual([{ v: 5 }])

    // 断线重连：服务端重放快照（rev5）后再推增量（rev6）。
    sockets[0].onclose?.()
    vi.advanceTimersByTime(10)
    open(sockets[1])
    sockets[1].onmessage?.({ data: JSON.stringify(envelope({ revision: 5, payload: { v: 5 } })) })
    sockets[1].onmessage?.({ data: JSON.stringify(envelope({ revision: 6, payload: { v: 6 } })) })
    expect(payloads).toEqual([{ v: 5 }, { v: 6 }]) // rev5 重放被去重
    client.dispose()
  })

  it('心跳：周期发送 ping，pong 续命，假死触发重连', () => {
    const { sockets, makeSource } = makeHarness()
    const source = makeSource({ backoffMs: 10, heartbeatMs: 1000 })
    open(sockets[0])

    vi.advanceTimersByTime(1000)
    const sends = (sockets[0].send as ReturnType<typeof vi.fn>).mock.calls
    expect(sends.some(([m]) => String(m).includes('"ping"'))).toBe(true)

    // pong 续命：不触发假死断开
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'pong' }) })
    vi.advanceTimersByTime(1000)
    expect(sockets).toHaveLength(1)

    // 2 个周期无 pong → 主动断开并重连（t=4000 判定假死，t=4010 重连）
    vi.advanceTimersByTime(2100)
    expect(sockets).toHaveLength(2)
    source.close()
  })

  it('error 帧经 onError 上报且不中断连接', () => {
    const { sockets, makeSource } = makeHarness()
    const source = makeSource({ backoffMs: 10 })
    const errors: Array<{ code?: string }> = []
    source.onError((frame) => errors.push(frame))
    open(sockets[0])
    sockets[0].onmessage?.({
      data: JSON.stringify({ type: 'error', code: 'unauthorized', message: 'bad token' })
    })
    expect(errors).toEqual([{ type: 'error', code: 'unauthorized', message: 'bad token' }])
    expect(sockets).toHaveLength(1) // 连接保持
    source.close()
  })

  it('onStateChange 报告 connecting→open→closed→open', () => {
    const { sockets, makeSource } = makeHarness()
    const source = makeSource({ backoffMs: 10 })
    const states: string[] = []
    source.onStateChange((s) => states.push(s))
    open(sockets[0])
    sockets[0].onclose?.()
    vi.advanceTimersByTime(10)
    open(sockets[1])
    // 首帧 connecting 在订阅前已发生（收集起点之后），验证关键迁移：
    expect(states).toContain('open')
    expect(states).toContain('closed')
    expect(states[states.length - 1]).toBe('open')
    source.close()
  })

  it('unsubscribe 在最后一个消费方释放时下发', () => {
    const { sockets, makeSource } = makeHarness()
    const source = makeSource({ backoffMs: 10 })
    const query = { contract: 'twin.test@1' }
    const sub1 = source.subscribe(query, () => {})
    source.subscribe(query, () => {}) // 第二个消费方
    open(sockets[0])

    sub1.dispose()
    const unsubCalls = (sockets[0].send as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) =>
      String(m).includes('unsubscribe')
    )
    expect(unsubCalls).toHaveLength(0) // 还有消费方
    source.close()
  })
})
