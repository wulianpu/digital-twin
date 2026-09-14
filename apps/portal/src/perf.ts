import { PerfCapture, SoakDriver, type PerfReport, type SoakReport } from '@twin/tooling-perf'
import type { PortalFoundation } from './foundation'
import type { SceneCoordinator } from './coordinator'

/**
 * I5 性能自动化接线：URL 查询参数驱动，生产访问不受影响。
 * - `?perf=1&perfMs=12000`        采集当前引擎诊断 → window.__twinPerfReport
 * - `?soak=1&soakCycles=20`       场景切换循环 heap 采样 → window.__twinSoakReport
 * - `?contextLoss=1`              WEBGL_lose_context 演练 → window.__twinContextLossReport
 * 报告同时暴露在 window 上供自动化采集；`?download=1` 时附加下载。
 */

declare global {
  interface Window {
    __twinPerfReport?: PerfReport
    __twinSoakReport?: SoakReport
    __twinContextLossReport?: Record<string, unknown>
    __twinDebug?: Record<string, unknown>
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function downloadJson(name: string, data: unknown): void {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    // 下载失败不影响报告落 window
  }
}

function heapMB(): number | undefined {
  const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory
  return memory ? Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10 : undefined
}

async function contextLossDrill(foundation: PortalFoundation): Promise<void> {
  const access = foundation.graphicsAccess
  await access.use()
  const renderer = access.currentContext!.renderer
  const before = access.getDiagnostics()?.frame
  const gl = renderer.getContext() as WebGL2RenderingContext | WebGLRenderingContext
  const ext = gl?.getExtension('WEBGL_lose_context') as
    | { loseContext(): void; restoreContext(): void }
    | null
  if (!ext) {
    window.__twinContextLossReport = { supported: false }
    return
  }
  ext.loseContext()
  await delay(1500)
  const duringLost = access.getDiagnostics()?.frame
  ext.restoreContext()
  await delay(3000)
  const after = access.getDiagnostics()?.frame
  const framesGrew = (after?.frameIndex ?? 0) > (before?.frameIndex ?? 0)
  window.__twinContextLossReport = {
    supported: true,
    before,
    duringLost,
    afterRestore: after,
    recovered: framesGrew && (after?.fps ?? 0) > 0
  }
  console.info('[perf] context loss 演练完成', window.__twinContextLossReport)
}

export function setupPerfAutomation(
  foundation: PortalFoundation,
  coordinator: SceneCoordinator
): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)

  // DEV 调试句柄：手动触发 context loss 演练
  if (import.meta.env.DEV) {
    window.__twinDebug = {
      contextLossDrill: () => void contextLossDrill(foundation)
    }
  }

  if (params.has('perf')) {
    const durationMs = Number(params.get('perfMs') ?? 12000) || 12000
    void (async () => {
      await delay(4000) // 等场景与引擎稳定
      const capture = new PerfCapture({
        // 标签收尾时解析：采集期间场景/范围可能切换（I7 修复标签过期）
        label: () =>
          `${coordinator.activeSceneId ?? foundation.world.session.scope.kind}/${foundation.world.session.mode}`,
        durationMs,
        intervalMs: 250,
        getDiagnostics: () => {
          const d = foundation.graphicsAccess.getDiagnostics()
          if (!d) return undefined
          return {
            fps: d.frame.fps,
            p50Ms: d.frame.p50Ms,
            p95Ms: d.frame.p95Ms,
            drawCalls: d.renderer.drawCalls,
            triangles: d.renderer.triangles,
            ...(d.tiles ? { tilesBytes: d.tiles.cachedBytes } : {}),
            ...(d.jsHeapMB !== undefined ? { jsHeapMB: d.jsHeapMB } : {})
          }
        }
      })
      capture.start()
      await delay(durationMs + 1500)
      const report = capture.report()
      window.__twinPerfReport = report
      console.info('[perf] 采集完成', report.summary)
      if (params.has('download')) downloadJson(`perf-${report.label}.json`, report)
    })()
  }

  if (params.has('soak')) {
    const cycles = Number(params.get('soakCycles') ?? 20) || 20
    void (async () => {
      await delay(4000)
      const scenes = ['global-ships', 'stack-yard'] as const
      const driver = new SoakDriver({
        totalCycles: cycles,
        runCycle: async (cycle) => {
          await coordinator.select(scenes[cycle % scenes.length])
          await delay(1500)
        },
        sampleHeap: heapMB
      })
      const report = await driver.run()
      window.__twinSoakReport = report
      console.info('[perf] soak 完成', report.plateau)
      if (params.has('download')) downloadJson(`soak-${cycles}.json`, report)
    })()
  }

  if (params.has('contextLoss')) {
    void (async () => {
      await delay(6000) // 等进入 3D 且渲染稳定
      await contextLossDrill(foundation)
    })()
  }
}
