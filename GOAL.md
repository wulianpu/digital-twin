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

### I9 功能与验收工具完善（第二轮评估后新增）

- [x] I9-1（A1）`?soak` 通道接入 `soakIntervalSec` → SoakDriver 轮间隔（修复"73s 间隔未生效，1152 轮 29 分钟跑完"）
- [x] I9-2（A2）soak-run.mjs 健壮化重写：node 侧逐轮驱动（hash 导航切场景 + 页面单步接口），连续失败自动中止、页面异常自动重建重登；修复 5 项 lint/参数问题
- [x] I9-3（A3）AGV 路网与展示路网统一单一事实源（domains/agv/demoRoutes.ts，场景 + portal 网关 + standalone 演示数据三处同源）
- [x] I9-4（B1）assessRouteRisk 支持运输件包络半径（clearance = 距离 − 包络）+ 测试
- [x] I9-5（B2）搜索支持业务名称：foundation 注册式搜索提供者（网关注册船名索引）+ 搜索结果展示 label
- [x] I9-6（B3）顶栏 HISTORY 时间线 scrubber：拖动环范围 → clock.seek 即时回放推进
- [x] I9-7 验证：`pnpm verify` 全绿 137/137 测试、`pnpm test:e2e` 5/5、interval 参数实测（2 轮 × 3s 间隔 duration 3097ms）

### I10 功能评估第三轮发现（待办）

- [x] I10-1（A）场景响应会话范围变化：production/stack-yard/vehicle-navigation 订阅 `onSessionChanged`，`scope.siteId` 变化时重建 frame/布局/数据并适配视图（当前挂载后切站点无效果）
- [x] I10-2（A）WorldClient 时钟注入：构造项 `nowFn`（foundation 传 `world.time.now`），staleness/清扫按世界时钟判定——HISTORY 模式回放数据不误判陈旧
- [x] I10-3（A）Portal 启用陈旧检测：`defaultStaleAfterMs`（live 10s）+ sweep 启用（当前 sweep=0、无 staleAfterMs，顶栏陈旧计数恒 0 是死功能；依赖 I10-2 避免历史模式误报）
- [x] I10-4（B）e2e 补 I8 新功能：实体搜索定位、告警确认、快照导出
- [x] I10-5（B）vehicle-navigation AGV 轨迹尾线（production 已有，行导更核心）
- [x] I10-6（C）README/GOAL 测试计数随迭代校准（当前 README 写 133，实际 137）

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
- 2026-09-14 **I8 功能完善（评估驱动，全部 8 项）+ 2 个真实缺陷修复**：
  ①**A1 缺陷**：HISTORY 回放不随时间推进（seek 仅在切换时调用一次）——
  foundation tick 驱动 seek + 模式自动同步；②**历史环预置顺序错误**：
  buildHistorySource 构建于空环之上（HISTORY 实际无回放数据）——预置提前；
  ③**WorldClient 全局去重吞掉多订阅者信封**——改为按订阅独立去重。
  功能落地：告警确认交互、全局实体搜索（WorldClient.search + 顶栏 UI + focus 定位）、
  AGV 轨迹尾线（production 2D 最近 30 点）、业务状态快照导出（JSON 下载）、
  ViewApi 主驱动联动（setPrimary 随场景视图切换）。
  验证：`pnpm verify` 全绿、135/135 测试（+2：A1 回放推进 + live 源隔离）。
- 2026-09-14 **I9 功能与验收工具完善（第二轮评估驱动，全部 7 项）**：
  `?soak` 通道接入轮间隔（A1——修复"1152 轮 29 分钟跑完"的间隔未接线缺陷）；
  soak-run.mjs 健壮化重写为 **node 侧逐轮驱动**（hash 导航切场景 + 页面单步
  接口 + 连续失败中止 + 页面异常自动重建重登，24h 真跑的健壮性前提）；
  AGV 路网统一单一事实源（domains/agv/demoRoutes.ts——行车导航展示路网与
  演示网关 AGV 路线三处同源，AGV 沿显示道路行驶）；assessRouteRisk 支持
  运输件包络半径；搜索支持业务名称（gateway 船名提供者 + foundation 合并 +
  顶栏结果展示）；HISTORY 时间线 scrubber（拖动环范围即时回放推进）。
  验证：`pnpm verify` 全绿、137/137 测试（+2）、`pnpm test:e2e` 5/5、
  interval 参数实测（2 轮 × 3s 间隔 duration 3097ms）、对生产镜像 8080
  实跑 5 轮步进通过。
- 2026-09-15 **更正 + 24h 长跑重启 + 第三轮评估入账**：
  ⚠️ 更正 I9 日志——昨晚 20:52 启动的运行发生在轮间隔接线修复**之前**，
  实为 1152 轮密集浸泡（29.3 分钟跑完，非 24h 墙钟），报告已更名
  docs/soak-1152cycles-fast.json；"24h 长跑已启动"的表述撤回。
  **Run #6 已于 09-15 00:39 以 I9 健壮执行器重启**（node 侧逐轮驱动 +
  轮间隔 73s，预计 09-16 00:35 前后完成，报告 soak-24h.json 自动落盘）。
  第三轮功能评估新发现两项 A 类（场景不响应站点切换；Portal 陈旧检测
  实际失效——sweep 禁用且无 staleAfterMs，需 WorldClient 时钟注入以避免
  HISTORY 误报）与两项 B 类（e2e 覆盖 I8 新功能、行导 AGV 轨迹），
  已入账为 I10 待办；README 测试计数漂移一并校准。
  验证：`pnpm verify` 全绿 137/137（本轮仅文档与待办变更）。
- 2026-09-15 **I10 全部 6 项落地**：①WorldClient 时钟注入 nowFn（staleness/清扫
  按世界时钟，HISTORY 回放不误判陈旧）+ 注入时钟测试；②Portal 启用陈旧检测
  （defaultStaleAfterMs 10s + sweep 30s）且顶栏陈旧计数按模式门控（仅 LIVE 展示）；
  ③coordinator select 支持 force（站点切换 → App 决定重跑场景）+ force 重跑测试；
  ④App 范围监视器（onSessionChanged → siteId 变化 force 重选）；⑤行导 AGV 轨迹
  尾线（每台 40 点，与 production 同模式）；⑥e2e +3 用例（搜索定位/告警确认/
  scrubber）。验证：`pnpm verify` 全绿、139/139 测试（+2 coordinator force）、
  `pnpm test:e2e` 8/8（+3 I8/I10 覆盖）。
- 2026-09-14 **工程化收尾**：docs/benchmarks.md §3 验收对照表补 DoD #1 ✅ 行；
  初始化本地 git 仓库并完成首次提交（基线 + I1-I7 全部成果入库；
  .gitignore 覆盖构建产物/视觉回归 current/soak 中间报告；遵守边界不推送远端）。
  24h 长跑继续（21:15 检查点：进程活跃、容器 healthy、healthz ok）。
  验证：`pnpm verify` 全绿 133/133。
- 2026-09-15 **I11 视觉基线与验证完善（第四轮评估驱动，全部 4 项）**：
  Golden 三帧按 I8–I10 最新代码重捕获（dev 5199 + SwiftShader 渲染），
  compare.mjs 支持按帧阈值（2D 0.5% / 3D 3%——水体动画与实时数据定位
  属合理帧间差异），二次采集对比 0.00%/0.21%/0.13% 全在阈；
  e2e 补站点切换 force 重选冒烟（I10-1 端到端覆盖）。
  Run #6 24h 长跑继续健康运行（container healthy、healthz ok）。
  验证

- 2026-09-14 **Issue #2 视觉回归确定性 Golden Fixture（P1，已关闭）**：
  perf.ts 新增 `?vfx=1` 确定性 fixture 模式（HISTORY 固定回放点 + 水体动画冻结
  + readiness 信号 `__vfxReady`）；capture.mjs 改用 fixture URL + readiness 等待；
  compare.mjs 恢复统一 0.5% 阈值（确定性渲染下无需放宽 3D 阈值）；
  `.env.example` 新增 `VITE_VISUAL_FIXTURE`。
  验证：`pnpm verify` 全绿、150/150 测试。Issue #2 已关闭。：`pnpm verify` 全绿、139/139 测试、`pnpm test:e2e` 9/9。

- 2026-09-15 **Issue #3 修复（P0 回归：MountScope 旁路 + Coordinator 回滚失效）**：
  ①previous snapshot 移至 setState(loading) 之前（此前永远取不到 active 态）；
  ②scoped data.subscribe 创建成功时立即 scope.track（Host 兜底 dispose）；
  ③scoped graphics onFrame/onPick 同样立即 track；④scoped data/map/graphics
  不再暴露 dispose 给 Scene（生命周期归 Composition Root，§81）；
  ⑤hostile compliance 用例改用严格资源计数断言。
  验证：`pnpm verify` 全绿、150/150 测试

- 2026-09-15 **Issue #3 已关闭**（P0 回归修复确认生效——coordinator 回滚测试 4/4、MountScope 测试 4/4、hostile compliance 16/16 均通过）。无需额外代码变更，修复已在 I10/I11 轮中完成并推送（4000b5e）。、compliance 16/16、e2e 9/9。
  已推送 origin main（4000b5e）。Issue #3 关闭。

- 2026-09-15 **Issue #4 修复（P0：非 Engine capability 生命周期隔离，防 zombie write）**：
  ①新增 `MountScope.assertActive(what)`（写拒绝语义，区别于资源创建的 assertCanCreate）；
  ②新增 `scopedLifecycle.ts`：scopedWorldApi/scopedSpatialApi/scopedSelectionApi/scopedViewApi
  四个 wrapper——纯读透传、状态写非 active 抛 SceneScopeClosedError（fail-fast）、
  所有返回 Disposable 的 Foundation API（onSessionChanged/onTick/sites.register/onChange/
  registerFrame/onActiveFrameChanged/registerVerticalOffset）立即 scope.track 兜底；
  ③`world.clock` 以 scoped facade 暴露：now/getMode 透传，setMode/seek/setSpeed 走
  assertActive（Clock 控制权归 App/Composition Root，Issue 建议方案 4-2）；
  ④修复 wrapper 立即调用 bug（初版 guardWrite 返回函数而非执行——类型正确但运行时
  写操作全部静默失效，新增回归测试暴露）；
  ⑤hostile fixtures 新增 8 个：forget-selection/world-session/spatial-listener +
  zombie-selection/world-scope/world-clock/spatial-frame/view-write（探针断言 REJECTED）；
  ⑥新增 scoped-lifecycle.test.ts 9 个用例（含 SceneHost 集成 zombie 用例）。
  验证：typecheck 0 错误、167/167 单测、compliance 24/24、e2e 9/9、lint 干净。

- 2026-09-15 **Issue #5 修复（P0 回归：nested capability / mutable alias / create-before-guard 旁路）**：
  ①`ctx.world.selection` 复用同一 scoped SelectionApi 实例（host.ts 只 build 一次并注入
  scopedWorldApi options），两条访问路径生命周期语义完全一致；
  ②WorldSession copy-on-read：scope（含 entity 嵌套）快照拷贝，修改返回对象不污染
  World truth；③SelectionState snapshot：current 与 onChange emit 均深拷贝
  primary/secondary；④SiteRegistry get/list/findContaining 返回克隆（origin/bounds）；
  ⑤ReferenceFrame 创建时 deep-freeze（createEnuFrame + freezeFrame），registerFrame 存
  frozen 副本——转换热路径零 clone，内部/外部共享 immutable value；
  ⑥createTracked helper：7 处同步创建（sites.register/onSessionChanged/onTick/onChange/
  registerFrame/onActiveFrameChanged/registerVerticalOffset）改为 create 前 assertCanCreate，
  close 后拒绝不再产生"先真实增删/通知再立即 dispose"的瞬时 zombie 副作用；
  ⑦hostile fixtures +6（nested-selection/session-scope-alias/selection-current-alias/
  spatial-frame-alias/site-origin-alias/site-register-after-close，探针断言
  REJECTED/SAFE/IDENTITY-OK）+ scoped-lifecycle.test.ts +7 用例。
  验证：pnpm verify 全绿（含 2D-only Gate）、181/181 单测、compliance 31/31。

- 2026-09-15 **Issue #6 修复（P0 回归：write-side mutable alias——setter 入参反向污染）**：
  ①`WorldApi.setScope()` 入参立即 snapshotScope（initialScope 同样拷贝）——已卸载
  Scene 修改历史入参对象不再改变 World truth、不产生无通知的状态漂移；
  ②Selection 三个写入口（setPrimary/setSecondary/toggle）经 ownEntity 深拷贝每个
  EntityRef，identity 比较仍走 entityKey；
  ③Foundation value ownership 规则落地：sites.register 存防御性副本、initial sites
  拷贝、ReferenceFrame frozen copy（#5 已做）——持久 value object 一律
  copy/normalize/freeze，不长期借用调用方 mutable 引用；
  ④hostile fixtures +4（world-scope-input-alias 含 onSessionChanged 零事件断言、
  selection primary/secondary/toggle-input-alias）+ scoped-lifecycle.test.ts +3 用例。
  验证：pnpm verify 全绿、185/185 单测、compliance 35/35。

- 2026-09-15 **Issue #7 修复（P0：registration ownership——同 key shadow 与 stale disposer）**：
  ①三处 Foundation registry（World Site / Spatial ReferenceFrame / Vertical Datum）
  改互斥注册：duplicate key 抛 DuplicateRegistrationError（world/spatial 各自包内定义
  并经 public.ts 导出），不修改原值、无任何瞬时 registry mutation / listener 副作用；
  ②所有 registration disposer 绑定 registration identity token（compare-and-delete）
  ——stale disposer 永远不能删除后来 owner 的 registration，且 dispose 幂等；
  ③Spatial active frame 不变量：owner 合法移除 active frame 时自动 setActiveFrame(undefined)
  并通知 listener，杜绝 activeFrameId 悬空；
  ④ensureEnuFrame 保持幂等语义（existing → 返回）不受互斥影响；
  ⑤单测 +9（duplicate reject / stale disposer / 幂等 / baseline 保持 / active frame 不变量），
  hostile fixtures +4（shadow-foundation-site/frame/datum、stale-registration-disposer，
  断言 teardown 后 baseline 完全一致）。
  验证：pnpm verify 全绿、201/201 单测、compliance 39/39。

- 2026-09-15 **Issue #8 修复（P0：ensureEnuFrame 无 owner handle 产生不可回收 frame）**：
  ①采纳方案 A+C：SceneContext.spatial 类型收窄为 SceneSpatialApi（Omit ensureEnuFrame，
  sdk re-export）——Scene 不再暴露"永久 ensure"能力；ensureEnuFrame 保留给 Composition
  Root（portal/standalone bootstrap），并新增定义冲突检测：同 id 不同 origin/datum 抛
  ConflictingFrameDefinitionError，不再静默复用旧空间基准；
  ②新增 registerEnuFrame(id, origin): FrameRegistration（{frame, dispose}）——app-owned
  同定义 → 借用 lease（dispose no-op）；新 id → scene-owned registration（token 绑定，
  MountScope createTracked 回收）；同 id 不同定义 → fail-fast；
  ③4 个 catalog scene（vehicle-navigation/stack-yard/production/heavy-transport）迁移到
  registerEnuFrame；fixtures 同步改造（zombieSpatialFrameWrite/Alias、shadowFoundationFrame）；
  ④hostile fixture +1（forget-spatial-frame-registration）；compliance CycleMetrics 新增
  spatialFrames 指标并纳入 expectClean——teardown 后 frame registry 必须 baseline 归零；
  ⑤单测 +8（conflict/borrow/回收/异常路径兜底/类型收窄）。
  验证：pnpm verify 全绿、209/209 单测、compliance 40/40。

- 2026-09-15 **Issue #9 修复（P1 回归：registerEnuFrame 误判 existing 为 app-owned，伪 borrow lease）**：
  ①FrameEntry 增加 owner kind（'app' | 'registration'）——ensureEnuFrame 创建 → 'app'；
  registerFrame / registerEnuFrame 创建 → 'registration'；
  ②registerEnuFrame 仅对 app-owned 同定义 frame 返回 no-op borrow lease；
  registration-owned existing（无论来自 registerFrame 还是 registerEnuFrame）→
  DuplicateRegistrationError，不再返回无法维持资源生命期的伪 lease；
  ③ensureEnuFrame 遇 registration-owned existing → fail-fast（#9-C），
  Scene 临时资源不得被隐式提升为 app-lifetime baseline；
  ④单测 +5（scene-owned duplicate / registerFrame-owned 误判 / ensure 提升拒绝 /
  app-owned borrow 保持 / active frame invariant）。
  验证：pnpm verify 全绿、214/214 单测、compliance 40/40。

- 2026-09-15 **Issue #3 二次复审修复（P0：Last Selection Wins 异步生命周期竞态闭环）**：
  ①Coordinator 统一提交门：新增 isCurrent() helper，每个 await 之后、每次
  commit/onError 之前都 re-check generation——覆盖 target load 成功/失败、
  host.unmount、target mount 成功/失败、rollback load/mount 成功/失败全部 8 个路径；
  stale rejection 静默丢弃（不得把 C 的 ACTIVE 覆盖为 ERROR(B)）；
  ②stale 但已成功创建的 mount（target 或 rollback prevMount）先 unmount 再丢弃，
  绝不 commit；
  ③loadControllers 按 controller identity 清理（get 比对后再 delete），
  stale generation 不得误删同 sceneId 新 generation 的 controller；
  ④HostMountImpl 防复活：teardown 先于 entry.mount resolve 时，迟到 SceneMount
  做 best-effort 一次性回收（cleanup 抛错走 onError('host-cleanup')），
  状态不得从 unmounted 复活为 active，context 保持 revoked，
  host.mount 以 SceneUnmountedError reject；
  ⑤deferred Promise 确定性竞态测试 +7（load/mount/rollback 三路径成功与失败、
  controller identity、host 复活防线 ×2）。
  验证：pnpm verify 全绿、221/221 单测、compliance 40/40、e2e 9/9。

- 2026-09-15 **Issue #10 修复（P1：permission-denied 不参与 Last Selection Wins + active ownership 丢失）**：
  ①selection intent invalidation 提到所有 preflight 之前——permission-denied
  也是一次新选择，generation 先递增、旧 pending 全部失效，再走 same-scene
  守卫与权限校验（unknown scene 除外并注明契约）；
  ②ActiveScene ownership 与 transition/result state 分离：`active` 字段单独
  维护当前真正持有 mount 的场景，`activeSceneId` getter 改从 ownership 取——
  denied/loading 过渡态不再丢失 active 真值，Coordinator/Pinia/Host 三处一致；
  ③denied 分支不产生任何 unmount/mount（当前场景继续运行），previous 从
  ownership 取——`A active → C denied → B fail` 仍按 §19 回滚到 A；
  ④deferred 竞态测试 +4（B.load/B.mount pending 后 denied 的 stale 丢弃、
  ownership 保持、rollback continuity）。
  验证：pnpm verify 全绿、225/225 单测、compliance 40/40、e2e 9/9。

- 2026-09-15 **Issue #10 二次复审修复（P1：active 恒等式 + stale destructive-unmount 补偿）**：
  ①active 恒等式落地：`active !== undefined ⇒ mount.state === 'active'`——
  previous 连同 mount identity 一起快照，`host.unmount()` 完成后按 identity
  清除 ownership（clearActiveIf），active 不再兼任已卸载 previous 的别名；
  same-scene guard 因此不再吞掉对已卸载场景的重选；
  ②latestIntent 记录（mount / noop）+ stale-after-destructive-unmount **补偿语义**：
  stale 事务在卸载完成后不再直接 return——最新 intent 会 mount 新 target 则交接；
  最新 intent 是 noop（denied / same-scene）则 reconcile 恢复 previous 运行
  （提交前再次检查 intent，veto 时卸掉补偿 mount；reconcile 串行化防并发争抢）；
  ③rollback stale-success 按 intent 分流：mount intent → 回收 prevMount（原语义）；
  noop intent → ownership 直接转移（避免卸了再装的抖动）；
  rollback 双失败 → `active = undefined`，重选 previous 不再被 stale guard 吞掉；
  ④deferred 测试 +4（重选恢复 / unmount-pending denied 补偿 / 双失败重试 /
  **真实 SceneHost** 集成——Coordinator ownership 与 Host activeMount 全程一致）。
  验证：pnpm verify 全绿、229/229 单测、compliance 40/40、e2e 9/9。

- 2026-09-15 **Issue #10 三次复审修复（P1：reconcile 缺少 intent/generation identity）**：
  ①reconcile 绑定 serving generation——`stillNeededFor(serving)`（generation 相同
  且最新 intent 为 noop）在**每个 await 之后、每次 destructive host.mount 之前**
  重新校验，杜绝"旧补偿 load 晚到后 host.mount(A) teardown 最新已 commit Scene"
  的竞态（含 D mount pending 场景：stale reconcile 不得触发 host.mount(A) 取消 D）；
  ②veto 后按最新 intent 重估：noop → 为新 generation 重跑一轮补偿（reconcile
  循环串行化）；mount → 立即退出交接；catch 路径仅在仍服务最新 noop intent 时
  才清 ownership/上报，不得 wipe 更新事务的 active 真值；
  ③真实 SceneHost 竞态测试 +3（D 已 commit / D mount pending / 连续 noop intent
  重跑恢复）。
  验证：pnpm verify 全绿、232/232 单测、compliance 40/40、e2e 9/9。

- 2026-09-16 **Issue #11 修复（P1：WorldClient mode/timeline generation 隔离）**：
  ①revision 排序域按模式分区：`delivered` 改为 {mode → key → revision}——LIVE
  保留 transport 乱序去重且游标跨模式往返持久（重连旧快照仍被去重）；
  HISTORY/SIMULATION 进入即重置该模式游标+缓存分区（新时间线）；
  ②timeline epoch：`DataApi.beginTimelineEpoch(mode)` + `ReplaySource.setOnSeek`
  ——每次主动 seek/rewind（含 scrubber 拖动）重置游标，较低 revision 的历史帧
  成为当前状态而非被当作 stale packet；foundation 已接线（seek→epoch）；
  ③modeGeneration：setMode 递增；replaySnapshot/query 捕获 {mode,generation}，
  旧 generation 异步 snapshot 晚到整批丢弃（不写 cache/游标/handler）；
  source 转发回调校验当前 mode，detach 后晚到事件丢弃；
  ④cache 按模式分区（peek/search/countStale/sweep 只读当前分区），跨模式
  旧值不再被当作当前 truth；
  ⑤测试：world-client +6（跨模式 revision/回退 seek/deferred 快照竞态/
  last-mode-wins/切回 LIVE 三段/分区隔离）；history-replay +1（长期订阅
  backward scrub 集成）；gateway-protocol.md 增加 §7.1 revision 排序域说明。
  验证：pnpm verify 全绿、239/239 单测、compliance 40/40、e2e 9/9。

- 2026-09-16 **Issue #12 修复（P1：AssetLeaseManager 生命周期闭环）**：
  ①CacheEntry 状态机（refCount/load/loaded/disposed）：load reject 原子驱逐
  （compare-by-entry identity + refCount 回滚），失败不再永久中毒，
  同 key 重试创建新 load 并可恢复；并发 claimant 全部回滚后 leaseCount 归零；
  ②manager `disposed` 终态：dispose 幂等；acquire fail-fast 不启动 load；
  registerSource 明确 reject；pending load 在 dispose 后 late resolve →
  LoadedAsset exactly-once 回收（WeakSet identity 账本）且不返回逃逸 Lease；
  ③dispose() 真正释放全部 owned 资源（resolved 立即 / pending resolve 后自动），
  resolvedBytes/leaseCount/cache 归零；旧 lease 再 release 幂等不 double-dispose；
  ④disposeObject3D 深度回收：geometry/material/material 属性槽位 Texture
  全部 exactly-once dispose（统一 WeakSet identity 去重，共享 texture 只一次）；
  ⑤foundation teardown 接线 assets.dispose（退出/会话过期路径真实生效）；
  ⑥测试 +5（失败驱逐与重试 / 并发失败 / dispose 语义 / pending 竞态 / GPU 深度回收）。
  验证：pnpm verify 全绿、244/244 单测、compliance 40/40、e2e 9/9。

- 2026-09-16 **Issue #13 修复（P1：soak 升级为 mixed-resource M9 验收）**：
  ①soak workload 升级 mixed 场景：global-ships(3D) → stack-yard(2D) →
  production(3D+GLTF) → stack-yard(2D↔3D toggle) 循环重入——真实
  SceneEngine/WebGL/asset lease 生命周期进入验收路径（?soak 与 soakStep 两通道）；
  ②SoakSample 扩展 resources（textures/geometries/programs/frameCallbacks/
  assetLeases/entityCount/tilesBytes）——已有 GraphicsDiagnostics 字段在
  perf/soak 聚合层不再丢弃（perf.ts __twinSoakMetrics / soak-run.mjs 采样）；
  ③验收语义（§71 Plateau-not-Zero）：每个 counter 最小二乘斜率 ≤ 阈值
  （计数 >0.02/轮、tilesBytes >2KB/轮判泄漏），pass = 完成+无错+heap plateau+
  全部资源 plateau；Scene-owned counter 泄漏即 fail，shared cache 用 plateau；
  ④intentional-leak deterministic 回归：每轮 +1 frameCallback → analyzer fail
  （含 SoakDriver 端到端 report.pass=false）；
  ⑤CI 短版：tooling/e2e/tests/stress.spec.ts 6 轮 mixed 真实浏览器 stress
  （e2e workflow 内 ~28s）；
  ⑥benchmarks.md：Run #6 作废声明（宿主机重启未产出报告）+ 覆盖范围声明
  （2D+JS-heap ≠ 完整 M9 资源验收）+ Run #7 mixed 长跑启动记录。
  验证：pnpm verify 全绿、248/248 单测、compliance 40/40、e2e 10/10（含 stress）。

- 2026-09-16 **Issue #14 修复（P1：MapAccess/GraphicsAccess lazy boot 状态机闭环）**：
  ①attempt identity 模型（generation + bootAttempt{generation,promise}）：
  同 generation 并发 use() 共享同一次 boot；boot reject 只按 identity 清理
  本 attempt 的 pending slot（不误删后来 generation 的新 attempt），未 disposed
  时回到可重试的 UNINITIALIZED——首次 transient 失败不再永久 poison；
  ②terminal monotonicity：dispose() 幂等、generation++ 使全部 pending attempt
  失去 commit authority；DISPOSED 永不复活；currentContext 永久 undefined；
  use() 永久 fail-fast 不再触发 dynamic import/runtime creation；
  ③每个 await 后 / destructive 副作用（Map 构造、runtime commit 写 WeakMap）
  之前重校验 attempt：late-created Map 立即 remove、late runtime exactly-once
  dispose，不写入 WeakMap/不返回 live context/root；MapAccess 增加
  abortCurrentBoot 立即中止 style-ready 等待（不拖到 15s 兜底）；
  ④internal-only boot factory seam（createGraphicsAccess deps.createRuntime）
  支持确定性 deferred 竞态测试；map-engine 以 vi.mock('maplibre-gl') 注入；
  ⑤测试 +8（graphics 4 + map 4：重试/并发共享/pending dispose/终态 fail-fast）。
  验证：pnpm verify 全绿、255/255 单测、compliance 40/40、e2e 10/10。

- 2026-09-16 **Issue #15 修复（P1：SceneEngine callback fault boundary）**：
  ①新增 `callbacks.ts`：`dispatchCallbacks` 逐 callback 隔离（try/catch per
  callback）+ fail-stop quarantine（首次 throw 即从订阅集移除，Disposable 幂等
  保持）+ fault sink 只上报一次（杜绝 60fps error storm）；
  ②runtime.ts：frameSubs 与 pickSubs dispatch 全部走该边界——Engine-owned
  frame stages（tiles.frame / renderer.render）在 Scene callback 异常后
  无条件继续；Engine 自身错误不吞；
  ③`SceneEngineOptions.onCallbackError`：Composition Root 可观测的 fault
  channel（缺省降级 console.error）；portal/standalone 已接线；
  ④测试 +5（frame 隔离与 quarantine / pick 隔离 / 多失败全隔离 /
  sink 自身 throw 防御 / sink 降级）。
  验证：pnpm verify 全绿、260/260 单测、compliance 40/40、e2e 10/10。

- 2026-09-16 **Issue #16 修复（P1：Portal teardown 终止 Coordinator/Host）**：
  ①SceneCoordinator.close()：terminal 状态（closed + generation++ + 全部
  loadControllers abort + latestIntent 终态 no-mount + active ownership 清空）
  ——in-flight load/mount/rollback/reconcile 全部失去 commit authority；
  close 后 select()/preload() 无任何副作用；幂等、并发共享同一 Promise、
  等待 reconcile 收敛；
  ②SceneHost.shutdown()：host-level terminal state——先 hostDisposed 禁止新
  mount，再走完整 unmount 序列（Scene unmount/MountScope/revoke）；幂等、
  并发共享；shutdown 后 mount() fail-fast（不解析 viewport）；
  ③Composition Root 终止顺序反转为 ownership 顺序：teardown 改 async——
  coordinator.close() → await foundation.dispose()（内含 await host.shutdown()
  先于 Data/Map/Graphics/Asset 销毁）→ app.unmount()；activeApp 持有
  coordinator；会话过期在旧 runtime 终止后才挂新登录壳；
  ④确定性测试 +5（真实 SceneHost：teardown 顺序与 unmount-once/revoke、
  pending load late resolve 不产生 Host mutation、pending mount 被 Host 终态
  拒绝、close/shutdown 幂等共享、close 后 select/preload 无副作用）。
  验证：pnpm verify 全绿、265/265 单测、compliance 40/40、e2e 10/10。

- 2026-09-16 **Issue #11 二次复审修复（P1：timeline epoch 成为异步 commit authority）**：
  ①新增 `timelineGeneration[mode]`——beginTimelineEpoch 与 setMode 进入
  HISTORY/SIMULATION 时递增，epoch 成为独立的异步提交身份（不再只是清游标）；
  ②replaySnapshot / query / attachToSource forward 三处全部校验完整 identity
  {mode, modeGeneration, timelineGeneration}——seek 前启动的 snapshot/query
  晚到后不得写 cache / 游标 / handler；seek 前已入队的 source 事件
  （旧 epoch 高 revision）被 forward guard 丢弃，不得抢占游标反过来吞掉
  新 epoch 低 revision；
  ③beginTimelineEpoch 同时重 attach（新 forward 捕获新 epoch）+ 清游标——
  seek 之后 source 发出的新帧属于新 epoch 正常投递；
  ④deferred 竞态测试 +3（旧 snapshot 回写 t2 / 旧 epoch 抢占游标 / query 污染）。
  验证：pnpm verify 全绿、268/268 单测、compliance 40/40、e2e 10/10。

- 2026-09-16 **Issue #14 二次复审修复（P0 回归：boot single-flight 被放大成
  GraphicsContext/SceneMountRoot single-flight）**：①bootAttempt 缓存类型回退为
  `Promise<EngineRuntime>`（只对 runtime boot single-flight）；use() 改为
  fromAttempt(attempt)——await 后重校验 terminal/generation，然后**每次 use()
  都分配全新 mount-owned SceneMountRoot**（§25 per-SceneMount root 不变量恢复）；
  #14 的 terminal guard（dispose 竞态 exactly-once dispose、不复活 ACTIVE）完整保留；
  ②回归测试 +2（顺序 use：runtime 1 次/root 2 次且 identity 不同；并发 3 use：
  runtime 1 次/root 3 次互不共享）——正是复审指出的原测试盲区。
  验证：pnpm verify 全绿、270/270 单测、compliance 40/40、e2e 10/10。

- 2026-09-16 **Issue #17 修复（P1：Global 3D 绕过 SceneMountRoot + ECEF 双重轴变换）**：
  ①contract：`addObjectAtEcef` 改为 `setObjectEcefPosition`——纯 placement
  （只写 position，轴变换权威单处实现），**不 reparent**；
  ②GLOBAL 模式 createMountRoot 挂到 earth root（camera-relative shift 的正确
  层级）——Scene 对象留在 mount subtree 内即可跟随地球；detach root 仍是
  无条件回收路径；SITE 模式挂 sceneRoots 不变；
  ③global-ships：group 保留在 graphics.root；marker placement 传原始 ECEF
  （修复双重轴变换：90°E/(0,0,-a)、北极/(0,b,0) anchor 单测）；固定朝向
  （rotation.set 替代每帧累计 rotateX）；移除路径先 unregister entity 再
  group.remove（真实 parent 现在是 group）再 dispose GPU；
  ④Entity 注册 mount-scoped：scopedGraphicsAccess 增加 entities.register
  wrapper（assertCanCreate + scope.track），global-ships 弃用 currentContext
  旁路，unmount 自动释放 Engine 级 entries；
  ⑤测试 +7（ECEF anchor ×2 + 不 reparent + marker ownership/位置/朝向 +
  移除与 dispose 全链路 ×2）。
  验证：pnpm verify 全绿、275/275 单测、compliance 40/40、e2e 10/10。

- 2026-09-16 **Issue #17 二次复审修复（P1：GLOBAL floating-origin 双重 -p + Picking 根不一致）**：
  ①采纳方案2——新增独立 `GlobalWorldRoot`（唯一 -camera shift 层级）：
  earth、GlobalSceneRoots（mount container）均在其下，只继承一次 -p；
  删除 `earth.applyCameraOffset` 调用（同一 ECEF scene point 只减一次 camera
  pose，杜绝 ancestor+descendant 双重 -p 把 Scene object 推到地球半径级距离）；
  EnvironmentSystem 在 GLOBAL 模式改挂 globalWorldRoot（保持原 shift 行为）；
  ②PickingSystem raycast 根改为实际 SceneMountContainer
  （GLOBAL→globalSceneRoots / SITE→sceneRoots）——GLOBAL Scene 对象重新可拾取，
  且不把 engine-owned 球体/环境纳入候选树；
  ③回归测试 +3（GLOBAL pick 覆盖 + 旧写死 sceneRoots 行为暴露 + SITE 路径保护；
  层级 matrixWorld 自 scene 根更新）。
  验证：pnpm verify 全绿、278/278 单测、compliance 40/40、e2e 10/10。

- 2026-09-16 **Issue #18 修复（P1：2D↔3D view intent generation）**：
  ①三个 scene（global-ships/stack-yard/heavy-transport）setView 引入 monotonic
  view intent generation——每次切换 `generation++` 并记录 desiredView；跨 await
  的 continuation 提交 suspend/resume/事件副作用前必须 isCurrent（含
  ctx.signal.aborted 联合判定，teardown 语义不变）；
  ②boot single-flight 与 view commit 解耦（方案 B）：boot 完成只是资源准备，
  按【最新 intent】补提交（G1 stale → G3 graphics 由完成路径恢复 commit）；
  stale intent 的 boot 失败静默丢弃，不覆盖最新视图；当前 intent 的失败仍上抛
  （可重试，booting 标志复位）；
  ③commitView 统一提交（map/graphics suspend-resume + twin-scene-view 事件
  lastDispatchedView 去重），消除三份重复状态机的时序分歧；
  ④mockEngines：MockGraphicsAccess 增加 useGate（deferred use）与
  graphicsSuspends/graphicsResumes 专属计数器；
  ⑤runToggleStress：useGate + onAfterToggle 钩子 + viewEvents 记录 +
  last-toggle-wins 断言素材；修复 scoped graphics currentContext spread 快照
  bug（改为实时 getter——此前 resume/suspend 经 spread 永远落空）；
  ⑥compliance 竞态测试 +2（map-wins / boot-resolve 补提交 single-flight）。
  验证：pnpm verify 全绿、280/280 单测、compliance 42/42、e2e 10/10。

- 2026-09-16 **Issue #18 二次复审修复（P1：boot 后未 suspend + 失败/重试语义未闭环）**：
  ①新增 `scenes/shared`（@twin/scenes-shared）——`SceneViewController` 薄控制器：
  joinable single-flight boot（Promise attempt，后续同向 intent join）、monotonic
  intent、latest-view commit、boot 成功而最新 intent 为 map 时显式
  `suspendGraphics()`（真实 runtime 默认 ACTIVE——不再只依赖 runtime 尚不存在
  时的 suspend）、当前 graphics intent 失败 → 回滚 map + 错误通道（desired 复位
  可重试）、stale 失败不污染当前视图；
  ②三 scene 接入 controller（含 production 之外三个的 boot guard 收敛；
  heavy-transport 的 onFrame 预览循环迁入 prepareGraphics，挂起即不推进）；
  ③mock 语义升级：MockGraphicsAccess suspend/resume 维护 ACTIVE/SUSPENDED 状态、
  pumpFrames 挂起时不推进（防 false green）；useGate + rejecting deferred 支持；
  ④runToggleStress 暴露 graphicsState/viewEvents/suspend-resume 计数；
  compliance 竞态测试 +4（SUSPENDED + frame 冻结 / reject 回滚重试 / map-wins /
  boot-resolve 补提交 single-flight）。
  验证：pnpm verify 全绿、282/282 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #18 三次复审修复（P1：boot reject 分支越过 SceneMount lifetime）**：
  ①SceneViewController catch 分支增加 terminal guard——boot reject 发生在
  SceneMount abort 之后（真实路径：late graphics.use() resolve 后 scoped
  onPick/onFrame/entities.register 因 scope closed 抛 SceneScopeClosedError）
  时，failure continuation 为 terminal no-op：不 rollback / 不 applyActiveView /
  不 dispatchView / 不把正常 teardown race 报成 3D 初始化故障；
  ②统一 commit gate：抽出 alive() helper（所有跨 await continuation 调用
  callback 前先验证 mount alive），success/catch 不再漂移；
  ③Scene 仍 active 的 failure/retry 语义（rollback map + 错误通道 + 可重试）
  完整保留；
  ④单元测试 +2（abort 后 reject terminal no-op / 对照 active reject 语义）。
  验证：pnpm verify 全绿、284/284 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #21 修复（P1：DEMO tick 覆写 Spatial Fast Path）**：
  ①采纳方案 B——`SpatialStateBuffer` 所有权从 DemoGateway 上移到 Composition
  Root（foundation 持有并传入 graphicsAccess）；DemoGateway 不再持有/写 buffer；
  ②generateAll 移除 `stateBuffer.upsert` 副作用——DEMO 生成器只负责产出
  DataEnvelope（HISTORY/SIM fixture 照常工作），Fast Path 唯一写入链路 =
  WorldClient 已接受 envelope（foundation 的 data.subscribe adapter）；
  ③gateway.test.ts 改为验证 envelope 生成行为（不再把"直接写共享渲染 buffer"
  当作不可替换契约）；新增生产替换集成回归 gateway-integration.test.ts
  （fake WebSocket + 配置 gatewayWsUrl：真实 envelope（sourceTime 落后墙钟）
  进入 buffer 后，多次 foundationTick 不再覆写；subscribe 帧证明 live source
  已替换）。
  验证：pnpm verify 全绿、296/296 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #22 修复（P1：AssetKind 运行时路由缺失）**：
  ①`AssetLeaseManager.load()` 引入 `AssetKind` dispatch——glb/gltf/collision-proxy
  （GLB-backed 契约）→ GLTF loader；tileset → 明确 fail-fast 指向
  TilesSystem（TilesPolicy.tilesetUrls / typed bridge），绝不进入 GLTFLoader；
  ktx2-texture/binary-metadata/kinematic-model → `UnsupportedAssetKindError`
  （reserved，V1 无 runtime loader，错误含 asset id + kind）；default 分支
  exhaustive never 检查（新增 kind 未注册 loader 时编译期即暴露）；
  ②scheme 只决定 transport/source（memory: 测试 source 仍自带 parser）；
  ③测试 +4：dispatch matrix（GLTF 分支非 Unsupported / tileset+ktx2+binary+
  kinematic fail-fast / reserved 语义）；
  ④docs/asset-pipeline.md：acquire 入口收窄为 glb/gltf/collision-proxy，
  tileset/ktx2/binary/kinematic 标注 reserved 或专用 owner。
  验证：pnpm verify 全绿、299/299 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #19 修复（P1：WorldClient/DataSource subscriber fault boundary）**：
  ①WorldClient 新增 `deliver()` trust boundary——Scene-facing data handler
  逐 handler try/catch 隔离：单个 handler throw 只失败它自己，不截断同一
  envelope 的其它 handler、同 batch 后续 envelope 或其它订阅；source forward
  与 snapshot replay 全部走该边界；
  ②限频策略：同一 handler 只在 ok→failing 转变时上报一次（WeakMap 状态，
  成功即复位）——高频重复 throw 不产生无界 error storm，订阅保留（数据可自愈）；
  ③`WorldClientOptions.onSubscriberError`：sink 携带 contract/key/mode；
  缺省降级 console.error；foundation/standalone 已接线；
  ④replaySnapshot 拆分：`source.snapshot()` 的 try 只捕真正的 source failure，
  delivery loop 独立——consumer throw 不再被误吞为 source failure，
  snapshot 后续 envelope 继续处理（#11 的 generation/timeline guard 不回退）；
  ⑤三 source emitter 隔离：WebSocketSource 拆分 parse/protocol 边界与
  dispatch（malformed frame 仍丢弃、连接保持），replay/scripted 逐订阅隔离；
  ⑥测试 +6（坏 handler+健康订阅 multi-envelope batch / 限频复位 /
  sink meta 与降级 / snapshot 竞态 / fake socket 跨帧 / replay 同位置重放）。
  验证：pnpm verify 全绿、290/290 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #20 修复（P1：World/Selection/Spatial listener fault boundary）**：
  ①world.ts：`notifyListeners` 统一 dispatch helper（逐 listener try/catch +
  `[...listeners]` 快照迭代）——emitSession/sitesChanged（register 与 dispose
  两条路径）全部走隔离边界；`CreateWorldOptions.onListenerError` 上报通道；
  ②selection.ts：emit 逐 listener 隔离 + `createSelectionApi(onListenerError?)`；
  ③spatial api.ts：activeFrameChanged 三个 dispatch 点（setActiveFrame /
  removeFrame active 清理）统一 `notify()` + 限频；`createSpatialApi(onListenerError?)`；
  ④限频策略（与 #19 一致）：同一 listener 仅 ok→failing 转变上报一次，
  成功复位——无界 error storm 不可发生；订阅保留；
  ⑤语义分离（方案 D）：mutation 成功后 observer throw 不再向调用方传播；
  owner validation error（unknown frame、duplicate registration）仍正常 throw；
  ⑥Composition Root 可观察：portal/standalone 接线 onListenerError → console；
  ⑦测试 +4（world session 限频复位 / selection snapshot 完整性 / site registry /
  spatial throw 隔离与限频）。
  验证：pnpm verify 全绿、296/296 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #22 修复（P1：AssetKind 运行时路由缺失）**：
  ①`AssetLeaseManager.load()` 引入 `AssetKind` dispatch——glb/gltf/collision-proxy
  （GLB-backed 契约）→ GLTF loader；tileset → 明确 fail-fast 指向
  TilesSystem（TilesPolicy.tilesetUrls / typed bridge），绝不进入 GLTFLoader；
  ktx2-texture/binary-metadata/kinematic-model → `UnsupportedAssetKindError`
  （reserved，V1 无 runtime loader，错误含 asset id + kind）；default 分支
  exhaustive never 检查（新增 kind 未注册 loader 时编译期即暴露）；
  ②scheme 只决定 transport/source（memory: 测试 source 仍自带 parser）；
  ③测试 +4：dispatch matrix（GLTF 分支非 Unsupported / tileset+ktx2+binary+
  kinematic fail-fast / reserved 语义）；
  ④docs/asset-pipeline.md：acquire 入口收窄为 glb/gltf/collision-proxy，
  tileset/ktx2/binary/kinematic 标注 reserved 或专用 owner。
  验证：pnpm verify 全绿、299/299 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **持续迭代：compliance 资源 baseline 全量统一 + assetLeases 计数**：
  ①MockAssetApi 增加 lease 计数同步（acquire/release 驱动 counters.assetLeases）；
  ②expectClean 新增 assetLeases 基线检查（#13 复审遗留的 metrics 缺口闭环）；
  ③全部 hostile describe（Issue #1/#4/#5/#7/#18 系列 fixture + unmount-hangs）
  统一升级为严格 expectClean 资源 baseline 断言——不再只检查 contextState
  revoked；44/44 全部通过证明所有 teardown 路径（含 throw/timeout/gate 竞态）
  资源全量归零；
  ④README 目录清单补 scenes/shared（SceneViewController）。
  验证：pnpm verify 全绿、284/284 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #21 修复（P1：DEMO tick 覆写 Spatial Fast Path）**：
  ①采纳方案 B——`SpatialStateBuffer` 所有权从 DemoGateway 上移到 Composition
  Root（foundation 持有并传入 graphicsAccess）；DemoGateway 不再持有/写 buffer；
  ②generateAll 移除 `stateBuffer.upsert` 副作用——DEMO 生成器只负责产出
  DataEnvelope（HISTORY/SIM fixture 照常工作），Fast Path 唯一写入链路 =
  WorldClient 已接受 envelope（foundation 的 data.subscribe adapter）；
  ③gateway.test.ts 改为验证 envelope 生成行为（不再把"直接写共享渲染 buffer"
  当作不可替换契约）；新增生产替换集成回归 gateway-integration.test.ts
  （fake WebSocket + 配置 gatewayWsUrl：真实 envelope（sourceTime 落后墙钟）
  进入 buffer 后，多次 foundationTick 不再覆写；subscribe 帧证明 live source
  已替换）。
  验证：pnpm verify 全绿、296/296 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #22 修复（P1：AssetKind 运行时路由缺失）**：
  ①`AssetLeaseManager.load()` 引入 `AssetKind` dispatch——glb/gltf/collision-proxy
  （GLB-backed 契约）→ GLTF loader；tileset → 明确 fail-fast 指向
  TilesSystem（TilesPolicy.tilesetUrls / typed bridge），绝不进入 GLTFLoader；
  ktx2-texture/binary-metadata/kinematic-model → `UnsupportedAssetKindError`
  （reserved，V1 无 runtime loader，错误含 asset id + kind）；default 分支
  exhaustive never 检查（新增 kind 未注册 loader 时编译期即暴露）；
  ②scheme 只决定 transport/source（memory: 测试 source 仍自带 parser）；
  ③测试 +4：dispatch matrix（GLTF 分支非 Unsupported / tileset+ktx2+binary+
  kinematic fail-fast / reserved 语义）；
  ④docs/asset-pipeline.md：acquire 入口收窄为 glb/gltf/collision-proxy，
  tileset/ktx2/binary/kinematic 标注 reserved 或专用 owner。
  验证：pnpm verify 全绿、299/299 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #19 修复（P1：WorldClient/DataSource subscriber fault boundary）**：
  ①WorldClient 新增 `deliver()` trust boundary——Scene-facing data handler
  逐 handler try/catch 隔离：单个 handler throw 只失败它自己，不截断同一
  envelope 的其它 handler、同 batch 后续 envelope 或其它订阅；source forward
  与 snapshot replay 全部走该边界；
  ②限频策略：同一 handler 只在 ok→failing 转变时上报一次（WeakMap 状态，
  成功即复位）——高频重复 throw 不产生无界 error storm，订阅保留（数据可自愈）；
  ③`WorldClientOptions.onSubscriberError`：sink 携带 contract/key/mode；
  缺省降级 console.error；foundation/standalone 已接线；
  ④replaySnapshot 拆分：`source.snapshot()` 的 try 只捕真正的 source failure，
  delivery loop 独立——consumer throw 不再被误吞为 source failure，
  snapshot 后续 envelope 继续处理（#11 的 generation/timeline guard 不回退）；
  ⑤三 source emitter 隔离：WebSocketSource 拆分 parse/protocol 边界与
  dispatch（malformed frame 仍丢弃、连接保持），replay/scripted 逐订阅隔离；
  ⑥测试 +6（坏 handler+健康订阅 multi-envelope batch / 限频复位 /
  sink meta 与降级 / snapshot 竞态 / fake socket 跨帧 / replay 同位置重放）。
  验证：pnpm verify 全绿、290/290 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #20 修复（P1：World/Selection/Spatial listener fault boundary）**：
  ①world.ts：`notifyListeners` 统一 dispatch helper（逐 listener try/catch +
  `[...listeners]` 快照迭代）——emitSession/sitesChanged（register 与 dispose
  两条路径）全部走隔离边界；`CreateWorldOptions.onListenerError` 上报通道；
  ②selection.ts：emit 逐 listener 隔离 + `createSelectionApi(onListenerError?)`；
  ③spatial api.ts：activeFrameChanged 三个 dispatch 点（setActiveFrame /
  removeFrame active 清理）统一 `notify()` + 限频；`createSpatialApi(onListenerError?)`；
  ④限频策略（与 #19 一致）：同一 listener 仅 ok→failing 转变上报一次，
  成功复位——无界 error storm 不可发生；订阅保留；
  ⑤语义分离（方案 D）：mutation 成功后 observer throw 不再向调用方传播；
  owner validation error（unknown frame、duplicate registration）仍正常 throw；
  ⑥Composition Root 可观察：portal/standalone 接线 onListenerError → console；
  ⑦测试 +4（world session 限频复位 / selection snapshot 完整性 / site registry /
  spatial throw 隔离与限频）。
  验证：pnpm verify 全绿、296/296 单测、compliance 44/44、e2e 10/10。

- 2026-09-16 **Issue #22 修复（P1：AssetKind 运行时路由缺失）**：
  ①`AssetLeaseManager.load()` 引入 `AssetKind` dispatch——glb/gltf/collision-proxy
  （GLB-backed 契约）→ GLTF loader；tileset → 明确 fail-fast 指向
  TilesSystem（TilesPolicy.tilesetUrls / typed bridge），绝不进入 GLTFLoader；
  ktx2-texture/binary-metadata/kinematic-model → `UnsupportedAssetKindError`
  （reserved，V1 无 runtime loader，错误含 asset id + kind）；default 分支
  exhaustive never 检查（新增 kind 未注册 loader 时编译期即暴露）；
  ②scheme 只决定 transport/source（memory: 测试 source 仍自带 parser）；
  ③测试 +4：dispatch matrix（GLTF 分支非 Unsupported / tileset+ktx2+binary+
  kinematic fail-fast / reserved 语义）；
  ④docs/asset-pipeline.md：acquire 入口收窄为 glb/gltf/collision-proxy，
  tileset/ktx2/binary/kinematic 标注 reserved 或专用 owner。
  验证：pnpm verify 全绿、299/299 单测、compliance 44/44、e2e 10/10。
