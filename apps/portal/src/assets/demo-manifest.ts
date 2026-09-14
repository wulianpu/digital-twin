import type { AssetManifest } from '@twin/content'

/**
 * 演示资产清单（I4-1）：由 tooling/asset-pipeline/generate-sample-assets.mjs
 * 生成到 public/assets/models/。生产部署的清单来自资产服务器
 * （经 ContentRegistry 注册，校验见 docs/asset-pipeline.md）。
 */
export const DEMO_ASSET_MANIFEST: AssetManifest = {
  assets: [
    {
      ref: { id: 'crane-marker-glb', version: 'r1' },
      kind: 'glb',
      url: '/assets/models/crane-marker.glb',
      bytes: 892
    },
    {
      ref: { id: 'yard-block-glb', version: 'r1' },
      kind: 'glb',
      url: '/assets/models/yard-block.glb',
      bytes: 884
    }
  ]
}
