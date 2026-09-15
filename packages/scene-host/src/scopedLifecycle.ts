import type {
  WorldApi,
  SelectionApi,
  WorldClock,
  SiteRegistryApi,
  WorldTimeApi
} from '@twin/world'
import type { SpatialApi } from '@twin/spatial'
import type { ViewApi } from '@twin/sdk'
import type { MountScope } from './scope'

/**
 * Scoped lifecycle wrappers（Issue #4 / §11-§14 生命周期隔离）：
 *
 * Scene 在 mount 时缓存 world/spatial/selection/view 引用后，即使 Scene
 * 已 unmount / context 已 revoke，仍可通过缓存引用改写平台全局状态
 * （zombie write）或遗留长期 listener。本模块创建 scope 感知的包装器：
 *
 * - 纯读操作：始终透传（帮助 Scene 安全降级）；
 * - 状态写操作：scope 非 active 时抛 SceneScopeClosedError（fail-fast，
 *   不让 stale Scene 静默污染全局状态）；
 * - 返回 Disposable 的 Foundation API：立即 scope.track()，Host 兜底释放，
 *   Scene 手工 dispose 仍然有效。
 * - world.clock：以 scoped facade 暴露——读操作透传，setMode/seek/setSpeed
 *   走 assertActive（Clock 控制属于 App/Composition Root 权限）。
 */

/** 状态写：非 active 抛错（Issue #4 验收语义）。 */
function assertWrite(scope: MountScope, what: string): void {
  scope.assertActive(what)
}

/**
 * 同步资源创建：先 assertCanCreate 再执行 inner create（Issue #5-C）。
 * closing/disposed 后在 inner create **之前**拒绝——杜绝
 * "先真实增删/发射通知、再立即 dispose" 的瞬时 zombie 副作用。
 * （异步迟到 resolve 的兜底回收是另一语义，见 scoped.ts 的 track。）
 */
function createTracked<T extends { dispose(): void }>(
  scope: MountScope,
  what: string,
  create: () => T
): T {
  scope.assertCanCreate(what)
  return scope.track(create()) as T
}

/** scoped clock facade：读写分离（Issue #4 建议方案 4-2）。 */
function scopedClock(inner: WorldClock, scope: MountScope): WorldClock {
  const facade = {
    now: () => inner.now(),
    getMode: () => inner.getMode(),
    setMode: (mode: Parameters<WorldClock['setMode']>[0], anchor?: number) => {
      assertWrite(scope, 'world.clock.setMode')
      inner.setMode(mode, anchor)
    },
    seek: (epochMillis: number) => {
      assertWrite(scope, 'world.clock.seek')
      inner.seek(epochMillis)
    },
    setSpeed: (speed: number) => {
      assertWrite(scope, 'world.clock.setSpeed')
      inner.setSpeed(speed)
    }
  }
  // WorldClock 含私有字段，结构化 facade 需显式断言
  return facade as unknown as WorldClock
}

function scopedSites(inner: SiteRegistryApi, scope: MountScope): SiteRegistryApi {
  return {
    get: (id) => inner.get(id),
    list: () => inner.list(),
    findContaining: (bounds) => inner.findContaining(bounds),
    register: (site) => createTracked(scope, 'world.sites.register', () => inner.register(site))
  }
}

function scopedTime(inner: WorldTimeApi, scope: MountScope): WorldTimeApi {
  return {
    now: () => inner.now(),
    onTick: (cb) => createTracked(scope, 'world.time.onTick', () => inner.onTick(cb))
  }
}

export function scopedWorldApi(
  inner: WorldApi,
  scope: MountScope,
  options: { selection?: SelectionApi } = {}
): WorldApi {
  return {
    get worldId() { return inner.worldId },
    get session() { return inner.session },
    get sites() { return scopedSites(inner.sites, scope) },
    get time() { return scopedTime(inner.time, scope) },
    // Issue #5-A：复用同一 scoped SelectionApi——ctx.world.selection 与
    // ctx.selection 生命周期语义完全一致（同一实例）
    get selection() { return options.selection ?? scopedSelectionApi(inner.selection, scope) },
    get clock() { return scopedClock(inner.clock, scope) },
    setMode: (mode) => {
      assertWrite(scope, 'world.setMode')
      inner.setMode(mode)
    },
    setScope: (s) => {
      assertWrite(scope, 'world.setScope')
      inner.setScope(s)
    },
    onSessionChanged: (cb) =>
      createTracked(scope, 'world.onSessionChanged', () => inner.onSessionChanged(cb))
  }
}

export function scopedSpatialApi(inner: SpatialApi, scope: MountScope): SpatialApi {
  return {
    get activeFrameId() { return inner.activeFrameId },
    listFrames: () => inner.listFrames(),
    getFrame: (id) => inner.getFrame(id),
    registerFrame: (frame) =>
      createTracked(scope, 'spatial.registerFrame', () => inner.registerFrame(frame)),
    ensureEnuFrame: (id, origin) => {
      scope.assertCanCreate('spatial.ensureEnuFrame')
      return inner.ensureEnuFrame(id, origin)
    },
    setActiveFrame: (id) => {
      assertWrite(scope, 'spatial.setActiveFrame')
      inner.setActiveFrame(id)
    },
    onActiveFrameChanged: (cb) =>
      createTracked(scope, 'spatial.onActiveFrameChanged', () => inner.onActiveFrameChanged(cb)),
    geodeticToLocal: (p) => inner.geodeticToLocal(p),
    localToGeodetic: (v) => inner.localToGeodetic(v),
    ecefToLocal: (e) => inner.ecefToLocal(e),
    localToEcef: (v) => inner.localToEcef(v),
    registerVerticalOffset: (from, to, meters) =>
      createTracked(scope, 'spatial.registerVerticalOffset', () =>
        inner.registerVerticalOffset(from, to, meters)
      ),
    toEllipsoidal: (p) => inner.toEllipsoidal(p)
  }
}

export function scopedSelectionApi(inner: SelectionApi, scope: MountScope): SelectionApi {
  return {
    get current() { return inner.current },
    setPrimary: (entity) => {
      assertWrite(scope, 'selection.setPrimary')
      inner.setPrimary(entity)
    },
    setSecondary: (entities) => {
      assertWrite(scope, 'selection.setSecondary')
      inner.setSecondary(entities)
    },
    toggle: (entity) => {
      assertWrite(scope, 'selection.toggle')
      inner.toggle(entity)
    },
    clear: () => {
      assertWrite(scope, 'selection.clear')
      inner.clear()
    },
    isSelected: (entity) => inner.isSelected(entity),
    onChange: (cb) => createTracked(scope, 'selection.onChange', () => inner.onChange(cb))
  }
}

export function scopedViewApi(inner: ViewApi, scope: MountScope): ViewApi {
  return {
    get primary() { return inner.primary },
    focus: (entity) => {
      assertWrite(scope, 'view.focus')
      return inner.focus(entity)
    },
    goToSite: (siteId) => {
      assertWrite(scope, 'view.goToSite')
      return inner.goToSite(siteId)
    },
    getTarget: () => inner.getTarget(),
    setTarget: (target) => {
      assertWrite(scope, 'view.setTarget')
      return inner.setTarget(target)
    }
  }
}
