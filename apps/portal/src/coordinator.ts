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

  async select(sceneId: SceneId): Promise<void> {
    const definition = this.get(sceneId)
    if (!definition) {
      this.options.onError?.(new Error(`unknown scene "${sceneId}"`), sceneId)
      return
    }
    if (this._state.kind === 'active' && this._state.sceneId === sceneId) return

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
    try {
      const entry = await definition.load()
      if (generation !== this.generation) return // superseded

      // UNMOUNT CURRENT → MOUNT TARGET (host enforces §12 teardown rules).
      await this.host.unmount()
      if (generation !== this.generation) return

      const mount = await this.host.mount(entry, { sceneId })
      if (generation !== this.generation) {
        await mount.unmount()
        return
      }

      this.loadControllers.delete(sceneId)
      this.setState({ kind: 'active', sceneId, mount })
    } catch (error) {
      this.loadControllers.delete(sceneId)
      if (generation !== this.generation) return // superseded failure: ignore
      this.options.onError?.(error, sceneId)
      this.setState({ kind: 'error', sceneId, error })
    }
  }

  private setState(state: CoordinatorState): void {
    this._state = state
    this.options.onStateChange?.(state)
  }
}
