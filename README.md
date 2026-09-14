# 船舶制造数字孪生平台

> 以 [docs/digital-twin-architecture-freeze-v1.2.md](docs/digital-twin-architecture-freeze-v1.2.md)
> 为唯一架构基线实现的 Web-first 数字孪生平台。
> 目标与验收基线见 [GOAL.md](GOAL.md)。

## 核心哲学

> **App decides what to run. Scene owns business and experience.
> Host owns lifecycle and isolation. Foundation owns facts and capabilities.
> Engines own rendering. Wrap platform semantics, expose engines.**

- 世界状态只有一份（WorldClient），表现由各引擎负责
- 引擎按需启动（demand-driven）：2D-only 构建不含 Three，进入 3D 才下载 three
- 所有 Foundation 包只暴露 `src/public.ts` 单一入口，架构边界由工具链强制

## 目录

```text
packages/    Foundation：world / spatial / content / world-client /
             map-engine / scene-engine / scene-host / sdk / ui
domains/     跨 Scene 业务复用：vessel / crane / agv / logistics / production
scenes/      业务场景：global-ships / stack-yard / vehicle-navigation /
             production / heavy-transport（三大 Architecture Spike）
apps/        portal（SceneCoordinator + Workspace）+ standalone ×3
tooling/     architecture-tests / scene-compliance / benchmarks /
             asset-pipeline / visual-regression
```

## 快速开始

```bash
pnpm install

# Portal（完整平台：登录壳 / 场景目录 / 世界模式 / 站点切换 / 诊断）
pnpm dev:portal            # http://localhost:5173
# 登录壳：任意名称即可进入演示会话；以 guest 开头的名称为受限角色
# （无「生产数字孪生」权限，用于验证权限强制路径）。

# 独立应用（同一份 Scene 源码，零修改）
pnpm dev:stack-yard        # 分段堆场（2D-first，3D 懒加载）
pnpm dev:production        # 生产数字孪生（2D+3D+水体+快路径）
pnpm dev:vehicles          # 行车导航（2D-only，不加载 three）
```

顶栏能力：世界模式（LIVE / HISTORY / SIM + 时间倍速）、范围切换（全球 / 长兴 / 启东）、
视图（2D / 分屏 / 3D）、质量档位（OFFICE → EXHIBITION）、诊断面板
（fps / p50 / p95 / draw calls / tiles 缓存 / 帧回调数 / JS heap）。

## 工程验证（Architecture Freeze Gate §89）

```bash
pnpm verify                # 全链：lint + typecheck + test + exports + build + 2D-only
pnpm lint                  # ESLint 静态检查（纳入 verify 门禁）
pnpm typecheck             # 全仓严格类型（vue-tsc）
pnpm test                  # 137 项单元/合规测试
pnpm test:e2e              # Playwright 浏览器冒烟（登录/切场景/2D↔3D/世界模式/权限）
pnpm test:architecture     # 16 项架构约束（依赖方向 / 单入口 / 懒加载边界）
pnpm test:compliance       # Scene 合规：mount/unmount 循环 + plateau + 2D/3D×100
pnpm bench                 # 热路径微基准（空间变换 / StateBuffer）
pnpm validate:assets       # 资产清单校验（§42）
```

| Gate | 验证 |
|---|---|
| 1. Stack Yard：Portal + Standalone 双运行 | 同一 `scenes/stack-yard` 源码；`dev:portal` / `dev:stack-yard` |
| 2. Production：2D↔3D 100 次切换 | `test:compliance`（toggle stress，选择与世界状态保持） |
| 3. Heavy Transport：Map + 3D + 运动学 Spike | 场景实现 + compliance 覆盖 |
| 4. mount/unmount stress 无增长泄漏 | `test:compliance`（资源计数回到 baseline） |
| 5. Site A/B 循环 cache plateau | `test:compliance`（6 轮双站点交替 + plateau 断言） |
| 6. 无 Foundation internal deep import | `test:architecture` |
| 7. 2D-only 构建不含 Three | `check:2d-only`（产物扫描） |
| 8. World/Spatial 不依赖 Vue/Three/MapLibre | `test:architecture` |

## 架构要点

- **Scene 生命周期**（§7/§9/§12/§13）：`SceneDefinition → SceneEntry.mount → SceneMount.unmount`；
  SceneHost 提供 AbortController + MountScope + Revocable SceneContext；
  unmount 幂等 / 异常安全 / 限时（默认 3s），超时后 Host 兜底清理并 revoke 上下文。
- **Last selection wins**（§11）：SceneCoordinator 以 AbortController + generation id
  取消未完成的切换，失败回滚。
- **实时两条路径**（§35/§36）：业务状态（任务/告警/状态）走 JSON 信封；
  空间快路径走 `SpatialStateBuffer`（SoA Float64），帧边界批量消费，
  绝不在消息回调里直接写 `Object3D.position`。
- **空间核心**（§37-39）：WGS84 → ECEF(Float64) → Site ENU（X=东, Y=上, Z=-北）→
  Asset/Render Local；垂直基准（椭球/MSL/图载…）一等建模，水位必须经基准链换算。
- **Native-first**（§15/§22/§18）：Scene 直接使用 MapLibre / Three 原生 API，
  平台只封装 WorldSession / ReferenceFrame / AssetLease / View 同步 / 生命周期。
- **资产**（§40-44）：Asset（可复用资源）与 WorldContent（如何进入世界）分离；
  共享资产用引用计数 Lease，Scene 只 `release()`，不 `dispose()` 平台资源。
- **3D Tiles**（§48-50）：只允许 `TilesSystem` 创建 TilesRenderer，
  显式字节/条目预算与诊断（cachedBytes / isFull / 队列 / 失败数）。

## 技术基线（exact pin，升级需跑 §78 全套回归）

```text
vue 3.5 / pinia 4 / vue-router 5 / vite 8 / typescript 5.9
three 0.186.0（WebGL2 生产基线；WebGPU 独立验证线）
maplibre-gl 6.9.0（ESM + WebGL2）
3d-tiles-renderer 0.5.2
```

## 数据接入

浏览器永远不直连 OT/PLC（§81）。生产部署把
`apps/portal/src/gateway.ts`（演示用确定性网关）替换为
`@twin/world-client` 的 `createWebSocketSource` 指向平台数据网关即可，
Scene 代码零修改。演示网关内置 12 艘 AIS 船舶、4 台龙门吊、6 台 AGV、
堆场/任务/告警的确定性数据流，并预置 20 分钟历史回放。

## 已知边界（与冻结文档一致的 V1 范围）

- 3D Tiles / GLB / KTX2 管线与 Lease 已实现并有测试，演示数据暂用程序化资产；
  真实资产通过 `tooling/asset-pipeline` 清单接入（见 docs/asset-pipeline.md）。
- 视觉回归（`tooling/visual-regression`）已实现 capture/compare 全链路
  （Golden 三帧基线入库，pixelmatch 0.5% 阈值）；跨机器基线需在固定
  浏览器版本/渲染环境上重新生成。
- MapLibre 文字标注依赖 glyphs 服务（离线时自动降级为无标注，
  顶栏指示器 tooltip 会显示「底图异常」计数）。
- 参考硬件的正式 4K 跑分与 24h soak 长跑：已脚本化
  （`pnpm soak` / `node tooling/perf/scripts/soak-run.mjs --cycles 1152`），
  300 轮扩展证据见 docs/benchmarks.md Run #4；24h 长跑在验收机一条命令执行。
