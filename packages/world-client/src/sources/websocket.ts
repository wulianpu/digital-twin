import type { Disposable } from '@twin/world'
import type { DataSource } from '../source'
import type { DataEnvelope, DataQuery } from '../types'

export interface WebSocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev?: unknown) => void) | null
  onclose: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev?: unknown) => void) | null
}

export type SocketFactory = (url: string) => WebSocketLike

export interface WebSocketSourceOptions {
  url: string
  kind?: 'live'
  socketFactory?: SocketFactory
  /** Base reconnect backoff; doubles up to maxBackoffMs. */
  backoffMs?: number
  maxBackoffMs?: number
  /**
   * 心跳间隔毫秒；0 关闭（协议 docs/gateway-protocol.md §6）。
   * 超过 2 个周期未收到 pong 即判定假死并主动重连。默认 30000。
   */
  heartbeatMs?: number
}

export type GatewayConnectionState = 'connecting' | 'open' | 'closed'

export interface GatewayErrorFrame {
  type: 'error'
  code?: string
  message?: string
  query?: unknown
}

export interface WebSocketSource extends DataSource {
  close(): void
  readonly connectionState: GatewayConnectionState
  onStateChange(cb: (state: GatewayConnectionState) => void): Disposable
  /** 服务端 error 帧（连接保持）；协议层错误经此上报。 */
  onError(cb: (frame: GatewayErrorFrame) => void): Disposable
}

/**
 * Platform Gateway transport (§34, §81; 协议见 docs/gateway-protocol.md):
 * client sends `{ type: 'subscribe' | 'unsubscribe' | 'ping' }`,
 * server pushes DataEnvelope(s) / pong / error as JSON.
 * Reconnects with exponential backoff, re-issues subscriptions on reopen,
 * and detects dead connections via the pong heartbeat.
 */
export function createWebSocketSource(options: WebSocketSourceOptions): WebSocketSource {
  const kind = options.kind ?? 'live'
  const backoffMs = options.backoffMs ?? 500
  const maxBackoffMs = options.maxBackoffMs ?? 15_000
  const heartbeatMs = options.heartbeatMs ?? 30_000
  // Issue #24：query 语义 identity（canonical key）——
  // 协议语义等价的 query 合并为一个 transport 订阅；
  // 引用计数只在 0→1（发 subscribe）与 1→0（发 unsubscribe）时跨网络。
  interface SubscriptionEntry {
    query: DataQuery
    handlers: Set<(e: DataEnvelope) => void>
    subscriptionId: string
  }
  const subscriptions = new Map<string, SubscriptionEntry>()
  /** subscriptionId → entry（attributed data 帧归属，Issue #24-r3-A）。 */
  const bySubscriptionId = new Map<string, SubscriptionEntry>()
  const stateListeners = new Set<(state: GatewayConnectionState) => void>()
  const errorListeners = new Set<(frame: GatewayErrorFrame) => void>()
  let socket: WebSocketLike | undefined
  let attempt = 0
  let closed = false
  let disposed = false // Issue #26-B：terminal state
  let state: GatewayConnectionState = 'closed'
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let lastPongAt = 0

  const factory: SocketFactory =
    options.socketFactory ??
    ((url) => {
      const WS = (globalThis as { WebSocket?: unknown }).WebSocket
      if (typeof WS !== 'function') {
        throw new Error('[world-client] WebSocket unavailable in this environment')
      }
      return new (WS as new (url: string) => WebSocketLike)(url)
    })

  // Issue #24-r2：递归稳定序列化——嵌套对象（如 entity scope）按键排序
  // 展开，不同语义的 scope 不可能碰撞。
  function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(',')}]`
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }

  // Issue #24-r3-C：normalizeQuery——canonical key、transport subscribe 帧
  // 与 correlation 全部来自同一归一化结果（keys 集合语义：去重 + 排序）。
  function normalizeQuery(query: DataQuery): DataQuery {
    const keys = query.keys ? [...new Set(query.keys)].sort() : undefined
    return keys
      ? { contract: query.contract, scope: query.scope, keys }
      : { contract: query.contract, scope: query.scope }
  }

  let correlationSeq = 0

  function queryKey(query: DataQuery): string {
    // contract + 稳定编码的 scope + 排序去重后的 keys（§5：协议语义等价）
    const keys = query.keys ? [...query.keys].sort() : undefined
    const scope = query.scope ? stableStringify(query.scope) : ''
    return `${query.contract}|${scope}|${keys ? JSON.stringify(keys) : ''}`
  }

  function setState(next: GatewayConnectionState): void {
    if (state === next) return
    state = next
    for (const cb of [...stateListeners]) cb(state)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  function startHeartbeat(s: WebSocketLike): void {
    if (heartbeatMs <= 0) return
    lastPongAt = Date.now()
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastPongAt > heartbeatMs * 2) {
        // 假死连接：主动断开，走 onclose → 重连退避。
        s.close()
        return
      }
      s.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
    }, heartbeatMs)
    heartbeatTimer.unref?.()
  }

  function connect(): void {
    if (closed) return
    setState('connecting')
    let s: WebSocketLike
    try {
      s = factory(options.url)
    } catch {
      scheduleReconnect()
      return
    }
    socket = s
    s.onopen = () => {
      attempt = 0
      setState('open')
      for (const { query, subscriptionId } of subscriptions.values()) {
        s.send(JSON.stringify({ type: 'subscribe', subscriptionId, query }))
      }
      startHeartbeat(s)
    }
    s.onmessage = (ev) => {
      // Issue #19：parse/protocol 边界与 subscriber dispatch 必须分离——
      // 业务 handler throw 不是 malformed frame，不得静默吞掉整批数据。
      let parsed: unknown
      try {
        parsed = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data
      } catch {
        return // Malformed frame: drop, keep the connection.
      }
      console.log('[TRACE onmessage] parsed type:', (parsed as { type?: string }).type, 'keys:', Object.keys((parsed ?? {}) as object))
      if (parsed && (parsed as { type?: string }).type === 'pong') {
        lastPongAt = Date.now()
        return
      }
      if (parsed && (parsed as { type?: string }).type === 'error') {
        for (const cb of [...errorListeners]) cb(parsed as GatewayErrorFrame)
        return
      }
      // Issue #24-r3：data plane 按 correlation 投递——
      // attributed 帧（{type:'data', subscriptionId, envelopes}）只投递给该
      // canonical entry；legacy 裸 envelope 帧只投递给 **非 scoped** 订阅
      //（scoped 订阅的服务端数据必须经 correlation 归属，防止跨 scope 静默错投）。
      const frame = parsed as {
        type?: string
        subscriptionId?: string
        envelopes?: DataEnvelope[]
      }
      const envelopes: DataEnvelope[] = Array.isArray(parsed)
        ? (parsed as DataEnvelope[])
        : Array.isArray(frame.envelopes)
          ? frame.envelopes
          : [frame as unknown as DataEnvelope]
      const attributed =
        !Array.isArray(parsed) && frame.subscriptionId !== undefined
      const scoped = (q: DataQuery): boolean =>
        q.scope !== undefined && q.scope.kind !== 'global'

      if (attributed) {
        const id = frame.subscriptionId as string
        const entry = bySubscriptionId.get(id)
        if (!entry) return
        for (const e of envelopes) {
          if (e.contract !== entry.query.contract) continue
          if (entry.query.keys && !entry.query.keys.includes(e.key)) continue
          for (const cb of [...entry.handlers]) {
            try {
              cb(e)
            } catch (error) {
              console.error('[world-client] ws subscriber failed; isolated', error)
            }
          }
        }
        return
      }

      // legacy 裸 envelope 帧：只投递给非 scoped 订阅
      for (const e of envelopes) {
        for (const { query, handlers } of subscriptions.values()) {
          if (scoped(query)) continue
          if (e.contract !== query.contract) continue
          if (query.keys && !query.keys.includes(e.key)) continue
          for (const cb of [...handlers]) {
            try {
              cb(e)
            } catch (error) {
              console.error('[world-client] ws subscriber failed; isolated', error)
            }
          }
        }
      }
    }
    s.onclose = () => {
      if (socket === s) socket = undefined
      stopHeartbeat()
      scheduleReconnect()
    }
    s.onerror = () => {
      /* onclose follows */
    }
  }

  function scheduleReconnect(): void {
    if (closed) return
    setState('closed')
    const delay = Math.min(backoffMs * 2 ** attempt, maxBackoffMs)
    attempt++
    setTimeout(connect, delay).unref?.()
  }

  const source: WebSocketSource = {
    kind,
    get connectionState() {
      return state
    },
    onStateChange(cb): Disposable {
      if (disposed) throw new Error('[world-client] source disposed (onStateChange rejected)')
      stateListeners.add(cb)
      return {
        dispose: () => {
          stateListeners.delete(cb)
        }
      }
    },
    onError(cb): Disposable {
      if (disposed) throw new Error('[world-client] source disposed (onError rejected)')
      errorListeners.add(cb)
      return {
        dispose: () => {
          errorListeners.delete(cb)
        }
      }
    },
    async snapshot() {
      // The gateway is push-based; clients bootstrap from subscriptions
      // (server replays a snapshot after each subscribe, §5 of the protocol).
      return []
    },
    subscribe(q, cb) {
      if (closed || disposed) {
        throw new Error('[world-client] source disposed (subscribe rejected)')
      }
      const query = q
      // Issue #24-C：canonical key、transport subscribe 帧与 correlation
      // 全部来自同一 normalizeQuery 结果（keys 集合语义：去重 + 排序）
      const normalized = normalizeQuery(query)
      const key = queryKey(normalized)
      let entry = subscriptions.get(key)
      const isNew = entry === undefined
      if (!entry) {
        entry = {
          query: normalized,
          handlers: new Set(),
          subscriptionId: `q-${++correlationSeq}`
        }
        subscriptions.set(key, entry)
      }
      entry.handlers.add(cb)
      bySubscriptionId.set(entry.subscriptionId, entry)
      // Issue #24-r3-A：携带 connection-local correlation id
      if (isNew && socket && state === 'open') {
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            subscriptionId: entry.subscriptionId,
            query: normalized
          })
        )
      }

      return {
        dispose: () => {
          const current = subscriptions.get(key)
          if (!current) return
          current.handlers.delete(cb)
          if (current.handlers.size > 0) return // 仍有活跃 consumer
          subscriptions.delete(key)
          bySubscriptionId.delete(current.subscriptionId)
          socket?.send(
            JSON.stringify({
              type: 'unsubscribe',
              subscriptionId: current.subscriptionId,
              query: current.query
            })
          )
        }
      }
    },
    close() {
      closed = true
      stopHeartbeat()
      setState('closed')
      socket?.close()
      socket = undefined
      subscriptions.clear()
      stateListeners.clear()
      errorListeners.clear()
    },
    dispose() {
      if (disposed) return // 幂等
      disposed = true
      source.close()
    }
  }

  connect()
  return source
}

export type { Disposable }
