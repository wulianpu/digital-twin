import type { GeodeticPosition, VerticalReference } from './types'

/**
 * Vertical datum is a first-class concept (Architecture Freeze v1.2 §39).
 * Heights must never be assigned to render coordinates without knowing
 * which datum they are expressed in.
 */

export interface VerticalOffset {
  readonly from: VerticalReference
  readonly to: VerticalReference
  /** meters, `to = from + meters`. */
  readonly meters: number
}

/**
 * Issue #7：Foundation facts 互斥注册——重复 key fail-fast，
 * 不修改原值、不产生事件副作用。
 */
export class DuplicateRegistrationError extends Error {
  readonly key: string
  constructor(what: string, key: string) {
    super(
      `[spatial] duplicate ${what} registration: "${key}"（Foundation facts 互斥注册，更新请走 app-owned API）`
    )
    this.name = 'DuplicateRegistrationError'
    this.key = key
  }
}

/** Register of known datum offsets (site config supplies the real values). */
export class VerticalDatumRegistry {
  // Issue #7：registration identity——disposer 绑定注册身份而非仅绑定 pair key
  private readonly offsets = new Map<string, { token: object; meters: number }>()

  register(offset: VerticalOffset): () => void {
    const k = key(offset.from, offset.to)
    // Issue #7：互斥注册——duplicate pair fail-fast，不修改原基准
    if (this.offsets.has(k)) {
      throw new DuplicateRegistrationError('vertical datum offset', k)
    }
    const token: object = {}
    this.offsets.set(k, { token, meters: offset.meters })
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      // Issue #7：compare-and-delete——stale disposer 不得删除后来 owner 的基准
      if (this.offsets.get(k)?.token !== token) return
      this.offsets.delete(k)
    }
  }

  get(from: VerticalReference, to: VerticalReference): number | undefined {
    return this.offsets.get(key(from, to))?.meters
  }

  /**
   * Convert a position's height to the ellipsoid using registered single-hop
   * offsets. Multi-hop chains are intentionally not resolved: sites declare
   * their offsets explicitly.
   */
  toEllipsoidal(p: GeodeticPosition): GeodeticPosition {
    if (p.verticalReference === 'ellipsoid') return p
    const offset = this.offsets.get(key(p.verticalReference, 'ellipsoid'))
    if (offset === undefined) {
      throw new Error(
        `[spatial] no registered vertical offset from "${p.verticalReference}" to "ellipsoid". Register it via registerVerticalOffset() before using heights.`
      )
    }
    return { ...p, heightMeters: p.heightMeters + offset.meters, verticalReference: 'ellipsoid' as const }
  }
}

function key(from: VerticalReference, to: VerticalReference): string {
  return `${from}->${to}`
}
