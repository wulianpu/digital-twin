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
  /**
   * Issue #29：render → logical 转换（Engine owner 注入，见 FloatingOriginState）。
   * getPosition() 的 contract 是返回 **Engine 逻辑 scene 坐标**
   * （SITE: frame-local m；GLOBAL: scene-axis ECEF km）——必须剔除
   * floating-origin/camera-relative 的 Engine-owned ancestor shift；
   * Scene-owned 祖先 transform 仍正常计入。
   */
  private readonly renderToLogical: ((v: THREE.Vector3) => void) | undefined

  constructor(
    stateBuffer?: SpatialStateBuffer,
    globalKmUnits = false,
    renderToLogical?: (v: THREE.Vector3) => void
  ) {
    this.stateBuffer = stateBuffer
    this.globalKmUnits = globalKmUnits
    this.renderToLogical = renderToLogical
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
    // Issue #29：getWorldPosition 是 render-world 坐标（含 floating-origin
    // ancestor shift）；必须经 renderToLogical 恢复 Engine 逻辑坐标后再返回。
    object.getWorldPosition(tempVec)
    this.renderToLogical?.(tempVec)
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
