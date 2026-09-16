import type { DataSource } from '../source'
import type { DataEnvelope, DataQuery } from '../types'

export interface ReplayFrame {
  readonly timeMs: number
  readonly envelopes: readonly DataEnvelope[]
}

export interface ReplaySourceOptions {
  frames: readonly ReplayFrame[]
  loop?: boolean
  /**
   * Issue #11：seek 通知钩子——HISTORY/SIMULATION 的主动 seek/rewind 是
   * 排序权威，宿主（foundation）借此通知 WorldClient 开启新的 timeline
   * epoch（重置 revision 游标），使较低 revision 的历史帧能成为当前状态。
   */
  onSeek?: (timeMs: number) => void
}

export interface ReplaySource extends DataSource {
  /**
   * Move the replay cursor to `timeMs` and emit the latest frame at or
   * before that time (dedup happens in WorldClient via revisions; a seek
   * notifies `onSeek` so the timeline epoch resets and backward seek
   * delivers correctly — Issue #11).
   */
  seek(timeMs: number): void
  /** Register/replace the seek notification hook (used by foundation wiring). */
  setOnSeek(cb: (timeMs: number) => void): void
  readonly range: { start: number; end: number }
}

/** History source: replays recorded frames driven by the world clock. */
export function createReplaySource(options: ReplaySourceOptions): ReplaySource {
  const sorted = [...options.frames].sort((a, b) => a.timeMs - b.timeMs)
  const subscriptions = new Set<{ query: DataQuery; cb: (e: DataEnvelope) => void }>()
  let lastEmittedFrameIndex = -1
  let seekHook: ((timeMs: number) => void) | undefined = options.onSeek

  function matches(e: DataEnvelope, q: DataQuery): boolean {
    if (e.contract !== q.contract) return false
    if (q.keys && !q.keys.includes(e.key)) return false
    return true
  }

  function emitFrame(index: number): void {
    const frame = sorted[index]
    if (!frame) return
    // commit 先行：同位置重复 seek 是 no-op（可重入安全）——
    // 投递隔离（Issue #19）由下方逐订阅 try/catch 保证，
    // 因此该提交不会造成 partial/stuck state。
    lastEmittedFrameIndex = index
    for (const { query, cb } of subscriptions) {
      for (const e of frame.envelopes) {
        if (!matches(e, query)) continue
        try {
          cb(e)
        } catch (error) {
          console.error('[world-client] replay subscriber failed; isolated', error)
        }
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
      // Issue #11：即使 frame 未变化也通知 epoch——主动 seek/rewind 是排序权威
      seekHook?.(timeMs)
      if (index !== lastEmittedFrameIndex) emitFrame(index)
    },
    setOnSeek(cb) {
      seekHook = cb
    },
    dispose() {
      subscriptions.clear()
    }
  }
  return source
}
