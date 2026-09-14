import type { DataApi } from '@twin/world-client'
import type { AssetApi, MapAccess, UiApi } from '@twin/sdk'
import type { GraphicsAccess } from '@twin/sdk'
import type { MountScope } from './scope'

/**
 * Scoped capability wrappers（Issue #1 / 问题2）：
 *
 * - 创建入口（subscribe / acquire / createLayer / use / onFrame / onPick）
 *   在 MountScope 非 active 时抛 SceneScopeClosedError——
 *   即使 Scene 在 mount 时缓存了 capability 引用，unmount 后也无法
 *   创建新的 subscription / lease / callback（zombie write 防线）；
 * - 创建成功的资源经 scope.track 登记，Host 兜底释放；
 * - 其余调用透明透传（§15：只封装生命周期，不重造引擎 API）。
 */

export function scopedDataApi(inner: DataApi, scope: MountScope): DataApi {
  return {
    query: (query) => inner.query(query),
    subscribe: (query, cb, options) => {
      scope.assertCanCreate('data.subscribe')
      const sub = inner.subscribe(query, cb, options)
      // Host 兜底 dispose（Scene 手工 dispose 幂等）
      return { query: sub.query, dispose: () => scope.track({ dispose: () => sub.dispose() }).dispose() }
    },
    peek: (contract, key) => inner.peek(contract, key),
    get mode() {
      return inner.mode
    },
    setMode: (mode) => inner.setMode(mode),
    dispose: () => inner.dispose()
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
    dispose: () => inner.dispose()
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
      // 问题6：late resolve——use() 调用发生在 close 之前、解析在 close 之后时，
      // 挂载根立即脱离场景，不留 zombie graphics root。
      if (scope.state !== 'active') {
        // 问题6：late resolve——返回 detached root（不可见、无 zombie 写入），
        // GPU 资源由 compliance / diagnostics 事后发现
        detachRoot(ctx.root)
      }
      // 问题3：per-mount root 的 detach 由 scope 兜底（Scene 忘记 remove 也逃不出）
      scope.track({ dispose: () => detachRoot(ctx.root) })
      return { ...ctx, root: ctx.root }
    },
    applyQuality: (profile) => inner.applyQuality(profile),
    suspend: () => inner.suspend(),
    resume: () => inner.resume(),
    getDiagnostics: () => inner.getDiagnostics(),
    dispose: () => inner.dispose()
  }
}

function detachRoot(root: { removeFromParent?(): void }): void {
  try {
    root.removeFromParent?.()
  } catch {
    // 引擎已销毁时忽略
  }
}

