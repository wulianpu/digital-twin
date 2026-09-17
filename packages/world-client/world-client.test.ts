import { describe, expect, it, vi } from 'vitest'
import {
  SpatialStateBuffer,
  WorldClient,
  createPoseSample,
  createReplaySource,
  createScriptedSource,
  createWebSocketSource,
  type DataEnvelope,
  type WebSocketLike
} from './src/public'

const now = 1_700_000_000_000

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

describe('WorldClient', () => {
  it('routes subscriptions to the live source and streams envelopes', async () => {
    const live = createScriptedSource({ kind: 'live' })
    const client = new WorldClient({ sources: [live], sweepIntervalMs: 0 })
    const cb = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cb)
    live.emit([envelope()])
    expect(cb).toHaveBeenCalledTimes(1)
    expect(client.peek('twin.test@1', 'e/1')?.key).toBe('e/1')
    client.dispose()
  })

  it('dedups stale revisions', () => {
    const live = createScriptedSource({ kind: 'live' })
    const client = new WorldClient({ sources: [live], sweepIntervalMs: 0 })
    const cb = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cb)
    live.emit([envelope({ revision: 5, payload: { v: 5 } })])
    live.emit([envelope({ revision: 4, payload: { v: 4 } })])
    expect(cb).toHaveBeenCalledTimes(1)
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ v: 5 })
    client.dispose()
  })

  it('marks old snapshots stale on delivery', () => {
    const live = createScriptedSource({ kind: 'live' })
    const client = new WorldClient({ sources: [live], sweepIntervalMs: 0 })
    const seen: string[] = []
    client.subscribe(
      { contract: 'twin.test@1' },
      (e) => seen.push(e.quality),
      { staleAfterMs: 1000 }
    )
    live.emit([envelope({ sourceTime: Date.now() - 60_000 })])
    expect(seen).toEqual(['stale'])
    client.dispose()
  })

  it('re-routes subscriptions and replays snapshots on mode switch', async () => {
    const live = createScriptedSource({ kind: 'live' })
    const sim = createScriptedSource({
      kind: 'simulation',
      initial: [envelope({ payload: { sim: true } })]
    })
    const client = new WorldClient({ sources: [live, sim], sweepIntervalMs: 0 })
    const cb = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cb)
    live.emit([envelope({ payload: { v: 'live' } })])
    expect(cb).toHaveBeenCalledTimes(1)
    client.setMode('simulation')
    await vi.waitFor(() => {
      expect(
        cb.mock.calls.some(([e]) => (e.payload as { sim?: boolean }).sim === true)
      ).toBe(true)
    })
    client.dispose()
  })

  it('query pulls a snapshot through the active source', async () => {
    const live = createScriptedSource({
      kind: 'live',
      initial: [envelope({ key: 'e/2' })]
    })
    const client = new WorldClient({ sources: [live], sweepIntervalMs: 0 })
    const out = await client.query({ contract: 'twin.test@1' })
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('e/2')
    client.dispose()
  })

  it('subscription dispose stops callbacks and detaches source subscription', () => {
    const live = createScriptedSource({ kind: 'live' })
    const client = new WorldClient({ sources: [live], sweepIntervalMs: 0 })
    const cb = vi.fn()
    const sub = client.subscribe({ contract: 'twin.test@1' }, cb)
    sub.dispose()
    sub.dispose() // idempotent
    live.emit([envelope()])
    expect(cb).not.toHaveBeenCalled()
    client.dispose()
  })

  it('staleness 按注入的世界时钟判定（I10-2）', () => {
    let fakeNow = 1_000_000
    const live = createScriptedSource({ kind: 'live' })
    const client = new WorldClient({
      sources: [live],
      sweepIntervalMs: 0,
      now: () => fakeNow
    })
    const seen: string[] = []
    client.subscribe(
      { contract: 'twin.test@1' },
      (e) => seen.push(e.quality),
      { staleAfterMs: 1000 }
    )
    // 数据时间 = 虚拟当前 → good
    live.emit([envelope({ sourceTime: fakeNow })])
    expect(seen).toEqual(['good'])
    // 虚拟时钟推进 2s（超过 1s 窗口）→ 同步刻的老数据判 stale
    fakeNow += 2_000
    live.emit([envelope({ key: 'e/9', sourceTime: fakeNow - 2_000 })])
    expect(seen).toEqual(['good', 'stale'])
    expect(client.countStale()).toBe(1)
    client.dispose()
  })

  it('countStale 统计降级信封（I3-3 降级可见）', () => {
    const live = createScriptedSource({ kind: 'live' })
    const client = new WorldClient({ sources: [live], sweepIntervalMs: 0 })
    client.subscribe({ contract: 'twin.test@1' }, () => {}, { staleAfterMs: 1000 })
    live.emit([
      envelope({ key: 'e/1', sourceTime: Date.now() }),
      envelope({ key: 'e/2', sourceTime: Date.now() - 60_000 })
    ])
    expect(client.countStale()).toBe(1)
    live.emit([envelope({ key: 'e/2', sourceTime: Date.now() })])
    expect(client.countStale()).toBe(0)
    client.dispose()
  })
})

describe('ReplaySource', () => {
  it('seeks to the latest frame at or before time', () => {
    const replay = createReplaySource({
      frames: [
        { timeMs: 100, envelopes: [envelope({ revision: 1, payload: { f: 1 } })] },
        { timeMs: 200, envelopes: [envelope({ revision: 2, payload: { f: 2 } })] },
        { timeMs: 300, envelopes: [envelope({ revision: 3, payload: { f: 3 } })] }
      ]
    })
    const client = new WorldClient({ sources: [replay], sweepIntervalMs: 0 })
    client.setMode('history') // replay sources deliver in history mode
    const seen: number[] = []
    client.subscribe({ contract: 'twin.test@1' }, (e) => {
      seen.push((e.payload as { f: number }).f)
    })
    replay.seek(250)
    expect(seen).toEqual([2])
    replay.seek(320)
    expect(seen).toEqual([2, 3])
    replay.seek(50)
    expect(seen).toEqual([2, 3])
    expect(replay.range.end).toBe(300)
    client.dispose()
  })
})

describe('ScriptedSource', () => {
  it('ticks generate() output to subscribers', async () => {
    const source = createScriptedSource({
      kind: 'simulation',
      generate: ({ index }) => [envelope({ key: `e/${index}` })]
    })
    const seen: string[] = []
    source.subscribe({ contract: 'twin.test@1' }, (e) => seen.push(e.key))
    source.tick(1234)
    source.tick(2345)
    expect(seen).toEqual(['e/1', 'e/2'])
    const snapshot = await source.snapshot({ contract: 'twin.test@1' })
    expect(snapshot).toHaveLength(2)
    source.dispose()
  })
})

describe('SpatialStateBuffer (fast path)', () => {
  it('upserts, drains dirty, and interpolates', () => {
    const buffer = new SpatialStateBuffer()
    buffer.upsert('agv/1', {
      x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, timeMs: 1000, frameId: 'site-a'
    })
    buffer.upsert('agv/1', {
      x: 10, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, timeMs: 2000, frameId: 'site-a'
    })
    expect(buffer.count).toBe(1)
    expect(buffer.dirtyCount).toBe(1)

    const sample = createPoseSample()
    expect(buffer.interpolate('agv/1', 1500, sample)).toBe(true)
    expect(sample.x).toBeCloseTo(5)
    expect(buffer.interpolate('agv/1', 999, sample)).toBe(true)
    expect(sample.x).toBeCloseTo(0)
    expect(buffer.interpolate('agv/1', 5000, sample)).toBe(true)
    expect(sample.x).toBeCloseTo(10)

    let drained = 0
    buffer.drainDirty(() => drained++)
    expect(drained).toBe(1)
    expect(buffer.dirtyCount).toBe(0)

    // Out-of-order writes are ignored.
    buffer.upsert('agv/1', {
      x: -99, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, timeMs: 500, frameId: 'site-a'
    })
    buffer.readLatest('agv/1', sample)
    expect(sample.x).toBeCloseTo(10)
  })

  it('grows beyond initial capacity', () => {
    const buffer = new SpatialStateBuffer(4)
    for (let i = 0; i < 50; i++) {
      buffer.upsert(`agv/${i}`, {
        x: i, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, timeMs: i, frameId: 'site-a'
      })
    }
    expect(buffer.count).toBe(50)
    const sample = createPoseSample()
    expect(buffer.readLatest('agv/49', sample)).toBe(true)
    expect(sample.x).toBe(49)
  })
})

describe('WebSocket source (transport contract)', () => {
  it('subscribes over the socket and dispatches envelopes', async () => {
    const sent: string[] = []
    const sockets: Array<{
      send: (data: string) => void
      close: () => void
      onopen: ((ev?: unknown) => void) | null
      onclose: ((ev?: unknown) => void) | null
      onmessage: ((ev: { data: unknown }) => void) | null
      onerror: ((ev?: unknown) => void) | null
    }> = []
    const source = createWebSocketSource({
      url: 'wss://gateway.test/ws',
      socketFactory: () => {
        const s: WebSocketLike = {
          send: (d: string) => sent.push(d),
          close: () => {},
          onopen: null,
          onclose: null,
          onmessage: null,
          onerror: null
        }
        sockets.push(s)
        queueMicrotask(() => s.onopen?.())
        return s
      }
    })
    const cb = vi.fn()
    source.subscribe({ contract: 'twin.test@1' }, cb)
    await vi.waitFor(() => expect(sent.some((m) => m.includes('subscribe'))).toBe(true))
    sockets[0].onmessage?.({ data: JSON.stringify(envelope()) })
    expect(cb).toHaveBeenCalledTimes(1)
    source.close()
  })
})

/** -------------------------- Issue #11：mode/timeline generation 隔离 */

describe('WorldClient mode/timeline isolation（Issue #11）', () => {
  function setup() {
    const live = createScriptedSource({ kind: 'live' })
    const history = createScriptedSource({ kind: 'history' })
    const simulation = createScriptedSource({ kind: 'simulation' })
    const client = new WorldClient({
      sources: [live, history, simulation],
      sweepIntervalMs: 0
    })
    return { live, history, simulation, client }
  }

  it('LIVE 高 revision 后切 HISTORY：较低历史 revision 必须投递并成为当前 truth', () => {
    const { live, history, client } = setup()
    const cb = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cb)
    live.emit([envelope({ revision: 1200, payload: { t: 'live' } })])
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 'live' })

    client.setMode('history')
    history.emit([envelope({ revision: 600, payload: { t: 'history-600' } })])

    expect(cb).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: { t: 'history-600' } })
    )
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 'history-600' })
    client.dispose()
  })

  it('HISTORY 内 backward seek：较低 revision 仍投递（timeline rewind 语义）', () => {
    const frames = [
      {
        timeMs: now,
        envelopes: [envelope({ revision: 50, payload: { t: 't1' } })]
      },
      {
        timeMs: now + 60_000,
        envelopes: [envelope({ revision: 80, payload: { t: 't2' } })]
      }
    ]
    const history = createReplaySource({ frames })
    const client = new WorldClient({ sources: [history], sweepIntervalMs: 0 })
    client.setMode('history')
    const cb = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cb)
    history.setOnSeek(() => client.beginTimelineEpoch('history'))

    history.seek(now + 60_000) // t2, rev=80
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 't2' })

    history.seek(now) // rewind → t1, rev=50（低 revision 必须覆盖）
    expect(cb).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: { t: 't1' } })
    )
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 't1' })
    client.dispose()
  })

  it('stale snapshot race：deferred snapshot 晚到不得写 cache / 触发 handler', async () => {
    let releaseHistory!: () => void
    const gate = new Promise<void>((r) => {
      releaseHistory = r
    })
    const history = createScriptedSource({ kind: 'history' })
    history.snapshot = () => gate.then(() => [
      envelope({ revision: 10, payload: { t: 'late-history' } })
    ])
    const simulation = createScriptedSource({ kind: 'simulation' })
    const client = new WorldClient({
      sources: [history, simulation],
      sweepIntervalMs: 0
    })
    const cb = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cb)

    client.setMode('history') // history snapshot pending
    const cbSim = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cbSim)
    simulation.emit([envelope({ revision: 900, payload: { t: 'sim' } })])
    // setMode('simulation') 会为新的 long-lived 订阅触发 simulation snapshot——
    // 为隔离竞态，直接校验：history snapshot 晚到后不得污染当前 simulation truth
    client.setMode('simulation')
    simulation.emit([envelope({ revision: 901, payload: { t: 'sim-901' } })])
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 'sim-901' })

    releaseHistory()
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    // 旧模式（history gen）的晚到 snapshot 被整批丢弃
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 'sim-901' })
    expect(cb).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: { t: 'late-history' } })
    )
    client.dispose()
  })

  it('rapid live → history → simulation：last-mode-wins，只有 simulation 可 commit', async () => {
    const histories: Array<Promise<readonly DataEnvelope[]>> = []
    const history = createScriptedSource({ kind: 'history' })
    history.snapshot = () => {
      const p = Promise.resolve<readonly DataEnvelope[]>([
        envelope({ revision: 5, payload: { t: 'history-snap' } })
      ])
      histories.push(p)
      return p
    }
    const live = createScriptedSource({ kind: 'live' })
    const simulation = createScriptedSource({ kind: 'simulation' })
    const client = new WorldClient({
      sources: [live, history, simulation],
      sweepIntervalMs: 0
    })
    const cb = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cb)

    client.setMode('history')
    client.setMode('simulation')
    simulation.emit([envelope({ revision: 900, payload: { t: 'sim' } })])
    await Promise.all(histories)
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    expect(client.mode).toBe('simulation')
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 'sim' })
    const historyDels = cb.mock.calls.filter(
      ([e]) => (e as DataEnvelope).payload && (e as DataEnvelope).payload !== null && (e as DataEnvelope & { payload: { t?: string } }).payload.t === 'history-snap'
    )
    expect(historyDels).toHaveLength(0)
    client.dispose()
  })

  it('switch back：LIVE 高 revision → HISTORY 旧 revision → LIVE 最新 revision 全程正确', () => {
    const { live, history, client } = setup()
    const cb = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cb)
    live.emit([envelope({ revision: 1200, payload: { t: 'live-1200' } })])
    client.setMode('history')
    history.emit([envelope({ revision: 300, payload: { t: 'history-300' } })])
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 'history-300' })

    client.setMode('live')
    // LIVE 游标与分区保留：重连旧快照 rev=1100 仍被去重，当前 truth 仍是
    // LIVE 最后已知状态（分区语义：各模式只暴露自己的 truth）
    live.emit([envelope({ revision: 1100, payload: { t: 'live-old-replay' } })])
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 'live-1200' })
    live.emit([envelope({ revision: 1300, payload: { t: 'live-1300' } })])
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 'live-1300' })
    expect(client.mode).toBe('live')
    client.dispose()
  })

  it('peek 不串模式：LIVE 写入的值在切 HISTORY 后不可见（缓存分区）', () => {
    const { live, history, client } = setup()
    const cb = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cb)
    live.emit([envelope({ payload: { t: 'live-only' } })])
    expect(client.peek('twin.test@1', 'e/1')).toBeDefined()

    client.setMode('history')
    expect(client.peek('twin.test@1', 'e/1')).toBeUndefined() // 分区隔离
    history.emit([envelope({ payload: { t: 'history-now' } })])
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 'history-now' })
    client.setMode('live')
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 'live-only' })
    client.dispose()
  })
})

/** ------------- Issue #11-r2：timeline epoch 作为异步 commit authority */

describe('timeline epoch commit authority（Issue #11-r2）', () => {
  function setupHistoryClient() {
    const history = createScriptedSource({ kind: 'history' })
    const client = new WorldClient({ sources: [history], sweepIntervalMs: 0 })
    client.setMode('history')
    return { history, client }
  }

  it('seek 前启动的 snapshot 晚到：不得把未来 t2 写回已 scrub 到的 t1', async () => {
    const { history, client } = setupHistoryClient()
    const cb = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, cb)

    // 旧 epoch：t2 的 snapshot 挂起（deferred）
    let releaseOld!: () => void
    const oldGate = new Promise<readonly DataEnvelope[]>((r) => {
      releaseOld = () => r([envelope({ revision: 80, payload: { t: 't2-future' } })])
    })
    history.snapshot = () => oldGate

    // 用户 scrub 向后 → 新 epoch（t1, rev=50）
    client.beginTimelineEpoch('history')
    history.emit([envelope({ revision: 50, payload: { t: 't1-correct' } })])
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 't1-correct' })

    // 旧 epoch snapshot 晚到 → 必须整批丢弃，不得把 t2 写回
    releaseOld()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 't1-correct' })
    client.dispose()
  })

  it('cursor 重置后旧 epoch 高 revision 事件抢先到达：不得抢占游标吞掉新 epoch 低 revision', () => {
    const { history, client } = setupHistoryClient()
    const cb = vi.fn()
    const forwardSink: Array<(e: DataEnvelope) => void> = []
    history.subscribe = (_q, cb2) => {
      forwardSink.push(cb2)
      return { dispose: () => {} }
    }
    client.subscribe({ contract: 'twin.test@1' }, cb)
    client.beginTimelineEpoch('history') // epoch++（t1 新时间线）
    expect(forwardSink.length).toBeGreaterThan(0)

    // 旧 epoch 的迟到事件（seek 前已入队，rev=80）
    forwardSink[0]!(envelope({ revision: 80, payload: { t: 'old-epoch' } }))
    // 旧 epoch 事件被 forward guard 丢弃 → 游标未被抢占
    expect(client.peek('twin.test@1', 'e/1')).toBeUndefined()

    // 新 epoch 正确的低 revision t1（经新 epoch 的 forward 通道）不被吞掉
    forwardSink[1]!(envelope({ revision: 50, payload: { t: 't1-correct' } }))
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 't1-correct' })
    client.dispose()
  })

  it('query 晚到 resolve：seek 后旧查询不再污染当前 cache', async () => {
    const { history, client } = setupHistoryClient()
    client.subscribe({ contract: 'twin.test@1' }, () => {})

    let releaseQuery!: () => void
    const gate = new Promise<readonly DataEnvelope[]>((r) => {
      releaseQuery = () =>
        r([envelope({ revision: 80, payload: { t: 'query-t2' } })])
    })
    history.snapshot = () => gate
    const p = client.query({ contract: 'twin.test@1' }) // t2 时代发起

    // seek 回 t1（epoch++）
    client.beginTimelineEpoch('history')
    history.emit([envelope({ revision: 50, payload: { t: 't1-correct' } })])
    releaseQuery()
    await p

    // 旧时间线的 query 结果不得污染当前 cache
    expect(client.peek('twin.test@1', 'e/1')?.payload).toEqual({ t: 't1-correct' })
    client.dispose()
  })
})

/** ---------------- Issue #19：subscriber fault boundary */

describe('WorldClient subscriber fault boundary（Issue #19）', () => {
  function setup(onSubscriberError?: (error: unknown, meta: {
    contract: string
    key: string
    mode: string
  }) => void) {
    const live = createScriptedSource({ kind: 'live' })
    const client = new WorldClient({
      sources: [live],
      sweepIntervalMs: 0,
      onSubscriberError
    })
    return { live, client }
  }

  it('坏 handler throw：健康订阅仍收到同一 envelope 与后续 batch', () => {
    const { live, client } = setup()
    const bad = vi.fn(() => {
      throw new Error('scene handler failed')
    })
    const healthy = vi.fn()
    const healthy2 = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, bad)
    client.subscribe({ contract: 'twin.test@1' }, healthy)
    client.subscribe({ contract: 'twin.test@1' }, healthy2)

    live.emit([
      envelope({ key: 'e/1', payload: { n: 1 } }),
      envelope({ key: 'e/2', payload: { n: 2 } }),
      envelope({ key: 'e/3', payload: { n: 3 } })
    ])

    // 健康订阅：三个 envelope 全部收到（bad 不截断 batch）
    expect(healthy).toHaveBeenCalledTimes(3)
    expect(healthy2).toHaveBeenCalledTimes(3)
    // cache/deliver 完整
    expect(client.peek('twin.test@1', 'e/3')?.payload).toEqual({ n: 3 })
    client.dispose()
  })

  it('限频：同一 handler 只在 ok→failing 转变时上报一次，成功后复位', () => {
    const onSubscriberError = vi.fn()
    const { live, client } = setup(onSubscriberError)
    let shouldThrow = true
    client.subscribe({ contract: 'twin.test@1' }, () => {
      if (shouldThrow) throw new Error('transient handler failure')
    })

    live.emit([envelope({ key: 'e/1' })])
    live.emit([envelope({ key: 'e/2' })])
    live.emit([envelope({ key: 'e/3' })])
    expect(onSubscriberError).toHaveBeenCalledTimes(1) // 只报一次（限频）

    shouldThrow = false
    live.emit([envelope({ key: 'e/4' })]) // 成功 → 复位
    live.emit([envelope({ key: 'e/5' })])
    live.emit([envelope({ key: 'e/6' })])
    shouldThrow = true
    live.emit([envelope({ key: 'e/7' })]) // 新一轮失败 → 再报一次
    expect(onSubscriberError).toHaveBeenCalledTimes(2)
    client.dispose()
  })

  it('sink meta 包含 contract/key/mode；缺省降级 console.error', () => {
    const onSubscriberError = vi.fn()
    const { live, client } = setup(onSubscriberError)
    client.subscribe({ contract: 'twin.test@1' }, () => {
      throw new Error('boom')
    })
    live.emit([envelope({ key: 'k/1' })])
    expect(onSubscriberError).toHaveBeenCalledWith(expect.any(Error), {
      contract: 'twin.test@1',
      key: 'k/1',
      mode: 'live'
    })
    client.dispose()

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client2 = setup().client
    client2.subscribe({ contract: 'twin.test@1' }, () => {
      throw new Error('boom')
    })
    const live2 = createScriptedSource({ kind: 'live' })
    void live2
    client2.dispose()
    errorSpy.mockRestore()
  })

  it('replaySnapshot：consumer throw 不截断 snapshot 后续 envelope，也不误吞 source failure', async () => {
    const history = createScriptedSource({ kind: 'history' })
    history.snapshot = async () => [
      envelope({ key: 'e/1', payload: { n: 1 } }),
      envelope({ key: 'e/2', payload: { n: 2 } }),
      envelope({ key: 'e/3', payload: { n: 3 } })
    ]
    const client = new WorldClient({ sources: [history], sweepIntervalMs: 0 })
    const bad = vi.fn((_e: DataEnvelope) => {
      throw new Error('consumer bug')
    })
    const healthy = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, bad)
    client.subscribe({ contract: 'twin.test@1' }, healthy)

    // setMode 触发 snapshot replay（#11 语义），consumer throw 不截断
    client.setMode('history')
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    // snapshot 三条全部 ingest/deliver（healthy 收到全部三条）
    expect(healthy).toHaveBeenCalledTimes(3)
    expect(client.peek('twin.test@1', 'e/3')?.payload).toEqual({ n: 3 })
    client.dispose()
  })

  it('WebSocket fake socket：subscriber throw 后 socket 继续处理下一帧', async () => {
    const sent: string[] = []
    const fakeSocket = {
      send: (d: string) => {
        sent.push(d)
      },
      close: () => {},
      onopen: null as ((e?: unknown) => void) | null,
      onclose: null as ((e?: unknown) => void) | null,
      onmessage: null as ((e: { data: unknown }) => void) | null,
      onerror: null as ((e?: unknown) => void) | null
    }
    const ws = createWebSocketSource({
      url: 'ws://gateway.test',
      socketFactory: () => fakeSocket as never,
      heartbeatMs: 0
    })
    const client = new WorldClient({ sources: [ws], sweepIntervalMs: 0 })
    const bad = vi.fn(() => {
      throw new Error('scene handler failed')
    })
    const healthy = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, bad)
    client.subscribe({ contract: 'twin.test@1' }, healthy)

    // 连接建立
    fakeSocket.onopen?.()
    // 帧 1：e1（bad handler 会 throw）、e2
    fakeSocket.onmessage?.({
      data: JSON.stringify([
        { contract: 'twin.test@1', key: 'e/1', sourceTime: 1, ingestTime: 1, quality: 'good', payload: { n: 1 } },
        { contract: 'twin.test@1', key: 'e/2', sourceTime: 2, ingestTime: 2, quality: 'good', payload: { n: 2 } }
      ])
    })
    // 帧 2：e3（socket 未断，继续处理）
    fakeSocket.onmessage?.({
      data: JSON.stringify([
        { contract: 'twin.test@1', key: 'e/3', sourceTime: 3, ingestTime: 3, quality: 'good', payload: { n: 3 } }
      ])
    })

    expect(healthy).toHaveBeenCalledTimes(3)
    expect(client.peek('twin.test@1', 'e/3')?.payload).toEqual({ n: 3 })
    // malformed frame 仍被安全丢弃（parse 与 dispatch 边界分离后语义不变）
    fakeSocket.onmessage?.({ data: 'not-json' })
    expect(healthy).toHaveBeenCalledTimes(3)
    client.dispose()
    ws.close()
  })

  it('ReplaySource：subscriber throw 不阻断其它订阅，重复 seek 同位置可完整重放', () => {
    const frames = [
      { timeMs: 1000, envelopes: [envelope({ revision: 10, payload: { t: 'a' } })] },
      { timeMs: 2000, envelopes: [envelope({ revision: 20, payload: { t: 'b' } })] }
    ]
    const history = createReplaySource({ frames })
    const client = new WorldClient({ sources: [history], sweepIntervalMs: 0 })
    client.setMode('history')
    const bad = vi.fn(() => {
      throw new Error('replay handler failed')
    })
    const healthy = vi.fn()
    client.subscribe({ contract: 'twin.test@1' }, bad)
    client.subscribe({ contract: 'twin.test@1' }, healthy)

    expect(() => history.seek(1000)).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
    expect(healthy.mock.calls[0]![0].payload).toEqual({ t: 'a' })
    expect(() => history.seek(2000)).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(2)
    client.dispose()
  })
})

/** -------- Issue #21-r2：SpatialStateBuffer timeline epoch */



describe('SpatialStateBuffer timeline epoch（Issue #21-r2）', () => {
  function pose(timeMs: number) {
    return { x: timeMs, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, timeMs, frameId: 'f' }
  }

  it('同 epoch 内防乱序：旧时间戳仍被拒绝', () => {
    const buffer = new SpatialStateBuffer()
    buffer.upsert('agv/1', pose(2000))
    buffer.upsert('agv/1', pose(1000)) // 乱序 → 丢弃
    const sample = createPoseSample()
    expect(buffer.readLatest('agv/1', sample)).toBe(true)
    expect(sample.timeMs).toBe(2000)
  })

  it('beginEpoch 后较低时间戳被接受（新 timeline 第一条 pose 无条件成为当前值）', () => {
    const buffer = new SpatialStateBuffer()
    buffer.upsert('agv/1', pose(2000)) // 旧 timeline
    buffer.beginEpoch() // 新 timeline epoch
    buffer.upsert('agv/1', pose(500)) // 较低时间戳 = 更早的正确世界状态
    const sample = createPoseSample()
    buffer.readLatest('agv/1', sample)
    expect(sample.timeMs).toBe(500)
  })

  it('epoch 内再次乱序仍被拒绝（保护不回退）', () => {
    const buffer = new SpatialStateBuffer()
    buffer.upsert('agv/1', pose(2000))
    buffer.beginEpoch()
    buffer.upsert('agv/1', pose(500)) // 新 epoch 第一条
    buffer.upsert('agv/1', pose(100)) // 同 epoch 乱序 → 仍拒绝
    const sample = createPoseSample()
    buffer.readLatest('agv/1', sample)
    expect(sample.timeMs).toBe(500)
  })

  it('未调用 beginEpoch 时行为不变（LIVE 单调保护保持）', () => {
    const buffer = new SpatialStateBuffer()
    buffer.upsert('agv/1', pose(2000))
    buffer.upsert('agv/1', pose(3000))
    buffer.upsert('agv/1', pose(2500))
    const sample = createPoseSample()
    buffer.readLatest('agv/1', sample)
    expect(sample.timeMs).toBe(3000)
  })
})

/** -------- Issue #24：WebSocketSource query 语义 identity */

describe('WebSocketSource query semantic identity（Issue #24）', () => {
  function makeTrackedSocket() {
    const sent: string[] = []
    const socket = {
      send: (d: string) => {
        sent.push(d)
      },
      close: () => {},
      onopen: null as (() => void) | null,
      onclose: null,
      onmessage: null,
      onerror: null
    }
    const ws = createWebSocketSource({
      url: 'ws://gateway.test',
      socketFactory: () => socket as never,
      heartbeatMs: 0
    })
    socket.onopen?.()
    const frames = () =>
      sent.map((f) => JSON.parse(f) as { type: string; query?: { contract: string } })
    return { ws, frames }
  }

  it('结构等价的 query 合并为一个 transport 订阅（一次 subscribe）', () => {
    const { ws, frames } = makeTrackedSocket()
    const q1 = { contract: 'twin.agv.state@1' }
    const q2 = { contract: 'twin.agv.state@1' } // 不同对象，语义等价

    const s1 = ws.subscribe(q1, () => {})
    ws.subscribe(q2, () => {})
    s1.dispose()

    const subs = frames().filter((f) => f.type === 'subscribe')
    const unsubs = frames().filter((f) => f.type === 'unsubscribe')
    // 语义等价 → 只发一次 subscribe；提前 unsubscribe 不触发（仍有活跃 consumer）
    expect(subs).toHaveLength(1)
    expect(unsubs).toHaveLength(0)
    ws.dispose()
  })

  it('最后一个语义等价 consumer 释放：恰好一次 unsubscribe', () => {
    const { ws, frames } = makeTrackedSocket()
    const q1 = { contract: 'twin.agv.state@1' }
    const q2 = { contract: 'twin.agv.state@1' }
    const s1 = ws.subscribe(q1, () => {})
    const s2 = ws.subscribe(q2, () => {})
    s1.dispose()
    s2.dispose()

    const unsubs = frames().filter((f) => f.type === 'unsubscribe')
    expect(unsubs).toHaveLength(1) // 最后一个 consumer 释放才发送
    ws.dispose()
  })

  it('keys 参与语义 identity：不同 keys 集合是不同订阅', () => {
    const { ws, frames } = makeTrackedSocket()
    ws.subscribe({ contract: 't.c@1', keys: ['b', 'a'] }, () => {})
    ws.subscribe({ contract: 't.c@1', keys: ['a', 'b'] }, () => {}) // 排序后等价 → 合并
    ws.subscribe({ contract: 't.c@1', keys: ['a'] }, () => {}) // 不同 keys → 独立订阅
    const subs = frames().filter((f) => f.type === 'subscribe')
    expect(subs).toHaveLength(2)
    ws.dispose()
  })
})

describe('query scope canonicalization（Issue #24-r2）', () => {
  function makeFramesSocket() {
    const sent: string[] = []
    const socket = {
      send: (d: string) => {
        sent.push(d)
      },
      close: () => {},
      onopen: null as (() => void) | null,
      onclose: null,
      onmessage: null,
      onerror: null
    }
    const ws = createWebSocketSource({
      url: 'ws://gateway.test',
      socketFactory: () => socket as never,
      heartbeatMs: 0
    })
    socket.onopen?.()
    const frames = () => sent.map((f) => JSON.parse(f) as { type: string })
    return { ws, frames }
  }

  it('嵌套 entity scope 不碰撞：不同 entity 是不同订阅', () => {
    const { ws, frames } = makeFramesSocket()
    const sA = ws.subscribe(
      { contract: 't.c@1', scope: { kind: 'entity', entity: { namespace: 'agv', id: 'A' } } },
      () => {}
    )
    ws.subscribe(
      { contract: 't.c@1', scope: { kind: 'entity', entity: { namespace: 'agv', id: 'B' } } },
      () => {}
    )
    let subs = frames().filter((f) => f.type === 'subscribe')
    expect(subs).toHaveLength(2) // 语义不同 → 独立订阅

    // 同 entity 的重复订阅 → 不重复发送（语义等价合并）
    ws.subscribe(
      { contract: 't.c@1', scope: { kind: 'entity', entity: { namespace: 'agv', id: 'A' } } },
      () => {}
    )
    subs = frames().filter((f) => f.type === 'subscribe')
    expect(subs).toHaveLength(2)

    // A 全部释放 → B 不受影响（无 unsubscribe）
    sA.dispose()
    sA.dispose()
    const unsubs = frames().filter((f) => f.type === 'unsubscribe')
    expect(unsubs).toHaveLength(0)
    ws.dispose()
  })

  it('site scope 同样参与语义 identity', () => {
    const { ws, frames } = makeFramesSocket()
    ws.subscribe({ contract: 't.c@1', scope: { kind: 'site', siteId: 's1' } }, () => {})
    ws.subscribe({ contract: 't.c@1', scope: { kind: 'site', siteId: 's2' } }, () => {})
    const subs = frames().filter((f) => f.type === 'subscribe')
    expect(subs).toHaveLength(2)
    ws.dispose()
  })
})

it('grow 扩容后同 epoch 防乱序保持（#21-r3 slotEpoch 扩容回归）', () => {
  const buffer = new SpatialStateBuffer(16) // 最小容量，触发多次 grow
  const p = (t: number) => ({
    x: t, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, timeMs: t, frameId: 'f'
  })
  for (let i = 0; i < 20; i++) {
    buffer.upsert(`agv/${i}`, p(2000 + i))
  }
  expect(buffer.count).toBe(20)
  // 扩容后同 epoch 乱序仍被拒绝
  buffer.upsert('agv/0', p(1000))
  const sample = createPoseSample()
  buffer.readLatest('agv/0', sample)
  expect(sample.timeMs).toBe(2000)
  // beginEpoch 后新 epoch 低时间戳接受
  buffer.beginEpoch()
  buffer.upsert('agv/0', p(500))
  buffer.readLatest('agv/0', sample)
  expect(sample.timeMs).toBe(500)
})

describe('data plane correlation（Issue #24-r3-A）', () => {
  function makeAttributedSocket() {
    const sent: string[] = []
    const socket = {
      send: (d: string) => {
        sent.push(d)
      },
      close: () => {},
      onopen: null as (() => void) | null,
      onclose: null as (() => void) | null,
      onmessage: null as ((e: { data: unknown }) => void) | null,
      onerror: null,
      dispatchMessage(data: unknown) {
        this.onmessage?.({ data })
      }
    }
    const ws = createWebSocketSource({
      url: 'ws://gateway.test',
      socketFactory: () => socket as never,
      heartbeatMs: 0
    })
    socket.onopen?.()
    const frames = () => sent.map((f) => JSON.parse(f))
    return { ws, socket, frames }
  }

  function agvAttributed(subscriptionId: string, key: string, x: number): string {
    return JSON.stringify({
      type: 'data',
      subscriptionId,
      envelopes: [
        {
          contract: 't.c@1',
          key,
          sourceTime: 1,
          ingestTime: 1,
          quality: 'good',
          payload: { xMeters: x, yMeters: 0, headingDeg: 0 }
        }
      ]
    })
  }

  it('attributed data 帧只投递给对应 subscription（scoped 订阅不收裸帧）', () => {
    const { ws, socket, frames } = makeAttributedSocket()
    const gotA: unknown[] = []
    const gotB: unknown[] = []
    const gotLegacy: unknown[] = []
    ws.subscribe(
      { contract: 't.c@1', scope: { kind: 'site', siteId: 'A' } },
      (e) => gotA.push(e)
    )
    ws.subscribe(
      { contract: 't.c@1', scope: { kind: 'site', siteId: 'B' } },
      (e) => gotB.push(e)
    )
    ws.subscribe({ contract: 't.c@1' }, (e) => gotLegacy.push(e))
    const subscribeFrames = frames().filter((f) => f.type === 'subscribe')
    expect(subscribeFrames).toHaveLength(3)

    // attributed 帧 → 只投递给该 subscriptionId 的 handlers
    const idA = subscribeFrames[0]!.subscriptionId as string
    socket.dispatchMessage(agvAttributed(idA, 'k/1', 42))
    expect(gotA).toHaveLength(1)
    expect(gotB).toHaveLength(0)
    expect(gotLegacy).toHaveLength(0)

    // legacy 裸 envelope 帧：只投递给非 scoped 订阅（scoped 不收裸帧）
    socket.dispatchMessage(
      JSON.stringify([
        {
          contract: 't.c@1',
          key: 'k/2',
          sourceTime: 2,
          ingestTime: 2,
          quality: 'good',
          payload: {}
        }
      ])
    )
    expect(gotA).toHaveLength(1)
    expect(gotLegacy).toHaveLength(1)
    ws.dispose()
  })
})
