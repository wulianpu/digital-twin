/**
 * 内存 plateau soak 驱动器（I5-3，§71）：重复场景切换循环并在每轮采样
 * JS heap，最终以两半均值与最小二乘斜率判断是否 plateau。
 * 24h 验收 = 以 `?soak=1&soakCycles=…`（或脚本）在目标机器上长跑本驱动器。
 */

export interface SoakSample {
  cycle: number
  tMs: number
  heapMB: number | undefined
  error?: string
}

export interface SoakPlateau {
  /**
   * 仅关心**增长性泄漏**（§71 Plateau 而非 Zero）：斜率 ≤ 阈值即判稳
   * （下降/持平均为健康）。默认 0.05 MB/轮 ≈ 5MB/100 轮。
   */
  detected: boolean
  slopeMBPerCycle: number
  firstHalfAvgMB: number | undefined
  secondHalfAvgMB: number | undefined
  thresholdMBPerCycle: number
}

export interface SoakReport {
  totalCycles: number
  completedCycles: number
  durationMs: number
  plateau: SoakPlateau
  samples: SoakSample[]
}

export interface SoakDriverOptions {
  totalCycles: number
  /** 一个完整的切换循环（应用装配：场景切换 / 2D↔3D / 站点切换等）。 */
  runCycle(cycle: number): Promise<void>
  sampleHeap?(): number | undefined
  now?: () => number
  plateauThresholdMBPerCycle?: number
  /** 每轮之后的间隔毫秒（24h 墙钟验收：73s × 1152 轮 ≈ 23.9h）。 */
  cycleIntervalMs?: number
}

/** 最小二乘斜率（heapMB 对 cycle），无有效样本时返回 NaN。 */
export function heapSlope(samples: SoakSample[]): number {
  const pts = samples.filter((s) => s.heapMB !== undefined) as Array<SoakSample & { heapMB: number }>
  const n = pts.length
  if (n < 2) return Number.NaN
  const meanX = pts.reduce((a, p) => a + p.cycle, 0) / n
  const meanY = pts.reduce((a, p) => a + p.heapMB, 0) / n
  let num = 0
  let den = 0
  for (const p of pts) {
    num += (p.cycle - meanX) * (p.heapMB - meanY)
    den += (p.cycle - meanX) ** 2
  }
  return den === 0 ? Number.NaN : num / den
}

export function analyzePlateau(
  samples: SoakSample[],
  thresholdMBPerCycle = 0.05
): SoakPlateau {
  const withHeap = samples.filter((s) => s.heapMB !== undefined) as Array<
    SoakSample & { heapMB: number }
  >
  const half = Math.floor(withHeap.length / 2)
  const avg = (a: Array<{ heapMB: number }>) =>
    a.length === 0 ? undefined : Math.round((a.reduce((x, y) => x + y.heapMB, 0) / a.length) * 10) / 10
  const firstHalfAvgMB = avg(withHeap.slice(0, half))
  const secondHalfAvgMB = avg(withHeap.slice(half))
  const slope = heapSlope(samples)
  return {
    detected:
      Number.isFinite(slope) && slope <= thresholdMBPerCycle,
    slopeMBPerCycle: Math.round(slope * 1000) / 1000,
    firstHalfAvgMB,
    secondHalfAvgMB,
    thresholdMBPerCycle
  }
}

export class SoakDriver {
  constructor(private readonly options: SoakDriverOptions) {}

  async run(): Promise<SoakReport> {
    const now = this.options.now ?? (() => performance.now())
    const startedAt = now()
    const samples: SoakSample[] = []
    const interval = this.options.cycleIntervalMs ?? 0
    for (let cycle = 1; cycle <= this.options.totalCycles; cycle++) {
      let error: string | undefined
      try {
        await this.options.runCycle(cycle)
      } catch (e) {
        error = String((e as Error)?.stack ?? e)
      }
      const sample: SoakSample = {
        cycle,
        tMs: now() - startedAt,
        heapMB: this.options.sampleHeap?.(),
        ...(error !== undefined ? { error } : {})
      }
      samples.push(sample)
      if (cycle < this.options.totalCycles && interval > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, interval))
      }
    }
    return {
      totalCycles: this.options.totalCycles,
      completedCycles: samples.filter((s) => s.error === undefined).length,
      durationMs: Math.round(now() - startedAt),
      plateau: analyzePlateau(samples, this.options.plateauThresholdMBPerCycle),
      samples
    }
  }
}
