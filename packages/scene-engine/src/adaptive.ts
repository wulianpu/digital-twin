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

/**
 * Per-profile rendering policy (§67)——**boot-time 全集**。
 *
 * Issue #33：其中 `antialias` 是 WebGL context creation-time 选项，
 * 运行期不可切换；applyQuality/adaptive 运行期只能完整生效
 * runtimeQualitySettings(profile) 子集。diagnostics.quality 表示动态
 * knob 已收敛的档位，不声称 antialias 已随运行期切档改变。
 */
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

/**
 * Issue #33（方案 B1）：运行期可完整生效的 profile knob 子集——
 * applyQuality / AdaptiveQuality 的动态应用只允许包含这里面的项；
 * `antialias` 是 boot-time knob（见 profileSettings），运行期不可切换。
 */
export function runtimeQualitySettings(profile: QualityProfile): {
  maxPixelRatio: number
  shadows: boolean
} {
  const s = profileSettings(profile)
  return { maxPixelRatio: s.maxPixelRatio, shadows: s.shadows }
}
