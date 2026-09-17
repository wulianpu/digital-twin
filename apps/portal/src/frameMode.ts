import type {
  GraphicsAccess,
  GraphicsContext,
  GraphicsDiagnostics,
  QualityProfile,
  SceneEngineState
} from '@twin/sdk'

/**
 * Issue #31（方案 B）：单一 mode authority 路由双 GraphicsAccess。
 *
 * Engine lifetime（WebGLRenderer / cache）≠ ReferenceFrame mode lifetime：
 * GLOBAL 与 SITE 是两个 app-owned 独立 runtime（SceneEngineOptions.global
 * 是 boot-time 决策），由本 router 按 **同一 mode authority** 分发：
 *
 * - Scene 经 services.graphics 拿到的永远是本 router——Scene 不能自行
 *   创建/切换 frame policy（§27 Foundation ownership）；
 * - use() 是 **prepare → revalidate → commit 两阶段事务**（#31 复审）：
 *   先 await 目标 access boot，再按最新 authority 校验——boot 期间
 *   authority 易主时，晚到的 runtime 被 quarantine（suspend + canvas
 *   移出 viewport），调用方 mount 以 stale 拒绝。rapid
 *   GLOBAL→SITE→GLOBAL 最后选择获胜，且旧 continuation 不会误伤已重新
 *   选中的同侧 runtime（按 access identity 比较，而非 mode 字符串）；
 * - `mode` 只反映已完成 commit 的 authority（View binding 同源读取），
 *   boot pending 期间 View 仍指向旧 runtime——不存在
 *   "Engine=GLOBAL 但 View=SITE" 的可构造正常状态；
 * - 非活跃 runtime 保持 suspend（无双 RAF/渲染），canvas 从 viewport
 *   移除，避免双 renderer 画布叠放。
 */
export type FrameMode = 'global' | 'site'

export interface ModeRoutingGraphicsAccess extends GraphicsAccess {
  /** 最近一次 commit 的 mode（初始值来自 resolveMode；boot pending 期间不变）。 */
  readonly mode: FrameMode
  /** 当前已提交 mode 对应的底层 access（View binding 与 graphics 同源）。 */
  readonly active: GraphicsAccess
}

export function createModeRoutingGraphicsAccess(args: {
  resolveMode(): FrameMode
  global: GraphicsAccess
  site: GraphicsAccess
  /** 共享 3D viewport——canvas DOM 归属随 mode 切换。 */
  viewport: () => HTMLElement | undefined
}): ModeRoutingGraphicsAccess {
  let committed = args.resolveMode()
  let routed: FrameMode | undefined
  let disposed = false

  const accessFor = (mode: FrameMode): GraphicsAccess =>
    mode === 'global' ? args.global : args.site
  const otherOf = (mode: FrameMode): FrameMode => (mode === 'global' ? 'site' : 'global')

  function canvasOf(access: GraphicsAccess): HTMLElement | undefined {
    const renderer = access.currentContext?.renderer as
      | { domElement?: HTMLElement }
      | undefined
    return renderer?.domElement
  }

  /**
   * #31-r3： GraphicsAccess.use() 成功创建的 mount-owned root（真实
   * createMountRoot 已 attach 进场景层级）只有两种合法归宿——随成功
   * context transfer 给 MountScope，或在 transfer 前的失败路径由当前
   * owner（router）立即 detach。不存在"创建后 reject 且无人拥有"的状态。
   */
  function discardContext(ctx: GraphicsContext): void {
    try {
      ctx.root.removeFromParent?.()
    } catch {
      // runtime 已 teardown 时忽略
    }
  }

  /**
   * #31 复审：晚到的 boot runtime 已在 createRuntime 中自启动（RAF +
   * canvas append）。commit 时 authority 已易主则必须显式回收——底层
   * GraphicsAccess.suspend 对 pending boot 是 no-op，这里是唯一的兜底。
   */
  function quarantine(access: GraphicsAccess): void {
    access.suspend()
    canvasOf(access)?.remove()
  }

  /**
   * mode 提交（仅在 revalidate 通过后调用）：suspend 非活跃侧、迁移
   * canvas、resume 目标侧。同 mode 幂等——不重复 suspend/resume。
   */
  function commitMode(mode: FrameMode): void {
    committed = mode
    if (routed === mode) return
    routed = mode
    const inactive = accessFor(otherOf(mode))
    inactive.suspend()
    canvasOf(inactive)?.remove()
    const active = accessFor(mode)
    // 切回已 boot 的 runtime 必须恢复运行（不产生双 RAF——另一个已 suspend）
    active.resume()
    const activeCanvas = canvasOf(active)
    const viewport = args.viewport()
    if (activeCanvas && viewport && activeCanvas.parentElement !== viewport) {
      viewport.appendChild(activeCanvas)
    }
  }

  return {
    get mode() {
      return committed
    },
    get active() {
      return accessFor(committed)
    },
    use(): Promise<GraphicsContext> {
      if (disposed) {
        return Promise.reject(new Error('[portal] graphics router disposed'))
      }
      const desired = args.resolveMode()
      const target = accessFor(desired)
      return target.use().then((ctx) => {
        if (disposed) {
          discardContext(ctx)
          quarantine(target)
          throw new Error('[portal] graphics router disposed during boot')
        }
        // revalidate：按 access identity 比较——GLOBAL→SITE→GLOBAL 时旧
        // continuation 重新命中同侧 access，不得误判为 stale
        const current = args.resolveMode()
        if (accessFor(current) !== target) {
          // #31-r3：本次 ctx 的 mount root 已在底层 fromAttempt 创建并
          // attach——reject 前必须先 detach（不依赖 MountScope 的
          // post-await cleanup：stale 时 scope 根本拿不到 ctx）
          discardContext(ctx)
          quarantine(target)
          throw new Error('[portal] frame-mode route superseded before boot resolved')
        }
        commitMode(current)
        return ctx
      })
    },
    get state(): SceneEngineState {
      return accessFor(committed).state
    },
    get currentContext() {
      return accessFor(committed).currentContext
    },
    applyQuality(profile: QualityProfile) {
      // 两个 runtime 都应用——后 boot 的一个也不带旧 profile
      args.global.applyQuality(profile)
      args.site.applyQuality(profile)
    },
    suspend() {
      accessFor(committed).suspend()
    },
    resume() {
      accessFor(committed).resume()
    },
    getDiagnostics(): GraphicsDiagnostics | undefined {
      return accessFor(committed).getDiagnostics()
    },
    dispose() {
      if (disposed) return
      disposed = true
      args.global.dispose()
      args.site.dispose()
    }
  }
}
