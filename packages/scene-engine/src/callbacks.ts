

/**
 * Issue #15：Scene-facing callback 的 trust/fault boundary。
 *
 * 不变量：**一个 Scene callback throw 不得阻止其它 callback 与
 * Engine-owned frame stages（tiles.frame / renderer.render）执行。**
 *
 * 语义为 fail-stop / quarantine：callback 第一次 throw 即从订阅集移除
 * （其 Disposable 保持幂等），错误经 fault sink 只上报一次——
 * 避免每帧 60fps error storm。Engine 自身错误不在本边界内。
 */

export type CallbackKind = 'frame' | 'pick'

export type CallbackFaultSink = (
  error: unknown,
  meta: { kind: CallbackKind }
) => void

export function dispatchCallbacks<T>(
  subs: Set<(arg: T) => void>,
  arg: T,
  kind: CallbackKind,
  sink: CallbackFaultSink
): void {
  for (const cb of [...subs]) {
    try {
      cb(arg)
    } catch (error) {
      // quarantine：已知坏 callback 不再每帧重复执行/上报
      subs.delete(cb)
      try {
        sink(error, { kind })
      } catch {
        /* sink 自身异常不得影响帧循环 */
      }
    }
  }
}

export function makeFaultSink(
  handler: ((error: unknown, meta: { kind: CallbackKind }) => void) | undefined
): CallbackFaultSink {
  return (error, meta) => {
    if (handler) {
      handler(error, meta)
      return
    }
    console.error(`[scene-engine] scene ${meta.kind} callback failed (quarantined)`, error)
  }
}
