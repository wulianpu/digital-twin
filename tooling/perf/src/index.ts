/**
 * @twin/tooling-perf — 性能采集与内存 soak（I5-1/I5-3）。
 * 引擎均为 tick 驱动可确定性单测；浏览器接线见 apps/portal/src/perf.ts。
 */

export { PerfCapture, summarizeSamples } from './capture'
export type {
  DiagnosticsSnapshot,
  PerfSample,
  PerfSummary,
  PerfReport,
  PerfCaptureOptions
} from './capture'
export {
  SoakDriver,
  analyzePlateau,
  analyzeResourcePlateaus,
  heapSlope,
  DEFAULT_RESOURCE_THRESHOLDS
} from './soak'
export type {
  SoakSample,
  SoakPlateau,
  SoakReport,
  SoakResources,
  ResourcePlateau,
  ResourceThresholds,
  SoakDriverOptions
} from './soak'
