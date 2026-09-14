import type { WorldMode, WorldTime } from './types'

/**
 * WorldClock provides lazy time for all three world modes:
 * - live: real wall-clock time (epoch millis).
 * - history / simulation: virtual timeline advanced by speed from an anchor.
 * No internal timer is required; `now()` computes on demand.
 */
export class WorldClock {
  private mode: WorldMode = 'live'
  private speed = 1
  private virtualAnchorMs = Date.now()
  private virtualAnchorRealMs = Date.now()

  now(): WorldTime {
    if (this.mode === 'live') {
      return { mode: 'live', epochMillis: Date.now(), speed: 1 }
    }
    const elapsed = (Date.now() - this.virtualAnchorRealMs) * this.speed
    return {
      mode: this.mode,
      epochMillis: this.virtualAnchorMs + elapsed,
      speed: this.speed
    }
  }

  setMode(mode: WorldMode, anchorEpochMillis?: number): void {
    if (mode === this.mode) {
      if (anchorEpochMillis !== undefined) this.seek(anchorEpochMillis)
      return
    }
    this.mode = mode
    this.virtualAnchorMs = anchorEpochMillis ?? Date.now()
    this.virtualAnchorRealMs = Date.now()
  }

  /** Jump the virtual timeline (history scrub / simulation seek). */
  seek(epochMillis: number): void {
    this.virtualAnchorMs = epochMillis
    this.virtualAnchorRealMs = Date.now()
  }

  setSpeed(speed: number): void {
    if (speed <= 0 || !Number.isFinite(speed)) {
      throw new Error(`[world] invalid time speed: ${speed}`)
    }
    const current = this.now()
    this.speed = speed
    this.virtualAnchorMs = current.epochMillis
    this.virtualAnchorRealMs = Date.now()
  }

  getMode(): WorldMode {
    return this.mode
  }
}
