import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// GLTFLoader.parse 在 Node 下无需 WebGL/DOM 网络
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * I4-1 资产管线验证：生成器产出的 .glb 必须是有效的 glTF 2.0，
 * 并能被运行时同款加载器（GLTFLoader）解析出预期网格。
 */

const modelsDir = join(import.meta.dirname, '../../apps/portal/public/assets/models')

function parseGlb(file: string): Promise<{ name: string; meshCount: number }> {
  const data = readFileSync(join(modelsDir, file))
  const arrayBuffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  )
  const loader = new GLTFLoader()
  return new Promise((resolve, reject) => {
    loader.parse(
      arrayBuffer as ArrayBuffer,
      '',
      (gltf) => {
        const meshes: string[] = []
        gltf.scene.traverse((obj) => {
          const mesh = obj as { isMesh?: boolean; name?: string }
          if (mesh.isMesh) meshes.push(mesh.name ?? '')
        })
        resolve({ name: gltf.scene.children[0]?.name ?? '', meshCount: meshes.length })
      },
      (error) => reject(new Error(String(error)))
    )
  })
}

describe('样例 GLB 资产（I4-1 管线验证）', () => {
  it('crane-marker.glb 可被 GLTFLoader 解析', async () => {
    const { name, meshCount } = await parseGlb('crane-marker.glb')
    expect(name).toBe('crane-marker')
    expect(meshCount).toBe(1)
  })

  it('yard-block.glb 可被 GLTFLoader 解析', async () => {
    const { name, meshCount } = await parseGlb('yard-block.glb')
    expect(name).toBe('yard-block')
    expect(meshCount).toBe(1)
  })
})
