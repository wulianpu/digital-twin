import * as THREE from 'three'
import type { GraphicsContext, SceneContext } from '@twin/sdk'
import type { TransportPlan } from './data'

export interface TransportGraphicsHandle {
  /** Scene-private preview pose (frame-local meters). */
  setTrolleyPose(position: { x: number; y: number; headingDeg: number }): void
  setRiskHighlight(violating: boolean): void
  dispose(): void
}

/**
 * 3D risk inspection: SPMT trolley + heavy module along the planned route.
 * Scene-private simulation preview (§28) — animation runs in the engine's
 * frame loop, positions live in the site frame.
 */
export async function mountGraphics(
  ctx: SceneContext,
  plan: TransportPlan
): Promise<TransportGraphicsHandle> {
  const graphics: GraphicsContext = await ctx.graphics!.use()
  const group = new THREE.Group()
  group.name = 'heavy-transport:preview'
  graphics.root.add(group)

  // Route ribbon on the ground.
  const routePoints = plan.route.map((p) => new THREE.Vector3(p.x, 0.3, p.y))
  const routeGeometry = new THREE.BufferGeometry().setFromPoints(routePoints)
  const routeMaterial = new THREE.LineBasicMaterial({ color: 0x57d9a3 })
  const routeLine = new THREE.Line(routeGeometry, routeMaterial)
  group.add(routeLine)

  // Trolley (SPMT platform) + heavy module.
  const platformGeometry = new THREE.BoxGeometry(9, 1.2, 22)
  const platformMaterial = new THREE.MeshStandardMaterial({ color: 0xd97f2e, metalness: 0.4, roughness: 0.5 })
  const platform = new THREE.Mesh(platformGeometry, platformMaterial)
  platform.castShadow = true

  const moduleGeometry = new THREE.BoxGeometry(12, 10, 26)
  const moduleMaterial = new THREE.MeshStandardMaterial({ color: 0x7e97b8, roughness: 0.8 })
  const moduleMesh = new THREE.Mesh(moduleGeometry, moduleMaterial)
  moduleMesh.position.y = 6.5
  moduleMesh.castShadow = true

  const trolleyGroup = new THREE.Group()
  trolleyGroup.add(platform, moduleMesh)
  trolleyGroup.userData.entityKey = 'transport/SPT-01'
  group.add(trolleyGroup)

  const offPick = graphics.onPick(() => {
    /* selection wiring lives in the entry */
  })

  return {
    setTrolleyPose(position) {
      trolleyGroup.position.set(position.x, 0.8, position.y)
      // Frame heading (deg, from north) -> group rotation around Up (Y).
      trolleyGroup.rotation.y = (position.headingDeg * Math.PI) / 180
    },
    setRiskHighlight(violating) {
      routeMaterial.color.set(violating ? 0xe05d5d : 0x57d9a3)
      moduleMaterial.color.set(violating ? 0xe05d5d : 0x7e97b8)
    },
    dispose() {
      offPick.dispose()
      graphics.root.remove(group)
      routeGeometry.dispose()
      routeMaterial.dispose()
      platformGeometry.dispose()
      platformMaterial.dispose()
      moduleGeometry.dispose()
      moduleMaterial.dispose()
    }
  }
}

export type { SceneContext }
