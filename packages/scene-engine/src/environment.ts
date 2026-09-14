import * as THREE from 'three'
import type { QualityProfile, WaterState, EnvironmentApi } from './types'

/**
 * EnvironmentSystem (§51): atmosphere / lighting / water.
 * Water STATE (level, datum) is separated from water RENDERING quality.
 */
export class EnvironmentSystem implements EnvironmentApi {
  private waterMesh: THREE.Mesh | undefined
  private waterMaterial: THREE.ShaderMaterial | undefined
  private waterState: WaterState | undefined

  constructor(
    scene: THREE.Object3D,
    private readonly profile: QualityProfile,
    options: { water?: { enabled?: boolean; halfSizeMeters?: number } } = {}
  ) {
    const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x2c3440, 0.85)
    scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xfff2df, 1.6)
    sun.position.set(-600, 900, 400)
    if (profile === 'HIGH' || profile === 'EXHIBITION') {
      sun.castShadow = true
      sun.shadow.mapSize.set(2048, 2048)
      sun.shadow.camera.near = 10
      sun.shadow.camera.far = 4000
      sun.shadow.camera.left = -1500
      sun.shadow.camera.right = 1500
      sun.shadow.camera.top = 1500
      sun.shadow.camera.bottom = -1500
    }
    scene.add(sun)
    scene.add(new THREE.AmbientLight(0x334455, 0.35))

    if (options.water?.enabled) {
      const halfSize = options.water.halfSizeMeters ?? 10_000
      const segments = profile === 'OFFICE' ? 1 : profile === 'STANDARD' ? 64 : 128
      const geometry = new THREE.PlaneGeometry(halfSize * 2, halfSize * 2, segments, segments)
      geometry.rotateX(-Math.PI / 2)
      this.waterMaterial = createWaterMaterial(profile)
      this.waterMesh = new THREE.Mesh(geometry, this.waterMaterial)
      this.waterMesh.name = 'twin-water'
      this.waterMesh.receiveShadow = profile === 'HIGH' || profile === 'EXHIBITION'
      scene.add(this.waterMesh)
    }
  }

  get water(): WaterState | undefined {
    return this.waterState
  }

  getWaterState(): WaterState | undefined {
    return this.waterState
  }

  setWaterState(state: WaterState): void {
    this.waterState = { ...state }
    if (this.waterMaterial) {
      this.waterMaterial.uniforms.uWaveHeight.value =
        state.waveHeightMeters ?? defaultWaveFor(this.profile)
      this.waterMaterial.uniforms.uTime.value = 0
    }
    if (this.waterMesh) {
      // NOTE: level height is provided in the ACTIVE frame already by the
      // runtime; the datum-aware conversion happens there via SpatialApi.
      this.waterMesh.position.y = state.levelMeters
    }
  }

  /** Apply datum-aware water height (meters in the active frame). */
  setWaterLevelLocal(localY: number): void {
    if (this.waterMesh) this.waterMesh.position.y = localY
  }

  setFrame(elapsedSeconds: number): void {
    if (this.waterMaterial && this.profile !== 'OFFICE') {
      this.waterMaterial.uniforms.uTime.value = elapsedSeconds
    }
  }

  dispose(): void {
    this.waterMesh?.removeFromParent()
    this.waterMaterial?.dispose()
    this.waterMesh?.geometry.dispose()
    this.waterMesh = undefined
    this.waterMaterial = undefined
    this.waterState = undefined
  }
}

function defaultWaveFor(profile: QualityProfile): number {
  switch (profile) {
    case 'OFFICE':
      return 0
    case 'STANDARD':
      return 0.25
    case 'HIGH':
      return 0.4
    case 'EXHIBITION':
      return 0.6
  }
}

function createWaterMaterial(profile: QualityProfile): THREE.ShaderMaterial {
  const useFresnel = profile !== 'OFFICE' && profile !== 'STANDARD'
  return new THREE.ShaderMaterial({
    transparent: profile !== 'OFFICE',
    uniforms: {
      uTime: { value: 0 },
      uWaveHeight: { value: defaultWaveFor(profile) },
      uDeepColor: { value: new THREE.Color(0x0b3d5c) },
      uShallowColor: { value: new THREE.Color(0x2f7f9f) },
      uSkyColor: { value: new THREE.Color(0x9db8d8) },
      uSunDirection: { value: new THREE.Vector3(-0.5, 0.8, 0.3).normalize() }
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uWaveHeight;
      varying vec3 vWorldPos;
      void main() {
        vec3 p = position;
        float w1 = sin(p.x * 0.02 + uTime * 1.1);
        float w2 = sin(p.z * 0.035 + uTime * 0.7);
        p.y += (w1 + w2) * uWaveHeight;
        vec4 world = modelMatrix * vec4(p, 1.0);
        vWorldPos = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uDeepColor;
      uniform vec3 uShallowColor;
      uniform vec3 uSkyColor;
      uniform vec3 uSunDirection;
      varying vec3 vWorldPos;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        vec3 normal = normalize(vec3(
          sin(vWorldPos.x * 0.05) * 0.15,
          1.0,
          sin(vWorldPos.z * 0.07) * 0.15
        ));
        float depthMix = clamp(0.35 + 0.3 * sin(vWorldPos.x * 0.001 + vWorldPos.z * 0.0013), 0.0, 1.0);
        vec3 base = mix(uDeepColor, uShallowColor, depthMix);
        float fresnel = pow(1.0 - clamp(dot(viewDir, normal), 0.0, 1.0), 3.0);
        vec3 color = mix(base, uSkyColor, ${useFresnel ? 'fresnel * 0.75' : '0.15'});
        vec3 halfVec = normalize(normal + uSunDirection);
        float spec = pow(clamp(dot(viewDir, halfVec), 0.0, 1.0), 80.0);
        color += vec3(spec * 0.6);
        gl_FragColor = vec4(color, 0.94);
      }
    `
  })
}
