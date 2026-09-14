import { quatSlerp } from '@twin/spatial'

/**
 * Spatial Fast Path (Architecture Freeze v1.2 §35, §36, §65).
 *
 * Structure-of-Arrays Float64 buffer for high-frequency poses. Deliberately
 * OUTSIDE any reactive system: messages write here, the frame boundary reads.
 */

export interface PoseWrite {
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
  /** Frame-local pose timestamp (world timeline millis). */
  timeMs: number
  frameId: string
}

export interface PoseSample {
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
  frameId: string
  timeMs: number
}

export function createPoseSample(): PoseSample {
  return { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, frameId: '', timeMs: 0 }
}

const STRIDE = 9 // x y z qx qy qz qw timeMs (prevFrame same layout, minus frameId)

export class SpatialStateBuffer {
  private capacity: number
  private current: Float64Array
  private previous: Float64Array
  private dirty: Uint8Array
  private frameIds: string[]
  private readonly slots = new Map<string, number>()
  private _count = 0

  constructor(capacity = 1024) {
    this.capacity = Math.max(16, capacity)
    this.current = new Float64Array(this.capacity * STRIDE)
    this.previous = new Float64Array(this.capacity * STRIDE)
    this.dirty = new Uint8Array(this.capacity)
    this.frameIds = new Array(this.capacity).fill('')
  }

  get count(): number {
    return this._count
  }

  get dirtyCount(): number {
    let n = 0
    for (let i = 0; i < this._count; i++) if (this.dirty[i]) n++
    return n
  }

  upsert(key: string, pose: PoseWrite): void {
    let slot = this.slots.get(key)
    if (slot === undefined) {
      if (this._count === this.capacity) this.grow()
      slot = this._count++
      this.slots.set(key, slot)
      this.frameIds[slot] = pose.frameId
      const c = slot * STRIDE
      this.current[c] = pose.x
      this.current[c + 1] = pose.y
      this.current[c + 2] = pose.z
      this.current[c + 3] = pose.qx
      this.current[c + 4] = pose.qy
      this.current[c + 5] = pose.qz
      this.current[c + 6] = pose.qw
      this.current[c + 7] = pose.timeMs
      this.current[c + 8] = pose.timeMs
      this.dirty[slot] = 1
      return
    }
    const c = slot * STRIDE
    // Ignore out-of-order / duplicate timestamps.
    if (pose.timeMs < this.current[c + 7]) return
    this.previous[c] = this.current[c]
    this.previous[c + 1] = this.current[c + 1]
    this.previous[c + 2] = this.current[c + 2]
    this.previous[c + 3] = this.current[c + 3]
    this.previous[c + 4] = this.current[c + 4]
    this.previous[c + 5] = this.current[c + 5]
    this.previous[c + 6] = this.current[c + 6]
    this.previous[c + 7] = this.current[c + 7]
    this.previous[c + 8] = this.current[c + 8]
    this.current[c] = pose.x
    this.current[c + 1] = pose.y
    this.current[c + 2] = pose.z
    this.current[c + 3] = pose.qx
    this.current[c + 4] = pose.qy
    this.current[c + 5] = pose.qz
    this.current[c + 6] = pose.qw
    this.current[c + 7] = pose.timeMs
    this.current[c + 8] = pose.timeMs
    this.frameIds[slot] = pose.frameId
    this.dirty[slot] = 1
  }

  has(key: string): boolean {
    return this.slots.has(key)
  }

  readLatest(key: string, out: PoseSample): boolean {
    const slot = this.slots.get(key)
    if (slot === undefined) return false
    const c = slot * STRIDE
    out.x = this.current[c]
    out.y = this.current[c + 1]
    out.z = this.current[c + 2]
    out.qx = this.current[c + 3]
    out.qy = this.current[c + 4]
    out.qz = this.current[c + 5]
    out.qw = this.current[c + 6]
    out.timeMs = this.current[c + 7]
    out.frameId = this.frameIds[slot]
    return true
  }

  /** Sample interpolated at `timeMs` between the previous and latest pose. */
  interpolate(key: string, timeMs: number, out: PoseSample): boolean {
    const slot = this.slots.get(key)
    if (slot === undefined) return false
    const c = slot * STRIDE
    const curT = this.current[c + 7]
    const prevT = this.previous[c + 7]
    if (!(timeMs < curT) || prevT === curT) {
      return this.readLatest(key, out)
    }
    const alpha = Math.min(1, Math.max(0, (timeMs - prevT) / (curT - prevT)))
    out.x = this.previous[c] + alpha * (this.current[c] - this.previous[c])
    out.y = this.previous[c + 1] + alpha * (this.current[c + 1] - this.previous[c + 1])
    out.z = this.previous[c + 2] + alpha * (this.current[c + 2] - this.previous[c + 2])
    const q = quatSlerp(
      {
        x: this.previous[c + 3],
        y: this.previous[c + 4],
        z: this.previous[c + 5],
        w: this.previous[c + 6]
      },
      {
        x: this.current[c + 3],
        y: this.current[c + 4],
        z: this.current[c + 5],
        w: this.current[c + 6]
      },
      alpha
    )
    out.qx = q.x
    out.qy = q.y
    out.qz = q.z
    out.qw = q.w
    out.timeMs = timeMs
    out.frameId = this.frameIds[slot]
    return true
  }

  /**
   * Frame-boundary drain (§36): visit every entity whose pose changed since
   * the last drain, then clear dirty flags. Zero allocation in the hot path.
   */
  drainDirty(cb: (key: string, slot: number) => void): number {
    let visited = 0
    for (const [key, slot] of this.slots) {
      if (this.dirty[slot]) {
        this.dirty[slot] = 0
        cb(key, slot)
        visited++
      }
    }
    return visited
  }

  private grow(): void {
    const capacity = this.capacity * 2
    const current = new Float64Array(capacity * STRIDE)
    const previous = new Float64Array(capacity * STRIDE)
    const dirty = new Uint8Array(capacity)
    const frameIds = new Array<string>(capacity).fill('')
    current.set(this.current)
    previous.set(this.previous)
    dirty.set(this.dirty)
    for (let i = 0; i < this._count; i++) frameIds[i] = this.frameIds[i]
    this.capacity = capacity
    this.current = current
    this.previous = previous
    this.dirty = dirty
    this.frameIds = frameIds
  }
}
