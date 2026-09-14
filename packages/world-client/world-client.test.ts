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
