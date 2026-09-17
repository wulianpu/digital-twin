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
  /** Issue #23：Fast Path buffer 引用——late registration catch-up 用。 */
  private readonly stateBuffer: SpatialStateBuffer | undefined
  private readonly globalKmUnits: boolean

  constructor(
    stateBuffer?: SpatialStateBuffer,
    globalKmUnits = false
  ) {
    this.stateBuffer = stateBuffer
    this.globalKmUnits = globalKmUnits
  }

  register(entity: EntityRef, object: THREE.Object3D): Disposable {
    const key = entityKey(entity)
    this.entries.set(key, object)
    // Issue #23：late registration catch-up——若 Fast Path 中已有该 key 的
    // latest pose（可能在 drainDirty 之后、entity 注册之前写入），
    // 注册时立即应用，不依赖下一次网络数据。
    if (this.stateBuffer && this.stateBuffer.has(key)) {
      const sample = createPoseSample()
      if (this.stateBuffer.readLatest(key, sample)) {
        const km = this.globalKmUnits ? 1 : 1
        object.position.set(
          sample.x * km,
          this.globalKmUnits ? sample.z * km : sample.y,
          this.globalKmUnits ? -sample.y * km : sample.z
        )
        object.quaternion.set(
          sample.qx,
          this.globalKmUnits ? sample.qz : sample.qy,
          this.globalKmUnits ? -sample.qy : sample.qz,
          sample.qw
        )
      }
    }
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
