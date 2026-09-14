import type { PortalFoundation } from './foundation'

/**
 * 错误上报与诊断导出（I6-3）：onError → 可插拔 telemetry sink（扇出）。
 * 平台不绑定任何具体 APM 供应商；生产部署通过
 * `window.__twin.registerTelemetrySink(sink)` 或在 bootstrap 注册供应商适配，
 * Scene/Foundation 零修改。
 */

export interface TelemetryErrorPayload {
  message: string
  stack?: string
  context?: Record<string, unknown>
}

export interface TelemetrySink {
  readonly name: string
  captureError(payload: TelemetryErrorPayload): void
  captureEvent(name: string, data?: Record<string, unknown>): void
}

const RING_SIZE = 50

export interface Telemetry {
  captureError(payload: TelemetryErrorPayload): void
  captureEvent(name: string, data?: Record<string, unknown>): void
  registerSink(sink: TelemetrySink): void
  /** 最近错误环形缓冲（诊断导出用）。 */
  recentErrors(): readonly TelemetryErrorPayload[]
}

/** 缺省 sink：结构化输出到 console（开发/演示环境）。 */
export function createConsoleSink(): TelemetrySink {
  return {
    name: 'console',
    captureError: (payload) => console.error('[telemetry]', payload.message),
    captureEvent: (name, data) => console.info('[telemetry]', name, data ?? {})
  }
}

export function createTelemetry(sinks: readonly TelemetrySink[] = []): Telemetry {
  const registry = [...sinks]
  const ring: TelemetryErrorPayload[] = []

  const fanOut = (fn: (sink: TelemetrySink) => void): void => {
    for (const sink of [...registry]) {
      try {
        fn(sink)
      } catch (error) {
        // sink 自身故障绝不影响平台运行
        console.warn(`[telemetry] sink "${sink.name}" failed`, error)
      }
    }
  }

  return {
    captureError(payload) {
      ring.push(payload)
      if (ring.length > RING_SIZE) ring.shift()
      fanOut((sink) => sink.captureError(payload))
    },
    captureEvent(name, data) {
      fanOut((sink) => sink.captureEvent(name, data))
    },
    registerSink(sink) {
      registry.push(sink)
    },
    recentErrors: () => [...ring]
  }
}

/** 诊断导出（I6-3）：一次性汇聚引擎/连接/会话/最近错误 → JSON。 */
export function buildDiagnosticExport(parts: {
  foundation: Pick<PortalFoundation, 'world' | 'config' | 'connection' | 'graphicsAccess' | 'mapAccess'>
  telemetry: Telemetry
}): Record<string, unknown> {
  const { foundation, telemetry } = parts
  return {
    exportedAt: new Date().toISOString(),
    session: {
      mode: foundation.world.session.mode,
      scope: foundation.world.session.scope,
      time: foundation.world.session.time
    },
    connection: foundation.connection(),
    map: {
      state: foundation.mapAccess.state,
      styleIssues: foundation.mapAccess.currentContext?.styleIssues() ?? []
    },
    graphics: foundation.graphicsAccess.getDiagnostics() ?? null,
    recentErrors: telemetry.recentErrors()
  }
}

declare global {
  interface Window {
    __twin?: {
      exportDiagnostics(download?: boolean): Record<string, unknown>
      registerTelemetrySink(sink: TelemetrySink): void
    }
  }
}

/** 把全局错误接入 telemetry，并暴露诊断导出句柄（window.__twin）。 */
export function setupTelemetry(
  telemetry: Telemetry,
  foundation: PortalFoundation
): void {
  window.addEventListener('error', (event) => {
    telemetry.captureError({
      message: String(event.message ?? 'unknown error'),
      context: { source: 'window.error', filename: event.filename }
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as Error | undefined
    telemetry.captureError({
      message: String(reason?.message ?? 'unhandled rejection'),
      stack: reason?.stack,
      context: { source: 'unhandledrejection' }
    })
  })

  window.__twin = {
    exportDiagnostics: (download = false) => {
      const report = buildDiagnosticExport({ foundation, telemetry })
      if (download) {
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `twin-diagnostics-${Date.now()}.json`
        a.click()
        URL.revokeObjectURL(url)
      }
      return report
    },
    registerTelemetrySink: (sink) => telemetry.registerSink(sink)
  }
}
