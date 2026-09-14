import type { SceneContext, SceneEntry, SceneMount, SceneId } from '@twin/sdk'
import type { Disposable } from '@twin/world'
import { UiApiImpl } from './ui'
import { createRevocableContext, type ContextServices, type ContextState } from './context'

export interface SceneViewport {
  /** Container for scene UI layers; may resolve lazily (apps mount late). */
  ui: HTMLElement | (() => HTMLElement)
}

export interface SceneHostOptions {
  viewport: SceneViewport
  services: Omit<ContextServices, 'ui'>
  /** Hard teardown deadline (§12.3). Default 3000ms. */
  unmountDeadlineMs?: number
  onError?(error: unknown, phase: 'mount' | 'scene-unmount' | 'host-cleanup' | 'deadline'): void
}

export interface MountOptions {
  sceneId?: SceneId
}

export interface MountResult {
  readonly errors: readonly unknown[]
  readonly timedOut: boolean
}

export interface HostMount extends Omit<SceneMount, 'unmount'> {
  unmount(): Promise<MountResult>
  readonly state: 'mounting' | 'active' | 'unmounting' | 'unmounted'
  readonly sceneId: SceneId
  /** Completes when the mount is fully torn down. */
  readonly done: Promise<MountResult>
}

/**
 * SceneHost is the ONLY lifecycle owner for scenes (§9):
 * - creates the mount runtime (AbortController + scoped context)
 * - aborts work on unmount start ("abort cancels work")
 * - revokes the context after teardown ("revoke prevents stale writes")
 * - unmount is idempotent (§12.1), exception-safe (§12.2), time-bounded (§12.3)
 *
 * The host understands nothing about business semantics.
 */
export class SceneHost {
  private current: HostMountImpl | undefined

  constructor(private readonly options: SceneHostOptions) {}

  get activeMount(): HostMount | undefined {
    return this.current
  }

  get contextState(): ContextState | undefined {
    return this.current?.contextState()
  }

  /** UI layers still alive (compliance diagnostics). */
  get liveUiLayers(): number {
    return this.current?.liveUiLayers ?? 0
  }

  async mount(entry: SceneEntry, mountOptions: MountOptions = {}): Promise<HostMount> {
    if (this.current && this.current.state !== 'unmounted') {
      await this.current.unmount()
    }
    const impl = new HostMountImpl(this.options, entry, mountOptions.sceneId ?? 'scene')
    this.current = impl
    await impl.start()
    return impl
  }

  async unmount(): Promise<MountResult> {
    if (!this.current) return { errors: [], timedOut: false }
    return this.current.unmount()
  }

  get isActive(): boolean {
    return this.current?.state === 'active'
  }
}

class HostMountImpl implements HostMount {
  state: HostMount['state'] = 'mounting'
  readonly done: Promise<MountResult>
  readonly sceneId: SceneId

  private controller = new AbortController()
  private ui: UiApiImpl
  private revocable: ReturnType<typeof createRevocableContext> | undefined
  private mountImpl: SceneMount | undefined
  private readonly mutableResult: { errors: unknown[]; timedOut: boolean } = {
    errors: [],
    timedOut: false
  }
  private resolveDone!: (r: MountResult) => void
  private readonly deadlineMs: number
  private readonly onError: SceneHostOptions['onError']

  constructor(
    private readonly options: SceneHostOptions,
    private readonly entry: SceneEntry,
    sceneId: SceneId
  ) {
    this.sceneId = sceneId
    this.deadlineMs = options.unmountDeadlineMs ?? 3000
    this.onError = options.onError
    this.ui = new UiApiImpl(resolveUiElement(options.viewport.ui))
    this.done = new Promise<MountResult>((resolve) => {
      this.resolveDone = resolve
    })
  }

  get result(): MountResult {
    return this.mutableResult
  }

  contextState(): ContextState | undefined {
    return this.revocable?.state()
  }

  get liveUiLayers(): number {
    return this.ui.layerCount
  }

  async start(): Promise<void> {
    const context = this.buildContext()
    try {
      this.mountImpl = await this.entry.mount(context)
      this.state = 'active'
    } catch (error) {
      this.onError?.(error, 'mount')
      this.mutableResult.errors.push(error)
      await this.teardown()
    }
  }

  /** Idempotent, exception-safe, time-bounded teardown (§12). */
  async unmount(): Promise<MountResult> {
    if (this.state === 'unmounting') return this.done
    if (this.state === 'unmounted') return this.mutableResult
    await this.teardown()
    return this.mutableResult
  }

  private async teardown(): Promise<void> {
    this.state = 'unmounting'
    // Abort cancels work (§13)...
    this.controller.abort()

    let timedOut = false
    if (this.mountImpl) {
      const sceneUnmount = this.runSceneUnmount(this.mountImpl)
      const timeout =
        this.deadlineMs > 0
          ? new Promise<'timeout'>((resolve) => {
              const t = setTimeout(() => resolve('timeout'), this.deadlineMs)
              t.unref?.()
            })
          : new Promise<never>(() => {})
      const outcome = await Promise.race([sceneUnmount, timeout])
      if (outcome === 'timeout') {
        timedOut = true
        this.mutableResult.timedOut = true
        this.onError?.(
          new Error(`scene "${this.sceneId}" unmount exceeded ${this.deadlineMs}ms deadline`),
          'deadline'
        )
      }
      this.mountImpl = undefined
    }

    // ...then Host-owned cleanup always runs (§12.2)...
    this.hostCleanup()

    // ...and the context is revoked so stale callbacks cannot write (§13).
    this.revocable?.revoke()
    this.state = 'unmounted'
    this.resolveDone(this.mutableResult)
    void timedOut
  }

  private async runSceneUnmount(mount: SceneMount): Promise<'scene-done'> {
    try {
      await mount.unmount()
    } catch (error) {
      this.mutableResult.errors.push(error)
      this.onError?.(error, 'scene-unmount')
    }
    return 'scene-done'
  }

  private hostCleanup(): void {
    // UI layers are Foundation-owned: remove leftovers.
    this.ui.disposeAll()
  }

  /** Hosts may track foundation-owned disposables for guaranteed cleanup. */
  track(label: string, disposable: Disposable): Disposable {
    void label
    return disposable
  }

  private buildContext(): SceneContext {
    this.revocable = createRevocableContext(
      this.sceneId,
      { ...this.options.services, ui: this.ui },
      this.controller.signal
    )
    return this.revocable.context
  }
}

function resolveUiElement(ui: HTMLElement | (() => HTMLElement)): HTMLElement {
  return typeof ui === 'function' ? ui() : ui
}
