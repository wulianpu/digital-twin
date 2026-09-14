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
export async function mountGraphics(
  ctx: SceneContext,
  registry: {
    register(entity: { namespace: string; id: string }, object: THREE.Object3D): Disposable
  }
): Promise<ShipsGraphicsHandle> {
  const graphics: GraphicsContext = await ctx.graphics!.use()
  const globalEnv = graphics.global
  if (!globalEnv) {
    throw new Error('[global-ships] engine was not configured in global mode')
  }

  const group = new THREE.Group()
  group.name = 'global-ships:markers'
  globalEnv.addObjectAtEcef(group, { x: 0, y: 0, z: 0 })

  const markerGeometry = new THREE.ConeGeometry(30, 90, 6)
  const markers = new Map<string, { mesh: THREE.Mesh; entity: { namespace: string; id: string } }>()

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
          registry.register(entity, mesh)
          group.add(mesh)
          marker = { mesh, entity }
          markers.set(key, marker)
        }
        const ecef = geodeticToEcef({
          longitudeDegrees: s.longitudeDegrees,
          latitudeDegrees: s.latitudeDegrees,
          heightMeters: 0,
          verticalReference: 'ellipsoid'
        })
        // Place on the ellipsoid surface, oriented along heading (approx).
        globalEnv.addObjectAtEcef(
          marker.mesh,
          { x: ecef.xMeters, y: ecef.zMeters, z: -ecef.yMeters }
        )
        marker.mesh.rotateX(Math.PI / 2)
      }
      for (const [key, marker] of markers) {
        if (!seen.has(key)) {
          group.remove(marker.mesh)
          ;(marker.mesh.material as THREE.Material).dispose()
          markers.delete(key)
        }
      }
    },
    dispose() {
      offPick.dispose()
      graphics.root.remove(group)
      markerGeometry.dispose()
      for (const marker of markers.values()) {
        ;(marker.mesh.material as THREE.Material).dispose()
      }
      markers.clear()
      group.removeFromParent()
    }
  }
}
