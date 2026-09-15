import type { DataApi } from '@twin/world-client'
import type { AssetApi, MapAccess, UiApi } from '@twin/sdk'
import type { GraphicsAccess } from '@twin/sdk'
import type { MountScope } from './scope'

/**
 * Scoped capability wrappers（Issue #1 / 问题2 + Issue #3 修复）：
 *
 * - 创建入口（subscribe / acquire / createLayer / use / onFrame / onPick）
 *   在 MountScope 非 active 时抛 SceneScopeClosedError——
 *   即使 Scene 在 mount 时缓存了 capability 引用，unmount 后也无法
 *   创建新的 subscription / lease / callback（zombie write 防线）；
 * - 创建成功的资源**立即**经 scope.track 登记到 MountScope——
 *   Host 兜底释放不依赖 Scene 手工清理；
 * - `dispose()` 不暴露给 Scene——引擎/Map 生命周期归 Composition Root（§81）；
 * - 其余调用透明透传（§15：只封装生命周期，不重造引擎 API）。
 */

export function scopedDataApi(inner: DataApi, scope: MountScope): DataApi {
  return {
    query: (query) => inner.query(query),
    subscribe: (query, cb, options) => {
      scope.assertCanCreate('data.subscribe')
      const sub = inner.subscribe(query, cb, options)
      // 创建成功时立即 track——Host 兜底 dispose 不依赖 Scene 手工清理
      scope.track(sub)
      return sub
    },
    peek: (contract, key) => inner.peek(contract, key),
    get mode() {
      return inner.mode
    },
    setMode: (mode) => inner.setMode(mode),
    beginTimelineEpoch: (mode) => inner.beginTimelineEpoch(mode),
    dispose: () => { /* no-op: 生命周期归 Composition Root（§81） */ }
  }
}

export function scopedAssetApi(inner: AssetApi, scope: MountScope): AssetApi {
  return {
    get leaseCount() {
      return inner.leaseCount
    },
    acquire: async (ref) => {
      scope.assertCanCreate('assets.acquire')
      const lease = await inner.acquire(ref)
      // Host 兜底：scope dispose 自动 release（Scene 手动 release 幂等）
      scope.track({ dispose: () => lease.release() })
      return {
        ...lease,
        release: () => {
          lease.release()
        }
      }
    }
  }
}

export function scopedUiApi(inner: UiApi, scope: MountScope): UiApi {
  return {
    get container() {
      return inner.container
    },
    createLayer: (options) => {
      scope.assertCanCreate('ui.createLayer')
      return inner.createLayer(options)
    }
  }
}

export function scopedMapAccess(inner: MapAccess, scope: MountScope): MapAccess {
  return {
    get state() {
      return inner.state
    },
    get currentContext() {
      return inner.currentContext
    },
    use: async () => {
      scope.assertCanCreate('map.use')
      return inner.use()
    },
    dispose: () => { /* no-op: 生命周期归 Composition Root（§81） */ }
  }
}

export function scopedGraphicsAccess(
  inner: GraphicsAccess,
  scope: MountScope
): GraphicsAccess {
  return {
    get state() {
      return inner.state
    },
    get currentContext() {
      return inner.currentContext
    },
    use: async () => {
      scope.assertCanCreate('graphics.use')
      const ctx = await inner.use()
      // 问题6：late resolve——use() 调用在 close 之前、解析在 close 之后时，
      // 挂载根立即脱离场景，不留 zombie graphics root。
      if (scope.state !== 'active') {
        detachRoot(ctx.root)
      }
      // 问题3：per-mount root 的 detach 由 scope 兜底（Scene 忘记 remove 也逃不出）
      scope.track({ dispose: () => detachRoot(ctx.root) })
      return {
        ...ctx,
        root: ctx.root,
        // 问题3 修复：onFrame/onPick 创建时立即纳入 MountScope
        onFrame: (cb) => {
          scope.assertCanCreate('graphics.onFrame')
          const d = ctx.onFrame(cb)
          scope.track(d)
          return d
        },
        onPick: (cb) => {
          scope.assertCanCreate('graphics.onPick')
          const d = ctx.onPick(cb)
          scope.track(d)
          return d
        },
        // Issue #17-C：Entity 注册纳入 MountScope——Scene 手工 dispose 与
        // Host 兜底都成立，Engine 级 entries 不再跨 Scene 泄漏
        entities: {
          ...ctx.entities,
          register: (entity, object) => {
            scope.assertCanCreate('graphics.entities.register')
            const d = ctx.entities.register(entity, object)
            scope.track(d)
            return d
          }
        }
      }
    },
    applyQuality: (profile) => inner.applyQuality(profile),
    suspend: () => inner.suspend(),
    resume: () => inner.resume(),
    getDiagnostics: () => inner.getDiagnostics(),
    dispose: () => { /* no-op: 生命周期归 Composition Root（§81） */ }
  }
}

function detachRoot(root: { removeFromParent?(): void }): void {
  try {
    root.removeFromParent?.()
  } catch {
    // 引擎已销毁时忽略
  }
}
