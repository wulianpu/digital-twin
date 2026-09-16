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
  /**
   * Issue #19：Scene-facing data handler 的 fault sink（Composition Root
   * 决定去向：console/telemetry/UI 诊断）。缺省降级 console.error。
   * 限频策略：同一 handler 的失败只在其 ok→failing 转变时上报一次，
   * 成功一次即复位——高频重复 throw 不会产生无界 error storm。
   */
  onSubscriberError?: (error: unknown, meta: {
    contract: string
    key: string
    mode: WorldMode
  }) => void
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
  /**
   * 开启一个新的时间线 epoch（Issue #11）：HISTORY/SIMULATION 的主动 seek /
   * rewind 是当前模式的排序权威——调用后该模式的 revision 游标与缓存被重置，
   * 较低的 revision 视为"用户选择的更早正确世界状态"而非网络旧包。
   * LIVE 的 transport 乱序去重不受影响。
   */
  beginTimelineEpoch(mode?: WorldMode): void
  dispose(): void
}

type DataContractIdString = string

interface ActiveSubscription {
  query: DataQuery
  handlers: Set<EnvelopeHandler>
  staleAfterMs: number
  sourceDisposables: Map<WorldMode, Disposable>
  /**
   * 按 {mode → key → revision} 分区的已投递游标（Issue #11）：
   * - 去重是**每订阅、每模式**语义：同一契约的多个订阅者必须各自收到全部
   *   新信封；不同 world mode 是不同时间线，revision 互不可比。
   * - LIVE：revision 是 transport ordering authority（重连旧快照仍被去重）。
   * - HISTORY/SIMULATION：timeline epoch 重置游标（beginTimelineEpoch），
   *   主动 rewind 后较低 revision 必须能成为当前状态。
   */
  delivered: Map<WorldMode, Map<string, number>>
}

/**
 * WorldClient: Query / Snapshot / Delta / Subscription / State cache with
 * mode routing and revision dedup (§34, §36). Scenes never see transports.
 *
 * Issue #11：revision 单调性只描述"同一 LIVE transport 内的乱序去重"；
 * world mode 切换与 HISTORY/SIM 时间线 rewind 由显式的
 * modeGeneration / timeline epoch 管理，三者不可混用同一游标。
 */
export class WorldClient implements DataApi {
  private readonly sources = new Map<WorldMode, DataSource>()
  private _mode: WorldMode = 'live'
  private modeGeneration = 0
  /**
   * #11-r2：timeline epoch 是**异步 commit authority**——每次
   * beginTimelineEpoch(mode) 递增；所有可能写当前 truth 的 async
   * continuation（replaySnapshot/query/source forward）必须校验
   * {mode, modeGeneration, timelineGeneration} 完整 identity。
   */
  private readonly timelineGeneration = new Map<WorldMode, number>()
  /** mode → (contract → key → envelope)：cache 按模式分区，互不串真值。 */
  private readonly cache = new Map<WorldMode, Map<DataContractIdString, Map<string, DataEnvelope>>>()
  private readonly active = new Set<ActiveSubscription>()
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  private readonly now: () => number
  /** Issue #19：handler → failing 状态（限频：只在 ok→failing 转变时上报）。 */
  private readonly failingHandlers = new WeakMap<
    (e: DataEnvelope) => void,
    true
  >()

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
    // #11-A：mode switch 产生新的 source generation。旧 generation 的异步
    // snapshot 晚到后必须整批丢弃（不写 cache / 游标 / handler）。
    this.modeGeneration++
    // #11-B/C：进入 HISTORY/SIMULATION = 新时间线——重置该模式的游标与缓存，
    // 防止上次访问遗留的旧时间线值被当作当前 truth。LIVE 是 transport
    // ordering authority：游标与缓存跨模式往返保留，重连旧快照仍被去重。
    if (mode !== 'live') this.resetModeState(mode)
    // Re-route active subscriptions; replay a snapshot so consumers receive
    // an immediate delta for the new mode.
    for (const sub of this.active) {
      this.detachFromSources(sub)
      this.attachToSource(sub)
      void this.replaySnapshot(sub)
    }
  }

  beginTimelineEpoch(mode: WorldMode = this._mode): void {
    if (this.disposed) return
    // #11-r2：epoch identity 递增——使 seek 前启动的 async continuation
    // （replaySnapshot/query/已入队 source 事件）全部失去 commit authority。
    this.timelineGeneration.set(mode, (this.timelineGeneration.get(mode) ?? 0) + 1)
    if (mode === this._mode) {
      // 游标重置：低 revision 的正确历史值可成为当前状态
      for (const sub of this.active) sub.delivered.get(mode)?.clear()
      // 重新 attach：新的 forward 闭包捕获新 epoch——旧闭包（seek 前挂起/
      // 已入队的事件）持有旧 epoch identity，会被 forward guard 丢弃；
      // seek 之后 source 发出的新帧属于新 epoch，正常投递。
      for (const sub of this.active) {
        this.detachFromSources(sub)
        this.attachToSource(sub)
      }
    }
  }

  private currentTimelineGen(mode: WorldMode): number {
    return this.timelineGeneration.get(mode) ?? 0
  }

  async query(query: DataQuery): Promise<readonly DataEnvelope[]> {
    const mode = this._mode
    const generation = this.modeGeneration
    const timeline = this.currentTimelineGen(mode)
    const source = this.sources.get(mode)
    if (!source) return []
    const envelopes = await source.snapshot(query)
    // #11-A/r2：query 也是异步——mode/generation/timeline 已变时结果属于
    // 旧时间线，只返回给调用方，不再写入当前模式 cache 污染 truth。
    if (
      !this.disposed &&
      this._mode === mode &&
      this.modeGeneration === generation &&
      this.currentTimelineGen(mode) === timeline
    ) {
      for (const e of envelopes) {
        if (this.matches(e, query)) this.putCache(e)
      }
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
    return this.cache.get(this._mode)?.get(contract)?.get(key)
  }

  /**
   * 全局实体搜索（B2）：在缓存键中做大小写不敏感子串匹配。
   * 只搜键（Foundation 不理解 payload 语义，§33）；
   * #11：只搜当前 mode 的 cache 分区。
   */
  search(term: string, limit = 8): Array<{ contract: DataContractIdString; key: string }> {
    const q = term.trim().toLowerCase()
    if (!q) return []
    const out: Array<{ contract: DataContractIdString; key: string }> = []
    for (const [contract, byKey] of this.cache.get(this._mode) ?? []) {
      for (const key of byKey.keys()) {
        if (key.toLowerCase().includes(q)) {
          out.push({ contract, key })
          if (out.length >= limit) return out
        }
      }
    }
    return out
  }

  /** 缓存中质量为 stale 的信封数量（I3-3：降级可见；仅当前 mode 分区）。 */
  countStale(): number {
    let count = 0
    for (const byKey of this.cache.get(this._mode)?.values() ?? []) {
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
    const mode = this._mode
    const timeline = this.currentTimelineGen(mode)
    const source = this.sources.get(mode)
    if (!source) return
    const forward: EnvelopeHandler = (e) => {
      // #11-A/r2：setMode 会 detach 旧 source，但已入队的转发回调仍可能晚到；
      // 同 mode 的旧 timeline epoch 事件（seek 前入队）同样丢弃——
      // 否则旧 epoch 高 revision 会抢占游标、反过来吞掉新 epoch 低 revision。
      if (this.disposed || this._mode !== mode) return
      if (this.currentTimelineGen(mode) !== timeline) return
      const effective = this.ingest(e, sub)
      if (effective) this.deliver(sub, effective)
    }
    sub.sourceDisposables.set(mode, source.subscribe(sub.query, forward))
  }

  private detachFromSources(sub: ActiveSubscription): void {
    for (const d of sub.sourceDisposables.values()) d.dispose()
    sub.sourceDisposables.clear()
  }

  private async replaySnapshot(sub: ActiveSubscription): Promise<void> {
    // #11-A/r2：捕获 {mode, modeGeneration, timelineGeneration} 完整 identity——
    // 异步 snapshot 晚到时若世界已切换模式或同一模式内 seek/rewind 开启了
    // 新 epoch，整批丢弃（不写 cache / 游标 / handler）。
    const mode = this._mode
    const generation = this.modeGeneration
    const timeline = this.currentTimelineGen(mode)
    const source = this.sources.get(mode)
    if (!source) return
    try {
      const envelopes = await source.snapshot(sub.query)
      if (
        this.disposed ||
        this._mode !== mode ||
        this.modeGeneration !== generation ||
        this.currentTimelineGen(mode) !== timeline
      ) {
        return
      }
      for (const e of envelopes) {
        const effective = this.ingest(e, sub)
        if (effective) this.deliver(sub, effective)
      }
    } catch {
      // Snapshot failures are non-fatal; the live stream will catch up.
    }
  }

  /**
   * Issue #19：Scene-facing data handler 的 trust/fault boundary——
   * 逐 handler 隔离：单个 handler throw 只失败它自己，不截断同一 envelope
   * 的其它 handler、不截断同 batch 后续 envelope、更不截断其它订阅。
   * 限频策略：同一 handler 只在 ok→failing 转变时上报一次（成功即复位），
   * 高频重复 throw 不产生无界 error storm；订阅保留（数据可能自愈）。
   */
  private deliver(sub: ActiveSubscription, envelope: DataEnvelope): void {
    for (const handler of [...sub.handlers]) {
      try {
        handler(envelope)
        if (this.failingHandlers.has(handler)) this.failingHandlers.delete(handler)
      } catch (error) {
        if (this.failingHandlers.has(handler)) continue // 已上报，限频
        this.failingHandlers.set(handler, true)
        try {
          if (this.options.onSubscriberError) {
            this.options.onSubscriberError(error, {
              contract: envelope.contract,
              key: envelope.key,
              mode: this._mode
            })
          } else {
            console.error(
              `[world-client] data subscriber failed (${envelope.contract}/${envelope.key}, mode=${this._mode}) — quarantined reporting until recovery`,
              error
            )
          }
        } catch {
          /* sink 自身异常不得影响 pipeline */
        }
      }
    }
  }

  /**
   * Cache write + per-subscription/per-mode dedup + staleness evaluation.
   * Returns the envelope to deliver to THIS subscription, or undefined when
   * it is a duplicate the subscriber has already seen.
   */
  private ingest(e: DataEnvelope, sub: ActiveSubscription): DataEnvelope | undefined {
    if (!this.matches(e, sub.query)) return undefined
    const mode = this._mode
    let cursor = sub.delivered.get(mode)
    if (!cursor) {
      cursor = new Map()
      sub.delivered.set(mode, cursor)
    }
    const last = cursor.get(e.key)
    if (last !== undefined && e.revision !== undefined && e.revision <= last) {
      return undefined
    }
    if (e.revision !== undefined) cursor.set(e.key, e.revision)
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

  /** Cache write（写入当前 mode 分区）for query results and ingested envelopes. */
  private putCache(e: DataEnvelope): void {
    let byContract = this.cache.get(this._mode)
    if (!byContract) {
      byContract = new Map()
      this.cache.set(this._mode, byContract)
    }
    let byKey = byContract.get(e.contract)
    if (!byKey) {
      byKey = new Map()
      byContract.set(e.contract, byKey)
    }
    byKey.set(e.key, e)
  }

  /** 重置某模式的 timeline 状态：epoch 递增 + 游标 + 该模式缓存分区。 */
  private resetModeState(mode: WorldMode): void {
    this.timelineGeneration.set(mode, (this.timelineGeneration.get(mode) ?? 0) + 1)
    for (const sub of this.active) sub.delivered.get(mode)?.clear()
    this.cache.delete(mode)
  }

  private sweepStale(): void {
    const now = this.now()
    const window = this.options.defaultStaleAfterMs ?? 60_000
    for (const byContract of this.cache.get(this._mode)?.values() ?? []) {
      for (const [key, e] of byContract) {
        if (e.quality === 'good' && now - e.sourceTime > window) {
          byContract.set(key, { ...e, quality: 'stale' })
        }
      }
    }
  }
}
