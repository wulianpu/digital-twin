# 运维手册

> 面向部署与值班同学；架构背景见 [docs/digital-twin-architecture-freeze-v1.2.md](digital-twin-architecture-freeze-v1.2.md)。

## 1. 日常健康检查

| 检查项 | 方法 | 健康标准 |
|---|---|---|
| Portal 存活 | `curl http://<host>/healthz` | `ok`（nginx，见 deploy/nginx.conf） |
| 前端资源 | 打开首页无 4xx/5xx | 所有 chunk 200 |
| 网关连接 | 顶栏连接指示（左上角圆点） | `网关已连接`（绿）或 `演示数据`（蓝） |
| 数据新鲜度 | 指示器「N 项陈旧」计数 | 0（持续 >0 说明网关停流或时钟偏差） |
| 底图异常 | 指示器 tooltip「底图异常 N 条」 | 0（glyphs/ sprite 不可达会降级为无文字标注） |

**诊断导出**：浏览器控制台执行
`__twin.exportDiagnostics(true)` —— 下载 JSON（会话/连接/引擎诊断/最近 50 条错误），
随工单附上。

## 2. 已知降级行为（设计使然）

| 现象 | 原因 | 影响 |
|---|---|---|
| 地图无文字标注 | glyphs 服务不可达（离线/内网） | 仅符号缺失；自建 style 指向本地 glyphs 可恢复 |
| 顶栏「演示数据」 | 未配置 `VITE_GATEWAY_WS_URL` | 数据来自内置确定性演示网关 |
| 「标记资产不可用」日志 | 资产管线未部署（清单无该 ref） | 场景跳过 GLB 道具，其余功能正常 |
| WebGL2 报错页 | 浏览器/驱动不支持 WebGL2 | MapLibre v6 / Three 均要求 WebGL2（§2），需换浏览器 |

## 3. 故障处置

### 3.1 网关断连
- 现象：顶栏红点「已断开 · 重连中」。
- 平台行为：指数退避自动重连（0.5s→15s 封顶），重连后自动重发订阅并接受快照重放；
  断连期间信封按 `sourceTime` 降级为 `stale`。
- 处置：检查网关服务与 `/gateway` 反代；恢复后无需刷新页面。

### 3.2 GPU context 丢失
- 现象：画面冻结数秒。
- 平台行为：自动停帧 → context 恢复后重置渲染状态并续跑（§75，已演练验证
  见 docs/benchmarks.md Run #2）。世界状态不受影响，无需刷新。

### 3.3 场景切换失败
- 现象：底部错误条 + 「重试」按钮。
- 处置：点重试；仍失败时用诊断导出附工单（最近错误环形缓冲已含堆栈）。

## 4. 性能验收

按 [docs/benchmarks.md](benchmarks.md) 的程序在目标机器执行。

**24h 内存 plateau 验收（DoD #5）已脚本化且当前正在生产镜像上长跑**
（2026-09-14 20:52 启动，报告完成后写入 `soak-24h.json`）。重跑/复验命令：

```bash
# 对生产镜像（compose 8080）执行 24h 墙钟验收（1152 轮 × 73s 间隔 ≈ 23.9h）：
pnpm soak
# 等价于：node tooling/perf/scripts/soak-run.mjs --url http://localhost:8080 \
#   --cycles 1152 --cycleIntervalSec 73 --out soak-24h.json

# 通过标准：exit 0 且报告 plateau.detected === true
# （cycles 全部完成、0 错误、斜率 ≤ 0.05 MB/轮）
```

其他验收命令：基准（`?perf=1&perfMs=12000`）、context loss 演练（`?contextLoss=1`）。
验收阈值：2560×1440 ≥30FPS、p95 ≤33ms。历史报告存于 `tooling/perf/reports/`。

## 5. 发布与回滚

- 发布：CI 通过 → 构建镜像（build args 注入 `VITE_*`）→ 推送 → 滚动更新。
- 回滚：镜像回退即可（前端无服务端状态；`VITE_*` 变更需重新构建镜像）。
- 依赖升级：`three` / `maplibre-gl` / `3d-tiles-renderer` 为 exact pin，
  升级必须全套回归（§78）：`pnpm verify` + `pnpm test:compliance` + `pnpm bench` +
  视觉回归（tooling/visual-regression）。
