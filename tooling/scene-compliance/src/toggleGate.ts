/**
 * Issue #18：确定性 deferred gate（无 timing sleep）。
 */
export interface ToggleGate {
  gate: Promise<void>
  release(): void
  dispose(): void
}

export function deferredGate(): ToggleGate {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  return {
    gate,
    release,
    dispose: () => release()
  }
}
