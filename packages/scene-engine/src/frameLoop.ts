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
