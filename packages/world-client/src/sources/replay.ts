import type { DataSource } from '../source'
import type { DataEnvelope, DataQuery } from '../types'

export interface ReplayFrame {
  readonly timeMs: number
  readonly envelopes: readonly DataEnvelope[]
}

export interface ReplaySourceOptions {
  frames: readonly ReplayFrame[]
  loop?: boolean
}

export interface ReplaySource extends DataSource {
  /**
   * Move the replay cursor to `timeMs` and emit the latest frame at or
   * before that time (dedup happens in WorldClient via revisions).
   */
  seek(timeMs: number): void
  readonly range: { start: number; end: number }
}

/** History source: replays recorded frames driven by the world clock. */
export function createReplaySource(options: ReplaySourceOptions): ReplaySource {
  const sorted = [...options.frames].sort((a, b) => a.timeMs - b.timeMs)
  const subscriptions = new Set<{ query: DataQuery; cb: (e: DataEnvelope) => void }>()
  let lastEmittedFrameIndex = -1

  function matches(e: DataEnvelope, q: DataQuery): boolean {
    if (e.contract !== q.contract) return false
    if (q.keys && !q.keys.includes(e.key)) return false
    return true
  }

  function emitFrame(index: number): void {
    const frame = sorted[index]
    if (!frame) return
    lastEmittedFrameIndex = index
    for (const { query, cb } of subscriptions) {
      for (const e of frame.envelopes) {
        if (matches(e, query)) cb(e)
      }
    }
  }

  const source: ReplaySource = {
    kind: 'history',
    get range() {
      return {
        start: sorted.length > 0 ? sorted[0].timeMs : 0,
        end: sorted.length > 0 ? sorted[sorted.length - 1].timeMs : 0
      }
    },
    async snapshot(query) {
      // Before the first seek there is no cursor: deliver nothing rather
      // than jumping to the last frame.
      if (lastEmittedFrameIndex === -1) return []
      const frame = sorted[lastEmittedFrameIndex]
      if (!frame) return []
      return frame.envelopes.filter((e) => matches(e, query))
    },
    subscribe(query, cb) {
      const sub = { query, cb }
      subscriptions.add(sub)
      return {
        dispose: () => {
          subscriptions.delete(sub)
        }
      }
    },
    seek(timeMs) {
      if (sorted.length === 0) return
      let index = -1
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].timeMs <= timeMs) index = i
        else break
      }
      if (index === -1) {
        if (options.loop) index = sorted.length - 1
        else return
      }
      if (index !== lastEmittedFrameIndex) emitFrame(index)
    },
    dispose() {
      subscriptions.clear()
    }
  }
  return source
}
