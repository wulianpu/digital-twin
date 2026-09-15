import type { SceneContext, SceneEntry, SceneId, SceneMount } from '@twin/sdk'
import type { Disposable } from '@twin/world'
import { UiApiImpl } from './ui'
import { MountScope } from './scope'
import {
  scopedAssetApi,
  scopedDataApi,
  scopedGraphicsAccess,
  scopedMapAccess,
  scopedUiApi
} from './scoped'
import {
  scopedWorldApi,
  scopedSpatialApi,
  scopedSelectionApi,
  scopedViewApi
} from './scopedLifecycle'
import {
  createRevocableContext,
  type ContextServices,
  type ContextState
} from './context'

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
 * SceneHost is the ONLY lifecycle owner for scenes (§9, Issue #1)：
 *
 * teardown 事务（严格顺序）：
 *   1. MountScope.close()   拒绝创建新资源
 *   2. AbortController      abort 取消进行中工作
 *   3. Scene unmount        （限时竞速，§12.3）
 *   4. MountScope.dispose() Host 兜底释放 tracked 资源
 *   5. UI layers 清理
 *   6. context revoke       拒绝一切后续访问
 *
 * mount 失败契约（问题1）：entry.mount() 抛错 → cleanup 完成后**重新抛出**
 * 原始错误——Coordinator 据此进入 ERROR 并可回滚，绝不会把失败 mount
 * commit 成 ACTIVE。
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
    await impl.start() // 问题1：失败在此处 reject（cleanup 已由 impl 保证）
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
  private readonly scope = new MountScope()
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
      this.mutableResult.errors.push(error)
      this.onError?.(error, 'mount')
      // 问题1：cleanup（含 scoped 资源兜底 + revoke）完成后重新抛出——
      // Coordinator 据此进入 ERROR，不会把失败 mount commit 成 ACTIVE。
      await this.teardown()
      throw error
    }
  }

  async unmount(): Promise<MountResult> {
    if (this.state === 'unmounting') return this.done
    if (this.state === 'unmounted') return this.result
    await this.teardown()
    return this.mutableResult
  }

  /** Idempotent, exception-safe, time-bounded teardown（§12，严格顺序见类注释）。 */
  private async teardown(): Promise<void> {
    if (this.state === 'unmounting' || this.state === 'unmounted') {
      // 并发/重复 teardown：等待既有序列完成
      await this.done
      return
    }
    this.state = 'unmounting'

    // 1. 拒绝创建新资源（close 后 subscribe/acquire/createLayer/use 抛错）
    this.scope?.close()

    // 2. abort 取消进行中工作（§13）
    this.controller.abort()

    // 3. Scene unmount：限时竞速（§12.3）；异常安全（§12.2）
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
        this.mutableResult.timedOut = true
        this.onError?.(
          new Error(`scene "${this.sceneId}" unmount exceeded ${this.deadlineMs}ms deadline`),
          'deadline'
        )
      }
      this.mountImpl = undefined
    }

    // 4. Host 兜底释放 scoped tracked 资源（无论 Scene cleanup 成功/throw/超时）
    this.scope?.dispose()

    // 5. UI layers（Foundation-owned）
    this.ui.disposeAll()

    // 6. revoke：拒绝一切后续访问（§13）
    this.revocable?.revoke()
    this.state = 'unmounted'
    this.resolveDone(this.mutableResult)
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

  /** Host 兜底登记（供测试/诊断）。 */
  track(label: string, disposable: Disposable): Disposable {
    void label
    return disposable
  }

  private buildContext(): SceneContext {
    const services = this.options.services
    this.revocable = createRevocableContext(
      this.sceneId,
      {
        // I10-1: 全部 capability 经 scoped wrapper 注入——
        // scope dispose 后写操作变为 no-op，防止 zombie write
        world: scopedWorldApi(services.world, this.scope),
        spatial: scopedSpatialApi(services.spatial, this.scope),
        data: scopedDataApi(services.data, this.scope),
        assets: scopedAssetApi(services.assets, this.scope),
        selection: scopedSelectionApi(services.selection, this.scope),
        view: scopedViewApi(services.view, this.scope),
        ui: scopedUiApi(this.ui, this.scope),
        map: services.map ? scopedMapAccess(services.map, this.scope) : undefined,
        graphics: services.graphics
          ? scopedGraphicsAccess(services.graphics, this.scope)
          : undefined
      } as ContextServices,
      this.controller.signal
    )
    return this.revocable.context
  }
}

function resolveUiElement(ui: HTMLElement | (() => HTMLElement)): HTMLElement {
  return typeof ui === 'function' ? ui() : ui
}
