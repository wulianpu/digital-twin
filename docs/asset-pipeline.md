# 资产接入指南（Asset Pipeline，I4）

> 架构依据：冻结文档 §40-45（Asset / WorldContent / 所有权模型）、§78（升级回归）。
> 实现：`packages/content`（清单与校验）、`packages/scene-engine/src/resources.ts`
> （AssetLease 运行时）、`tooling/asset-pipeline`（校验与样例生成）。

## 1. 总览

```text
Source Asset (IFC/RVT/DCC/点云)
   ↓  （离线管线，产出运行时资产）
Canonical Asset（GLB / 3D Tiles / KTX2）
   ↓  manifest（清单 = 平台与管线之间的契约）
ContentRegistry.registerAssetManifest()
   ↓  ctx.assets.acquire(ref)   ← Scene 唯一入口（glb/gltf/collision-proxy）
      （tileset 不走此入口：由 SceneEngine TilesSystem 拥有，
        经 TilesPolicy.tilesetUrls / descriptor bridge 加载；
        ktx2-texture / binary-metadata / kinematic-model 在 V1 为
        reserved——acquire 会 fail-fast 抛 UnsupportedAssetKindError）
AssetLease（引用计数；归零时平台释放 GPU 资源）
   ↓  graphics.root.add(lease.object)
Scene unmount → lease.release()（只归还使用权，绝不 dispose 平台资源，§44）
```

## 2. 清单规范

```jsonc
// manifest（AssetManifest / WorldContentManifest）
{
  "assets": [
    {
      "ref": { "id": "gantry-crane-glb", "version": "r3" },  // id 必须 kebab-case
      "kind": "glb",                // glb | gltf | ktx2-texture | tileset | collision-proxy | kinematic-model | binary-metadata
      "url": "https://assets.example/…/gantry-crane.glb",  // http(s) / data: / 或注册的自定义 scheme（如 memory:）
      "bytes": 48211234,            // 估算字节 → 内存预算（maxTotalBytes）与诊断
      "metadata": { "lod": "high" }
    }
  ]
}
```

校验（CI 已接入 `pnpm test`，也可独立执行）：

```bash
pnpm validate:assets                                    # 校验 tooling/asset-pipeline/manifests/
TWIN_MANIFEST_DIR=/path/to/manifests pnpm validate:assets  # 部署清单
```

规则：重复 id / 非法 kind / 缺 url / url scheme 白名单（http(s)、`/`、`memory:`）/ 站点引用完整性。

## 3. 样例资产生成（无外部资产服务器时）

```bash
node tooling/asset-pipeline/scripts/generate-sample-assets.mjs
# → apps/portal/public/assets/models/crane-marker.glb / yard-block.glb
```

产物为确定性字节的最小 glTF 2.0（GLB）样例，入库提交；
`tooling/asset-pipeline/glb.test.ts` 用运行时同款 GLTFLoader 验证其可解析性。

## 4. Scene 接入（引用计数租约）

```ts
// 进入 3D 时（stack-yard 实现样例）
let lease: AssetLease | undefined
try {
  lease = await ctx.assets.acquire({ id: 'crane-marker-glb', version: 'r1' })
  graphics.root.add(lease.object as THREE.Object3D)
} catch (error) {
  // 资产不可用 → 降级跳过，不阻塞场景
}
// unmount：只归还使用权；GPU 释放由平台在引用计数归零时执行（§43-44）
lease?.release()
```

禁止（§44）：对 Leased 资产的材质/纹理调用 `dispose()`；平台在归零时统一释放。

## 5. 解码器装配（KTX2 / DRACO / meshopt）

装配发生在**应用组合根**（`apps/portal/src/foundation.ts` 的 `gltfLoaderEnhancer`），
平台层只提供钩子——组合根持有 renderer（KTX2 `detectSupport` 需要）与部署配置：

- `VITE_ASSET_DECODER_PATH`：KTX2 basis 转码器与 DRACO 解码器的基础路径。
  **离线部署**：把 three 仓库 `examples/jsm/libs/basis/`（转码器）与 DRACO 解码器
  拷贝到静态目录，将此变量指向该目录（如 `/decoders/`），并在 nginx 放开对应 MIME。
  缺省为随 three exact pin（0.186.0）的 unpkg CDN——**内网环境必须覆盖**。

## 6. 内存预算

- 租约按清单 `bytes` 累计：`AssetLeaseManager.estimatedBytesTotal`。
- `maxTotalBytes` 超限时 `acquire` 直接拒绝（错误含当前用量），已在最旧租约
  仍被持有的情况下保护页面不因资产膨胀而崩溃。
- 诊断：顶栏诊断面板显示活跃租约数；字节数预算接线见上。

## 7. 3D Tiles 接入（I4-3）

```bash
VITE_TILES_TILESET_URL=https://tiles.example/site/tileset.json
```

引擎启动即经 `TilesSystem.addTileset` 接入（§48：Scene 禁止 `new TilesRenderer`），
并套用全局缓存预算（`VITE_TILES_MAX_BYTES`）。诊断（`cachedBytes / isFull /
downloading / parsing / failed` 等，§50）随 Portal「诊断」面板自动输出；
tileset 不可达时引擎记录错误并继续运行。

## 8. 部署要点

- nginx 已为 `.glb` 设置 `model/gltf-binary` MIME 与不可变缓存（`deploy/nginx.conf`）。
- 资产版本化：目录/URL 带 `version`（如 `…/r3/…`）+ 不可变缓存；新版本 = 新 URL。
- 3D Tiles 与 GLB 的服务器均需允许跨域（或与 Portal 同域反代）。
- 升级 three / 3d-tiles-renderer 前：`pnpm verify` + `pnpm test:compliance` +
  `pnpm bench` + Golden Scene 视觉回归（§78）。
