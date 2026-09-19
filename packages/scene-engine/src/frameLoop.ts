import type { FrameInfo } from './types'

export type FrameCallback = (info: FrameInfo) => void

/**
 * The ONE render loop owner (§21). Scenes never touch rAF; they subscribe
 * here and the subscription dies with the mount lifecycle.
 */
export class FrameLoop {
  private rafId: number | undefined
  private running = false
  private lastTime = 0
  private elapsed = 0
  private frameIndex_ = 0
  private readonly callbacks = new Set<FrameCallback>()
  private readonly frameTimes: number[] = []
  private lastStatsAt = 0

  fps = 0
  p50Ms = 0
  p95Ms = 0

  get frameIndex(): number {
    return this.frameIndex_
  }

  constructor(
    private readonly requestFrame: (cb: (t: number) => void) => number = (cb) => requestAnimationFrame(cb),
    private readonly statsIntervalMs = 500
  ) {}

  get callbackCount(): number {
    return this.callbacks.size
  }

  onFrame(cb: FrameCallback): () => void {
    this.callbacks.add(cb)
    return () => {
      this.callbacks.delete(cb)
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    const tick = (t: number) => {
      if (!this.running) return
      this.rafId = this.requestFrame(tick)
      this.runFrame(t)
    }
    this.rafId = this.requestFrame(tick)
  }

  stop(): void {
    this.running = false
    if (this.rafId !== undefined) {
      // cancelAnimationFrame is the natural inverse; accept the handle type.
      cancelAnimationFrame(this.rafId)
      this.rafId = undefined
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** One manual frame (tests / deterministic stepping). */
  runFrame(nowMs: number = performance.now()): void {
    const delta = Math.min(0.25, Math.max(0, (nowMs - this.lastTime) / 1000))
    this.lastTime = nowMs
    this.elapsed += delta
    this.frameIndex_++
    this.recordFrameTime(delta * 1000, nowMs)
    const info: FrameInfo = {
      deltaSeconds: delta,
      elapsedSeconds: this.elapsed,
      frameIndex: this.frameIndex_
    }
    for (const cb of [...this.callbacks]) {
      cb(info)
    }
  }

  dispose(): void {
    this.stop()
    this.callbacks.clear()
    this.frameTimes.length = 0
  }

  private recordFrameTime(ms: number, nowMs: number): void {
    this.frameTimes.push(ms)
    if (this.frameTimes.length > 300) this.frameTimes.shift()
    const now = nowMs
    if (now - this.lastStatsAt >= this.statsIntervalMs) {
      this.lastStatsAt = now
      const sorted = [...this.frameTimes].sort((a, b) => a - b)
      this.p50Ms = percentile(sorted, 0.5)
      this.p95Ms = percentile(sorted, 0.95)
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length)
      this.fps = avg > 0 ? 1000 / avg : 0
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))
  return sorted[index]
}

/**
 * Issue #35：render-loop 的统一 run authority——多个独立「禁止渲染」原因
 * （app/mode suspend、WebGL context lost、terminal dispose）的合取 gate。
 *
 * 核心不变量：任意 blocking reason 仍为 true 时，另一个 reason 被解除都
 * 不得启动 FrameLoop（`shouldRun = !disposed && !appSuspended && !contextLost`）。
 * 之前 mode/app suspend 直接操作 FrameLoop、context-loss 只 stop 不进状态，
 * 「inactive → context lost → 切回 active」会在 GPU 恢复前越权重启 RAF。
 * reconcile 幂等（FrameLoop.start 自身防重入），不会产生重复 RAF。
 */
export class RenderLoopGate {
  private appSuspended = false
  private contextLost = false
  private disposed = false

  constructor(
    private readonly loop: { start(): void; stop(): void }
  ) {}

  private reconcile(): void {
    if (this.canRender) this.loop.start()
    else this.loop.stop()
  }

  /** app / frame-mode 的临时暂停（#31 mode route、workspace 切换等）。 */
  setAppSuspended(suspended: boolean): void {
    this.appSuspended = suspended
    this.reconcile()
  }

  /** WebGL context lost/restored（ContextLossGuard 接线）。 */
  setContextLost(lost: boolean): void {
    this.contextLost = lost
    this.reconcile()
  }

  /** terminal——最高优先级：dispose 后任何 reason 解除都不得恢复运行。 */
  dispose(): void {
    this.disposed = true
    this.reconcile()
  }

  get canRender(): boolean {
    return !this.disposed && !this.appSuspended && !this.contextLost
  }
}
