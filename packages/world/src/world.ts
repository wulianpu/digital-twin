import { WorldClock } from './clock'
import { createSelectionApi, type SelectionApi } from './selection'
import type { Disposable } from './lifecycle'
import type {
  GeoBounds,
  Site,
  SiteId,
  WorldMode,
  WorldScope,
  WorldSession,
  WorldTime
} from './types'

export interface SiteRegistryApi {
  get(id: SiteId): Site | undefined
  list(): readonly Site[]
  findContaining(bounds: GeoBounds): Site | undefined
  register(site: Site): Disposable
}

export interface WorldTimeApi {
  /** Lazily-computed current time (no reactivity, no timer). */
  now(): WorldTime
  /** Subscribe to coarse time changes (driven by the app's tick, e.g. UI clock). */
  onTick(cb: (time: WorldTime) => void): Disposable
}

export interface WorldApi {
  readonly worldId: string
  /** Current session (immutable snapshot; mode changes create a new one). */
  readonly session: WorldSession
  readonly sites: SiteRegistryApi
  readonly time: WorldTimeApi
  readonly selection: SelectionApi
  readonly clock: WorldClock
  setMode(mode: WorldMode): void
  setScope(scope: WorldScope): void
  onSessionChanged(cb: (session: WorldSession) => void): Disposable
}

export interface CreateWorldOptions {
  worldId?: string
  sites?: readonly Site[]
  initialMode?: WorldMode
  initialScope?: WorldScope
  selection?: SelectionApi
  /**
   * Issue #20：listener fault boundary 的上报通道（Composition Root 决定
   * 去向）。限频：同一 listener 仅 ok→failing 转变时上报一次；缺省降级
   * console.error。listener throw 不阻断其它健康 listener，也不把已提交的
   * mutation 伪装成失败。
   */
  onListenerError?: (error: unknown, meta: { event: string }) => void
}

/** Issue #20：逐 listener 隔离 + 限频上报的统一 dispatch helper。 */
function notifyListeners<T>(
  listeners: Iterable<(value: T) => void>,
  value: T,
  event: string,
  onError: ((error: unknown, meta: { event: string }) => void) | undefined,
  failing: WeakMap<(value: T) => void, true>
): void {
  for (const cb of [...listeners]) {
    try {
      cb(value)
      failing.delete(cb)
    } catch (error) {
      if (failing.has(cb)) continue // 已上报，限频
      failing.set(cb, true)
      try {
        onError?.(error, { event })
      } catch {
        /* sink 自身异常不得击穿 dispatch */
      }
    }
  }
}

/**
 * Issue #6：write-side alias 防线——外部 mutable value 进入 Foundation
 * 前 normalize/copy；Foundation 内部不持有调用方可继续修改的引用。
 */
function snapshotScope(scope: WorldScope): WorldScope {
  if (scope.kind === 'entity') {
    return { kind: 'entity', entity: { ...scope.entity } }
  }
  return { ...scope }
}

/** Site 是低频稳定 read model：浅拷贝嵌套几何即可切断别名。 */
function snapshotSite(site: Site): Site {
  return {
    ...site,
    origin: { ...site.origin },
    bounds: { ...site.bounds }
  }
}

/**
 * Registration identity（Issue #7）：disposer 绑定注册身份而非仅绑定 key——
 * stale disposer 永远不能删除后来 owner 的 registration。
 */
interface Registration<T> {
  readonly token: object
  readonly value: T
}

/**
 * Issue #7：Foundation facts 互斥注册——重复 key fail-fast，
 * 不修改原值、不产生 listener 副作用。
 */
export class DuplicateRegistrationError extends Error {
  readonly key: string
  constructor(what: string, key: string) {
    super(
      `[world] duplicate ${what} registration: "${key}"（Foundation facts 互斥注册，更新请走 app-owned API）`
    )
    this.name = 'DuplicateRegistrationError'
    this.key = key
  }
}

/** The one logical digital world. Scope/Mode are views onto it (§29-30). */
export function createWorldApi(options: CreateWorldOptions = {}): WorldApi {
  const worldId = options.worldId ?? 'world-main'
  const clock = new WorldClock()
  if (options.initialMode) clock.setMode(options.initialMode)

  const sites = new Map<SiteId, Registration<Site>>()
  // Issue #6：Foundation owns facts——初始 sites 同样防御性拷贝
  for (const site of options.sites ?? []) {
    sites.set(site.id, { token: {}, value: snapshotSite(site) })
  }

  // Issue #6：write-side alias 防线——内部 truth 不持有调用方可变引用
  let scope: WorldScope = snapshotScope(options.initialScope ?? { kind: 'global' })
  let mode: WorldMode = options.initialMode ?? 'live'

  const siteListeners = new Set<() => void>()
  const sessionListeners = new Set<(s: WorldSession) => void>()
  const tickListeners = new Set<(t: WorldTime) => void>()
  // Issue #20：listener fault 状态（限频）
  const failingSite = new WeakMap<() => void, true>()
  const failingSession = new WeakMap<(s: WorldSession) => void, true>()
  const onListenerError = options.onListenerError
  // Issue #20-r2：默认 selection 必须继承同一个 listener fault sink——
  // 否则真实 Composition Root 路径（world.selection）的故障不可观察。
  const selection = options.selection ?? createSelectionApi(onListenerError)

  function buildSession(): WorldSession {
    return {
      worldId,
      mode,
      // Issue #5：snapshot 必须与内部 state 脱离别名——
      // 调用方修改返回的 scope/entity 不得反向污染 World truth
      scope: snapshotScope(scope),
      time: clock.now()
    }
  }

  function emitSession(): void {
    const session = buildSession()
    notifyListeners(sessionListeners, session, 'world.sessionChanged', onListenerError, failingSession)
  }

  const siteRegistry: SiteRegistryApi = {
    get: (id) => {
      const entry = sites.get(id)
      return entry ? snapshotSite(entry.value) : undefined
    },
    list: () => [...sites.values()].map((entry) => snapshotSite(entry.value)),
    findContaining(bounds) {
      for (const entry of sites.values()) {
        const b = entry.value.bounds
        if (
          bounds.south >= b.south &&
          bounds.north <= b.north &&
          bounds.west >= b.west &&
          bounds.east <= b.east
        ) {
          return snapshotSite(entry.value)
        }
      }
      return undefined
    },
    register(site) {
      // Issue #6：registry 存防御性副本——调用方后续修改 origin/bounds 不影响 truth
      const stored = snapshotSite(site)
      // Issue #7：互斥注册——duplicate key fail-fast，无任何瞬时副作用
      if (sites.has(stored.id)) {
        throw new DuplicateRegistrationError('site', stored.id)
      }
      const token: object = {}
      sites.set(stored.id, { token, value: stored })
      for (const cb of siteListeners) cb()
      let disposed = false
      return {
        dispose: () => {
          if (disposed) return
          disposed = true
          // Issue #7：compare-and-delete——stale disposer 不得删除
          // 后来 owner 的 registration
          if (sites.get(stored.id)?.token !== token) return
          sites.delete(stored.id)
          notifyListeners(siteListeners, undefined, 'world.sitesChanged', onListenerError, failingSite)
        }
      }
    }
  }

  const timeApi: WorldTimeApi = {
    now: () => clock.now(),
    onTick(cb) {
      tickListeners.add(cb)
      return {
        dispose: () => {
          tickListeners.delete(cb)
        }
      }
    }
  }

  return {
    worldId,
    get session() {
      return buildSession()
    },
    sites: siteRegistry,
    time: timeApi,
    selection,
    clock,
    setMode(next) {
      if (next === mode) return
      // Keep the virtual timeline continuous when leaving live mode.
      const anchor = next === 'live' ? undefined : clock.now().epochMillis
      clock.setMode(next, anchor)
      mode = next
      emitSession()
    },
    setScope(next) {
      // Issue #6：入参立即 snapshot——调用方（含已卸载 Scene 的历史闭包）
      // 之后修改原对象不得反向污染 World truth
      scope = snapshotScope(next)
      emitSession()
    },
    onSessionChanged(cb) {
      sessionListeners.add(cb)
      return {
        dispose: () => {
          sessionListeners.delete(cb)
        }
      }
    }
  }
}
