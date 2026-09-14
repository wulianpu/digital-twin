# 部署手册（I1）

## 本地生产预览

```bash
cp .env.example .env       # 按需填写 VITE_*（留空保持演示行为）
docker compose up --build  # http://localhost:8080
```

健康检查：`curl http://localhost:8080/healthz`。

> 注意：`VITE_*` 是**构建期**注入（Vite 在打包时内联），修改后需要重新 build 镜像。
> CI 构建时通过 build args 传入。

## CI

`.github/workflows/ci.yml`：

- 所有 push / PR：`pnpm verify`（typecheck → 85 项测试（含 Scene 合规与架构约束）→
  exports 检查 → 4 应用构建 → 2D-only Gate）+ 资产清单校验。
- `main` 分支额外执行 `docker build` 验证镜像可构建（不推送）。

## 生产拓扑（§81 OT/IT 边界）

```text
浏览器 ── HTTPS ── nginx(Portal 静态资源)
              └── /gateway(WS 反代,按需启用) ── 平台数据网关 ── OT
浏览器 ── HTTPS ── 资产/3D Tiles 静态服务
```

- Portal 只发**订阅**，不直连任何 OT 系统；下行即 `@twin/world-client` 的 DataEnvelope。
- 打开 `deploy/nginx.conf` 中 `/gateway` 反代注释块并指向真实网关；
  前端构建时设置 `VITE_GATEWAY_WS_URL=wss://<host>/gateway`。
- 上行命令通道（Business Command Service，含鉴权/审计/安全联锁）属于 I3+ 范围，
  当前版本 Portal 为只读订阅。

## 构建参数

| 变量 | 作用 | 缺省行为 |
|---|---|---|
| `VITE_GATEWAY_WS_URL` | 生产网关 WS 地址 | 内置演示网关 |
| `VITE_MAP_STYLE_URL` | 远端 MapLibre style | 内置离线暗色底图 |
| `VITE_RASTER_TILES_URL` | 内置底图的 raster 瓦片模板 | 无影像层 |
| `VITE_TILES_MAX_BYTES` | 3D Tiles 全局缓存字节预算 | 512MiB |
| `VITE_DEFAULT_QUALITY` | 初始质量档位 | STANDARD |
| `VITE_TILES_TILESET_URL` | 真实 3D Tiles tileset 入口（I4-3） | 不加载 tileset |
| `VITE_ASSET_DECODER_PATH` | KTX2/DRACO 解码器基础路径（I4-2） | three CDN（随 exact pin） |

## 升级约束（冻结文档 §78）

`three` / `maplibre-gl` / `3d-tiles-renderer` 为 exact pin。
升级任何一项必须全套回归：`pnpm verify` + `pnpm test:compliance` + `pnpm bench`，
并按 `tooling/visual-regression/README.md` 更新 Golden Scene 基线。
