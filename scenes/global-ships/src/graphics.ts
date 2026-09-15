import * as THREE from 'three'
import type { GraphicsContext, SceneContext } from '@twin/sdk'
import type { Disposable } from '@twin/world'
import { geodeticToEcef } from '@twin/spatial'
import type { VesselState } from '@twin/domain-vessel'

export interface ShipsGraphicsHandle {
  /** Frame-boundary updates from the business path (1 Hz). */
  updateShips(states: ReadonlyMap<string, VesselState>): void
  dispose(): void
}

/**
 * Global 3D: procedural WGS84 globe + vessel markers in ECEF-km with
 * camera-relative rendering (engine-provided `global` environment, §37.2).
 */
export async function mountGraphics(ctx: SceneContext): Promise<ShipsGraphicsHandle> {
  const graphics: GraphicsContext = await ctx.graphics!.use()
  const globalEnv = graphics.global
  if (!globalEnv) {
    throw new Error('[global-ships] engine was not configured in global mode')
  }

  // Issue #17-A：group 保留在 graphics.root（per-mount root，GLOBAL 模式下
  // 已由引擎挂到 earth root 的 camera-relative 层级）——不逃逸出 mount subtree。
  const group = new THREE.Group()
  group.name = 'global-ships:markers'

  const markerGeometry = new THREE.ConeGeometry(30, 90, 6)
  const markers = new Map<
    string,
    { mesh: THREE.Mesh; entity: { namespace: string; id: string }; entityDisposable: Disposable }
  >()

  graphics.root.add(group)

  const offPick = graphics.onPick((event) => {
    // Picking on the globe is handled by per-marker userData.entityKey.
    void event
  })

  return {
    updateShips(states) {
      const seen = new Set<string>()
      for (const [key, s] of states) {
        seen.add(key)
        let marker = markers.get(key)
        if (!marker) {
          const material = new THREE.MeshStandardMaterial({ color: 0x4f9cf9 })
          const mesh = new THREE.Mesh(markerGeometry, material)
          mesh.userData.entityKey = `ais/${key}`
          const entity = { namespace: 'ais', id: key }
          // Issue #17-C：Entity 注册走 scoped GraphicsContext（MountScope track，
          // Scene teardown 自动释放），不再经 currentContext 旁路。
          const entityDisposable = graphics.entities.register(entity, mesh)
          group.add(mesh)
          marker = { mesh, entity, entityDisposable }
          markers.set(key, marker)
        }
        const ecef = geodeticToEcef({
          longitudeDegrees: s.longitudeDegrees,
          latitudeDegrees: s.latitudeDegrees,
          heightMeters: 0,
          verticalReference: 'ellipsoid'
        })
        // Issue #17-A/D：纯 placement——传原始 ECEF，轴变换只在 SceneEngine
        // 一处权威实现；mesh 保留在 group（mount subtree）内，不 reparent。
        globalEnv.setObjectEcefPosition(marker.mesh, {
          x: ecef.xMeters,
          y: ecef.yMeters,
          z: ecef.zMeters
        })
        marker.mesh.rotation.set(Math.PI / 2, 0, 0) // 固定朝向（非累计 rotateX）
      }
      for (const [key, marker] of markers) {
        if (!seen.has(key)) {
          marker.entityDisposable.dispose() // Issue #17-C：先解除 Engine entity 注册
          group.remove(marker.mesh) // 真实 parent 现在是 group，可正确移除
          ;(marker.mesh.material as THREE.Material).dispose()
          markers.delete(key)
        }
      }
    },
    dispose() {
      // Issue #17-E：停止 callback → unregister entities → detach subtree →
      // dispose GPU 资源（不在 live render tree 里先 dispose）
      offPick.dispose()
      for (const marker of markers.values()) {
        marker.entityDisposable.dispose()
        marker.mesh.removeFromParent()
        ;(marker.mesh.material as THREE.Material).dispose()
      }
      markers.clear()
      markerGeometry.dispose()
      graphics.root.remove(group)
    }
  }
}
