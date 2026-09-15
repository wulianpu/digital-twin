import * as THREE from 'three'
import type { Vec3d } from '@twin/spatial'
import type { GlobalEnvironmentApi } from './types'

const EARTH_A_KM = 6378.137
const EARTH_B_KM = 6356.7523142

/**
 * Procedural WGS84 globe for the GLOBAL scope: camera-relative rendering
 * with scene units of KILOMETERS (ECEF / 1000). This keeps Float64 positions
 * out of the float32 GPU path (§37.2): every object is placed in ECEF-km and
 * the whole globe root is shifted against the camera (floating origin).
 */
export class GlobalEarthSystem implements GlobalEnvironmentApi {
  readonly enabled = true
  readonly root = new THREE.Group()

  constructor(scene: THREE.Object3D) {
    const geometry = new THREE.SphereGeometry(1, 96, 64)
    const texture = createGraticuleTexture()
    const material = new THREE.MeshBasicMaterial({ map: texture })
    const ellipsoid = new THREE.Mesh(geometry, material)
    ellipsoid.scale.set(EARTH_A_KM, EARTH_B_KM, EARTH_A_KM)
    this.root.name = 'twin-global-earth'
    this.root.add(ellipsoid)
    scene.add(this.root)
  }

  /**
   * 纯 placement（Issue #17-A）：ECEF meters -> scene position (km)。
   * **不 reparent**——调用方对象保留在自己的 mount-owned subtree 下；
   * 本 root 仅承担 camera-relative shift（§37.2），不得收编 Scene 资源。
   */
  setObjectEcefPosition(object: THREE.Object3D, ecefMeters: Vec3d): void {
    object.position.set(ecefMeters.x / 1000, ecefMeters.z / 1000, -ecefMeters.y / 1000)
  }

  /** Scene km -> ECEF meters for the current frame (camera position). */
  static sceneToEcefMeters(p: Vec3d): Vec3d {
    // Scene axes: x=X, y=Z, z=-Y (so that Y-up rendering matches ECEF Z-up).
    return { x: p.x * 1000, y: -p.z * 1000, z: p.y * 1000 }
  }

  static ecefMetersToScene(e: Vec3d): Vec3d {
    return { x: e.x / 1000, y: e.z / 1000, z: -e.y / 1000 }
  }

  dispose(): void {
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    })
    this.root.removeFromParent()
  }
}

function createGraticuleTexture(): THREE.Texture {
  const width = 2048
  const height = 1024
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#0d1b2e'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = 'rgba(120, 160, 210, 0.25)'
  ctx.lineWidth = 1
  for (let lon = -180; lon <= 180; lon += 15) {
    const x = ((lon + 180) / 360) * width
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = ((90 - lat) / 180) * height
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  // Equator + prime meridian emphasis
  ctx.strokeStyle = 'rgba(140, 190, 240, 0.5)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, height / 2)
  ctx.lineTo(width, height / 2)
  ctx.stroke()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
