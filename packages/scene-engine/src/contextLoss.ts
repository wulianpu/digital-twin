/**
 * Context Loss 守护（§75，I5-4）：GPU context 是可丢失资源，不是世界真值。
 * 丢失 → 停帧（suspend）；恢复 → 重置渲染状态并续跑，表示层由既有 JS 数据
 * 自动重建——Scene 无需重新请求业务真值。
 * 抽取为独立类以便单元演练（ContextLossGuard 无 DOM 依赖，仅 EventTarget）。
 */
export interface ContextLossHooks {
  suspendLoop(): void
  resumeLoop(): void
  resetRendererState(): void
  onLost?(): void
  onRestored?(): void
}

export class ContextLossGuard {
  private readonly target: EventTarget
  private readonly hooks: ContextLossHooks
  private readonly handleLost = (e: Event): void => {
    // preventDefault 允许上下文随后被恢复（WEBGL_lose_context）。
    e.preventDefault()
    this.lost = true
    this.hooks.suspendLoop()
    this.hooks.onLost?.()
  }
  private readonly handleRestored = (): void => {
    this.lost = false
    this.hooks.resetRendererState()
    this.hooks.resumeLoop()
    this.hooks.onRestored?.()
  }

  /** 是否处于丢失状态（诊断/演练用）。 */
  lost = false

  constructor(target: EventTarget, hooks: ContextLossHooks) {
    this.target = target
    this.hooks = hooks
    target.addEventListener('webglcontextlost', this.handleLost as EventListener)
    target.addEventListener('webglcontextrestored', this.handleRestored as EventListener)
  }

  dispose(): void {
    this.target.removeEventListener('webglcontextlost', this.handleLost as EventListener)
    this.target.removeEventListener('webglcontextrestored', this.handleRestored as EventListener)
  }
}
