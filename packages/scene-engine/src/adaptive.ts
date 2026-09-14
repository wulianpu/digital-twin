import type { QualityProfile } from './types'

const ORDER: QualityProfile[] = ['OFFICE', 'STANDARD', 'HIGH', 'EXHIBITION']

/**
 * AdaptiveQuality (§68): watches p95 frame time and adjusts the quality
 * profile. Scenes never branch on GPU capability (§67) — quality policy
 * belongs to the engine.
 */
export class AdaptiveQuality {
  private cooldownFrames = 0

  constructor(
    private current: QualityProfile,
    private readonly max: QualityProfile,
    private readonly apply: (profile: QualityProfile) => void
  ) {}

  get profile(): QualityProfile {
    return this.current
  }

  force(profile: QualityProfile): void {
    this.current = profile
    this.apply(profile)
    this.cooldownFrames = 300
  }

  /** Called once per frame with the smoothed p95 frame time. */
  sample(p95Ms: number): void {
    if (this.cooldownFrames > 0) {
      this.cooldownFrames--
      return
    }
    const currentIndex = ORDER.indexOf(this.current)
    const maxIndex = ORDER.indexOf(this.max)
    if (p95Ms > 50 && currentIndex > 0) {
      this.force(ORDER[currentIndex - 1])
    } else if (p95Ms < 22 && currentIndex < maxIndex) {
      this.force(ORDER[currentIndex + 1])
    }
  }
}

/** Per-profile rendering policy (§67). */
export function profileSettings(profile: QualityProfile): {
  maxPixelRatio: number
  antialias: boolean
  shadows: boolean
} {
  switch (profile) {
    case 'OFFICE':
      return { maxPixelRatio: 1, antialias: false, shadows: false }
    case 'STANDARD':
      return { maxPixelRatio: 1.5, antialias: true, shadows: false }
    case 'HIGH':
      return { maxPixelRatio: 2, antialias: true, shadows: true }
    case 'EXHIBITION':
      return { maxPixelRatio: 2.5, antialias: true, shadows: true }
  }
}
