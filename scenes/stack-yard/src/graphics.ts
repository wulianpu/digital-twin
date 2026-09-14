import * as THREE from 'three'
import type { AssetLease, GraphicsContext, SceneContext } from '@twin/sdk'
import { frameLocalToGeodetic } from '@twin/spatial'
import type { StackLayout } from './data'

export interface StackGraphicsHandlers {
  onPickStack(code: string | undefined): void
}

export interface StackGraphicsHandle {
  dispose(): void
}

/**
 * 3D representation — loaded ONLY when the user enters 3D (§26): this module
 * (and `three`) stays out of the scene's initial chunk. All Three resources
 * created here are Owned and disposed on teardown (§45).
 */
export async function mountGraphics(
  ctx: SceneContext,
  layout: StackLayout,
  handlers: StackGraphicsHandlers
): Promise<StackGraphicsHandle> {
  const graphics: GraphicsContext = await ctx.graphics!.use()

  const group = new THREE.Group()
  group.name = 'stack-yard:blocks'

  const statuses = new Map<string, string>(
    layout.cells.map((c) => [c.code, c.status])
  )
  const colorOf = (code: string): number => {
    switch (statuses.get(code)) {
      case 'inbound':
        return 0x57d9a3
      case 'outbound':
        return 0xffd166
      case 'maintenance':
        return 0xe05d5d
      default:
        return 0x3a6ea5
    }
  }

  const meshes: THREE.Mesh[] = []
  for (const cell of layout.cells) {
    const geometry = new THREE.BoxGeometry(cell.widthM, cell.heightM, cell.lengthM)
    const material = new THREE.MeshStandardMaterial({
      color: colorOf(cell.code),
      roughness: 0.85,
      metalness: 0.05
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(cell.cx, cell.heightM / 2, cell.cy)
    mesh.userData.entityKey = `yard/${cell.code}`
    group.add(mesh)
    meshes.push(mesh)
  }

  // Ground reference plane (Owned).
  const groundGeometry = new THREE.PlaneGeometry(900, 700)
  groundGeometry.rotateX(-Math.PI / 2)
  const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x1b2735, roughness: 1 })
  const ground = new THREE.Mesh(groundGeometry, groundMaterial)
  ground.position.y = -0.05
  group.add(ground)

  graphics.root.add(group)

  // I4-1: 真实 GLB 经 AssetLease 进入世界——清单 → acquire → root。
  // Leased 资源平台所有：场景只 release()，绝不 dispose()（§44）。
  // 资产管线未部署（清单无此 ref）时降级跳过，不阻塞场景。
  let markerLease: AssetLease | undefined
  try {
    markerLease = await ctx.assets.acquire({ id: 'crane-marker-glb', version: 'r1' })
    const marker = markerLease.object as THREE.Object3D
    marker.name = 'stack-yard:crane-marker'
    marker.scale.setScalar(10)
    marker.position.set(0, 0, 0)
    graphics.root.add(marker)
  } catch (error) {
    console.info('[stack-yard] 标记资产不可用，跳过（资产管线未部署时正常降级）', error)
  }

  const offPick = graphics.onPick((event) => {
    if (!event.entity) {
      handlers.onPickStack(undefined)
      return
    }
    if (event.entity.namespace === 'yard') {
      handlers.onPickStack(event.entity.id)
    }
  })

  return {
    dispose() {
      offPick.dispose()
      // 平台负责在引用计数归零时释放 GPU 资源；这里只归还使用权。
      markerLease?.release()
      graphics.root.remove(group)
      for (const mesh of meshes) {
        mesh.geometry.dispose()
        ;(mesh.material as THREE.Material).dispose()
      }
      groundGeometry.dispose()
      groundMaterial.dispose()
    }
  }
}

/** Convenience for the entry: entity -> geodetic focus target. */
export function stackFocusGeodetic(layout: StackLayout, code: string) {
  const cell = layout.cells.find((c) => c.code === code)
  if (!cell) return undefined
  return frameLocalToGeodetic(layout.frame, { x: cell.cx, y: cell.heightM, z: cell.cy })
}

export type { GraphicsContext }
