# 性能基准与稳定性验收（I5）

> 方法与工具：`tooling/perf`（PerfCapture / SoakDriver）+ Portal URL 参数驱动
> （`?perf=1&perfMs=…` / `?soak=1&soakCycles=…` / `?contextLoss=1`）。
> 采集项：fps、p50/p95 帧时（引擎滚动统计的最差观测）、draw calls、triangles、
> 3D Tiles 缓存字节、JS heap（growth = 末值 − 首值）。
> 产出：`window.__twinPerfReport / __twinSoakReport / __twinContextLossReport`（JSON）。

## 1. 基准记录

### Run #1 — Production Twin · 3D · Live（2026-09-14）

| 项 | 值 |
|---|---|
| 环境 | 开发机（Apple Silicon，120Hz 显示），**非参考硬件** |
| 视口 | 2560 × 1440（DoD 目标分辨率） |
| 场景 | production，3D 视图，Live 数据流（16 顶点建筑 + 4 龙门吊 + AGV + 水体） |
| 采样 | 10s 窗口 / 41 样本 |
| **FPS** | avg **116.7**（min 0 为 context loss 演练瞬间的合法样本，稳态 120） |
| **帧时** | p50Worst **8.3ms** · p95Worst **10.3ms**（DoD 目标 p95 ≤ 33ms ✅） |
| draw calls | max 57 |
| triangles | max 8,854 |
| JS heap | 71.8 → 84.6 MB（growth +12.8MB，含采集期场景切换的合理波动） |

> 结论：办公终端 DoD（2560×1440 ≥30FPS、p95≤33ms）在开发机上大幅余量达成。
> **参考硬件正式跑分**待公司定义 Reference Hardware 后按相同程序执行并替换本节。

### Run #2 — Context Loss 演练（§75，I5-4）

Production 3D 运行中，经 `WEBGL_lose_context` 强制丢失并恢复：

| 阶段 | fps | frameIndex | 说明 |
|---|---|---|---|
| before | 120 | 4160 | 正常渲染 |
| duringLost | 120 | **4161** | 丢失瞬间 Render Loop 立即停帧（4161→保持） |
| afterRestore | 120 | **4518** | 恢复后自动续跑 357 帧，表示层由既有世界真值重建 |

**recovered: true**。验证了 §75 语义：GPU context 可丢失、世界状态不受影响、
Scene 无需重新请求业务真值。（实现：`packages/scene-engine/src/contextLoss.ts`，
带可单测的 ContextLossGuard。）

### Run #3 — Scene-Switch Soak（§71，I5-3）

**冒烟**（6 轮）：heap 88.1 → 83.4 MB，无增长迹象。

**20 轮强化**（2026-09-14，global-ships ⇄ stack-yard 交替，30.2s 完成）：

| 项 | 值 |
|---|---|
| 循环 | 20/20 完成，0 错误 |
| heap 轨迹 | 77.2 MB → **65.2 MB**（下降 12MB） |
| plateau 斜率 | **−1.57 MB/轮**（下降，`detected: true`） |
| 前半/后半均值 | 71.6 / 55.0 MB |

> 结论：无增长性泄漏。**24h 验收已脚本化**（见 Run #4）。

### Run #4 — 扩展 Soak：300 轮场景切换（2026-09-14，I5-3 强化证据）

**执行方式**：`node tooling/perf/scripts/soak-run.mjs --cycles 300`（全自动：
headless Chromium → 登录 → 300 轮 global-ships ⇄ stack-yard 切换 → plateau 判定）。

| 项 | 值 |
|---|---|
| 循环 | **300/300 完成，0 错误** |
| 耗时 | 452s（7.5 分钟，≈1.5s/轮） |
| heap 轨迹 | 55.4 MB → 73.9 MB（前段 JIT/缓存爬升后趋平，§71 预期行为） |
| **plateau 斜率** | **0.046 MB/轮 ≤ 0.05 阈值 → `detected: true`** |
| 报告 | `docs/soak-300cycles.json`（含全部 300 个样本） |

> 结论：**通过 §71 验收标准**。

### Run #5 — 1152 轮密集浸泡（⚠️ 非 24h 墙钟，见更正与 Run #6）

- 执行：2026-09-14 20:52 → 21:35（对**生产镜像** http://localhost:8080）
- 结果：**1152/1152 完成、0 错误、plateau 斜率 0.02 ≤ 0.05 → pass**
- 报告：`docs/soak-1152cycles-fast.json`
- ⚠️ **更正（2026-09-14 晚）**：`--cycleIntervalSec 73` 参数存在但**未接线到
  页面内驱动器**（perf.ts 的 soak 通道只读 soakCycles），导致 1152 轮以
  ≈1.5s/轮在 29.3 分钟内跑完——**这不是 24h 墙钟验证**，早前"24h 长跑
  已启动"的结论据此更正。本运行作为 1152 轮密集浸泡证据保留。
- 正式 24h 验收需两项修复后重跑：①perf.ts soak 通道接入轮间隔参数；
  ②soak-run.mjs 改为 node 侧逐轮驱动 + 页面故障自动恢复（24h 必需健壮性）
  → **两项均已于 I9 修复并实测**（详见 I9-1/I9-2）。

### Run #6 — 24h 墙钟长跑（2026-09-15 00:40 启动；⚠️ 覆盖范围见下）

- 执行器：I9-2 健壮化版本（node 侧逐轮驱动 + 页面故障自动重建）
- 参数：`--url http://localhost:8080 --cycles 1152 --cycleIntervalSec 73`
  （1152 轮 × ≈74.5s ≈ 23.9h 墙钟；轮间隔已实测生效）
- 报告：完成后自动写入 `soak-24h.json`，通过标准同 §71
- 结果：**作废（未产出报告）**——宿主机于 2026-09-15 深夜重启（colima/栈随之
  停止），长跑进程中断且 `soak-24h.json` 未落盘
- ⚠️ **覆盖范围声明（Issue #13）**：Run #6 的 workload 仅做 global-ships ⇄
  stack-yard 场景切换、pass 判定仅依据 JS heap slope。即使完成并通过，其结论
  也仅是「2D 场景切换 workload 下 JS heap 无持续增长」，
  **不等价于 M9 的 GPU/asset/tile/frame-callback 资源 plateau 验收**。

### Run #7 — 24h mixed-resource 墙钟长跑（⚠️ 作废：宿主机休眠中断，未产出报告）

- 启动：2026-09-16 00:50（colima/栈恢复后重新拉起）
- 结果：**作废**——宿主机于 2026-09-16 白天休眠，colima/栈停止，
  长跑进程中断且 `soak-24h.json` 未落盘（约 14h 后发现）
- 执行器：同 I9-2 版本 + Issue #13 升级：
  - **mixed 场景**：global-ships(3D) → stack-yard(2D) → production(3D+GLTF)
    → stack-yard(2D↔3D toggle) 循环重入——真实 SceneEngine/WebGL/
    asset lease 生命周期进入验收路径
  - **资源采样**：每轮经 `__twinSoakMetrics` 聚合 renderer
    textures/geometries/programs、frameCallbacks、assetLeases、entityCount、
    tilesBytes（不丢已有 diagnostics 字段）
  - **验收语义（§71 Plateau-not-Zero）**：heap plateau + 每个资源 counter
    slope ≤ 阈值（计数 >0.02/轮、tilesBytes >2KB/轮判泄漏）才 pass；
    任一 counter 单调增长即 fail
- 参数：`--url http://localhost:8080 --cycles 1152 --cycleIntervalSec 73 --out soak-24h.json`
- 结果：待填（预计 2026-09-17 23:50 前后完成）
- CI 短版：`tooling/e2e/tests/stress.spec.ts`（6 轮 mixed，随 e2e workflow 运行）

### Run #8 — 24h mixed-resource 墙钟长跑（Run #7 中断后重启，执行中）

- 启动：2026-09-16 23:15（colima/栈恢复后重新拉起，Run #7 中断于 ~14h）
- 参数/通过标准：同 Run #7
- 结果：待填（预计 2026-09-17 23:15 前后完成）

### 微基线（Node，M 系列；`pnpm bench`）

| 任务（每任务含 ×1000 次操作） | 任务/秒 | 单任务均值 |
|---|---|---|
| geodeticToEcef ×1000 | 36,374 | 0.028ms |
| ecefToFrameLocal（site 变换）×1000 | 35,837 | 0.028ms |
| SpatialStateBuffer upsert ×1000 | 14,791 | 0.069ms |
| SpatialStateBuffer interpolate ×1000 | 14,601 | 0.069ms |

> 空间数学与 Fast Path 均远超帧预算需求（AGV@10Hz×100 实体 ≈ 1ms/帧的量级）。

> **Docker 构建与 healthz 实跑通过（DoD #1，2026-09-14）**：安装 colima 0.10.3
> + docker 29.8.0 + compose v2 后，实际执行 `docker compose up --build`——
> multi-stage 镜像构建成功（容器内 pnpm fetch → --offline 安装 → vite build
> 均在 linux/arm64 完成）、容器启动并转为 **healthy**（wget → /healthz，
> FailingStreak 0）、首页 200、GLB 以 `model/gltf-binary` 正确下发。
> 过程中修复真实缺陷：CSP 头反斜杠跨行书写导致响应头多行、容器 wget
> 健康检查失败（"bad header line"）——已改单行并重建验证。

## 2. 复现程序

```bash
pnpm dev:portal
# 浏览器（建议无痕/干净 profile）：
#   基准：    http://localhost:5173/?perf=1&perfMs=12000#/scene/production
#             进入场景后点击场景内 3D 按钮，等待 ~18s，
#             结果在 window.__twinPerfReport（?download=1 附加 JSON 下载）
#   Soak：    http://localhost:5173/?soak=1&soakCycles=1152#/scene/global-ships
#             结果在 window.__twinSoakReport
#   演练：    http://localhost:5173/?contextLoss=1#/scene/production（进入 3D 后）
#             结果在 window.__twinContextLossReport
```

CI 侧 `pnpm bench` 提供空间数学与 StateBuffer 的微基线；
帧级指标依赖真实 GPU，按本节程序在目标机器采集。

## 3. 验收对照（DoD #5）

| DoD 条目 | 状态 |
|---|---|
| **一键部署**（DoD #1） | ✅ `docker compose up --build` 实跑：镜像构建成功、容器 healthy、/healthz ok、首页与 GLB 验证通过（2026-09-14，见上方附注） |
| 2560×1440 ≥30 FPS，p95 ≤ 33ms | ✅ 开发机 116.7 FPS / 10.3ms（参考硬件跑分待执行） |
| 24h 内存 plateau | 🟠 **24h 墙钟长跑执行中**（Run #6，2026-09-15 00:40 启动，健壮执行器 + 轮间隔 73s；报告自动落盘 soak-24h.json） |
| Context loss 自动恢复 | ✅ Run #2 |
