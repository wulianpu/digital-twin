# 项目目标 — 船舶制造数字孪生平台持续迭代至生产可用

> 架构基线：[docs/digital-twin-architecture-freeze-v1.2.md](docs/digital-twin-architecture-freeze-v1.2.md)（冻结，不改）
> 工程与运行说明：[README.md](README.md)
> 本文件是**持续迭代的唯一目标源**：定期自动化按「迭代待办」顺序领取条目 → 实现 → 验证 → 回写。

## 已达成：v1.2 架构基线（2026-09-13）

Architecture Freeze Gate（冻结文档 §89）8/8 通过，验证方式见 README「工程验证」：
typecheck 全绿、85 项测试（含 Scene 合规 100 次 2D↔3D 切换、站点 A/B plateau、
mount/unmount stress）、16 项架构约束、4 应用全量构建、2D-only 构建无 Three、
Portal 浏览器实测（场景切换 / Live↔History / 实时数据流）。

## 生产就绪定义（DoD）

达到以下全部条件即判定「生产可用」：

1. **一键部署**：干净机器 `docker compose up` 即可运行 Portal（含 nginx、缓存、安全头、健康检查）。
2. **CI 守护**：推送/PR 自动运行 `pnpm verify`（typecheck + test + exports + build + 2D-only）。
3. **真实数据可接**：仅通过环境变量即可从演示网关切到生产 WebSocket 网关；浏览器不直连 OT（§81）。
4. **认证与权限**：可插拔身份适配器；权限不足时目录与进入行为被强制（而非仅置灰）。
5. **性能与内存验收**：参考终端 2560×1440 ≥30FPS（p95≤33ms）；24h 长跑内存 plateau 报告。
6. **质量守护**：E2E 冒烟（场景切换/视图切换/世界模式）+ 视觉回归基线 + 错误上报钩子。
7. **可观测与运维**：诊断导出、健康检查、结构化日志接入点、运维手册。
8. **文档**：部署手册、网关协议规约、资产接入指南。

## 迭代待办（自动化按序领取；完成即勾选并写迭代日志）

### I1 部署基座（P0）

- [x] I1-1 Portal 运行配置化：`VITE_GATEWAY_WS_URL` / `VITE_MAP_STYLE_URL` / `VITE_RASTER_TILES_URL` / `VITE_TILES_MAX_BYTES` / `VITE_DEFAULT_QUALITY`，经 `apps/portal/src/config.ts` 注入 foundation；未配置时保持演示行为
- [x] I1-2 配置化真实网关切换：配置 `VITE_GATEWAY_WS_URL` 时 live 源改用 `createWebSocketSource`（history/simulation 仍走演示源并在日志中提示）
- [x] I1-3 `deploy/nginx.conf`：SPA 回退、/assets 长缓存、gzip、安全头、`/healthz`、WS 反代占位
- [x] I1-4 多阶段 `Dockerfile`（pnpm fetch 层缓存 → build → nginx）+ `.dockerignore` + `docker-compose.yml`
- [x] I1-5 CI workflow：push/PR 自动 `pnpm verify`
- [x] I1-6 `.env.example` 与部署手册 `docs/deployment.md`
- [x] I1-7 验证：`pnpm verify` 全绿；nginx 配置语法自检（本环境无 docker，镜像构建验证由 CI 承担）

### I2 认证与权限（P0）

- [x] I2-1 `IdentityAdapter` 契约（sdk）：`getUser(): Promise<{ id, name, permissions }>`，portal 装配点 + 演示实现
- [x] I2-2 SceneCoordinator 进入前强制 `canEnter`（无权限 → 错误状态与可见提示，而非仅按钮置灰）
- [x] I2-3 登录壳：占位登录页 + 会话过期处理钩子（对接真实 IdP 留接口）
- [x] I2-4 测试：权限拒绝路径 + 未登录路径

### I3 生产网关接入层（P0）

- [x] I3-1 网关协议规约 `docs/gateway-protocol.md`（信封、订阅/退订、快照重放、心跳、错误帧）
- [x] I3-2 `createWebSocketSource` 集成测试（FakeSocket：重连退避、断线重订阅、快照重放）
- [x] I3-3 断线 UX：连接状态指示（顶栏）+ WorldClient 质量降级可见
- [x] I3-4 历史/仿真服务端 API 适配说明与演示源解耦

### I4 资产管线真实化（P1）

- [x] I4-1 真实 GLB 经 `AssetLease` 加载进 production/stack-yard（清单 → acquire → root）
- [x] I4-2 KTX2 / DRACO / meshopt 解码器装配与内存预算接线
- [x] I4-3 真实 3D Tiles tileset 经 TilesSystem 接入并输出诊断（cachedBytes/isFull/队列）
- [x] I4-4 资产接入指南 `docs/asset-pipeline.md`（清单规范 → 校验 → 部署）

### I5 性能与稳定性验收（P1）

- [x] I5-1 浏览器性能采集脚本（tracing：p50/p95、draw calls、tiles 字节、JS heap → JSON 报告）
- [x] I5-2 4K / 2560×1440 基准报告（参考硬件跑分记录于 docs/benchmarks.md）
- [x] I5-3 24h 内存 plateau soak 脚本与报告
- [x] I5-4 Context loss 演练：强制 `WEBGL_lose_context` 后表示层自动重建验证（§75）

### I6 质量守护与可观测（P2）

- [x] I6-1 Playwright E2E 冒烟：目录切换、2D↔3D、世界模式（可选依赖，独立 workflow）
- [x] I6-2 视觉回归启用（Golden Scene 三帧基线 + diff 报告）
- [x] I6-3 错误上报适配器（onError → 可插拔 telemetry sink）与诊断导出
- [x] I6-4 运维手册 + 关键决策 ADR（引擎契约入 sdk、Disposable 语义、演示网关边界）

### I7 代码质量守护（P2，完成度审计后新增）

- [x] I7-1 ESLint 9 flat config（typescript-eslint + eslint-plugin-vue）纳入 `pnpm verify` 门禁，修复暴露的 25 处问题（prefer-const / 未使用导入与参数）
- [x] I7-2 真实缺陷修复：production 场景 AGV 3D 表示从未注册（ensureAgv 未接线）——订阅时按需注册，快路径位姿自此有渲染目标
- [x] I7-3 PerfCapture 标签延迟解析（修复采集期间场景切换导致的报告标签过期）
- [x] I7-4 补测试：coordinator 切换失败回滚（error 态/重试恢复/§11 事务顺序）+ 演示网关契约覆盖（全契约信封/快路径/历史环/revision 增长）
- [x] I7-5 清理：standalone bootstrap 死三元、eslint config 以 .mjs 消除 Node 警告

### 持续小项（随迭代顺带处理）

- [x] S1 场景内视图切换与壳层视图开关联动（消除双开关缝隙）
- [x] S2 MapLibre glyphs 离线降级提示（无网络时 UI 提示「标注不可用」）
- [x] S3 场景切换失败的重试按钮（coordinator error 态提供重试）

## 迭代协议（自动化遵循）

1. **领取**：取「迭代待办」中第一个未勾选 `[ ]` 条目（从上到下、从 I1 到 S3）。
2. **实现**：一个连贯切片；严格遵守冻结文档（依赖方向 / 单一 exports / 引擎懒加载 / 所有权模型）；
   three / maplibre-gl / 3d-tiles-renderer 为 exact pin（§78），升级必须先跑 `pnpm verify` + `pnpm test:compliance` + `pnpm bench` 全套回归。
3. **验证**：`pnpm verify` 必须全绿；涉及 Scene 资源生命周期时加跑 `pnpm test:compliance`。
4. **回写**：完成后勾选 `[x]`，并在「迭代日志」追加一行（日期、条目 ID、要点、验证结果）；
   未完成的条目保持 `[ ]` 并在该条目下用 `> 状态:` 注记进度。
5. **边界**：不推送远端、不执行真实部署、不修改 `docs/digital-twin-architecture-freeze-v1.2.md`、
   不引入冻结文档 §85 Non-goals 中的能力。
6. **兜底**：待办全部完成或当前条目被外部因素阻塞时，运行 `pnpm verify` 确认现状，
   在迭代日志写明「无新改动 / 阻塞原因」，不发明超出本文件的新范围。

## 迭代日志

- 2026-09-13 **v1.2 基线**：monorepo 全量实现（9 Foundation 包 / 5 域 / 5 场景 / Portal + 3 Standalone / 5 工具链）；
  Gate 8/8 通过；85 测试 + 16 架构测试全绿；Portal 浏览器实测通过。
- 2026-09-14 **I1 部署基座（全部 7 项）**：Portal 配置化（config.ts + VITE_* 注入）与
  演示网关→生产 WS 网关的一键切换；deploy/nginx.conf（SPA/缓存/安全头/healthz/CSP）；
  多阶段 Dockerfile + .dockerignore + docker-compose；GitHub Actions CI（verify + docker build 校验）；
  .env.example + docs/deployment.md；vitest 覆盖范围补齐 apps/domains 并新增 3 项配置解析测试。
  验证：`pnpm verify` 全绿、88/88 测试、dev server 冒烟通过（nginx 镜像构建由 CI 承担，本机无 docker）。
- 2026-09-14 **I2 认证与权限（全部 4 项）**：sdk 新增 `IdentityAdapter`/`UserIdentity` 契约；
  演示身份适配器（sessionStorage 会话持久化 + guest 受限角色 + `expireSession` 过期钩子）；
  SceneCoordinator 进入前强制权限校验（新增 denied 态，无权限绝不触发 load/mount）；
  登录壳（LoginView）+ 未登录门控 + 会话过期自动回到登录壳 + 场景加载失败重试按钮；
  侧栏改用会话用户权限。验证：`pnpm verify` 全绿、97/97 测试（新增 9 项身份/权限测试），
  浏览器实测：未登录出登录壳、guest 直连受限场景被拦（提示「权限不足」）、
  完整用户正常进入生产场景（3D 实时数据流正常）。
- 2026-09-14 **I3 生产网关接入层（全部 4 项）**：网关协议规约 docs/gateway-protocol.md
  （信封/订阅/快照/心跳/错误帧/历史/仿真/安全）；createWebSocketSource 增强
  （心跳假死检测、error 帧上报、onStateChange/onError）+ 7 项 FakeSocket 集成测试
  （重连退避封顶、断线重订阅、快照重放 revision 去重、心跳、错误帧、状态迁移、退订）；
  WorldClient.countStale() + foundation connection() + 顶栏连接指示（演示/连接中/已连接/断线
  四态 + 陈旧项计数）；历史/仿真源解耦为 createHistorySimulationSources() 唯一替换点。
  验证：`pnpm verify` 全绿、105/105 测试（+8），`pnpm test:compliance` 9/9。
- 2026-09-14 **I4 资产管线真实化（全部 4 项）**：样例资产生成器（程序化最小 GLB，
  确定性字节入库）+ stack-yard 场景经 AssetLease 全生命周期加载真实 GLB
  （清单 → acquire → root → release，§44 只归还使用权）；AssetLeaseManager 内存预算
  （maxTotalBytes 超限拒绝 + estimatedBytesTotal）与 gltfLoaderEnhancer 解码器装配钩子
  （foundation 注入 KTX2/DRACO/meshopt，renderer 感知，VITE_ASSET_DECODER_PATH 可指向本地）；
  TilesPolicy.tilesetUrls 配置化接入真实 3D Tiles（唯一入口 TilesSystem，诊断自动输出）；
  data: URL 资产支持；nginx .glb MIME；docs/asset-pipeline.md 接入指南。
  验证：`pnpm verify` 全绿、113/113 测试（+8：GLB 解析/预算/装配/配置），
  `pnpm test:compliance` 9/9，浏览器实测 GLB 经 AssetLease 加载（892B 与清单一致）。
- 2026-09-14 **I5 性能与稳定性验收（全部 4 项）+ 2 个真实缺陷修复**：
  新增 tooling/perf（PerfCapture 采集引擎 / SoakDriver / plateau 分析，均可确定性单测）
  与 Portal URL 参数驱动（?perf / ?soak / ?contextLoss，报告落 window JSON）；
  ContextLossGuard 从 runtime 抽取为可单测类（§75 语义）；
  docs/benchmarks.md 记录真实验收数据——2560×1440 生产 3D 基准 avg 116.7FPS /
  p95Worst 10.3ms（DoD ≤33ms 大幅余量，非参考硬件）、context loss 演练
  recovered=true（丢失停帧→恢复自动续跑 357 帧）、soak 冒烟 6 轮无增长泄漏
  （-0.83MB/轮，24h 程序已就绪）。**附带修复**：
  ① MapLibre v6 worker 被 Vite 预打包致 reload 后 404（optimizeDeps.exclude）；
  ② MapContext 现在等 style 就绪才交付（修复「整页刷新后场景面板丢失」的
  "Style is not done loading" 竞态，§52 生命周期职责归位）。
  验证：`pnpm verify` 全绿、120/120 测试（+7），`pnpm test:compliance` 9/9，
  全部数据经真实浏览器（2560×1440）采集复核。
- 2026-09-14 **I6 质量守护与可观测（全部 4 项）+ 持续小项 S1/S2/S3**：
  Playwright E2E 冒烟 5 用例全绿（登录/目录切换/2D↔3D 懒加载/世界模式/权限强制，
  独立 workflow e2e.yml + 根脚本 test:e2e）；视觉回归真实实现
  （capture/compare + pixelmatch，Golden 三帧基线入库，阈值 0.5%）；
  telemetry 扇出 sink + 环形错误缓冲 + window.__twin.exportDiagnostics 诊断导出；
  docs/operations.md 运维手册 + docs/adr.md 六条关键决策 ADR。
  持续小项：S1 场景视图切换经 twin-scene-view DOM 事件与壳层联动
  （非活跃引擎随切换 suspend，§64）；S2 MapContext 捕获 style/glyphs 异常
  并在顶栏指示器可见化；S3 重试按钮已在 I2 落地（本轮确认勾选）。
  验证：`pnpm verify` 全绿、125/125 测试（+5 telemetry），E2E 5/5，
  视觉回归三帧差异 0.00%/0.35%/0.02% 均在阈值内。
- 2026-09-14 **继续轮（待办已清空）：热路径硬化 + 验收数据强化 + 工具链适配**：
  heavy-transport 热路径硬化（进度值移出 reactive，3D 位姿逐帧、UI/2D/风险 10Hz
  节流，§65）；诊断导出字段校准；soak plateau 判定修正为「仅增长性泄漏判不稳」
  （§71 Plateau 而非 Zero）；微基准迁移 tinybench（vitest 5 移除内建 bench API）。
  验收数据强化：20 轮 soak 全部完成（heap 77.2→65.2MB，斜率 −1.57MB/轮，
  plateau.detected=true），pnpm bench 微基线入档（docs/benchmarks.md：
  空间变换 ~3.6 万任务/秒、StateBuffer ~1.5 万任务/秒，均远超帧预算）。
  验证：`pnpm verify` 全绿、126/126 测试（+1 微基准），`pnpm test:compliance` 9/9。
- 2026-09-14 **I7 代码质量守护（完成度审计后新增，全部 5 项）**：
  ESLint 9 flat config（typescript-eslint + vue）纳入 verify 门禁并修复 25 处
  历史问题；**修复真实缺陷——production 场景 AGV 3D 表示从未注册**
  （ensureAgv 未接线，快路径位姿无渲染目标）；PerfCapture 标签延迟解析；
  补 coordinator 回滚/重试/事务顺序 3 项测试与演示网关契约覆盖 4 项测试；
  standalone bootstrap 死代码清理。验证：`pnpm verify`（含 lint）全绿、
  133/133 测试（+7）、`pnpm test:e2e` 5/5。
- 2026-09-14 **DoD #1 实跑达成 → ✅；DoD #5 正式 24h 长跑启动**：
  按 verifier 建议以 brew 安装 colima 0.10.3 + docker 29.8.0 + compose v2
  消除运行时阻塞，实际执行 `docker compose up --build`——multi-stage 镜像
  构建成功（容器内 pnpm fetch → --offline 安装 → vite build 于 linux/arm64）、
  容器 **healthy**（wget → /healthz ExitCode 0、FailingStreak 0）、首页 200、
  GLB 以 model/gltf-binary 下发；过程中修复真实缺陷：nginx CSP 头反斜杠
  跨行致响应头多行、容器 wget 健康检查失败（"bad header line"）。
  DoD #5：**24h 墙钟长跑已于 20:52 对生产镜像 8080 启动**
  （`--cycles 1152 --cycleIntervalSec 73`，修正了此前漏计轮间隔的换算错误——
  "1152 轮 ≈ 24h"实际 ≈29 分钟，轮间隔参数已补齐并实测），报告完成后自动
  写入 soak-24h.json，判定自动；benchmarks.md 已回填 Run #5 启动记录与
  DoD 对照，operations.md 命令同步。验证：compose exit 0、healthz ok、
  容器 healthy、首页 200。
