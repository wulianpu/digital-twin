import * as THREE from 'three'
import { parseEntityKey } from '@twin/world'
import type { PickEvent } from './types'

export type PickHandler = (event: PickEvent) => void

/**
 * PickingSystem (§46): raycasts the SceneMountRoot on click gestures and
 * reports entity keys via userData.entityKey. Selection state itself stays
 * in the World context (§57) — scenes wire pick events to ctx.selection.
 *
 * Issue #29/#31 同类坐标边界：PickEvent.localPoint 的 contract 是 **Engine
 * 逻辑 scene 坐标**（SITE: frame-local m；GLOBAL: scene-axis ECEF km）——
 * raycast 的 hit.point 是 render-world 坐标（含 floating-origin ancestor
 * shift），必须经 renderToLogical（Engine 注入，见 FloatingOriginState）
 * 恢复逻辑坐标后再上报。
 */
export class PickingSystem {
  private readonly handlers = new Set<PickHandler>()
  private readonly raycaster = new THREE.Raycaster()
  private readonly renderToLogical: ((v: THREE.Vector3) => void) | undefined
  private downX = 0
  private downY = 0
  private downTime = 0

  constructor(
    private readonly domElement: HTMLElement,
    private readonly getRoot: () => THREE.Object3D | undefined,
    private readonly getCamera: () => THREE.Camera | undefined,
    renderToLogical?: (v: THREE.Vector3) => void
  ) {
    this.renderToLogical = renderToLogical
    domElement.addEventListener('pointerdown', this.onPointerDown)
    domElement.addEventListener('pointerup', this.onPointerUp)
  }

  onPick(cb: PickHandler): () => void {
    this.handlers.add(cb)
    return () => {
      this.handlers.delete(cb)
    }
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown)
    this.domElement.removeEventListener('pointerup', this.onPointerUp)
    this.handlers.clear()
  }

  private onPointerDown = (e: PointerEvent) => {
    this.downX = e.clientX
    this.downY = e.clientY
    this.downTime = performance.now()
  }

  private onPointerUp = (e: PointerEvent) => {
    const dx = e.clientX - this.downX
    const dy = e.clientY - this.downY
    if (dx * dx + dy * dy > 25 || performance.now() - this.downTime > 400) return
    const root = this.getRoot()
    const camera = this.getCamera()
    if (!root || !camera) return

    const rect = this.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(ndc, camera)
    const hits = this.raycaster.intersectObject(root, true)
    // Issue #36：最近命中优先——命中无 entityKey 的普通几何也是合法 hit
    //（entity === undefined ≠ miss）；此前只报 entity 命中会让 miss 与
    // 逻辑原点命中在 public API 上不可区分
    const hit = hits[0]
    // Issue #29 同类边界：render-world → logical，floating-origin 不外泄；
    // miss（无 hit）不做变换，也不产生合成哨兵坐标
    let localPoint: { x: number; y: number; z: number } | undefined
    if (hit) {
      this.renderToLogical?.(hit.point)
      localPoint = { x: hit.point.x, y: hit.point.y, z: hit.point.z }
    }
    const event: PickEvent = {
      entity: hit ? findEntityKey(hit.object) : undefined,
      localPoint
    }
    for (const handler of [...this.handlers]) handler(event)
  }
}

function findEntityKey(object: THREE.Object3D): ReturnType<typeof parseEntityKey> | undefined {
  let current: THREE.Object3D | null = object
  while (current) {
    const key = (current.userData as { entityKey?: string }).entityKey
    if (typeof key === 'string' && key.includes('/')) {
      try {
        return parseEntityKey(key)
      } catch {
        return undefined
      }
    }
    current = current.parent
  }
  return undefined
}
