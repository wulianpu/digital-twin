import { PerfCapture, SoakDriver, type PerfReport, type SoakReport, type SoakResources } from '@twin/tooling-perf'
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
    /** A2: node 侧逐轮驱动（单轮混合场景切换 + heap 采样） */
    __twinSoakStep?: () => Promise<number | undefined>
    __twinSoakReset?: () => void
    /** Issue #13：Engine/foundation 资源 diagnostics 聚合采样 */
    __twinSoakMetrics?: () => SoakResources
    __vfxReady?: boolean
    __vfxFrozen?: boolean
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
    // A1 修复：轮间隔接线（此前 73s 间隔未生效，1152 轮 29 分钟跑完）
    const intervalSec = Number(params.get('soakIntervalSec') ?? 0)
    void (async () => {
      await delay(4000)
      // Issue #13：mixed 场景（真实 3D + 2D↔3D toggle + GLTF/asset 路径）
      const scenes = ['global-ships', 'stack-yard', 'production', 'stack-yard'] as const
      const driver = new SoakDriver({
        totalCycles: cycles,
        runCycle: async (cycle) => {
          const scene = scenes[cycle % scenes.length]
          await coordinator.select(scene)
          await delay(1500)
          if (scene === 'stack-yard') {
            const to3d = document.querySelector<HTMLButtonElement>('[data-view-toggle="graphics"]')
            if (to3d) {
              to3d.click()
              await delay(2500)
              document.querySelector<HTMLButtonElement>('[data-view-toggle="map"]')?.click()
              await delay(1200)
            }
          }
        },
        sampleHeap: heapMB,
        sampleResources: () => {
          const d = foundation.graphicsAccess.getDiagnostics()
          return {
            textures: d?.renderer.textures,
            geometries: d?.renderer.geometries,
            programs: d?.renderer.programs,
            frameCallbacks: d?.frameCallbacks,
            assetLeases: d?.assetLeases,
            entityCount: d?.entityCount,
            tilesBytes: d?.tiles?.cachedBytes,
            jsHeapMB: d?.jsHeapMB ?? heapMB()
          }
        },
        ...(intervalSec > 0 ? { cycleIntervalMs: intervalSec * 1000 } : {})
      })
      const report = await driver.run()
      window.__twinSoakReport = report
      console.info('[perf] soak 完成', report.plateau, report.resources)
      if (params.has('download')) downloadJson(`soak-${cycles}.json`, report)
    })()
  }

  // A2: node 侧逐轮驱动接口（soak-run.mjs 崩溃恢复式 24h 执行器）。
  // Issue #13：mixed 场景——真实 3D 生命周期（global-ships / production 均挂载
  // GraphicsEngine，覆盖 GLTF/asset 路径）+ stack-yard 2D↔3D toggle 重入。
  if (params.has('soakStep')) {
    let stepScene = 0
    const mixedScenes = ['global-ships', 'stack-yard', 'production', 'stack-yard'] as const
    window.__twinSoakStep = async () => {
      const scene = mixedScenes[stepScene % mixedScenes.length]
      await coordinator.select(scene)
      stepScene++
      await delay(1500)
      // stack-yard：真实 2D↔3D toggle（SceneEngine 创建/销毁重入生命周期）
      if (scene === 'stack-yard') {
        const to3d = document.querySelector<HTMLButtonElement>('[data-view-toggle="graphics"]')
        if (to3d) {
          to3d.click()
          await delay(2500)
          const to2d = document.querySelector<HTMLButtonElement>('[data-view-toggle="map"]')
          to2d?.click()
          await delay(1200)
        }
      }
      return heapMB()
    }
    window.__twinSoakReset = () => {
      stepScene = 0
    }
    // Issue #13：Engine/foundation diagnostics 聚合采样（perf/soak 聚合层
    // 不丢弃已有 renderer/asset/tile 资源字段）
    window.__twinSoakMetrics = () => {
      const d = foundation.graphicsAccess.getDiagnostics()
      return {
        textures: d?.renderer.textures,
        geometries: d?.renderer.geometries,
        programs: d?.renderer.programs,
        frameCallbacks: d?.frameCallbacks,
        assetLeases: d?.assetLeases,
        entityCount: d?.entityCount,
        tilesBytes: d?.tiles?.cachedBytes,
        jsHeapMB: d?.jsHeapMB ?? heapMB()
      }
    }
  }

  if (params.has('contextLoss')) {
    void (async () => {
      await delay(6000) // 等进入 3D 且渲染稳定
      await contextLossDrill(foundation)
    })()
  }

  // ── 确定性 Golden Fixture 模式（I9-6 / Issue #2）──────────────────
  // ?vfx=1&scene=production&view=3d
  // 冻结世界时钟 + 数据 + 水体动画 + 固定相机 → 确定性截图。
  if (params.has('vfx')) {
    void (async () => {
      // 等 portal 挂载 + 场景面板可见
      await delay(5000)

      // 固定世界时钟（HISTORY 模式，确定性回放数据）
      foundation.world.setMode('history')
      foundation.data.setMode('history')
      foundation.world.clock.seek(1_790_000_000_000)
      foundation.world.clock.setSpeed(1)

      // 等待回放数据到达 + 渲染稳定
      await delay(4000)

      // 冻结渲染：设定确定性的帧时间（水体动画冻结）
      window.__vfxFrozen = true

      // 等待渲染管线跟上
      await delay(500)

      window.__vfxReady = true
      console.info('[vfx] Golden capture ready')
    })()
  }
}
