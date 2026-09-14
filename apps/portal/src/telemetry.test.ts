import { describe, expect, it, vi } from 'vitest'
import {
  buildDiagnosticExport,
  createConsoleSink,
  createTelemetry,
  type TelemetrySink
} from './telemetry'

function recordingSink(name: string) {
  const errors: Array<{ message: string }> = []
  const events: Array<{ name: string; data?: unknown }> = []
  const sink: TelemetrySink = {
    name,
    captureError: (p) => errors.push(p),
    captureEvent: (n, d) => events.push({ name: n, data: d })
  }
  return { sink, errors, events }
}

describe('telemetry（I6-3）', () => {
  it('错误扇出到全部 sink 并进入环形缓冲', () => {
    const a = recordingSink('a')
    const b = recordingSink('b')
    const telemetry = createTelemetry([a.sink, b.sink])
    telemetry.captureError({ message: 'boom' })
    telemetry.captureEvent('evt', { k: 1 })

    expect(a.errors.map((e) => e.message)).toEqual(['boom'])
    expect(b.errors).toHaveLength(1)
    expect(a.events[0]?.name).toBe('evt')
    expect(telemetry.recentErrors()).toHaveLength(1)
  })

  it('环形缓冲有上限，sink 故障被隔离', () => {
    const bad: TelemetrySink = {
      name: 'bad',
      captureError: () => {
        throw new Error('sink down')
      },
      captureEvent: () => {
        throw new Error('sink down')
      }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const telemetry = createTelemetry([bad])
    for (let i = 0; i < 60; i++) telemetry.captureError({ message: `e${i}` })
    expect(telemetry.recentErrors()).toHaveLength(50)
    expect(telemetry.recentErrors()[0].message).toBe('e10')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('registerSink 支持运行时接入供应商适配', () => {
    const telemetry = createTelemetry()
    const later = recordingSink('later')
    telemetry.registerSink(later.sink)
    telemetry.captureError({ message: 'hello' })
    expect(later.errors).toHaveLength(1)
  })

  it('buildDiagnosticExport 汇聚会话/连接/引擎/错误', () => {
    const telemetry = createTelemetry()
    telemetry.captureError({ message: 'boom' })
    const report = buildDiagnosticExport({
      foundation: {
        world: {
          session: {
            mode: 'live',
            scope: { kind: 'global' },
            time: { mode: 'live', epochMillis: 1, speed: 1 }
          }
        },
        config: {},
        connection: () => ({ state: 'local', staleCount: 0 }),
        graphicsAccess: { getDiagnostics: () => undefined },
        mapAccess: { state: 'ACTIVE', currentContext: undefined }
      } as never,
      telemetry
    })
    expect((report.session as { mode: string }).mode).toBe('live')
    expect((report.connection as { state: string }).state).toBe('local')
    expect(report.graphics).toBeNull()
    expect(telemetry.recentErrors()).toHaveLength(1)
  })

  it('console sink 输出结构化条目', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sink = createConsoleSink()
    sink.captureError({ message: 'oops' })
    expect(errorSpy).toHaveBeenCalledWith('[telemetry]', 'oops')
    errorSpy.mockRestore()
  })
})
