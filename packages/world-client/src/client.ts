import type { Disposable } from '@twin/world'
import type { DataSource } from './source'
import type {
  DataEnvelope,
  DataQuery,
  DataSubscription,
  EnvelopeHandler,
  SubscribeOptions,
  WorldMode
} from './types'

export interface WorldClientOptions {
  /** One source per world mode; all three may be provided. */
  sources: readonly DataSource[]
  /** Default staleness window for subscriptions without an explicit option. */
  defaultStaleAfterMs?: number
  /** Sweeper interval for staleness checks; 0 disables. */
  sweepIntervalMs?: number
  /**
   * 世界时钟注入（I10-2）：staleness/清扫按该时钟判定。默认 Date.now；
   * foundation 传世界时钟后，HISTORY/SIMULATION 模式的回放数据按虚拟时间
   * 判定陈旧，不会误报。
   */
  now?: () => number
}

export interface DataApi {
  query(query: DataQuery): Promise<readonly DataEnvelope[]>
  subscribe(
    query: DataQuery,
    cb: EnvelopeHandler,
    options?: SubscribeOptions
  ): DataSubscription
  /** Cached latest envelope for a contract/key, if any. */
  peek(contract: DataContractIdString, key: string): DataEnvelope | undefined
  /** Current world mode routing. */
  readonly mode: WorldMode
  setMode(mode: WorldMode): void
  dispose(): void
}

type DataContractIdString = string

interface ActiveSubscription {
  query: DataQuery
  handlers: Set<EnvelopeHandler>
  staleAfterMs: number
  sourceDisposables: Map<WorldMode, Disposable>
  /**
   * 按订阅记录的已投递 revision（key → revision）。去重是**每订阅**语义：
   * 同一契约的多个订阅者必须各自收到全部新信封，全局缓存去重会吞掉
   * 第二个订阅者的投递（I7 修复的多订阅缺陷）。
   */
  delivered: Map<string, number>
}

/**
 * WorldClient: Query / Snapshot / Delta / Subscription / State cache with
 * mode routing and revision dedup (§34, §36). Scenes never see transports.
 */
export class WorldClient implements DataApi {
  private _mode: WorldMode = 'live'
  private readonly sources = new Map<WorldMode, DataSource>()
  private readonly cache = new Map<DataContractIdString, Map<string, DataEnvelope>>()
  private readonly active = new Set<ActiveSubscription>()
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  private readonly now: () => number

  constructor(private readonly options: WorldClientOptions) {
    this.now = options.now ?? (() => Date.now())
    for (const source of options.sources) {
      this.sources.set(source.kind, source)
    }
    const sweep = options.sweepIntervalMs ?? 30_000
    if (sweep > 0) {
      this.sweepTimer = setInterval(() => this.sweepStale(), sweep)
      // Never hold the process open just for the sweeper.
      this.sweepTimer.unref?.()
    }
  }

  get mode(): WorldMode {
    return this._mode
  }

  setMode(mode: WorldMode): void {
    if (mode === this._mode || this.disposed) return
    this._mode = mode
    // Re-route active subscriptions; replay a snapshot so consumers receive
    // an immediate delta for the new mode.
    for (const sub of this.active) {
      this.detachFromSources(sub)
      this.attachToSource(sub)
      void this.replaySnapshot(sub)
    }
  }

  async query(query: DataQuery): Promise<readonly DataEnvelope[]> {
    const source = this.sources.get(this._mode)
    if (!source) return []
    const envelopes = await source.snapshot(query)
    for (const e of envelopes) {
      if (this.matches(e, query)) this.putCache(e)
    }
    return envelopes
  }

  subscribe(
    query: DataQuery,
    cb: EnvelopeHandler,
    options?: SubscribeOptions
  ): DataSubscription {
    const sub: ActiveSubscription = {
      query,
      handlers: new Set([cb]),
      staleAfterMs: options?.staleAfterMs ?? this.options.defaultStaleAfterMs ?? Number.POSITIVE_INFINITY,
      sourceDisposables: new Map(),
      delivered: new Map()
    }
    this.active.add(sub)
    this.attachToSource(sub)
    void this.replaySnapshot(sub)

    let disposed = false
    return {
      query,
      dispose: () => {
        if (disposed) return
        disposed = true
        sub.handlers.delete(cb)
        if (sub.handlers.size === 0) {
          this.detachFromSources(sub)
          this.active.delete(sub)
        }
      }
    }
  }

  peek(contract: DataContractIdString, key: string): DataEnvelope | undefined {
    return this.cache.get(contract)?.get(key)
  }

  /**
   * 全局实体搜索（B2）：在缓存键中做大小写不敏感子串匹配。
   * 只搜键（Foundation 不理解 payload 语义，§33）。
   */
  search(term: string, limit = 8): Array<{ contract: DataContractIdString; key: string }> {
    const q = term.trim().toLowerCase()
    if (!q) return []
    const out: Array<{ contract: DataContractIdString; key: string }> = []
    for (const [contract, byKey] of this.cache) {
      for (const key of byKey.keys()) {
        if (key.toLowerCase().includes(q)) {
          out.push({ contract, key })
          if (out.length >= limit) return out
        }
      }
    }
    return out
  }

  /** 缓存中质量为 stale 的信封数量（I3-3：降级可见）。 */
  countStale(): number {
    let count = 0
    for (const byKey of this.cache.values()) {
      for (const envelope of byKey.values()) {
        if (envelope.quality === 'stale') count++
      }
    }
    return count
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    for (const sub of this.active) this.detachFromSources(sub)
    this.active.clear()
    this.cache.clear()
    for (const source of this.sources.values()) source.dispose()
  }

  private attachToSource(sub: ActiveSubscription): void {
    const source = this.sources.get(this._mode)
    if (!source) return
    const forward: EnvelopeHandler = (e) => {
      const effective = this.ingest(e, sub)
      if (effective) {
        for (const handler of sub.handlers) handler(effective)
      }
    }
    sub.sourceDisposables.set(this._mode, source.subscribe(sub.query, forward))
  }

  private detachFromSources(sub: ActiveSubscription): void {
    for (const d of sub.sourceDisposables.values()) d.dispose()
    sub.sourceDisposables.clear()
  }

  private async replaySnapshot(sub: ActiveSubscription): Promise<void> {
    const source = this.sources.get(this._mode)
    if (!source) return
    try {
      const envelopes = await source.snapshot(sub.query)
      if (this.disposed) return
      for (const e of envelopes) {
        const effective = this.ingest(e, sub)
        if (effective) {
          for (const handler of sub.handlers) handler(effective)
        }
      }
    } catch {
      // Snapshot failures are non-fatal; the live stream will catch up.
    }
  }

  /**
   * Cache write + per-subscription dedup + staleness evaluation.
   * Returns the envelope to deliver to THIS subscription, or undefined when
   * it is a duplicate the subscriber has already seen.
   */
  private ingest(e: DataEnvelope, sub: ActiveSubscription): DataEnvelope | undefined {
    if (!this.matches(e, sub.query)) return undefined
    const last = sub.delivered.get(e.key)
    if (
      last !== undefined &&
      e.revision !== undefined &&
      e.revision <= last
    ) {
      return undefined
    }
    if (e.revision !== undefined) sub.delivered.set(e.key, e.revision)
    const effective =
      sub.staleAfterMs !== Number.POSITIVE_INFINITY &&
      e.sourceTime + sub.staleAfterMs < this.now() &&
      e.quality === 'good'
        ? { ...e, quality: 'stale' as const }
        : e
    this.putCache(effective)
    return effective
  }

  private matches(e: DataEnvelope, q: DataQuery): boolean {
    if (e.contract !== q.contract) return false
    if (q.keys && !q.keys.includes(e.key)) return false
    return true
  }

  /** Cache write for query results (no subscription staleness window). */
  private putCache(e: DataEnvelope): void {
    let byKey = this.cache.get(e.contract)
    if (!byKey) {
      byKey = new Map()
      this.cache.set(e.contract, byKey)
    }
    byKey.set(e.key, e)
  }

  private sweepStale(): void {
    const now = this.now()
    const window = this.options.defaultStaleAfterMs ?? 60_000
    for (const byKey of this.cache.values()) {
      for (const [key, e] of byKey) {
        if (e.quality === 'good' && now - e.sourceTime > window) {
          byKey.set(key, { ...e, quality: 'stale' })
        }
      }
    }
  }
}
