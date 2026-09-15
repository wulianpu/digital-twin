/**
 * Scene 共享的 2D↔3D view intent 控制器（Issue #18-r2）。
 *
 * 职责边界：只管理 lazy prepare（single-flight joinable boot）+ intent
 * generation + latest-view commit + 失败回滚；业务逻辑留在各 Scene。
 *
 * 不变量：
 * - monotonic intent generation：跨 await 的 continuation 提交副作用前必须
 *   isCurrent（联合 isAborted，teardown 语义由 Scene 侧处理）；
 * - boot single-flight 可 join：后续同向 intent join 同一 attempt；
 * - boot 成功只是资源准备——按【最新 intent】提交；最新 intent 为 map 时
 *   显式挂起新建 runtime（真实 runtime 默认 ACTIVE 并已启动 frameLoop）；
 * - 失败语义分离：当前 graphics intent 的失败 → 回滚到 map + 错误通道
 *   （可重试，不留 "UI=graphics 但无 handle" 的不可重试状态）；stale intent
 *   的失败 → 不污染当前视图，仅记录。
 */

export type SceneView = 'map' | 'graphics'

export interface SceneViewCallbacks {
  /** single-flight 资源准备：进入 3D 所需的 mount（仅首次 boot 调用一次）。 */
  prepareGraphics(): Promise<unknown>
  /**
   * 应用最新 intent 到底层的 suspend/resume：
   * map → map.resume + graphics.suspend；graphics → map.suspend + graphics.resume。
   * boot pending 时不会被调用（完成路径会按最新 intent 再提交）。
   */
  applyActiveView(view: SceneView): void
  /**
   * boot 成功但最新 intent 已是 map：显式挂起刚创建的 graphics runtime——
   * 真实 runtime 创建后默认 ACTIVE（frameLoop 已启动），不能只依赖
   * “runtime 尚不存在时的 suspend”。
   */
  suspendGraphics(): void
  /** view 事件派发（控制器按 lastDispatched 去重）。 */
  dispatchView(view: SceneView): void
  /** SceneMount teardown 探测（ctx.signal.aborted）。 */
  isAborted(): boolean
  /** intent 变化同步（Scene 用它维护 state.view）。 */
  onIntentChanged(view: SceneView): void
  /** boot 失败回滚到 map（Scene 用它同步 state.view）。 */
  onRollbackToMap(): void
  /** boot 失败错误通道（UI/telemetry；当前 intent 的失败必须可见）。 */
  onGraphicsError(error: unknown): void
}

export class SceneViewController {
  private intent = 0
  private desired: SceneView = 'map'
  private lastDispatched: SceneView | undefined
  private boot: Promise<unknown> | undefined
  private booted = false

  constructor(private readonly cb: SceneViewCallbacks) {}

  /** 当前期望视图（映射到 Scene 的 state.view）。 */
  get view(): SceneView {
    return this.desired
  }

  get isBooting(): boolean {
    return this.boot !== undefined
  }

  /** SceneMount lifetime authority（所有跨 await continuation 的统一 gate）。 */
  private alive(): boolean {
    return !this.cb.isAborted()
  }

  async setView(view: SceneView): Promise<void> {
    if (this.desired === view && !this.boot) return
    const generation = ++this.intent
    this.desired = view
    this.cb.onIntentChanged(view)

    if (view === 'graphics' && !this.booted && !this.boot) {
      this.boot = this.cb.prepareGraphics()
    }

    if (this.boot) {
      try {
        await this.boot
        this.booted = true
        this.boot = undefined
      } catch (error) {
        this.boot = undefined
        // #18-r3：boot reject 不是重新获得 commit authority 的理由——
        // SceneMount 已 abort 时，failure continuation 与 success continuation
        // 一样是 terminal no-op：不 rollback / 不 applyActiveView /
        // 不 dispatchView / 不把正常 teardown race 报成 3D 初始化故障。
        // （成功路径的 isAborted 检查保留；见 alive()。）
        if (this.cb.isAborted()) return
        if (this.desired === 'graphics') {
          // 当前 graphics intent 的失败：回滚到 map + 明确错误通道
          //（可重试——desired 复位后下一次 setView('graphics') 不被阻断）
          this.desired = 'map'
          this.cb.onRollbackToMap()
          this.commit()
          this.cb.onGraphicsError(error)
          return
        }
        // stale（最新 intent 已是 map）：不污染当前视图，仅记录
        this.cb.onGraphicsError(error)
        return
      }
    }

    if (!this.alive()) return

    // #18-r2：boot 成功而最新 intent 已是 map——显式挂起新 runtime
    if (this.desired === 'map' && this.booted) {
      this.cb.suspendGraphics()
    }

    this.commit(generation)
  }

  private commit(generation?: number): void {
    // boot pending：完成路径会按最新 intent 再提交
    if (this.desired === 'graphics' && this.boot) return
    this.cb.applyActiveView(this.desired)
    if (this.lastDispatched !== this.desired) {
      this.lastDispatched = this.desired
      this.cb.dispatchView(this.desired)
    }
    void generation
  }
}
