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

  constructor(private readonly options: WorldClientOptions) {
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
      sourceDisposables: new Map()
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

  /** Cache write + staleness evaluation. Returns the envelope to deliver. */
  private ingest(e: DataEnvelope, sub: ActiveSubscription): DataEnvelope | undefined {
    if (!this.matches(e, sub.query)) return undefined
    const cached = this.cache.get(e.contract)?.get(e.key)
    if (
      cached &&
      cached.revision !== undefined &&
      e.revision !== undefined &&
      e.revision <= cached.revision
    ) {
      return undefined
    }
    const effective =
      sub.staleAfterMs !== Number.POSITIVE_INFINITY &&
      e.sourceTime + sub.staleAfterMs < Date.now() &&
      e.quality === 'good'
        ? { ...e, quality: 'stale' as const }
        : e
    let byKey = this.cache.get(e.contract)
    if (!byKey) {
      byKey = new Map()
      this.cache.set(e.contract, byKey)
    }
    byKey.set(e.key, effective)
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
    const now = Date.now()
    for (const byKey of this.cache.values()) {
      for (const [key, e] of byKey) {
        if (e.quality === 'good' && now - e.sourceTime > 60_000) {
          byKey.set(key, { ...e, quality: 'stale' })
        }
      }
    }
  }
}
