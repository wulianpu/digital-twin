import type { Disposable } from '@twin/world'

/**
 * MountScope（Issue #1 / 问题2，§11/§14 生命周期隔离）：
 *
 * close() 后禁止创建新的 Host/Foundation-owned 资源；
 * dispose() 由 Host 在 Scene cleanup 之后无条件调用——无论 Scene cleanup
 * 成功、throw 还是 timeout，tracked 资源都会被兜底释放。
 *
 * Scene 仍可手工 dispose/release（全部幂等）；Host 只是最后兜底。
 */

export type MountScopeState = 'active' | 'closing' | 'disposed'

export class SceneScopeClosedError extends Error {
  readonly what: string
  constructor(what: string) {
    super(
      `[scene-host] MountScope closing/disposed：拒绝 ${what}（§11/§14 生命周期隔离）`
    )
    this.name = 'SceneScopeClosedError'
    this.what = what
  }
}

export class MountScope {
  private _state: MountScopeState = 'active'
  private readonly tracked: Disposable[] = []

  get state(): MountScopeState {
    return this._state
  }

  /** 是否允许创建新的 Host/Foundation-owned 资源。 */
  canCreate(): boolean {
    return this._state === 'active'
  }

  assertCanCreate(what: string): void {
    if (this._state !== 'active') throw new SceneScopeClosedError(what)
  }

  /**
   * 是否允许平台状态写操作（Issue #4 stale-write 防线）。
   * unmount 开始后，Scene 不得再改写全局 world/selection/spatial/view 状态。
   */
  assertActive(what: string): void {
    if (this._state !== 'active') throw new SceneScopeClosedError(what)
  }

  /**
   * 登记资源并由 Host 兜底释放。
   * - scope active：登记，待 dispose 统一释放；
   * - closing/disposed：**立即释放**（迟到的资源自动回收，问题6）。
   */
  track(disposable: Disposable): Disposable {
    const wrapped: Disposable = {
      dispose: () => {
        const index = this.tracked.indexOf(disposable)
        if (index >= 0) this.tracked.splice(index, 1)
        disposable.dispose()
      }
    }
    if (this._state !== 'active') {
      disposable.dispose()
      return wrapped
    }
    this.tracked.push(disposable)
    return wrapped
  }

  /** 关闭入口：停止接受新资源（由 Host 在 abort 后、Scene unmount 前调用）。 */
  close(): void {
    if (this._state === 'active') this._state = 'closing'
  }

  /** Host 兜底释放全部 tracked 资源。幂等。 */
  dispose(): void {
    if (this._state === 'disposed') return
    this._state = 'disposed'
    const all = [...this.tracked]
    this.tracked.length = 0
    for (const disposable of all) {
      try {
        disposable.dispose()
      } catch {
        // 兜底释放不因单个资源失败而中断
      }
    }
  }
}
