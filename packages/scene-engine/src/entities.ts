import * as THREE from 'three'
import { entityKey, type Disposable, type EntityRef } from '@twin/world'
import { createPoseSample, type SpatialStateBuffer } from '@twin/world-client'
import type { EntitySystemApi } from './types'

/**
 * EntitySystem (§46, §47): stable entity identities mapped to their current
 * representation object. Enables focus, picking and — when a SpatialStateBuffer
 * is configured — frame-boundary pose sync from the fast path (§36).
 */
export class EntitySystem implements EntitySystemApi {
  private readonly entries = new Map<string, THREE.Object3D>()
  private readonly sample = createPoseSample()

  register(entity: EntityRef, object: THREE.Object3D): Disposable {
    const key = entityKey(entity)
    this.entries.set(key, object)
    return {
      dispose: () => {
        if (this.entries.get(key) === object) this.entries.delete(key)
      }
    }
  }

  getPosition(entity: EntityRef, out: { x: number; y: number; z: number }): boolean {
    const object = this.entries.get(entityKey(entity))
    if (!object) return false
    object.getWorldPosition(tempVec)
    out.x = tempVec.x
    out.y = tempVec.y
    out.z = tempVec.z
    return true
  }

  has(entity: EntityRef): boolean {
    return this.entries.has(entityKey(entity))
  }

  get count(): number {
    return this.entries.size
  }

  /** Consume the fast path at the frame boundary; representations follow. */
  syncFromBuffer(buffer: SpatialStateBuffer, globalKmUnits = false): number {
    const scale = globalKmUnits ? 1 : 1
    return buffer.drainDirty((key) => {
      const object = this.entries.get(key)
      if (!object) return
      if (!buffer.readLatest(key, this.sample)) return
      object.position.set(
        this.sample.x * scale,
        globalKmUnits ? this.sample.z * scale : this.sample.y,
        globalKmUnits ? -this.sample.y * scale : this.sample.z
      )
      object.quaternion.set(
        globalKmUnits ? this.sample.qx : this.sample.qx,
        globalKmUnits ? this.sample.qz : this.sample.qy,
        globalKmUnits ? -this.sample.qy : this.sample.qz,
        this.sample.qw
      )
    })
  }

  clear(): void {
    this.entries.clear()
  }
}

const tempVec = new THREE.Vector3()
