# 船舶制造数字孪生平台完整开发设计方案

> **Architecture Freeze v1.2**  
> 状态：**Approved / Baseline for Development & Review**  
> 日期：2026-09-13  
> 面向：架构评审、技术立项、PoC、MVP、平台开发、Scene 开发规范

---

## 0. 文档目的

本文档定义公司级船舶制造数字孪生平台的最终基础架构基线，用于指导后续：

- 技术开发；
- Architecture Review；
- PoC / Architecture Spike；
- Scene 开发；
- 资产管线建设；
- 性能与内存测试；
- Portal 与独立应用部署；
- Live / History / Simulation 演进；
- 多厂区和全球船舶业务扩展。

本文档的目标不是规定所有业务实现细节，而是冻结长期稳定的：

1. **架构边界**；
2. **核心术语**；
3. **依赖方向**；
4. **Scene 生命周期**；
5. **2D / 3D Engine 组合方式**；
6. **空间坐标模型**；
7. **资产与资源所有权模型**；
8. **性能和内存原则**；
9. **Scene 开发契约**；
10. **技术验证和验收 Gate**。

核心设计哲学：

> **App decides what to run.**  
> 应用决定运行什么。

> **Scene owns business and experience.**  
> 场景拥有业务与体验。

> **Host owns lifecycle and isolation.**  
> 宿主负责生命周期与隔离。

> **Foundation owns facts and capabilities.**  
> 底座拥有事实与能力。

> **Engines own rendering.**  
> 引擎负责渲染。

> **Wrap platform semantics, expose engines.**  
> 封装平台语义，开放引擎能力。

> **World state is shared; representations are engine-specific.**  
> 世界状态只有一份，表现由各引擎负责。

> **Engines start only when they are actually needed.**  
> 引擎只有在真正需要时才启动。

---

# 1. 项目定位

平台不是一个单独的三维展示系统，也不是传统 GIS 应用，而是一个面向船舶制造全生命周期的 Web-first 数字孪生基础平台。

业务空间尺度：

```text
全球
│
├── 全球公司船舶
│
├── 公司多个 Site
│   ├── 船厂
│   ├── 港区
│   ├── 码头
│   ├── 服务基地
│   └── 试验场
│
└── Site 内
    ├── 厂房
    ├── 道路
    ├── 船坞
    ├── 码头
    ├── 堆场
    ├── 船舶
    ├── 分段
    ├── 龙门吊
    ├── AGV / 车辆
    ├── 人员 / 设备
    ├── 实时生产状态
    ├── 历史回放
    └── 仿真
```

平台必须同时支持：

- 纯 2D 场景；
- 纯 3D 场景；
- 同一 Scene 内 2D / 3D 动态切换；
- 2D + 3D Split / Mini Map；
- Portal 动态加载 Scene；
- Scene 独立部署；
- 全球尺度 → Site → 米级设备尺度；
- Live / History / Simulation；
- 大规模静态空间资产；
- 高频动态对象；
- 江河 / 海岸 / 码头 / 水体；
- 未来工程仿真。

---

# 2. 最终技术路线

## 2.1 Application

```text
Vue 3
TypeScript
Vite
Vue Router
Pinia
```

Vue 负责：

- Application Shell；
- Scene Panel；
- Router；
- 用户与权限；
- Portal UI；
- 业务 Panel；
- 表格 / 树 / 图表；
- Scene 内部 Vue UI；
- Workspace；
- 低频 Application State。

Vue **不负责**：

- 高频 Twin Pose；
- Three Scene Graph；
- 3D Tiles 生命周期；
- GPU Resource；
- Floating Origin；
- Simulation Tick；
- 大规模空间状态更新。

---

## 2.2 2D Engine

```text
MapEngine
└── MapLibre GL JS
```

负责：

- 全球二维船舶态势；
- 航迹；
- Site 位置与边界；
- 厂区道路；
- 堆位；
- 车辆导航；
- Vector Tile；
- Raster / Imagery；
- 专题图；
- Feature State；
- Label；
- 传统 GIS 交互。

生产基线：

> **WebGL2-capable modern Chromium**

MapLibre GL JS v6 已要求 WebGL2，因此平台不再为 WebGL1 做架构兼容。

---

## 2.3 3D Engine

```text
SceneEngine
├── Three.js
└── 3DTilesRendererJS
```

负责：

- 全球三维世界；
- 大尺度地理场景；
- 精细厂区；
- 3D Tiles；
- GLB；
- PBR；
- 水体；
- 环境；
- Picking；
- 动态设备；
- 物理与仿真结果表现；
- 高级 Three 生态能力。

生产 V1：

```text
Three WebGLRenderer / WebGL2
```

WebGPU / TSL：

```text
独立研发验证线
```

不建立 Universal Renderer 抽象。

---

# 3. 最终总体架构

```text
                              Applications
                    ┌─────────────┴─────────────┐
                  Portal                    Standalone
                    │                           │
             SceneCoordinator                   │
                    │                           │
              SceneDefinition                   │
                    └─────────────┬─────────────┘
                                  │
                              SceneHost
                                  │
                              SceneEntry
                                  │
                                mount
                                  │
                             SceneContext
                                  │
           ┌──────────────────────┼──────────────────────┐
           │                      │                      │
         World                 Spatial                Content
           │                      │                      │
           └──────────────────────┼──────────────────────┘
                                  │
                             WorldClient
                                  │
                  ┌───────────────┴───────────────┐
                  │                               │
              MapEngine                      SceneEngine
              MapLibre                         Three
                                                  │
                                          3DTilesRendererJS


                               Scenes

           Global Ships / Stack Yard / Vehicle Navigation
           Production / Safety / Energy / Simulation
           Heavy Transport / Lifting / ...
```

---

# 4. 顶层职责划分

最终代码空间分成五个部分。

```text
apps/
    如何运行和部署

scenes/
    业务场景

domains/
    跨 Scene 的业务领域复用

packages/
    Foundation

tooling/
    工程工具
```

核心规则：

> **App 负责装配与部署。**

> **Scene 负责业务。**

> **Domain 负责业务复用。**

> **Foundation 负责稳定能力。**

---

# 5. Monorepo 目录

推荐冻结：

```text
repo/

├── apps/
│   ├── portal/
│   │   ├── application/
│   │   │   ├── scene-catalog/
│   │   │   ├── scene-coordinator/
│   │   │   └── workspace/
│   │   └── ui/
│   │       └── ScenePanel.vue
│   │
│   └── standalone/
│       ├── vehicle-navigation/
│       ├── stack-yard/
│       └── production/
│
├── scenes/
│   ├── global-ships/
│   ├── vehicle-navigation/
│   ├── stack-yard/
│   ├── production/
│   ├── safety/
│   ├── energy/
│   ├── heavy-transport/
│   └── simulation/
│
├── domains/
│   ├── vessel/
│   ├── crane/
│   ├── agv/
│   ├── logistics/
│   └── production/
│
├── packages/
│   ├── world/
│   ├── spatial/
│   ├── content/
│   ├── world-client/
│   ├── map-engine/
│   ├── scene-engine/
│   ├── scene-host/
│   ├── sdk/
│   └── ui/
│
└── tooling/
    ├── asset-pipeline/
    ├── architecture-tests/
    ├── benchmarks/
    ├── scene-compliance/
    └── visual-regression/
```

禁止建立：

```text
@twin/foundation
@twin/platform
shared/
```

原因：

- `Foundation` 是架构集合，不是 God Package；
- `platform` 容易成为所有杂项的归宿；
- `shared` 容易成为无语义垃圾桶。

---

# 6. Foundation 的定义

Foundation 是以下稳定能力的架构集合：

```text
World
Spatial
Content
WorldClient
MapEngine
SceneEngine
SceneHost
SDK
UI foundation
```

不要出现：

```ts
const foundation = new Foundation()
```

也不要通过全局 Service Locator 获得所有能力。

系统真正的 Composition Root 在：

```text
apps/portal/main.ts
```

或：

```text
apps/standalone/<scene>/main.ts
```

---

# 7. Scene 模型

## 7.1 SceneDefinition

SceneDefinition **只属于 Application**。

```ts
export interface SceneDefinition {
  readonly id: SceneId
  readonly name: string

  readonly description?: string
  readonly icon?: string

  readonly permissions?: readonly string[]

  load(): Promise<SceneEntry>
}
```

它只回答：

1. 场景是谁；
2. 用户是否能进入；
3. 场景代码从哪里加载。

明确删除：

```ts
engines
assets
topics
layers
camera
businessRules
```

等字段。

原则：

> **SceneDefinition 描述如何进入 Scene，不描述 Scene 如何实现。**

---

## 7.2 SceneEntry

唯一程序入口：

```ts
export interface SceneEntry {
  mount(
    context: SceneContext
  ): Promise<SceneMount>
}
```

---

## 7.3 SceneMount

一次真实运行实例：

```ts
export interface SceneMount {
  unmount():
    void | Promise<void>
}
```

生命周期：

```text
SceneDefinition
      ↓ load()
SceneEntry
      ↓ mount()
SceneMount
      ↓ unmount()
结束
```

---

# 8. SceneDefinition 不声明 Engine

正式删除：

```ts
engines: ['map', 'scene']
```

原因：

- Engine 是 Scene 内部实现细节；
- 同一 Scene 可能只在用户进入 3D 时才需要 Three；
- 用户可能整个会话都不进入 3D；
- 未来 Scene 可能有 CAD / P&ID / Deck Plan 等内部视图；
- SceneDefinition 不应该演化成实现 DSL。

冻结原则：

> **Engine initialization is demand-driven, not metadata-driven.**

---

# 9. SceneHost

SceneHost 是 Foundation 中 Scene 生命周期的唯一宿主。

职责：

```text
SceneHost
├── 创建 Scene Mount runtime
├── AbortController
├── 内部 MountScope
├── 创建 scoped SceneContext
├── mount()
├── 自动跟踪 Foundation-owned resources
├── unmount()
├── 自动 cleanup
└── revoke SceneContext
```

SceneHost 不理解：

```text
Production
Safety
Navigation
Stack Yard
```

等业务语义。

---

# 10. SceneCoordinator

SceneCoordinator **只属于 Portal Application**。

职责：

- Scene Panel 选择；
- SceneDefinition 查询；
- Scene Code Preload；
- Scene 切换；
- URL / Router；
- Loading；
- Error；
- Previous Scene；
- Last Selection Wins；
- Scene 切换失败回滚。

Standalone App 不需要 SceneCoordinator。

```text
Standalone
   ↓
SceneHost
   ↓
SceneEntry
```

---

# 11. Scene 切换事务

推荐：

```text
SELECT TARGET
      ↓
LOAD SCENE CODE
      ↓
PREPARE APPLICATION STATE
      ↓
UNMOUNT CURRENT
      ↓
MOUNT TARGET
      ↓
COMMIT ACTIVE SCENE
```

需要支持：

```text
AbortController
+
Generation ID
```

确保：

> **Last selection wins.**

用户快速点击：

```text
Production
↓ 100ms
Safety
↓ 100ms
Stack Yard
```

前两个未完成操作必须取消。

---

# 12. Scene Mount / Unmount 硬约束

## 12.1 `unmount()` 必须 Idempotent

```ts
await mount.unmount()
await mount.unmount()
```

必须安全。

---

## 12.2 `unmount()` 必须 Exception-safe

Scene 的自定义 cleanup 报错：

```text
SceneHost 仍继续执行 Host-owned cleanup。
```

---

## 12.3 `unmount()` 必须 Time-bounded

场景错误地永久等待时：

```text
Host 不能永久阻塞整个 Portal。
```

Host 达到 teardown deadline 后：

- 记录错误；
- abort；
- 强制执行 Host-owned cleanup；
- 继续场景切换。

---

# 13. Revocable SceneContext

AbortSignal 不能完全解决 Zombie Scene。

因此 SceneContext 必须和 SceneMount 生命周期绑定：

```text
ACTIVE
 ↓
UNMOUNTING
 ↓
REVOKED
```

unmount 后：

```ts
ctx.ui...
ctx.data...
ctx.assets...
```

等 API 在开发环境应：

```text
throw SceneUnmountedError
```

防止旧异步 callback 污染新 Scene。

原则：

> **Abort cancels work; revoke prevents stale work from writing.**

---

# 14. SceneContext

最终建议：

```ts
export interface SceneContext {
  readonly world: WorldApi
  readonly spatial: SpatialApi
  readonly data: DataApi

  readonly selection: SelectionApi
  readonly view: ViewApi
  readonly assets: AssetApi
  readonly ui: UiApi

  readonly map?: MapAccess
  readonly graphics?: GraphicsAccess

  readonly signal: AbortSignal
}
```

平台语义 API：

```text
world
spatial
data
selection
view
assets
ui
```

Engine 能力：

```text
map
graphics
```

---

# 15. Native-first Engine API

最终采用：

> **Wrap platform semantics, expose engines.**

平台不重造 Three.js / MapLibre API。

## 应封装

```text
WorldSession
ReferenceFrame
WGS84 / ECEF / ENU
WorldClient
Asset Lease
WorldContent
Selection
View sync
Live / History / Simulation
Scene lifecycle
Engine lifecycle
3D Tiles policy
```

## 不应重复封装

```text
THREE.Mesh
THREE.Group
THREE.Material
THREE.Geometry
MapLibre addSource
MapLibre addLayer
MapLibre Style Expressions
MapLibre Feature State
```

---

# 16. MapAccess / MapContext

Map engine 必须是 lazy capability。

概念接口：

```ts
export interface MapAccess {
  use(): Promise<MapContext>
}

export interface MapContext {
  readonly instance: Map
}
```

第一次：

```ts
const mapContext = await ctx.map!.use()
```

才允许 Host：

```text
dynamic import MapEngine
↓
initialize MapLibre
```

Standalone 3D-only Application 可以根本不配置 `map`。

---

# 17. GraphicsAccess / GraphicsContext

同理：

```ts
export interface GraphicsAccess {
  use(): Promise<GraphicsContext>
}

export interface GraphicsContext {
  readonly root: THREE.Group

  readonly renderScene: THREE.Scene
  readonly camera: THREE.Camera
  readonly renderer: THREE.WebGLRenderer

  onFrame(
    callback: FrameCallback
  ): Disposable
}
```

说明：

- `root`：当前 SceneMount 的 3D 隔离根节点；
- `renderScene`：Borrowed；
- `camera`：Borrowed；
- `renderer`：Borrowed；
- `onFrame()`：受 Host 管理的唯一高频回调入口。

---

# 18. Three Native API 使用规范

Scene **可以**：

```ts
import * as THREE from 'three'

const group = new THREE.Group()
const material = new THREE.MeshStandardMaterial(...)
const mesh = new THREE.Mesh(...)
graphics.root.add(mesh)
```

允许使用 Three 生态：

- three-mesh-bvh；
- Three shader；
- 后处理；
- Three helper；
- Three ecosystem packages。

但普通 Scene 禁止：

```text
renderer.dispose()

renderer.setAnimationLoop(...)

renderScene.clear()

替换 Foundation environment root

自己创建 3D Tiles 全局 cache

自己接管 Render Loop
```

---

# 19. Three Scene Graph 隔离

推荐：

```text
THREE.Scene                       ← SceneEngine owns
│
├── BaseWorldRoot                 ← SceneEngine owns
│   ├── Terrain
│   ├── 3D Tiles
│   ├── Environment
│   └── Water
│
└── SceneMountRoot                ← current Scene logical scope
    ├── Scene Mesh
    ├── Scene Effects
    ├── Scene Helpers
    └── Scene Representations
```

Scene 的原生 Three 对象默认只能挂在：

```text
SceneMountRoot
```

下。

---

# 20. Renderer / Camera 所有权

`renderer` 与 `camera` 以 Borrowed 形式暴露。

Scene 可进行：

```text
camera.project(...)
renderer.capabilities
renderer.compileAsync(...)
```

但标准空间导航必须优先：

```ts
ctx.view.focus(...)
ctx.view.setTarget(...)
```

避免 Scene 随意修改 camera pose 后破坏：

```text
Map ↔ 3D
View synchronization
```

高级视觉场景如确有需求，可直接操作，但需通过 Scene Compliance 验证。

---

# 21. Render Loop

一个 SceneEngine 只能有一个 Render Loop。

禁止 Scene：

```ts
requestAnimationFrame(...)
renderer.setAnimationLoop(...)
```

需要高频更新：

```ts
const disposable = graphics.onFrame(frame => {
  // animation / interpolation / simulation visualization
})
```

回调必须自动跟随 SceneMount 生命周期释放。

---

# 22. MapLibre Native API 使用规范

Scene 可以直接：

```ts
const map = (await ctx.map!.use()).instance

map.addSource(...)
map.addLayer(...)
map.setFilter(...)
map.setFeatureState(...)
map.on(...)
```

平台不重造：

```text
MapSourceApi
MapLayerApi
MapStyleApi
```

。

---

# 23. MapLibre 所有权边界

Scene 可以管理自己的：

- Sources；
- Layers；
- Images；
- Listeners；
- Feature State；
- Custom Layers。

Scene 禁止：

```text
destroy Map

破坏 Host-owned base layers

任意替换 Host base style（除非应用明确授予整个 Map 所有权）
```

Scene 添加的 MapLibre 资源必须在 Scene unmount 时清理。

---

# 24. MapLibre ID Namespace

推荐约定：

```text
<sceneId>:<localId>
```

例如：

```text
production:agv-source
production:agv-layer

stack-yard:stack-source
stack-yard:stack-fill
```

可以提供极薄 helper：

```ts
ctx.ui // 不负责
sceneId helper / SceneContext id helper
```

但不要因此包装 MapLibre `addSource/addLayer`。

---

# 25. Engine 可选且按需启动

具体 Application 可只装配一种 Engine。

## 2D-only

```text
Vue
Foundation
MapEngine
Scene
```

没有：

```text
Three
3DTilesRendererJS
Water
GLTF loaders
```

---

## 3D-only

```text
Vue
Foundation
SceneEngine
Scene
```

MapLibre 可以完全不打包。

---

## Full Twin

```text
Vue
Foundation
MapEngine
SceneEngine
Scene
```

Scene 可以运行时切换。

---

# 26. Mixed Scene 的代码拆分要求

对于支持 2D + 3D、但默认 2D 的 Scene，避免：

```ts
import * as THREE from 'three'
```

出现在主入口的 top-level，从而导致 Scene load 时就下载 Three。

推荐：

```text
production/
├── entry.ts
├── map.ts
├── graphics.ts
└── ui/
```

`entry.ts`：

```ts
async function enterGraphics(ctx: SceneContext) {
  const graphics = await ctx.graphics!.use()
  const module = await import('./graphics')

  return module.mountGraphics(ctx, graphics)
}
```

只有真正进入 3D 时，才下载：

```text
graphics.ts
+
three
+
SceneEngine
```

这对：

- 2D-first；
- 移动终端；
- 工控机；
- 行车导航；
- 堆位地图；

非常重要。

---

# 27. View 与 Scene 正交

严格区分：

```text
Scene
=
正在做什么业务

View
=
如何观察
```

例如：

```text
Scene = Production
View = Map
```

或：

```text
Scene = Production
View = Graphics
```

切换 View：

```text
Scene 不 unmount
业务状态不丢失
数据订阅不重建
```

。

---

# 28. WorldMode 与 Scene / View 正交

```text
WorldMode
├── Live
├── History
└── Simulation
```

因此：

```text
Production + Map + Live
Production + Graphics + History
Production + Graphics + Simulation
```

全部是合法组合。

只有真正“整个世界进入 alternative state”时才使用 Simulation WorldMode。

局部：

```text
吊装路径预演
单设备运动预览
```

可以只是 Scene 私有 Preview，不必创建 Simulation World。

---

# 29. WorldScope

```ts
export type WorldScope =
  | { kind: 'global' }
  | { kind: 'site'; siteId: SiteId }
  | { kind: 'entity'; entity: EntityRef }
```

Global / Site / Entity 不是三个不同 World。

它们只是同一个 WorldSession 的 Scope。

---

# 30. WorldSession

```ts
export interface WorldSession {
  readonly worldId: WorldId

  readonly mode:
    | 'live'
    | 'history'
    | 'simulation'

  readonly scope: WorldScope

  readonly time: WorldTime
}
```

`WorldSession` 不包含：

```text
Three
MapLibre
View Mode
Scene ID
```

。

---

# 31. World Foundation

Foundation Domain 必须保持最小化。

核心：

```text
World
Site
WorldSession
WorldScope
EntityRef
Selection
WorldTime
```

禁止把以下业务类型放入 Foundation：

```text
Crane
AGV
Stack
ProductionTask
Alarm
EnergyMeter
SafetyRisk
```

---

# 32. EntityRef

建议稳定身份：

```ts
export interface EntityRef {
  namespace: string
  id: string
}
```

例如：

```text
ais / IMO1234567

production / CRANE-003

yard / STACK-A-017
```

Foundation 不理解 namespace 业务含义。

---

# 33. Data Contract 与 Data Envelope

Foundation 不建设 Universal Twin Entity Schema。

业务 State 由 Scene / Domain Contract 定义。

例如：

```ts
interface CraneState {
  status: 'running' | 'idle' | 'fault'
  hookHeightMeters: number
  loadTonnes: number
}
```

Foundation 只理解 Envelope：

```ts
export interface DataEnvelope<T> {
  contract: DataContractId

  key: string

  sourceTime: Timestamp
  ingestTime: Timestamp

  revision?: number

  quality:
    | 'good'
    | 'stale'
    | 'bad'
    | 'unknown'

  payload: T
}
```

平台负责：

```text
transport
time
quality
revision
subscription
reconnect
```

业务负责：

```text
payload semantics
```

---

# 34. WorldClient

职责：

```text
WorldClient
├── Query
├── Snapshot
├── Delta
├── Subscription
├── State Cache
├── Live Source
├── History Source
└── Simulation Source
```

Scene 不直接理解：

```text
MQTT
Kafka
OPC UA
AIS provider
WebSocket protocol detail
```

。

浏览器通过统一 Platform Gateway 获得世界数据。

---

# 35. 实时数据两条内部路径

## Business State Path

适用于：

```text
Task
Alarm
WorkOrder
Equipment Status
KPI
```

可以：

```text
Object
JSON
Vue
普通 cache
```

。

## Spatial Fast Path

适用于：

```text
Ship Position
AGV Pose
Vehicle Pose
Crane Motion
Simulation Pose
```

内部采用：

```text
TypedArray
Structure of Arrays
Spatial State Buffer
```

不进入 Vue reactive。

---

# 36. Realtime 与 Render 解耦

固定：

```text
Realtime Message
      ↓
WorldClient
      ↓
State Buffer
      ↓
Frame Boundary
      ↓
Representation Update
      ↓
Engine
```

禁止：

```text
WebSocket callback
↓
Object3D.position =
↓
renderer.render()
```

。

好处：

- 合并重复更新；
- 降低 GC；
- 插值；
- 回放；
- 支持 Map + 3D 同时消费；
- 避免 message-driven rendering。

---

# 37. Spatial Core

## 37.1 坐标层次

```text
1. Geodetic / WGS84
2. ECEF Float64
3. Site Local ENU
4. Asset Local
5. Render Local
```

---

## 37.2 Global

全球真实位置：

```text
ECEF Float64
```

GPU：

```text
Camera-relative ECEF
```

避免巨大 ECEF 直接进入 float GPU。

---

## 37.3 Site Reference Frame

建议：

```text
X = East
Y = Up
Z = -North
```

Site 内：

- Physics；
- Navigation；
- Kinematic；
- Water；
- Simulation；
- Dynamic object；

尽量运行在稳定 Site Local Frame。

---

## 37.4 ReferenceFrame

```ts
export interface ReferenceFrame {
  id: ReferenceFrameId

  originECEF: Vec3d
  basisECEF: Mat3d
}
```

不要使用裸 `Frame` 作为公共术语，避免与：

- Render Frame；
- Animation Frame；
- WebGPU Frame Graph；

混淆。

---

# 38. Spatial Domain 类型

```ts
export interface GeodeticPosition {
  longitudeDegrees: number
  latitudeDegrees: number

  heightMeters: number
  verticalReference: VerticalReference
}

export interface EcefPosition {
  xMeters: number
  yMeters: number
  zMeters: number
}

export interface Pose {
  frameId: ReferenceFrameId

  positionMeters: Vec3d
  orientation: Quaterniond
}

export interface SpatialAnchor {
  frameId: ReferenceFrameId
  pose: Pose
}
```

Spatial Core 不依赖：

```text
THREE.Vector3
MapLibre
Vue
DOM
```

。

---

# 39. Vertical Datum

必须一等建模：

```text
Ellipsoid
MSL
SiteDatum
ChartDatum
TidalDatum
```

严禁：

```text
tideHeight
直接赋值到
Three Y
```

而不知道高度基准。

该能力未来直接影响：

- 潮位；
- 船舶吃水；
- 码头高程；
- 船坞；
- 水深；
- 靠离泊；
- 水动力仿真。

---

# 40. Content 与 Asset

## 40.1 Asset

Asset 表示：

> 可复用数字资源。

例如：

```text
龙门吊 GLB
船舶 GLB
厂房 3D Tiles
碰撞代理
Kinematic model
```

---

## 40.2 WorldContent

WorldContent 表示：

> Asset 如何进入世界。

```ts
export interface WorldContent {
  id: ContentId

  asset: AssetRef

  anchor?: SpatialAnchor

  role:
    | 'terrain'
    | 'tileset'
    | 'base-model'
    | 'water'
    | 'environment'
}
```

Site：

```ts
interface Site {
  id: SiteId

  origin: GeodeticPosition
  bounds: GeoBounds

  baseContent: ContentId[]
}
```

---

# 41. 静态与动态资产

3D Tiles：

```text
厂房
道路
码头
船坞
固定设施
倾斜摄影
大型固定结构
```

GLB：

```text
船
龙门吊
AGV
车辆
机械设备
分段
人员
可运动机构
```

核心：

> **3D Tiles = Spatial World**

> **GLB = Active / Dynamic Object**

不要把所有动态设备烘入 3D Tiles。

---

# 42. Asset Pipeline

```text
Source Asset
   ↓
Normalize
   ↓
Canonical Asset
   ↓
Runtime Pipeline
   ↓
3D Tiles / GLB / KTX2
   ↓
LOD / Collision / Metadata
```

Source：

```text
IFC
RVT
DWG
DGN
STEP
CAD
DCC
Point Cloud
Photogrammetry
```

Runtime：

```text
3D Tiles
GLB
KTX2
Collision Proxy
Kinematic Model
Metadata
Manifest
```

Runtime Asset 必须可重新生成。

---

# 43. Asset API 与 AssetLease

平台统一负责：

```text
Asset version
URL
cache
KTX2
Meshopt
Abort
Reference count
budget
```

Scene：

```ts
const lease =
  await ctx.assets.acquire(assetRef)
```

共享 Asset 不允许 Scene：

```ts
texture.dispose()
material.dispose()
```

Scene 只：

```text
lease.release()
```

。

---

# 44. 资源所有权模型

正式冻结：

```text
Owned
Leased
Borrowed
```

## Owned

Scene 自己 `new` 的资源：

```text
new THREE.Geometry
new THREE.Material
Worker
Canvas
```

Scene 负责 dispose。

---

## Leased

平台拥有：

```text
GLB
Texture
Geometry
shared Material
Content
```

Scene 获得 Lease。

---

## Borrowed

平台长期拥有：

```text
Map
Renderer
Camera
WorldSession
Site
THREE.Scene
```

Scene 禁止 dispose。

---

# 45. Scene 自建 Three Resource

Native-first 下，Scene：

```ts
const geometry = new THREE.BufferGeometry()
const material = new THREE.MeshStandardMaterial()
```

则 Scene 必须在 `unmount()`：

```ts
geometry.dispose()
material.dispose()
```

Three.js 官方明确说明 GPU-side geometry / material / texture / render target 需要应用显式释放；从场景图移除对象并不会自动释放这些资源。

平台不在 V1 引入魔法 Resource Tracker。

通过：

```text
Scene Compliance Test
```

验证 Scene 是否泄漏。

---

# 46. SceneEngine

内部推荐：

```text
SceneEngine
├── CameraSystem
├── ReferenceFrameSystem
├── TilesSystem
├── EntitySystem
├── RepresentationSystem
├── PickingSystem
├── EnvironmentSystem
├── EffectSystem
├── ResourceManager
└── Diagnostics
```

避免：

```text
CameraManager
PickingManager
LodManager
WaterRuntime
TwinObjectManager
```

等名词泛滥。

命名原则：

```text
Engine
→ 长生命周期执行引擎

System
→ Engine 子系统

Manager
→ 真正复杂的资源所有权管理

Registry
→ 定义目录

Adapter
→ 第三方库适配

Lease
→ 共享资源使用权

Ref
→ 稳定身份
```

---

# 47. Representation

同一个 EntityRef 可以有不同表现：

```text
SHIP-003
├── MapLibre Symbol
├── Globe Point
├── Billboard
├── Low GLB
└── High GLB
```

业务对象不变。

变化的是：

```text
Representation
```

Semantic Representation 与 Geometry LOD 区分：

```text
Point → Billboard → GLB
=
Semantic Representation

GLB LOD0 / LOD1 / LOD2
=
Geometry LOD
```

---

# 48. 3D Tiles Runtime

Scene 禁止：

```ts
new TilesRenderer(...)
```

3D Tiles 统一由：

```text
SceneEngine
└── TilesSystem
```

管理。

原因：

- ReferenceFrame；
- Tile cache；
- Download queue；
- Parsing queue；
- Byte budget；
- Site lifecycle；
- Diagnostics；
- Dispose。

---

# 49. 3D Tiles Cache Domain

V1 只定义：

```text
GlobalTileCache

ActiveSiteTileCache
```

不要现在设计：

```text
Per Scene
Per Building
Per Zone
```

等复杂 Cache topology。

当前 3DTilesRendererJS 已支持按 item / byte 约束缓存，并允许多个 TilesRenderer 共享部分 cache / queue，因此平台必须显式控制这些策略，不能依赖第三方默认行为。

---

# 50. Tiles Diagnostics

至少：

```text
cachedBytes
maxBytes
isFull
loadProgress

queued
downloading
parsing
loaded
visible
active
failed
```

达到 hard byte cap 后可能影响继续细化，因此必须可诊断。

---

# 51. Environment / Water

Environment 属于 SceneEngine 基础能力：

```text
EnvironmentSystem
├── Atmosphere
├── Lighting
├── Weather
└── Water
```

水体状态与视觉分开：

```text
Water State
≠
Water Rendering
```

Water State：

```text
level
vertical datum
current
wave
turbidity
```

表现可按质量 Profile：

```text
LOW
STANDARD
HIGH
EXHIBITION
```

逐步增加：

```text
Gerstner
Normal
Fresnel
Reflection
Foam
Wake
SSR
Planar reflection
```

---

# 52. MapEngine

MapEngine 管理：

- MapLibre 生命周期；
- Host base style；
- Host base sources；
- Map canvas；
- WebGL context；
- View sync；
- suspend / resume；
- diagnostics。

Scene 直接使用原生 MapLibre API。

不要重造 MapLibre Style API。

---

# 53. Map / Graphics Engine 生命周期

公开只要求 Scene 按需：

```ts
await ctx.map?.use()
await ctx.graphics?.use()
```

内部 Engine 状态尽量简单：

```text
UNINITIALIZED
ACTIVE
SUSPENDED
DISPOSED
```

不要增加：

```text
WARM
COLD
IDLE
BACKGROUND
PAUSED
```

等过多公共状态。

---

# 54. 2D / 3D 动态切换

同一个 Scene：

```text
Production Scene
     │
     ├── Map
     └── Graphics
```

切换：

```text
Map → 3D → Map
```

期间：

```text
Scene 不 unmount
WorldSession 不变
Selection 不变
Time 不变
业务 Store 不变
数据订阅不全量重建
```

。

---

# 55. ViewState

不要用一个 Camera 类型强行统一 MapLibre 与 Three。

```ts
type ViewState =
  | MapViewState
  | SceneViewState
```

二维：

```ts
interface MapViewState {
  kind: 'map'
  center: GeodeticPosition
  zoom: number
  bearingRadians: number
  pitchRadians: number
}
```

三维：

```ts
interface SceneViewState {
  kind: 'scene'
  target: GeodeticPosition
  rangeMeters: number
  headingRadians: number
  pitchRadians: number
  rollRadians: number
}
```

跨引擎使用：

```ts
interface ViewTarget {
  target: GeodeticPosition
  scaleMeters?: number
  headingRadians?: number
}
```

---

# 56. ViewApi

```ts
interface ViewApi {
  focus(
    entity: EntityRef
  ): Promise<void>

  goToSite(
    siteId: SiteId
  ): Promise<void>

  getTarget():
    ViewTarget | undefined

  setTarget(
    target: ViewTarget
  ): Promise<void>
}
```

不使用 `NavigationApi`，避免与“行车导航”业务语义冲突。

Scene-specific：

```text
Deck Plan
P&ID
CAD
Dashboard
```

全部属于 Scene 私有，不进入 ViewApi。

---

# 57. Selection

Selection 属于 Application / World context，而不是 Engine。

```ts
interface Selection {
  primary?: EntityRef
  secondary: EntityRef[]
}
```

2D 选中：

```text
CRANE-003
```

切 3D 后仍然：

```text
CRANE-003
```

。

禁止：

```text
MapSelection
ThreeSelection
```

两份业务状态。

---

# 58. Portal 与 Standalone

同一个 Scene 必须能够：

```text
Portal
✓

Standalone
✓

Test Host
✓
```

Scene 源码不修改。

Scene 禁止假定：

```text
Portal Router
Portal Sidebar
Portal Pinia
特定 DOM ID
```

存在。

---

# 59. Standalone App

例如：

```text
apps/standalone/stack-yard
```

main.ts 理想上只做：

```text
创建 Foundation
创建 SceneHost
加载 StackYard Scene
mount
```

Stack Yard 业务仍然只存在：

```text
scenes/stack-yard
```

没有：

```text
stack-yard-portal
stack-yard-standalone
```

两套业务源码。

---

# 60. Portal Scene Panel

Portal：

```text
ScenePanel
↓
SceneCoordinator
↓
SceneDefinition
↓
SceneHost
```

Scene Panel 可以提供：

```text
全球船舶
堆位地图
行车导航
生产数字孪生
安全态势
仿真分析
```

用户无需知道 Scene 是：

```text
2D
3D
Embedded
Standalone-capable
```

。

---

# 61. Scene Code Preload

允许：

```text
hover / predicted navigation
↓
prefetch Scene JS chunk
```

。

区分三种成本：

```text
Code Preload
Engine Warm-up
World Content Load
```

不要因为 hover：

```text
Production
```

就开始加载全部 3D Tiles / GLB。

---

# 62. CSS 与 Vue 生命周期

## App-level Pinia

只保存：

```text
User
WorldSession
Active Scene
Global Selection
Portal shell
```

## Scene state

优先：

```text
local reactive
composable
Vue effectScope
```

Scene Pinia Store 必须在 Scene unmount：

```text
reset
dispose
```

。

---

## CSS

Scene 禁止：

```css
button {}
.panel {}
h1 {}
```

推荐：

```text
Vue scoped CSS
CSS Modules
Scene root namespace
```

防止动态 Scene 之间污染。

---

# 63. Native MapLibre Cleanup

Scene 直接调用：

```text
map.addSource
map.addLayer
map.on
```

Scene 就必须清理：

```text
removeLayer
removeSource
off
```

。

V1 不重造“自动管理版 MapLibre API”。

如未来重复问题明显，再提供 optional helper：

```text
MapResourceScope
```

但不作为核心架构。

---

# 64. Render 性能原则

固定：

```text
2D-only
→ 不加载 Three

3D
→ lazy SceneEngine

Inactive Engine
→ suspend

Realtime
→ state buffer

Render
→ frame-boundary batch

Hot path
→ low allocation

Shared resource
→ lease

Scene switch
→ abortable

Tiles
→ explicit budget
```

---

# 65. Frame Hot Path

热点中避免：

```ts
new Vector3()
new Matrix4()
array.map()
array.filter()
object spread
```

。

使用：

```text
reusable temp objects
TypedArray
object pool（仅必要位置）
```

。

只要求：

- Spatial update；
- Representation update；
- Picking；
- animation；
- high-frequency simulation；

不要牺牲普通业务代码可读性。

---

# 66. Split View

Map + Three 同时 ACTIVE 时：

```text
WorldClient
     │
Shared State
     │
 ┌───┴───┐
Map    Graphics
```

世界状态只有一份。

两个 Engine 只维护各自 Representation。

副视窗可以：

```text
低刷新率
event-driven
reduced quality
```

降低双 WebGL2 Context 开销。

---

# 67. Quality Profile

推荐：

```text
OFFICE
STANDARD
HIGH
EXHIBITION
```

统一决定：

```text
pixel ratio
tile budget
texture budget
shadow
water
reflection
postprocessing
representation threshold
```

Scene 禁止：

```ts
if (lowGpu) ...
```

。

质量策略属于 Engine。

---

# 68. Adaptive Quality

根据：

```text
device probe
p95 frame time
resource pressure
```

动态：

```text
降低 SSR
降低 reflection
降低 shadow
增加 tile SSE
降低 pixel ratio
```

优先保留：

```text
核心船舶
关键设备
交互
基本水体可信度
```

优先牺牲：

```text
cloud
高级 reflection
远距离 shadow
重型 post FX
```

。

---

# 69. 性能指标

不要只看 FPS。

至少：

```text
p50 frame time
p95 frame time

CPU update
GPU render

draw calls
triangles
visible instances

tiles cache bytes
asset estimate bytes
texture count
geometry count
render target count

JS heap
subscriptions
frame callbacks
```

。

---

# 70. 初始 PoC 性能目标

以下是工程基线，不是永久 SLA。

## 办公终端

```text
2560 × 1440
典型 Site 数字孪生
目标 ≥ 30 FPS
p95 frame time 目标 ≤ 33ms
```

## 高性能展示终端

```text
4K
重点场景目标 ≥ 45 FPS
核心演示镜头争取 60 FPS
```

最终以公司定义的 Reference Hardware 为准。

---

# 71. 内存验收：Plateau，而非 Zero

Scene / Site 循环：

```text
Global
→ Site A
→ Global
→ Site B
→ Global
```

或者：

```text
Production
→ Stack Yard
→ Production
```

重复 20 次。

健康：

```text
760MB
771MB
768MB
```

不健康：

```text
760
900
1050
1250
```

。

Three 内部缓存可能导致 `renderer.info.memory` 不完全归零，因此重点是趋稳而非归零。

---

# 72. Scene Compliance Test

每个 Scene 进入 Portal Catalog 前必须：

```text
mount
↓
run
↓
unmount
```

循环。

检查：

```text
Data subscriptions
Vue effects
DOM nodes
Timers
Workers

Asset leases

Map layers
Map sources
Map listeners

Three geometry
Three texture
RenderTargets
Frame callbacks
```

Scene-owned：

```text
必须回到 baseline
```

共享 Engine cache：

```text
允许保留
但必须 plateau
```

。

---

# 73. 2D / 3D Toggle Stress

Production Scene：

```text
mount once

2D
↓
3D
↓
2D
↓
3D
...
100 次

unmount once
```

验证：

```text
Scene 不重挂
Selection 一致
WorldSession 一致
Map listeners 稳定
WebGL context count 稳定
Tiles cache 稳定
Asset leases 稳定
```

。

---

# 74. Scene Switch Stress

```text
Global Ships
↓
Stack Yard
↓
Production
↓
Navigation
↓
Simulation
↓
Production
```

循环。

验证：

```text
Last selection wins
旧加载 abort
旧 context revoked
旧 Scene 资源清理
Engine cache plateau
Router 正确
```

。

---

# 75. Context Loss

GPU Context 是可丢失资源，不是 World Truth。

```text
WorldSession
业务 State
Scene State
```

不依赖 GPU context。

Context 恢复：

```text
World Truth
↓
重新建立 Representation
```

Scene 不需要重新请求全部业务真值。

---

# 76. Architecture Tests

CI 强制检查依赖方向。

禁止：

```text
world → Vue
world → Three
world → MapLibre

spatial → Three
spatial → MapLibre

Foundation → scenes

Scene → engine internal
Scene → world internal
```

Native-first 下：

```text
Scene → three
Scene → maplibre-gl
```

允许，但必须遵守 ownership 规范。

禁止：

```text
Scene → @twin/scene-engine/src/internal/*
```

。

---

# 77. Package Exports

所有 Foundation package 只公开：

```json
{
  "exports": {
    ".": "./src/public.ts"
  }
}
```

禁止依赖 internal path。

架构边界必须：

> **由工具链 enforce，而不是只靠文档。**

---

# 78. Third-party Dependencies

生产核心依赖：

```text
three
maplibre-gl
3d-tiles-renderer
```

使用 exact pin。

升级必须运行：

```text
Golden Scene
Visual Regression
Performance Regression
Memory Cycle
Tiles Lifecycle
2D/3D Toggle
Scene Compliance
```

。

---

# 79. WebGPU

V1：

```text
WebGL2 production
```

WebGPU：

```text
独立 Lab / Spike
```

不引入：

```text
RendererBackend abstraction
```

去重写 Three。

Three 的 WebGPURenderer 当前仍属于 experimental 演进路线，同时带有 TSL / Node Material 等不同技术体系，因此不应让 V1 架构被提前迁移需求绑架。

---

# 80. Security

当前 Scene 定位：

```text
Trusted Internal Code
```

不是第三方 Plugin Sandbox。

因此允许 Native Three / MapLibre。

如果未来需要加载不可信 Remote Scene：

必须另建：

```text
iframe / Worker
CSP
RPC
package signing
```

机制。

不要误认为 SceneContext 就是安全 Sandbox。

---

# 81. OT / IT 边界

Browser 禁止：

```text
直接连接 PLC
直接连接厂区 OT MQTT
直接执行设备控制
```

链路：

```text
OT
↓
Gateway
↓
Platform Data Layer
↓
WorldClient
↓
Scene
```

Command：

```text
Scene
↓
Business Command Service
↓
Authorization
↓
Audit
↓
Safety
↓
OT Gateway
```

。

---

# 82. Scene 与 Domain

Scene 内部结构完全私有。

例如：

```text
scenes/production/

  entry.ts
  domain/
  data/
  map/
  graphics/
  ui/
```

只是该 Scene 自己的选择。

Foundation 不规定 Scene project structure。

跨 Scene 复用：

```text
domains/crane
domains/vessel
domains/agv
```

但 Domain Library 不自动进入 Foundation。

---

# 83. 三个 Architecture Spike

## A. Stack Yard

```text
2D 核心
MapLibre polygon / label / feature-state
optional 3D
分段堆叠 / 高度 / 姿态
```

验证：

```text
Map-only cold start
2D → 3D lazy load
Selection continuity
3D → 2D
Asset eviction
```

---

## B. Production Twin

```text
2D + 3D
Large Site
3D Tiles
Ship / Crane / AGV
High-frequency data
Live / History / Simulation
Water
```

验证：

```text
World state single source
Split view
3D Tiles cache
High-frequency fast path
Long-running mount
```

---

## C. Heavy Transport / Lifting

```text
2D route planning
3D risk inspection
collision
kinematic
physics
simulation preview
```

验证：

```text
Site local physics
visual/collision asset separation
scene-private simulation
world-level simulation boundary
```

三个 Spike 已覆盖大多数最难的技术组合。

---

# 84. 船舶制造典型 Scene 支持矩阵

| Scene | 2D | 3D | History | Simulation | Standalone |
|---|---:|---:|---:|---:|---:|
| 全球船舶 | ✓ | ✓ | ✓ | - | ✓ |
| 行车导航 | ✓ | 可选 | - | - | ✓ |
| 堆位地图 | ✓ | ✓ | ✓ | - | ✓ |
| 生产数字孪生 | ✓ | ✓ | ✓ | ✓ | ✓ |
| AGV 调度 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 分段堆场 | ✓ | ✓ | ✓ | - | ✓ |
| 龙门吊作业 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 大件运输 | ✓ | ✓ | - | ✓ | ✓ |
| 吊装仿真 | 辅助 | ✓ | - | ✓ | ✓ |
| 船坞生产 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 下水 / 出坞 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 码头舾装 | ✓ | ✓ | ✓ | 可选 | ✓ |
| 安全管理 | ✓ | ✓ | ✓ | 可选 | ✓ |
| 能源管理 | ✓ | ✓ | ✓ | 可选 | ✓ |
| 应急指挥 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 靠离泊仿真 | ✓ | ✓ | - | ✓ | ✓ |

没有发现需要引入新的 Foundation 大概念才能支持的关键 Scene。

---

# 85. Non-goals v1

明确不做：

```text
Universal Renderer API

Universal GIS API

Universal Twin Entity Schema

Scene DSL

Business DSL

Low-code Scene Builder

Plugin Marketplace

Remote JS Plugin Runtime

Microfrontend Platform

Global EventBus

Global ResourceManager

Scene Dependency Graph

Engine Metadata DSL

Foundation God Object

自研通用 3D 文件格式

自研通用 GIS Engine
```

并明确：

```text
不采用 Cesium 作为当前核心技术路线。
```

---

# 86. 核心 Glossary

| 名称 | 含义 |
|---|---|
| Foundation | 底座架构集合 |
| World | 逻辑数字世界 |
| Site | 厂区 / 港区 / 基地 |
| WorldSession | 当前世界上下文 |
| WorldScope | Global / Site / Entity |
| EntityRef | 稳定对象身份 |
| Spatial | 空间核心 |
| ReferenceFrame | 空间参考系 |
| Pose | 位置和姿态 |
| SpatialAnchor | 对象空间锚定 |
| Asset | 可复用数字资产 |
| WorldContent | Asset 如何进入世界 |
| WorldClient | 世界状态客户端 |
| MapEngine | MapLibre 2D Engine |
| SceneEngine | Three 3D Engine |
| SceneDefinition | Application 场景描述 |
| SceneEntry | Scene 程序入口 |
| SceneMount | 一次 Scene 运行实例 |
| SceneContext | Scene 获得的 Foundation 能力 |
| SceneHost | Scene 生命周期宿主 |
| SceneCoordinator | Portal 的 Scene 切换编排 |
| ViewState | 空间观察状态 |
| ViewTarget | 2D / 3D 中性观察目标 |
| ViewApi | 空间观察控制 |
| AssetLease | 共享 Asset 使用权 |

除非真实实现出现新需求，不再主动创造新的架构词汇。

---

# 87. 开发阶段

## Phase 0 — Skeleton

完成：

```text
Monorepo
Vue Portal
SceneDefinition
SceneHost
SceneContext
MapEngine lazy loader
SceneEngine lazy loader
```

第一验证：

```text
Stack Yard Scene
mount
↓
MapLibre
↓
unmount
```

。

---

## Phase 1 — Spatial Core

完成：

```text
WGS84
ECEF
ReferenceFrame
Site ENU
Vertical Datum
ViewTarget
Map ↔ 3D transform
```

Hello World：

```text
真实 WGS84 对象
↓
Map
↓
3D Globe
↓
Site Frame
↓
近距离
```

位置不跳变。

---

## Phase 2 — Architecture Spike

正式实现：

```text
Stack Yard
Production Twin
Heavy Transport / Lifting
```

三个差异最大的 Scene。

---

## Phase 3 — Resource / Asset

完成：

```text
Asset Manifest
AssetLease
GLB
KTX2
3D Tiles
Tiles Cache Domain
Resource Diagnostics
```

。

---

## Phase 4 — Realtime

完成：

```text
WorldClient
Snapshot
Delta
Reconnect
Quality
Spatial Fast Path
```

。

---

## Phase 5 — World Modes

完成：

```text
Live
History
Simulation
```

。

---

## Phase 6 — Performance / Stability

完成：

```text
Golden Scene
Scene Compliance
Mount/unmount stress
2D/3D toggle
Site switch
Context loss
Memory plateau
4K benchmark
```

。

---

# 88. Architecture Review Checklist

正式评审必须回答：

### Architecture

- Scene 是否只通过稳定契约访问 Foundation？
- SceneDefinition 是否保持极薄？
- 是否出现 God Foundation / Platform package？
- Scene 是否能 Portal / Standalone 双运行？
- 2D / 3D 是否正交于 Scene？

### Native Engine

- 是否避免重复封装 Three / MapLibre？
- Scene 是否只拥有自己的 Three root？
- Scene 是否禁止接管 Renderer lifecycle？
- MapLibre Scene-owned layer/source 是否可清理？

### Spatial

- WGS84 / ECEF / Site ENU 是否分层？
- ReferenceFrame 是否明确？
- Vertical Datum 是否明确？
- 是否存在业务手工移动模型“对齐”的情况？

### Asset

- Static / Dynamic 是否分离？
- Asset 与 WorldContent 是否分离？
- Shared Asset 是否使用 Lease？
- Scene 是否错误 dispose shared texture/material？

### Memory

- Scene mount/unmount 是否可重复？
- Context 是否 revoke？
- Abort 是否生效？
- Vue watchers 是否清理？
- Map layers/listeners 是否清理？
- Native Three resources 是否 dispose？
- Cache 是否 plateau？

### Performance

- 2D-only 是否真正不加载 Three？
- 3D 是否 lazy load？
- 高频数据是否避开 Vue reactive？
- Realtime 是否通过 State Buffer？
- Render Loop 是否唯一？
- Split 模式是否降低副 View 成本？
- Tiles cache 是否显式预算？

### Extensibility

- 新 Scene 是否无需修改 Foundation？
- Scene 是否没有相互 runtime dependency？
- 跨 Scene 代码是否进入 Domain Library，而不是 Foundation？
- Engine 新特性是否能直接使用 Native API？

---

# 89. Architecture Freeze Gate

满足以下条件后正式冻结：

```text
1. Stack Yard Scene
   Portal + Standalone 通过

2. Production Scene
   2D ↔ 3D 100次切换通过

3. Heavy Transport Scene
   Map + 3D + Physics Spike 通过

4. Scene mount/unmount stress
   无增长性 leak

5. Site A / Site B 循环
   Tiles / asset cache plateau

6. Scene source
   无 Foundation internal deep import

7. 2D-only build
   不包含 Three runtime

8. World / Spatial package
   不依赖 Vue / Three / MapLibre
```

达到后：

> **Architecture Freeze v1.2 — Approved**

---

# 90. 最终架构哲学

整个系统最终只需要记住：

## 第一层

> **World 定义有什么。**

## 第二层

> **Spatial 定义在哪里。**

## 第三层

> **Scene 定义业务含义与体验。**

## 第四层

> **Engine 定义如何观察。**

## 第五层

> **Host 定义生命周期。**

同时：

> **Foundation owns facts and capabilities.**

> **Scene owns business and experience.**

> **App owns composition and deployment.**

> **Host owns lifecycle and isolation.**

> **Wrap platform semantics, expose engines.**

这构成当前船舶制造数字孪生平台的正式开发基线。

---

# Appendix A — 技术事实基线（2026-09）

以下仅作为当前工程判断依据，版本升级时重新验证。

## Three.js Resource Lifecycle

Three.js geometry、material、texture、render target 等 GPU 资源需要显式 `dispose()`；从 Scene Graph 移除对象并不代表 GPU 资源自动释放。

参考：

- https://threejs.org/manual/en/how-to-dispose-of-objects.html

## Three WebGPU

Three.js `WebGPURenderer` 已提供 WebGPU 优先 / WebGL2 fallback、TSL / Node Material 等能力，但官方仍标记为 experimental；V1 因此使用 WebGLRenderer/WebGL2，WebGPU 独立验证。

参考：

- https://threejs.org/manual/en/webgpurenderer

## MapLibre GL JS

MapLibre GL JS v6 使用 ESM，并要求 WebGL2。

参考：

- https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/

## 3DTilesRendererJS Cache

当前 API 支持按 item 和 bytes 管理 LRU cache，包括 `maxBytesSize` / `cachedBytes` 等能力。平台必须显式定义 Tile Cache Policy，而不是依赖默认策略。

参考：

- https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/src/core/renderer/API.md

---

# Appendix B — 决策摘要

| 决策 | 结论 |
|---|---|
| Vue | 采用 |
| MapLibre | 保留，专业 2D GIS |
| Three.js | 核心 3D Engine |
| 3DTilesRendererJS | 采用，封装在 TilesSystem |
| SceneDefinition.engines | 删除 |
| Scene 内部结构 | Foundation 不建模 |
| Scene Deployment | Portal + Standalone |
| Scene 2D/3D | 同一 Scene 动态切换 |
| Three API | 可信 Scene 原生开放 |
| MapLibre API | 可信 Scene 原生开放 |
| Platform Wrapper | 只封装平台语义 |
| Render Loop | SceneEngine 唯一所有 |
| Shared Asset | Lease |
| Scene native resource | Scene 自己 dispose |
| 3D Tiles cache | Platform 显式控制 |
| WebGPU | V1 非生产默认 |
| Universal Renderer API | 不做 |
| Scene DSL | 不做 |
| Remote Plugin | V1 不做 |
| Cesium | 当前路线不采用 |

---

# Appendix C — 最小 Scene 示例

```ts
// scenes/stack-yard/entry.ts

import type {
  SceneEntry,
  SceneContext,
  SceneMount
} from '@twin/sdk'

const entry: SceneEntry = {
  async mount(ctx: SceneContext): Promise<SceneMount> {
    const mapContext = await ctx.map!.use()
    const map = mapContext.instance

    const sourceId = 'stack-yard:stacks'
    const layerId = 'stack-yard:stack-fill'

    map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: []
      }
    })

    map.addLayer({
      id: layerId,
      type: 'fill',
      source: sourceId
    })

    const subscription = ctx.data.subscribe(/* contract */)

    return {
      async unmount() {
        subscription.dispose()

        if (map.getLayer(layerId)) {
          map.removeLayer(layerId)
        }

        if (map.getSource(sourceId)) {
          map.removeSource(sourceId)
        }
      }
    }
  }
}

export default entry
```

---

# Appendix D — 最小 3D Scene 示例

```ts
// scenes/production/graphics.ts

import * as THREE from 'three'
import type {
  SceneContext,
  GraphicsContext
} from '@twin/sdk'

export async function mountGraphics(
  ctx: SceneContext,
  graphics: GraphicsContext
) {
  const geometry =
    new THREE.BoxGeometry(1, 1, 1)

  const material =
    new THREE.MeshStandardMaterial()

  const mesh =
    new THREE.Mesh(
      geometry,
      material
    )

  graphics.root.add(mesh)

  const frameTask =
    graphics.onFrame(({ deltaSeconds }) => {
      mesh.rotation.y +=
        deltaSeconds * 0.1
    })

  return {
    dispose() {
      frameTask.dispose()

      graphics.root.remove(mesh)

      geometry.dispose()
      material.dispose()
    }
  }
}
```

核心思想：

```text
Three 操作
→ Native Three

Scene lifetime
→ SceneHost

Shared asset
→ AssetLease

Render loop
→ SceneEngine
```

至此，平台不需要重新发明 Three.js。
