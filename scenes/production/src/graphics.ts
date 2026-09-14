import * as THREE from 'three'
import type { GraphicsContext, SceneContext } from '@twin/sdk'
import type { CraneState } from '@twin/domain-crane'
import type { ProductionLayout } from './data'

export interface ProductionGraphicsHandle {
  /** Apply latest crane business state (2 Hz); visual smoothing at frame rate. */
  applyCraneState(code: string, state: CraneState): void
  /** I4-1 补充：新出现的 AGV 实体注册表示（数据驱动，场景 mount 时未知）。 */
  ensureAgv(key: string): void
  /** Datum-aware water state (§39/§51) — site-frame level. */
  setWaterLevelLocalY(localY: number): void
  dispose(): void
}

/**
 * 3D representation — reached ONLY through dynamic import (§26). All Three
 * objects created here are Owned and explicitly disposed (§45). The render
 * loop is the engine's; this module only subscribes via onFrame (§21).
 */
export async function mountGraphics(
  ctx: SceneContext,
  layout: ProductionLayout,
  registerEntity: (key: string, object: THREE.Object3D) => { dispose(): void }
): Promise<ProductionGraphicsHandle> {
  const graphics: GraphicsContext = await ctx.graphics!.use()

  const group = new THREE.Group()
  group.name = 'production:twin'
  graphics.root.add(group)

  const disposables: Array<{ dispose(): void }> = []

  // Ground.
  const groundGeometry = new THREE.PlaneGeometry(1400, 1300)
  groundGeometry.rotateX(-Math.PI / 2)
  const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x1e2a38, roughness: 1 })
  const ground = new THREE.Mesh(groundGeometry, groundMaterial)
  group.add(ground)
  disposables.push(groundGeometry, groundMaterial)

  // Buildings (extruded footprints; would be 3D Tiles in production, §41).
  for (const b of layout.buildings) {
    const geometry = new THREE.BoxGeometry(b.widthM, b.heightM, b.depthM)
    const material = new THREE.MeshStandardMaterial({ color: 0x33415c, roughness: 0.9 })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(b.cx, b.heightM / 2, b.cz)
    mesh.userData.entityKey = `facility/${b.key}`
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    disposables.push(geometry, material)
  }

  // Gantry cranes: legs + beam + trolley + hook (kinematic from business state).
  const craneActors = new Map<string, CraneActor>()
  for (const base of layout.cranes) {
    const actor = new CraneActor(base.x, base.z, base.trackLengthM)
    actor.group.userData.entityKey = `production/${base.code}`
    group.add(actor.group)
    craneActors.set(base.code, actor)
    disposables.push(actor)
  }

  // AGVs: representations driven by the SpatialStateBuffer at frame
  // boundaries via the engine EntitySystem (§35-36 fast path).
  const agvMeshes = new Map<string, { mesh: THREE.Mesh; dispose(): void }>()
  const agvGeometry = new THREE.BoxGeometry(6, 3, 10)
  const agvMaterial = new THREE.MeshStandardMaterial({ color: 0x4f9cf9, emissive: 0x123a5e })
  disposables.push(agvGeometry, agvMaterial)

  function ensureAgv(key: string): THREE.Mesh {
    let entry = agvMeshes.get(key)
    if (!entry) {
      const mesh = new THREE.Mesh(agvGeometry, agvMaterial)
      mesh.userData.entityKey = `agv/${key}`
      group.add(mesh)
      disposables.push(registerEntity(`agv/${key}`, mesh))
      entry = { mesh, dispose: () => group.remove(mesh) }
      agvMeshes.set(key, entry)
    }
    return entry.mesh
  }

  // Water plane spans beyond the quay; the ENGINE owns its base mesh via the
  // environment system — the scene only sets STATE (§51).
  graphics.environment.setWaterState({
    levelMeters: 0,
    verticalReference: 'site-datum',
    waveHeightMeters: 0.45,
    currentDirectionDeg: 250,
    currentSpeedMs: 0.6
  })

  const offPick = graphics.onPick((event) => {
    void event // picking resolves via userData; scenes wire selection in entry
  })

  // ONE high-frequency entry point: kinematic smoothing at frame rate (§21).
  const offFrame = graphics.onFrame(({ deltaSeconds }) => {
    for (const actor of craneActors.values()) actor.update(deltaSeconds)
  })

  return {
    applyCraneState(code, state) {
      craneActors.get(code)?.target(state)
    },
    ensureAgv(key) {
      ensureAgv(key)
    },
    setWaterLevelLocalY(localY: number) {
      graphics.environment.setWaterState({
        levelMeters: localY,
        verticalReference: 'site-datum'
      })
    },
    dispose() {
      offFrame.dispose()
      offPick.dispose()
      for (const entry of agvMeshes.values()) entry.dispose()
      agvMeshes.clear()
      graphics.root.remove(group)
      for (const d of disposables) d.dispose()
      disposables.length = 0
    }
  }
}

/**
 * Gantry crane kinematic representation. Business state arrives at low Hz;
 * the actor exponentially-smooths toward the target INSIDE the frame loop —
 * never in a WebSocket callback (§36), and without per-frame allocation (§65).
 */
class CraneActor {
  readonly group = new THREE.Group()
  private readonly trolley: THREE.Mesh
  private readonly hook: THREE.Mesh
  private readonly cable: THREE.Mesh
  private readonly geometry: THREE.BoxGeometry
  private readonly materials: THREE.Material[] = []

  private current = { gantry: 0, trolley: 0, hookY: 20 }
  private goal = { gantry: 0, trolley: 0, hookY: 20 }
  private readonly baseX: number

  constructor(baseX: number, baseZ: number, trackLengthM: number) {
    this.baseX = baseX
    this.geometry = new THREE.BoxGeometry(1, 1, 1)
    const legMaterial = new THREE.MeshStandardMaterial({ color: 0xd97f2e, roughness: 0.6, metalness: 0.3 })
    const beamMaterial = new THREE.MeshStandardMaterial({ color: 0xe8944a, roughness: 0.5, metalness: 0.4 })
    const cableMaterial = new THREE.MeshBasicMaterial({ color: 0xcccccc })
    this.materials.push(legMaterial, beamMaterial, cableMaterial)
    this.group.add(box(this.geometry, legMaterial, 14, 3, 14, -18, 22, 0))
    this.group.add(box(this.geometry, legMaterial, 14, 3, 14, 18, 22, 0))
    this.group.add(box(this.geometry, beamMaterial, 46, 4, 4, 0, 40, 0))
    this.group.add(box(this.geometry, beamMaterial, 4, 30, 4, -20, 18, 0))
    this.group.add(box(this.geometry, beamMaterial, 4, 30, 4, 20, 18, 0))
    this.trolley = box(this.geometry, beamMaterial, 8, 3, 8, 0, 37, 0)
    this.hook = box(this.geometry, legMaterial, 4, 3, 4, 0, 20, 0)
    this.cable = box(this.geometry, cableMaterial, 0.4, 1, 0.4, 0, 28, 0)
    this.group.add(this.trolley, this.hook, this.cable)
    // Rail sleepers along the gantry track.
    for (let i = 0; i <= trackLengthM; i += 40) {
      this.group.add(box(this.geometry, legMaterial, 2, 1.2, 2, i - trackLengthM / 2, 0.6, 0))
    }
    this.group.position.set(baseX, 0, baseZ)
  }

  target(state: CraneState): void {
    this.goal.gantry = state.gantryMeters
    this.goal.trolley = state.trolleyMeters
    this.goal.hookY = Math.max(2, state.hookHeightMeters)
  }

  /** Frame-boundary smoothing toward the latest business state (§36, §65). */
  update(dt: number): void {
    const k = Math.min(1, dt * 2.5)
    this.current.gantry += (this.goal.gantry - this.current.gantry) * k
    this.current.trolley += (this.goal.trolley - this.current.trolley) * k
    this.current.hookY += (this.goal.hookY - this.current.hookY) * k
    this.group.position.x = this.baseX + this.current.gantry
    this.trolley.position.x = this.current.trolley
    this.hook.position.set(this.current.trolley, this.current.hookY, 0)
    const cableHeight = Math.max(0.1, 35.5 - this.current.hookY)
    this.cable.scale.y = cableHeight
    this.cable.position.set(this.current.trolley, this.current.hookY + cableHeight / 2, 0)
  }

  dispose(): void {
    this.geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.group.removeFromParent()
  }
}

function box(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number
): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material)
  m.scale.set(sx, sy, sz)
  m.position.set(x, y, z)
  m.castShadow = true
  return m
}

export type { SceneContext }
