#!/usr/bin/env node
/**
 * 样例资产生成器（I4-1）：程序化生成最小有效的 glTF 2.0 二进制（.glb），
 * 用于在不依赖外部资产服务器的情况下跑通「清单 → AssetLease → GLTFLoader → 场景」
 * 的真实管线。产物为确定性字节，提交入库；重新生成：
 *
 *   node tooling/asset-pipeline/scripts/generate-sample-assets.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const outDir = join(repoRoot, 'apps/portal/public/assets/models')

/** 金字塔标记体：底面正方形 + 顶点，18 索引。 */
function pyramidPositions() {
  return [
    [-0.5, 0, -0.5],
    [0.5, 0, -0.5],
    [0.5, 0, 0.5],
    [-0.5, 0, 0.5],
    [0, 1, 0]
  ]
}

function buildGlb({ name, baseColor }) {
  const positions = pyramidPositions()
  const indices = [
    0, 4, 1,
    1, 4, 2,
    2, 4, 3,
    3, 4, 0,
    0, 1, 2,
    0, 2, 3
  ]

  const positionBytes = new Float32Array(positions.flat())
  const indexBytes = new Uint16Array(indices)
  const positionBuffer = Buffer.from(positionBytes.buffer)
  const indexBuffer = Buffer.from(indexBytes.buffer)
  const bin = Buffer.concat([positionBuffer, indexBuffer])

  const gltf = {
    asset: { version: '2.0', generator: 'twin-asset-pipeline/1.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [
      {
        name,
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
            material: 0,
            mode: 4
          }
        ]
      }
    ],
    materials: [
      {
        name: `${name}-mat`,
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: baseColor,
          metallicFactor: 0.1,
          roughnessFactor: 0.7
        }
      }
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126, // FLOAT
        count: positions.length,
        type: 'VEC3',
        min: [-0.5, 0, -0.5],
        max: [0.5, 1, 0.5]
      },
      {
        bufferView: 1,
        componentType: 5123, // UNSIGNED_SHORT
        count: indices.length,
        type: 'SCALAR'
      }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBuffer.length, target: 34962 },
      { buffer: 0, byteOffset: positionBuffer.length, byteLength: indexBuffer.length, target: 34963 }
    ],
    buffers: [{ byteLength: bin.length }]
  }

  return toGlb(gltf, bin)
}

/** glTF JSON + BIN chunk → GLB 容器（4 字节对齐填充）。 */
function toGlb(gltf, bin) {
  const jsonHeader = Buffer.from(JSON.stringify(gltf), 'utf8')
  const jsonPad = (4 - (jsonHeader.length % 4)) % 4
  const jsonChunk = Buffer.concat([
    jsonHeader,
    Buffer.alloc(jsonPad, 0x20) // 空格填充
  ])
  const binPad = (4 - (bin.length % 4)) % 4
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0x00)])

  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length
  const out = Buffer.alloc(total)
  const view = new DataView(out.buffer)

  view.setUint32(0, 0x46546c67, true) // magic 'glTF'
  view.setUint32(4, 2, true) // version
  view.setUint32(8, total, true)

  let offset = 12
  view.setUint32(offset, jsonChunk.length, true)
  view.setUint32(offset + 4, 0x4e4f534a, true) // 'JSON'
  jsonChunk.copy(out, offset + 8)
  offset += 8 + jsonChunk.length

  view.setUint32(offset, binChunk.length, true)
  view.setUint32(offset + 4, 0x004e4942, true) // 'BIN'
  binChunk.copy(out, offset + 8)

  return out
}

mkdirSync(outDir, { recursive: true })

const assets = [
  { file: 'crane-marker.glb', name: 'crane-marker', baseColor: [0.85, 0.5, 0.15, 1] },
  { file: 'yard-block.glb', name: 'yard-block', baseColor: [0.35, 0.55, 0.8, 1] }
]

for (const asset of assets) {
  const glb = buildGlb(asset)
  const target = join(outDir, asset.file)
  writeFileSync(target, glb)
  console.log(`✓ ${target} (${glb.length} bytes)`)
}
