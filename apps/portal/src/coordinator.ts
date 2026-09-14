import type { SceneDefinition, SceneId } from '@twin/sdk'
import type { HostMount, SceneHost } from '@twin/scene-host'
import { canEnter } from './catalog'

export type CoordinatorState =
  | { kind: 'idle' }
  | { kind: 'loading'; target: SceneId }
  | { kind: 'active'; sceneId: SceneId; mount: HostMount }
  | { kind: 'denied'; sceneId: SceneId }
  | { kind: 'error'; sceneId: SceneId; error: unknown }

export interface SceneCoordinatorOptions {
  /**
   * I2-2: 当前用户权限提供者。缺省（未提供）时保持旧行为——由目录 UI 置灰提示，
   * 但不强制。提供后进入场景前强制校验，权限不足 → denied 态。
   */
  permissions?: () => readonly string[]
  onError?(error: unknown, sceneId: SceneId): void
  onStateChange?(state: CoordinatorState): void
}

/**
 * SceneCoordinator (§10-11) — Portal-only orchestration:
 *   SELECT → LOAD → PREPARE → UNMOUNT CURRENT → MOUNT TARGET → COMMIT
 * with AbortController + generation id so that **last selection wins**:
 * rapid A→B→C switches cancel the pending loads and never mount stale scenes.
 * Failure rolls the state back instead of killing the portal.
 */
export class SceneCoordinator {
  private generation = 0
  private loadControllers = new Map<SceneId, AbortController>()
  private _state: CoordinatorState = { kind: 'idle' }

  constructor(
    private readonly host: SceneHost,
    private readonly catalog: readonly SceneDefinition[],
    private readonly options: SceneCoordinatorOptions = {}
  ) {}

  get state(): CoordinatorState {
    return this._state
  }

  get activeSceneId(): SceneId | undefined {
    return this._state.kind === 'active' ? this._state.sceneId : undefined
  }

  get(sceneId: SceneId): SceneDefinition | undefined {
    return this.catalog.find((d) => d.id === sceneId)
  }

  /** Preload scene CODE only — engines and world content stay lazy (§61). */
  preload(sceneId: SceneId): void {
    const definition = this.get(sceneId)
    void definition?.load().catch(() => {})
  }

  async select(sceneId: SceneId, options: { force?: boolean } = {}): Promise<void> {
    const definition = this.get(sceneId)
    if (!definition) {
      this.options.onError?.(new Error(`unknown scene "${sceneId}"`), sceneId)
      return
    }
    // force：会话范围（站点）变化时，App 决定重跑当前场景（§"App decides
    // what to run"）——绕过同场景守卫，仍走完整切换事务（§11）。
    if (
      !options.force &&
      this._state.kind === 'active' &&
      this._state.sceneId === sceneId
    ) {
      return
    }

    // I2-2: 强制权限边界——无权限时绝不触碰 load / host.mount。
    if (
      this.options.permissions &&
      !canEnter(definition, this.options.permissions())
    ) {
      this.options.onError?.(
        new Error(`permission denied for scene "${sceneId}"`),
        sceneId
      )
      this.setState({ kind: 'denied', sceneId })
      return
    }

    // Last selection wins: invalidate every pending switch (§11).
    const generation = ++this.generation
    for (const controller of this.loadControllers.values()) controller.abort()
    this.loadControllers.clear()
    const loadController = new AbortController()
    this.loadControllers.set(sceneId, loadController)

    this.setState({ kind: 'loading', target: sceneId })

    // 问题4（§19）：切换前保存 previous——目标 mount 失败时可恢复 previous scene
    const previous =
      this._state.kind === 'active'
        ? { definition: this.get(this._state.sceneId)!, sceneId: this._state.sceneId }
        : undefined

    let entry
    try {
      entry = await definition.load()
      if (generation !== this.generation) return // superseded
    } catch (loadError) {
      // load 失败（dynamic import/网络）：无副作用产生，直接 ERROR
      this.loadControllers.delete(sceneId)
      this.options.onError?.(loadError, sceneId)
      this.setState({ kind: 'error', sceneId, error: loadError })
      return
    }

    // UNMOUNT CURRENT → MOUNT TARGET (host enforces §12 teardown rules).
    await this.host.unmount()
    if (generation !== this.generation) return

    let mount: HostMount
    try {
      mount = await this.host.mount(entry, { sceneId })
      if (mount.state !== 'active') {
        throw new Error(`scene "${sceneId}" did not reach active state`)
      }
      if (generation !== this.generation) {
        await mount.unmount()
        return
      }
    } catch (mountError) {
      // 问题4：真回滚——目标 mount 失败后尝试恢复 previous scene；
      // Last Selection Wins：generation 变化时过期回滚不得执行。
      if (previous && generation === this.generation) {
        try {
          const prevEntry = await previous.definition.load()
          const prevMount = await this.host.mount(prevEntry, {
            sceneId: previous.sceneId
          })
          this.loadControllers.delete(sceneId)
          this.setState({ kind: 'active', sceneId: previous.sceneId, mount: prevMount })
          this.options.onError?.(mountError, sceneId)
          return
        } catch (rollbackError) {
          this.loadControllers.delete(sceneId)
          this.options.onError?.(rollbackError, previous.sceneId)
          this.setState({ kind: 'error', sceneId, error: rollbackError })
          return
        }
      }
      this.loadControllers.delete(sceneId)
      this.options.onError?.(mountError, sceneId)
      this.setState({ kind: 'error', sceneId, error: mountError })
      return
    }

    this.loadControllers.delete(sceneId)
    this.setState({ kind: 'active', sceneId, mount })
  }

  private setState(state: CoordinatorState): void {
    this._state = state
    this.options.onStateChange?.(state)
  }
}
