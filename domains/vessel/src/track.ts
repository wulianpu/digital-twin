import type { VesselState } from './contracts'

export interface TrackPoint {
  timeMs: number
  longitudeDegrees: number
  latitudeDegrees: number
  headingDegrees: number
}

/** Ring-buffer track history for one vessel (History view / trails). */
export class VesselTrack {
  private points: TrackPoint[] = []
  constructor(private readonly maxPoints = 600) {}

  push(timeMs: number, state: VesselState): void {
    const last = this.points[this.points.length - 1]
    if (last && Math.abs(last.timeMs - timeMs) < 1) return
    this.points.push({
      timeMs,
      longitudeDegrees: state.longitudeDegrees,
      latitudeDegrees: state.latitudeDegrees,
      headingDegrees: state.headingDegrees
    })
    if (this.points.length > this.maxPoints) {
      this.points.splice(0, this.points.length - this.maxPoints)
    }
  }

  /** GeoJSON Linestring coordinates [[lng, lat], ...] (latest last). */
  toLineCoordinates(): Array<[number, number]> {
    return this.points.map((p) => [p.longitudeDegrees, p.latitudeDegrees])
  }

  get length(): number {
    return this.points.length
  }

  clear(): void {
    this.points = []
  }
}

/** Shared registry of vessel tracks keyed by entity key. */
export class VesselTrackRegistry {
  private readonly tracks = new Map<string, VesselTrack>()

  trackFor(key: string): VesselTrack {
    let t = this.tracks.get(key)
    if (!t) {
      t = new VesselTrack()
      this.tracks.set(key, t)
    }
    return t
  }

  /** Issue #27：实体离场时丢弃其轨迹（幂等）。 */
  drop(key: string): void {
    this.tracks.delete(key)
  }

  clear(): void {
    this.tracks.clear()
  }

  get size(): number {
    return this.tracks.size
  }
}
