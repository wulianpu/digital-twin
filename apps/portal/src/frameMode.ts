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
 * - mode 在 mount 的 use() 时刻提交（与 Scene switch transaction 对齐，
 *   rapid GLOBAL→SITE→GLOBAL 最后选择获胜）；
 * - 非活跃 runtime 保持 suspend（无双 RAF/渲染），其 canvas 从 viewport
 *   移除，避免双 renderer 画布叠放；
 * - View binding 通过 `active` + `mode` 读取同一已提交 authority——
 *   不存在 Engine=GLOBAL 但 View=SITE 的可构造正常状态。
 */
export type FrameMode = 'global' | 'site'

export interface ModeRoutingGraphicsAccess extends GraphicsAccess {
  /** 最近一次 use() 提交的 mode（初始值来自 resolveMode）。 */
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
   * mode 提交：与 Scene switch 对齐——use() 是唯一提交点。
   * 幂等：同 mode 重复 use() 不重复 suspend/canvas 操作。
   */
  function commitMode(mode: FrameMode): void {
    committed = mode
    if (routed === mode) return
    routed = mode
    const inactive = accessFor(otherOf(mode))
    inactive.suspend()
    const inactiveCanvas = canvasOf(inactive)
    inactiveCanvas?.remove()
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
      commitMode(args.resolveMode())
      return accessFor(committed).use()
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
      args.global.dispose()
      args.site.dispose()
    }
  }
}
