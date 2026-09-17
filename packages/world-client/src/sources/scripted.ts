import type { Disposable } from '@twin/world'
import type { DataSource } from '../source'
import type { DataEnvelope, DataQuery } from '../types'

export interface ScriptedTickContext {
  /** Wall or virtual time in milliseconds. */
  timeMs: number
  /** Number of ticks since start. */
  index: number
}

export interface ScriptedSourceOptions {
  kind: 'live' | 'history' | 'simulation'
  /** Optional initial snapshot contents. */
  initial?: readonly DataEnvelope[]
  /** Called on every `emit()` / interval tick; returns fresh envelopes. */
  generate?: (ctx: ScriptedTickContext) => readonly DataEnvelope[]
}

export interface ScriptedSource extends DataSource {
  /** Push a batch immediately to all matching subscribers. */
  emit(envelopes: readonly DataEnvelope[]): void
  /** Start a timer that emits `generate()` output every `intervalMs`. */
  start(intervalMs: number): void
  stop(): void
  /** Manual tick (tests / custom drivers). */
  tick(timeMs?: number): void
  readonly tickCount: number
}

/**
 * In-process source used by demos, simulations and tests. Business-agnostic:
 * generators are supplied by apps / scenes.
 */
export function createScriptedSource(options: ScriptedSourceOptions): ScriptedSource {
  // Issue #26-B：terminal disposed state
  let disposed = false
  let buffer: DataEnvelope[] = [...(options.initial ?? [])]
  const subscriptions = new Set<{
    query: DataQuery
    cb: (e: DataEnvelope) => void
  }>()
  let timer: ReturnType<typeof setInterval> | undefined
  let tickIndex = 0

  function matches(e: DataEnvelope, q: DataQuery): boolean {
    if (e.contract !== q.contract) return false
    if (q.keys && !q.keys.includes(e.key)) return false
    return true
  }

  const source: ScriptedSource = {
    kind: options.kind,
    async snapshot(query) {
      return buffer.filter((e) => matches(e, query))
    },
    subscribe(query, cb) {
      if (disposed) throw new Error('[world-client] source disposed (subscribe rejected)')
      const sub = { query, cb }
      subscriptions.add(sub)
      return {
        dispose: () => {
          subscriptions.delete(sub)
        }
      }
    },
    emit(envelopes) {
      if (disposed) return // Issue #26-B：terminal 后不再投递/重建 buffer
      buffer = envelopes.length > 0 ? [...buffer, ...envelopes].slice(-4096) : buffer
      // Issue #19：逐订阅隔离——坏 subscriber 不得让后续健康订阅持续饥饿
      for (const { query, cb } of subscriptions) {
        for (const e of envelopes) {
          if (!matches(e, query)) continue
          try {
            cb(e)
          } catch (error) {
            console.error('[world-client] scripted subscriber failed; isolated', error)
          }
        }
      }
    },
    tick(timeMs) {
      if (disposed) return // Issue #26-B：terminal 后不再生成/投递
      tickIndex++
      if (!options.generate) return
      const out = options.generate({ timeMs: timeMs ?? Date.now(), index: tickIndex })
      source.emit(out)
    },
    start(intervalMs) {
      if (disposed) return // Issue #26-B：terminal 后不得重建 timer
      source.stop()
      timer = setInterval(() => source.tick(), intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    },
    get tickCount() {
      return tickIndex
    },
    dispose() {
      if (disposed) return // Issue #26-B：幂等
      disposed = true
      source.stop()
      subscriptions.clear()
      buffer = []
    }
  }
  return source
}

export type { Disposable }
