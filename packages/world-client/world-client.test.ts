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
