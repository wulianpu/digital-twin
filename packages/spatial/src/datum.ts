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

/** Register of known datum offsets (site config supplies the real values). */
export class VerticalDatumRegistry {
  private readonly offsets = new Map<string, number>()

  register(offset: VerticalOffset): () => void {
    this.offsets.set(key(offset.from, offset.to), offset.meters)
    return () => {
      this.offsets.delete(key(offset.from, offset.to))
    }
  }

  get(from: VerticalReference, to: VerticalReference): number | undefined {
    return this.offsets.get(key(from, to))
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
    return { ...p, heightMeters: p.heightMeters + offset, verticalReference: 'ellipsoid' as const }
  }
}

function key(from: VerticalReference, to: VerticalReference): string {
  return `${from}->${to}`
}
