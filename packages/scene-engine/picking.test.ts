// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { PickingSystem } from './src/picking'

/** -------- Issue #17-r2：GLOBAL SceneMountContainer 的 picking 覆盖回归 */

describe('PickingSystem GLOBAL SceneMountContainer（Issue #17-r2）', () => {
  function makeFakeDomElement() {
    const listeners: Record<string, Array<(e: unknown) => void>> = {}
    return {
      element: {
        addEventListener: (type: string, cb: (e: unknown) => void) => {
          ;(listeners[type] ??= []).push(cb)
        },
        removeEventListener: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
      } as unknown as HTMLElement,
      dispatch(type: 'pointerdown' | 'pointerup', x: number, y: number) {
        for (const cb of listeners[type] ?? []) cb({ clientX: x, clientY: y })
      }
    }
  }

  it('GLOBAL：mount root 在 globalSceneRoots（非 sceneRoots）下仍可拾取', () => {
    const { element, dispatch } = makeFakeDomElement()
    // 复刻 runtime 层级：scene ⊃ globalWorldRoot（-p）⊃ globalSceneRoots
    const scene = new THREE.Scene()
    const globalWorldRoot = new THREE.Group()
    scene.add(globalWorldRoot)
    const globalSceneRoots = new THREE.Group()
    globalWorldRoot.add(globalSceneRoots)
    const sceneRoots = new THREE.Group()
    scene.add(sceneRoots)

    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, 0, 0)
    camera.lookAt(0, 0, -1)

    // 相机 ECEF-scene pose p（例如地球半径处）：整个 global 层被 -p 平移
    const p = new THREE.Vector3(0, 0, 6378)
    globalWorldRoot.position.copy(p).negate()
    scene.updateMatrixWorld(true)

    // GLOBAL Scene 的对象挂在 globalSceneRoots 下的 mount root：
    // local = p（ECEF-scene pose）+ 相机前方偏移 → world = 相机正前方近处
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12))
    mesh.position.copy(p).add(new THREE.Vector3(0, 0, -5))
    mesh.userData.entityKey = 'ais/hull-1'
    globalSceneRoots.add(mesh)
    scene.updateMatrixWorld(true)

    const picking = new PickingSystem(element, () => globalSceneRoots, () => camera)
    const onPick = vi.fn()
    picking.onPick(onPick)

    dispatch('pointerdown', 400, 300)
    dispatch('pointerup', 400, 300)

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]![0].entity).toEqual({
      namespace: 'ais',
      id: 'hull-1'
    })

    // 对照：若 raycast 写死 sceneRoots（旧回归行为）——GLOBAL 对象永远 miss
    const legacyPicking = new PickingSystem(
      element,
      () => sceneRoots,
      () => camera
    )
    const legacyPick = vi.fn()
    legacyPicking.onPick(legacyPick)
    dispatch('pointerdown', 400, 300)
    dispatch('pointerup', 400, 300)
    // 旧回归行为：raycast 写死 sceneRoots → GLOBAL 对象永远 miss
    expect(legacyPick.mock.calls[0]![0].entity).toBeUndefined()
    picking.dispose()
    legacyPicking.dispose()
  })

  it('SITE：sceneRoots 路径保持不变（回归保护）', () => {
    const { element, dispatch } = makeFakeDomElement()
    const sceneRoots = new THREE.Group()
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, 0, 0)
    camera.lookAt(0, 0, -1)

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12))
    mesh.position.set(0, 0, -5)
    mesh.userData.entityKey = 'agv/1'
    sceneRoots.add(mesh)
    sceneRoots.updateMatrixWorld(true)

    const picking = new PickingSystem(element, () => sceneRoots, () => camera)
    const onPick = vi.fn()
    picking.onPick(onPick)
    dispatch('pointerdown', 400, 300)
    dispatch('pointerup', 400, 300)
    expect(onPick.mock.calls[0]![0].entity).toEqual({ namespace: 'agv', id: '1' })
    picking.dispose()
  })
})
