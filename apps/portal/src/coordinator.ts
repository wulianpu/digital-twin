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
 *
 * #10：active ownership（当前真正持有 active mount 的场景）与 transition/
 * result state（loading/denied/error）分离，且恒等式
 * `active !== undefined ⇒ active.mount.state === 'active'`——
 * active 不兼任已卸载 previous 的回滚候选别名。
 *
 * #10-r2（复审）：generation 只是 **commit authority**，不是已开始的
 * destructive 副作用的撤销机制。stale 事务在 `host.unmount()` 完成后必须
 * **reconcile（补偿或交接）**：若最新 intent 不会 mount（denied / same-scene
 * no-op），stale 事务负责把 previous 恢复运行；若最新 intent 会 mount 新
 * target，则由它接管 Host。这样 denied 语义"当前场景继续运行"在任何
 * 交错下都成立。
 */
interface ActiveScene {
  definition: SceneDefinition
  sceneId: SceneId
  mount: HostMount
}

interface SwitchIntent {
  generation: number
  /** mount：该 generation 将 mount 新 target；noop：denied/same-scene，不会 mount。 */
  kind: 'mount' | 'noop'
}

export class SceneCoordinator {
  private generation = 0
  private loadControllers = new Map<SceneId, AbortController>()
  private _state: CoordinatorState = { kind: 'idle' }
  private active: ActiveScene | undefined
  private latestIntent: SwitchIntent = { generation: 0, kind: 'noop' }
  /** reconcile 串行化：补偿恢复不与其它补偿并发争抢 Host。 */
  private reconcileTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly host: SceneHost,
    private readonly catalog: readonly SceneDefinition[],
    private readonly options: SceneCoordinatorOptions = {}
  ) {}

  get state(): CoordinatorState {
    return this._state
  }

  /** 当前实际拥有 active mount 的场景（denied/loading 等过渡态不丢失）。 */
  get activeSceneId(): SceneId | undefined {
    return this.active?.sceneId
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
      // unknown scene 是编程错误而非用户选择 intent，不参与 generation 失效
      this.options.onError?.(new Error(`unknown scene "${sceneId}"`), sceneId)
      return
    }

    // Last selection wins: invalidate every pending switch (§11).
    // #10-A：selection intent invalidation 必须在所有 preflight 之前——
    // permission-denied 也是一次新的用户选择，同样使更早的 pending 失效。
    // generation 是 stale-result suppression 的唯一 commit authority：
    // 每个 await 之后、每次 commit/onError 之前都要重查。
    const generation = ++this.generation
    const isCurrent = (): boolean => generation === this.generation
    for (const controller of this.loadControllers.values()) controller.abort()
    this.loadControllers.clear()
    const loadController = new AbortController()
    this.loadControllers.set(sceneId, loadController)
    // 问题4-2：按 controller identity 清理——stale generation 不得误删
    // 同 sceneId 后续 generation 创建的新 controller。
    const releaseLoadController = (): void => {
      if (this.loadControllers.get(sceneId) === loadController) {
        this.loadControllers.delete(sceneId)
      }
    }
    // #10-r2：默认该 intent 不会 mount（denied / same-scene no-op）；
    // 只有通过全部 preflight 进入切换事务时才升级为 mount intent。
    this.latestIntent = { generation, kind: 'noop' }

    // force：会话范围（站点）变化时，App 决定重跑当前场景（§"App decides
    // what to run"）——绕过同场景守卫，仍走完整切换事务（§11）。
    if (!options.force && this.active?.sceneId === sceneId) {
      releaseLoadController()
      return
    }

    // I2-2: 强制权限边界——无权限时绝不触碰 load / host.mount。
    // #10-C：denied 不改变 active ownership——当前场景继续运行。
    if (
      this.options.permissions &&
      !canEnter(definition, this.options.permissions())
    ) {
      releaseLoadController()
      this.options.onError?.(
        new Error(`permission denied for scene "${sceneId}"`),
        sceneId
      )
      this.setState({ kind: 'denied', sceneId })
      return
    }

    // #10-B：previous 连同 mount identity 一起快照——unmount 完成后按
    // identity 清理 active，保证 active 只代表真实 active mount。
    const previous = this.active
      ? {
          definition: this.active.definition,
          sceneId: this.active.sceneId,
          mount: this.active.mount
        }
      : undefined
    this.latestIntent = { generation, kind: 'mount' }

    this.setState({ kind: 'loading', target: sceneId })

    let entry
    try {
      entry = await definition.load()
      if (!isCurrent()) {
        releaseLoadController()
        return // superseded success：丢弃，不得 commit
      }
    } catch (loadError) {
      releaseLoadController()
      if (!isCurrent()) return // stale rejection：不得覆盖更新的 Scene 状态
      this.options.onError?.(loadError, sceneId)
      this.setState({ kind: 'error', sceneId, error: loadError })
      return
    }

    // UNMOUNT CURRENT → MOUNT TARGET (host enforces §12 teardown rules).
    await this.host.unmount()
    // #10-r2-A：previous 已被本事务完整卸载——按 identity 立即清除 ownership，
    // active 不再充当已卸载场景的别名。
    this.clearActiveIf(previous?.mount)
    if (!isCurrent()) {
      // stale-after-destructive-unmount：补偿或交接，不能只 return
      releaseLoadController()
      await this.reconcileAfterUnmount(previous)
      return
    }

    let mount: HostMount
    try {
      mount = await this.host.mount(entry, { sceneId })
      if (mount.state !== 'active') {
        throw new Error(`scene "${sceneId}" did not reach active state`)
      }
      if (!isCurrent()) {
        // stale success：B 不是最新 intent 想要的场景——先 teardown，
        // 再补偿（若最新 intent 不会 mount，恢复 previous 运行）
        await mount.unmount().catch(() => {})
        releaseLoadController()
        await this.reconcileAfterUnmount(previous)
        return
      }
    } catch (mountError) {
      releaseLoadController()
      if (!isCurrent()) return // stale rejection：不得覆盖 C 的 ACTIVE
      // 问题4：真回滚——目标 mount 失败后尝试恢复 previous scene；
      // Last Selection Wins：generation 变化时过期回滚不得执行。
      if (previous) {
        try {
          const prevEntry = await previous.definition.load()
          if (!isCurrent()) return
          const prevMount = await this.host.mount(prevEntry, {
            sceneId: previous.sceneId
          })
          if (prevMount.state !== 'active') {
            throw new Error(
              `previous scene "${previous.sceneId}" did not reach active state`
            )
          }
          if (!isCurrent()) {
            if (this.newestIntentWillMount()) {
              // 最新事务会接管 Host：回收本次回滚 mount（旧测试语义保持）
              await prevMount.unmount().catch(() => {})
            } else {
              // #10-r2：最新 intent（denied / same-scene no-op）期望 previous
              // 继续运行——回滚 mount 直接转移 ownership（避免卸了再装的抖动）
              this.active = {
                definition: previous.definition,
                sceneId: previous.sceneId,
                mount: prevMount
              }
              this.setState({ kind: 'active', sceneId: previous.sceneId, mount: prevMount })
            }
            return
          }
          this.active = {
            definition: previous.definition,
            sceneId: previous.sceneId,
            mount: prevMount
          }
          this.setState({ kind: 'active', sceneId: previous.sceneId, mount: prevMount })
          this.options.onError?.(mountError, sceneId)
          return
        } catch (rollbackError) {
          // #10-r2-C：回滚双失败——伪 ownership 必须清除，
          // 否则 same-scene guard 会永久阻断用户重试 previous
          this.active = undefined
          if (!isCurrent()) return
          this.options.onError?.(rollbackError, previous.sceneId)
          this.setState({ kind: 'error', sceneId, error: rollbackError })
          return
        }
      }
      this.options.onError?.(mountError, sceneId)
      this.setState({ kind: 'error', sceneId, error: mountError })
      return
    }

    releaseLoadController()
    this.active = { definition, sceneId, mount }
    this.setState({ kind: 'active', sceneId, mount })
  }

  /** active 与 mount identity 绑定：仅当 active 就是该 mount 时清除。 */
  private clearActiveIf(mount: HostMount | undefined): void {
    if (mount && this.active?.mount === mount) this.active = undefined
  }

  /** 最新 intent 是否会 mount 新 target（会则由它接管 Host）。 */
  private newestIntentWillMount(): boolean {
    return this.latestIntent.kind === 'mount'
  }

  /**
   * stale-after-destructive-unmount 的补偿语义（#10-r2-B）：
   * - 最新 intent 会 mount → 交接给它；
   * - 最新 intent 是 noop（denied / same-scene re-select）→ 恢复 previous
   *   运行，保证"denied 不改变当前场景"在任何交错下成立。
   * 提交前再次检查最新 intent，veto 时卸掉补偿 mount。
   */
  private reconcileAfterUnmount(
    previous: { definition: SceneDefinition; sceneId: SceneId } | undefined
  ): Promise<void> {
    const run = async (): Promise<void> => {
      if (!previous || this.newestIntentWillMount()) return
      try {
        const entry = await previous.definition.load()
        const mount = await this.host.mount(entry, { sceneId: previous.sceneId })
        if (mount.state !== 'active') {
          throw new Error(
            `previous scene "${previous.sceneId}" did not reach active state`
          )
        }
        if (this.newestIntentWillMount()) {
          await mount.unmount().catch(() => {})
          return
        }
        this.active = {
          definition: previous.definition,
          sceneId: previous.sceneId,
          mount
        }
        this.setState({ kind: 'active', sceneId: previous.sceneId, mount })
      } catch (error) {
        this.clearActiveIf(undefined)
        this.active = undefined
        if (!this.newestIntentWillMount()) {
          this.options.onError?.(error, previous.sceneId)
        }
      }
    }
    const runSerialized = this.reconcileTail.then(run, run)
    this.reconcileTail = runSerialized.catch(() => {})
    return runSerialized
  }

  private setState(state: CoordinatorState): void {
    this._state = state
    this.options.onStateChange?.(state)
  }
}
