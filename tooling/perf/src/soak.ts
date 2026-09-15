/**
 * 内存/resource plateau soak 驱动器（I5-3，§71；Issue #13 M9 资源验收）：
 * 重复混合场景循环（含真实 3D 生命周期）并在每轮采样 JS heap + Engine
 * diagnostics（textures/geometries/programs/frameCallbacks/assetLeases/tiles）。
 *
 * 验收语义（§71/§72 "Plateau, not Zero"）：
 * - Scene/scope-owned counters（frameCallbacks / assetLeases 等）在稳定
 *   teardown checkpoint 应回 baseline；
 * - Engine/shared cache（renderer programs、tiles bytes 等）不要求归零，
 *   但 N 轮 warmup 后必须 plateau——**任一 counter 单调增长即 fail**，
 *   pass 不再仅由 JS heap slope 决定。
 */

export interface SoakResources {
  jsHeapMB?: number
  textures?: number
  geometries?: number
  programs?: number
  frameCallbacks?: number
  assetLeases?: number
  tilesBytes?: number
  entityCount?: number
}

export interface SoakSample {
  cycle: number
  tMs: number
  heapMB: number | undefined
  resources?: SoakResources
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

export interface ResourcePlateau {
  /** 最小二乘斜率（counter 对 cycle）。 */
  slopePerCycle: number
  /** slope ≤ 阈值即 plateau（仅增长性泄漏判不稳）。 */
  detected: boolean
  thresholdPerCycle: number
  samples: number
}

export type ResourceThresholds = Partial<Record<keyof SoakResources, number>>

export interface SoakReport {
  totalCycles: number
  completedCycles: number
  durationMs: number
  plateau: SoakPlateau
  /** #13：Engine diagnostics 资源 plateau（按 counter）。 */
  resources: {
    thresholds: ResourceThresholds
    plateaus: Record<string, ResourcePlateau>
    /** 所有被采样的资源 counter 均 plateau。 */
    pass: boolean
  }
  /** 总体验收：完成数 / 错误 / heap plateau / 资源 plateau 全部通过。 */
  pass: boolean
  samples: SoakSample[]
}

export interface SoakDriverOptions {
  totalCycles: number
  /** 一个完整的切换循环（应用装配：场景切换 / 2D↔3D / 站点切换等）。 */
  runCycle(cycle: number): Promise<void>
  sampleHeap?(): number | undefined
  /** #13：Engine/foundation diagnostics 聚合采样（textures 等）。 */
  sampleResources?(): SoakResources | undefined
  now?: () => number
  plateauThresholdMBPerCycle?: number
  /** 资源 counter 的每轮增长阈值（默认值见 DEFAULT_RESOURCE_THRESHOLDS）。 */
  resourceThresholds?: ResourceThresholds
  /** 每轮之后的间隔毫秒（24h 墙钟验收：73s × 1152 轮 ≈ 23.9h）。 */
  cycleIntervalMs?: number
}

/** 默认资源增长阈值（每轮）：计数类 >0.02/轮（≈2/100 轮）判泄漏。 */
export const DEFAULT_RESOURCE_THRESHOLDS: ResourceThresholds = {
  textures: 0.02,
  geometries: 0.02,
  programs: 0.01,
  frameCallbacks: 0.02,
  assetLeases: 0.02,
  entityCount: 0.05,
  tilesBytes: 2048
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

function slopeOf(values: Array<{ x: number; y: number }>): number {
  const n = values.length
  if (n < 2) return Number.NaN
  const meanX = values.reduce((a, p) => a + p.x, 0) / n
  const meanY = values.reduce((a, p) => a + p.y, 0) / n
  let num = 0
  let den = 0
  for (const p of values) {
    num += (p.x - meanX) * (p.y - meanY)
    den += (p.x - meanX) ** 2
  }
  return den === 0 ? Number.NaN : num / den
}

/**
 * #13：按 counter 计算资源 plateau。仅增长性泄漏判不稳（下降/持平均健康）；
 * 样本数 < 4 的 counter 不参与判定（warmup 噪声）。
 */
export function analyzeResourcePlateaus(
  samples: SoakSample[],
  thresholds: ResourceThresholds = DEFAULT_RESOURCE_THRESHOLDS
): { plateaus: Record<string, ResourcePlateau>; pass: boolean } {
  const plateaus: Record<string, ResourcePlateau> = {}
  const keys = Object.keys(thresholds) as Array<keyof SoakResources>
  let pass = true
  for (const key of keys) {
    const pts: Array<{ x: number; y: number }> = []
    for (const s of samples) {
      if (s.error !== undefined) continue
      const value = s.resources?.[key]
      if (typeof value === 'number') pts.push({ x: s.cycle, y: value })
    }
    if (pts.length < 4) continue // warmup / 未采样
    const threshold = thresholds[key] ?? 0.02
    const slope = slopeOf(pts)
    const detected = Number.isFinite(slope) && slope <= threshold
    if (!detected) pass = false
    plateaus[key] = {
      slopePerCycle: Math.round(slope * 1e6) / 1e6,
      detected,
      thresholdPerCycle: threshold,
      samples: pts.length
    }
  }
  return { plateaus, pass }
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
        ...(this.options.sampleResources
          ? { resources: this.options.sampleResources() }
          : {}),
        ...(error !== undefined ? { error } : {})
      }
      samples.push(sample)
      if (cycle < this.options.totalCycles && interval > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, interval))
      }
    }
    const thresholds = {
      ...DEFAULT_RESOURCE_THRESHOLDS,
      ...(this.options.resourceThresholds ?? {})
    }
    const { plateaus, pass: resourcesPass } = analyzeResourcePlateaus(samples, thresholds)
    const plateau = analyzePlateau(samples, this.options.plateauThresholdMBPerCycle)
    const completedCycles = samples.filter((s) => s.error === undefined).length
    return {
      totalCycles: this.options.totalCycles,
      completedCycles,
      durationMs: Math.round(now() - startedAt),
      plateau,
      resources: { thresholds, plateaus, pass: resourcesPass },
      pass:
        completedCycles === this.options.totalCycles &&
        samples.every((s) => s.error === undefined) &&
        plateau.detected &&
        resourcesPass,
      samples
    }
  }
}
