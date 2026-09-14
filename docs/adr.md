# 架构决策记录（ADR）

> 基线：[Architecture Freeze v1.2](digital-twin-architecture-freeze-v1.2.md)。
> 记录实现层的关键取舍；格式：背景 → 决策 → 后果。

## ADR-1 引擎能力契约收拢在 @twin/sdk（类型单向依赖）

**背景**：SceneContext 需要 MapAccess/GraphicsContext 类型，而引擎驱动又需要
ViewDriver/ViewTarget —— 最初 sdk ↔ engines 相互 import 形成包级循环。

**决策**：引擎能力契约（MapContext/GraphicsContext/诊断/水位等）全部定义在
`sdk/src/engines.ts`；引擎包单向依赖 sdk。类型层面 sdk 允许 `import type`
three/maplibre（devDeps），运行时零引入（architecture-tests 强制）。

**后果**：✅ 无循环依赖、Scene 只需认识 @twin/sdk；⚠️ sdk devDeps 需随
three/maplibre exact pin 同步升级（已在 §78 回归清单内）。

## ADR-2 Disposable 为接口而非裸函数

**背景**：事件订阅曾直接返回 `() => void`，与 `Disposable { dispose() }`
接口在类型上不兼容，且幂等清理语义无处安放。

**决策**：统一 `Disposable` 接口；所有 Foundation 订阅/注册句柄返回
`{ dispose() }`（场景侧 `offPick.dispose()`）。

**后果**：✅ 清理语义可扩展（如幂等标记）；⚠️ 调用点略啰嗦。

## ADR-3 MapContext 交付前 style 必须就绪

**背景**：整页刷新直连场景时，Scene 首个 `addSource` 与 MapLibre style
异步加载竞态（"Style is not done loading"），表现为场景面板丢失。
SPA 内不易复现（引擎已 boot），仅在 reload/直达 URL 出现。

**决策**：`MapAccess.use()` 在 `isStyleLoaded() / 'load' / 'error'`（15s 兜底）
之后才 resolve MapContext —— ready 语义属于引擎生命周期（§52），不留给 Scene。

**后果**：✅ 场景可安全地在 `use()` 后立即调用原生 API；⚠️ 首次交付最多延迟
至 style 加载完成（内置 style 为本地对象，通常 <300ms）。

## ADR-4 演示网关是应用层装配，不是 Foundation 能力

**背景**：开发/演示需要无依赖的数据流，但 Foundation 不得内置业务语义。

**决策**：确定性演示网关位于 `apps/portal/src/gateway.ts`（应用层）；
Foundation 只提供 `ScriptedSource/ReplaySource/WebSocketSource` 三种
业务无关的传输形态。生产切换 = 一个环境变量（I1-2）+ 一个函数
（`createHistorySimulationSources`，I3-4）。

**后果**：✅ Scene/Foundation 与演示数据零耦合；⚠️ 演示生成器在 app 层有
少量与 standalone 共享的复制（可接受：配置而非逻辑）。

## ADR-5 Spatial Fast Path 在应用层适配、帧边界消费

**背景**：AGV 等高频位姿若走 Vue reactive 会拖垮帧率（§35）；若在消息回调里
直写 `Object3D.position` 则破坏帧预算（§36）。

**决策**：AGV 信封在**应用层**（portal/standalone 的 adapter）写入共享
`SpatialStateBuffer`（SoA Float64）；引擎仅在 frame boundary
`drainDirty` 更新表示。2D 表示走业务信封 + 节流 setData。

**后果**：✅ 高频路径不进任何 reactive 系统、可单测；⚠️ buffer 内容是
「渲染侧最新态」，非历史真值（历史回放走信封重放，同一 adapter 随模式自动跟随）。

## ADR-6 场景视图切换经 DOM 事件与壳层联动（S1）

**背景**：视图切换是场景体验（§26 场景内 enterGraphics），但壳层视口模式
（2D/分屏/3D）是应用布局——两者曾各自为政（双开关）。

**决策**：场景在切换视图时向自身 UI 层派发 `twin-scene-view` DOM CustomEvent
（场景不 import 任何应用代码）；Portal 监听并同步壳层视口模式。
非活跃引擎随切换 suspend（§64）。

**后果**：✅ 双开关缝隙消除，场景保持可独立部署；⚠️ 事件名为约定契约，
已列入运维手册。
