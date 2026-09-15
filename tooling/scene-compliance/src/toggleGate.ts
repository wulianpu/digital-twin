/**
 * Issue #18：确定性 deferred gate（无 timing sleep）。
 */
export interface ToggleGate {
  gate: Promise<void>
  release(): void
  reject(error: unknown): void
  dispose(): void
}

export function deferredGate(): ToggleGate {
  let release!: () => void
  let reject!: (error: unknown) => void
  const gate = new Promise<void>((r, j) => {
    release = r
    reject = j
  })
  return {
    gate,
    release,
    reject,
    dispose: () => release()
  }
}
