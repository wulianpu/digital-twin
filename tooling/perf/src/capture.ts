/**
 * 性能采集引擎（I5-1）：周期采样引擎诊断 → 汇总报告（JSON）。
 * 引擎本身是 tick 驱动（`sample(now)` 可手动调用），便于确定性单元测试；
 * `start()/stop()` 提供定时驱动封装。
 */

export interface DiagnosticsSnapshot {
  fps: number
  p50Ms: number
  p95Ms: number
  drawCalls: number
  triangles: number
  tilesBytes?: number
  jsHeapMB?: number
}

export interface PerfSample {
  tMs: number
  fps: number
  p50Ms: number
  p95Ms: number
  drawCalls: number
  triangles: number
  tilesBytes?: number
  jsHeapMB?: number
}

export interface PerfSummary {
  sampleCount: number
  durationMs: number
  fps: { avg: number; min: number; max: number }
  /** 引擎滚动统计的最差观测值（p50/p95 取采样期内最大，即最差帧预算）。 */
  frameMs: { p50Worst: number; p95Worst: number }
  drawCalls: { max: number }
  triangles: { max: number }
  tilesBytes: { max: number | undefined }
  jsHeapMB: { first: number | undefined; last: number | undefined; growthMB: number | undefined }
}

export interface PerfReport {
  label: string
  startedAtISO: string
  durationMs: number
  summary: PerfSummary
  samples: PerfSample[]
}

export interface PerfCaptureOptions {
  /** 固定标签，或收尾时解析（场景/视图可能在采集期间切换）。 */
  label: string | (() => string)
  durationMs: number
  intervalMs?: number
  getDiagnostics(): DiagnosticsSnapshot | undefined
  now?: () => number
  onFinished?(report: PerfReport): void
}

const num = (values: number[]): number | undefined =>
  values.length === 0 ? undefined : values[values.length - 1]

export function summarizeSamples(
  label: string | (() => string),
  startedAtISO: string,
  durationMs: number,
  samples: PerfSample[]
): PerfReport {
  const resolvedLabel = typeof label === 'function' ? label() : label
  const fpsValues = samples.map((s) => s.fps)
  const p50Values = samples.map((s) => s.p50Ms)
  const p95Values = samples.map((s) => s.p95Ms)
  const drawValues = samples.map((s) => s.drawCalls)
  const triValues = samples.map((s) => s.triangles)
  const tileValues = samples.map((s) => s.tilesBytes).filter((v): v is number => v !== undefined)
  const heapValues = samples.map((s) => s.jsHeapMB).filter((v): v is number => v !== undefined)
  const avg = (a: number[]) => (a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length)

  const first = heapValues.length > 0 ? heapValues[0] : undefined
  const last = num(heapValues)
  return {
    label: resolvedLabel,
    startedAtISO,
    durationMs,
    summary: {
      sampleCount: samples.length,
      durationMs: samples.length > 0 ? samples[samples.length - 1].tMs - samples[0].tMs : 0,
      fps: {
        avg: Math.round(avg(fpsValues) * 10) / 10,
        min: fpsValues.length ? Math.min(...fpsValues) : 0,
        max: fpsValues.length ? Math.max(...fpsValues) : 0
      },
      frameMs: {
        p50Worst: p50Values.length ? Math.max(...p50Values) : 0,
        p95Worst: p95Values.length ? Math.max(...p95Values) : 0
      },
      drawCalls: { max: drawValues.length ? Math.max(...drawValues) : 0 },
      triangles: { max: triValues.length ? Math.max(...triValues) : 0 },
      tilesBytes: { max: num(tileValues.map((v) => Math.round(v))) },
      jsHeapMB: {
        first: first === undefined ? undefined : Math.round(first * 10) / 10,
        last: last === undefined ? undefined : Math.round(last * 10) / 10,
        growthMB:
          first === undefined || last === undefined
            ? undefined
            : Math.round((last - first) * 10) / 10
      }
    },
    samples
  }
}

export class PerfCapture {
  private samples: PerfSample[] = []
  private startedAt = 0
  private startedAtISO = ''
  private timer: ReturnType<typeof setInterval> | undefined
  private finished = false

  constructor(private readonly options: PerfCaptureOptions) {}

  get isRunning(): boolean {
    return this.timer !== undefined
  }

  start(): void {
    const now = this.options.now ?? (() => performance.now())
    this.startedAt = now()
    this.startedAtISO = new Date().toISOString()
    this.stop() // 幂等
    this.finished = false
    const interval = this.options.intervalMs ?? 250
    this.timer = setInterval(() => {
      this.sample(now())
    }, interval)
    this.timer.unref?.()
    this.sample(this.startedAt)
  }

  /** 单次采样（定时器或测试驱动器调用）；到达 duration 时自动收尾。 */
  sample(tMs: number): PerfSample | undefined {
    if (this.finished) return undefined
    const diag = this.options.getDiagnostics()
    if (!diag) return undefined
    const sample: PerfSample = {
      tMs,
      fps: diag.fps,
      p50Ms: diag.p50Ms,
      p95Ms: diag.p95Ms,
      drawCalls: diag.drawCalls,
      triangles: diag.triangles,
      ...(diag.tilesBytes !== undefined ? { tilesBytes: diag.tilesBytes } : {}),
      ...(diag.jsHeapMB !== undefined ? { jsHeapMB: diag.jsHeapMB } : {})
    }
    this.samples.push(sample)
    if (tMs - this.startedAt >= this.options.durationMs) {
      this.finish()
    }
    return sample
  }

  stop(): PerfReport {
    this.stopTimer()
    return this.report()
  }

  report(): PerfReport {
    return summarizeSamples(
      this.options.label,
      this.startedAtISO || new Date().toISOString(),
      this.options.durationMs,
      this.samples
    )
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    this.stopTimer()
    this.options.onFinished?.(this.report())
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}
