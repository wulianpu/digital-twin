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
}

/** The one logical digital world. Scope/Mode are views onto it (§29-30). */
export function createWorldApi(options: CreateWorldOptions = {}): WorldApi {
  const worldId = options.worldId ?? 'world-main'
  const clock = new WorldClock()
  if (options.initialMode) clock.setMode(options.initialMode)

  const sites = new Map<SiteId, Site>()
  for (const site of options.sites ?? []) sites.set(site.id, site)

  let scope: WorldScope = options.initialScope ?? { kind: 'global' }
  let mode: WorldMode = options.initialMode ?? 'live'

  const siteListeners = new Set<() => void>()
  const sessionListeners = new Set<(s: WorldSession) => void>()
  const tickListeners = new Set<(t: WorldTime) => void>()
  const selection = options.selection ?? createSelectionApi()

  function buildSession(): WorldSession {
    return {
      worldId,
      mode,
      scope,
      time: clock.now()
    }
  }

  function emitSession(): void {
    const session = buildSession()
    for (const cb of sessionListeners) cb(session)
  }

  const siteRegistry: SiteRegistryApi = {
    get: (id) => sites.get(id),
    list: () => [...sites.values()],
    findContaining(bounds) {
      for (const site of sites.values()) {
        const b = site.bounds
        if (
          bounds.south >= b.south &&
          bounds.north <= b.north &&
          bounds.west >= b.west &&
          bounds.east <= b.east
        ) {
          return site
        }
      }
      return undefined
    },
    register(site) {
      sites.set(site.id, site)
      for (const cb of siteListeners) cb()
      return {
        dispose: () => {
          sites.delete(site.id)
          for (const cb of siteListeners) cb()
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
      scope = next
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
