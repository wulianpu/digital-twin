import * as THREE from 'three'
import { parseEntityKey } from '@twin/world'
import type { PickEvent } from './types'

export type PickHandler = (event: PickEvent) => void

/**
 * PickingSystem (§46): raycasts the SceneMountRoot on click gestures and
 * reports entity keys via userData.entityKey. Selection state itself stays
 * in the World context (§57) — scenes wire pick events to ctx.selection.
 */
export class PickingSystem {
  private readonly handlers = new Set<PickHandler>()
  private readonly raycaster = new THREE.Raycaster()
  private downX = 0
  private downY = 0
  private downTime = 0

  constructor(
    private readonly domElement: HTMLElement,
    private readonly getRoot: () => THREE.Object3D | undefined,
    private readonly getCamera: () => THREE.Camera | undefined
  ) {
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
    const hit = hits.find((h) => findEntityKey(h.object) !== undefined)
    const point = hit?.point ?? new THREE.Vector3()
    const event: PickEvent = {
      entity: hit ? findEntityKey(hit.object) : undefined,
      localPoint: { x: point.x, y: point.y, z: point.z }
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
