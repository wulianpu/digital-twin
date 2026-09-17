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
  const subscriptions = new Map<
    string,
    { query: DataQuery; handlers: Set<(e: DataEnvelope) => void> }
  >()
  const stateListeners = new Set<(state: GatewayConnectionState) => void>()
  const errorListeners = new Set<(frame: GatewayErrorFrame) => void>()
  let socket: WebSocketLike | undefined
  let attempt = 0
  let closed = false
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

  function queryKey(query: DataQuery): string {
    // contract + 稳定编码的 scope + 排序去重后的 keys（§5：协议语义等价）
    const keys = query.keys ? [...query.keys].sort() : undefined
    const scope = query.scope
      ? JSON.stringify(query.scope, Object.keys(query.scope).sort())
      : ''
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
      for (const { query } of subscriptions.values()) {
        s.send(JSON.stringify({ type: 'subscribe', query }))
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
      if (parsed && (parsed as { type?: string }).type === 'pong') {
        lastPongAt = Date.now()
        return
      }
      if (parsed && (parsed as { type?: string }).type === 'error') {
        for (const cb of [...errorListeners]) cb(parsed as GatewayErrorFrame)
        return
      }
      const envelopes = Array.isArray(parsed) ? parsed : [parsed]
      // 逐订阅/逐 handler 隔离：单个 subscriber throw 不击穿 emitter，
      // 也不阻断同 batch 后续 envelope（DataSource 独立使用时契约仍安全）。
      for (const e of envelopes as DataEnvelope[]) {
        for (const { query, handlers } of subscriptions.values()) {
          if (e.contract !== query.contract) continue
          if (query.keys && !query.keys.includes(e.key)) continue
          for (const cb of [...handlers]) {
            console.log('[TRACE ws] dispatch to handler, contract match:', e.contract === query.contract)
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
      stateListeners.add(cb)
      return {
        dispose: () => {
          stateListeners.delete(cb)
        }
      }
    },
    onError(cb): Disposable {
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
    subscribe(query, cb) {
      // Issue #24：query 语义 identity——协议语义等价的 query 合并；
      // dispose 只在最后一个语义等价 consumer 释放时发送 unsubscribe
      const key = queryKey(query)
      let entry = subscriptions.get(key)
      const isNew = entry === undefined
      if (!entry) {
        entry = { query, handlers: new Set() }
        subscriptions.set(key, entry)
      }
      entry.handlers.add(cb)
      if (isNew && socket && state === 'open') {
        socket.send(JSON.stringify({ type: 'subscribe', query }))
      }

      return {
        dispose: () => {
          const current = subscriptions.get(key)
          if (!current) return
          current.handlers.delete(cb)
          if (current.handlers.size > 0) return // 仍有活跃 consumer
          subscriptions.delete(key)
          socket?.send(JSON.stringify({ type: 'unsubscribe', query: current.query }))
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
      source.close()
    }
  }

  connect()
  return source
}

export type { Disposable }
