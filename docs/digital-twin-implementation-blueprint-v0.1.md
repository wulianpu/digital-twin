# 船舶制造数字孪生平台实施蓝图

> **Implementation Blueprint v0.1**  
> 基线：Architecture Freeze v1.2  
> 目标：从架构冻结进入可执行开发阶段

---

# 1. 实施目标

本阶段不再继续增加架构概念，而是验证并实现以下最小闭环：

```text
Portal
  ↓
Scene Panel
  ↓
SceneCoordinator
  ↓
SceneHost
  ↓
SceneEntry.mount()
  ↓
SceneContext
  ↓
World / Spatial / Data / Asset / View
  ↓
MapEngine / SceneEngine（按需）
```

必须首先证明：

1. Scene 可以在 Portal 动态加载 / 卸载；
2. 同一 Scene 可以在 Standalone 中零修改运行；
3. 2D-only Scene 不加载 Three；
4. 同一 Scene 可按需进入 3D；
5. Scene 切换后无明显 JS / GPU / Listener / Subscription 泄漏；
6. World / Spatial 不依赖 Vue / Three / MapLibre；
7. Scene 可直接使用原生 MapLibre / Three API；
8. Host 能保证生命周期、隔离和错误恢复。

---

# 2. 第一阶段优先级

开发顺序严格建议：

```text
M0 Repository + Architecture Rules
        ↓
M1 Scene Contract + SceneHost
        ↓
M2 MapEngine + Stack Yard Scene
        ↓
M3 Spatial Core
        ↓
M4 SceneEngine + 2D/3D Toggle
        ↓
M5 Production Twin Spike
        ↓
M6 Content / Asset Lease / 3D Tiles
        ↓
M7 WorldClient / Realtime
        ↓
M8 Heavy Transport / Lifting Spike
        ↓
M9 Memory / Performance Hardening
```

不要优先做：

```text
水面特效
高级Shader
复杂资产平台
低代码
远程插件
WebGPU
完整仿真平台
```

---

# 3. Monorepo 初始结构

```text
repo/

├── apps/
│   ├── portal/
│   │   └── src/
│   │       ├── application/
│   │       │   ├── scene-catalog/
│   │       │   ├── scene-coordinator/
│   │       │   └── workspace/
│   │       ├── router/
│   │       ├── stores/
│   │       └── ui/
│   │
│   └── standalone/
│       ├── stack-yard/
│       ├── production/
│       └── heavy-transport/
│
├── scenes/
│   ├── stack-yard/
│   ├── production/
│   └── heavy-transport/
│
├── domains/
│   ├── yard/
│   ├── crane/
│   ├── agv/
│   └── logistics/
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
├── tooling/
│   ├── architecture-tests/
│   ├── benchmarks/
│   ├── scene-compliance/
│   ├── visual-regression/
│   └── asset-pipeline/
│
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.base.json
```

---

# 4. Workspace / Package 规则

推荐：

```text
pnpm workspace
```

要求：

- 所有 package 使用 TypeScript strict；
- package 只通过 public exports 暴露 API；
- 禁止跨 package deep import；
- Scene 允许依赖 `three` / `maplibre-gl`，但禁止依赖 engine internal；
- `world` / `spatial` 禁止 DOM / Vue / Three / MapLibre；
- `sdk` 不持有业务逻辑；
- `apps` 是唯一 Composition Root。

---

# 5. TypeScript 基础策略

推荐开启：

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true
  }
}
```

核心 Identity 建议 branded：

```ts
export type SceneId =
  string & { readonly __brand: 'SceneId' }

export type SiteId =
  string & { readonly __brand: 'SiteId' }

export type WorldId =
  string & { readonly __brand: 'WorldId' }

export type AssetId =
  string & { readonly __brand: 'AssetId' }
```

不要给所有数值都做 branded type。

单位通过命名优先表达：

```ts
heightMeters
headingRadians
longitudeDegrees
latitudeDegrees
```

---

# 6. `@twin/sdk` 第一版

目标：

> 极薄、稳定、好用。

建议 public API：

```ts
export type {
  SceneDefinition,
  SceneEntry,
  SceneMount,
  SceneContext,

  WorldApi,
  SpatialApi,
  DataApi,
  SelectionApi,
  ViewApi,
  AssetApi,
  UiApi,

  MapAccess,
  MapContext,
  GraphicsAccess,
  GraphicsContext,

  Disposable
}
```

不要在 v1 暴露：

```text
ResourceManager
TilesSystem
EngineRegistry
MountScope
SceneEngine internals
WorldClient internals
```

---

# 7. Scene Contract

```ts
export interface SceneEntry {
  mount(
    context: SceneContext
  ): Promise<SceneMount>
}

export interface SceneMount {
  unmount():
    void | Promise<void>
}
```

第一原则：

> SceneEntry 应尽量无状态。

一次实际运行实例的状态属于 SceneMount / Scene 内部闭包。

---

# 8. SceneDefinition

Application 层定义：

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

禁止增加：

```text
engines
layers
topics
assets
camera
water
simulation
```

等内部实现字段。

---

# 9. SceneContext

第一版建议：

```ts
export interface SceneContext {
  readonly sceneId: SceneId

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

所有 SceneContext API 必须满足：

```text
mount active
→ usable

unmount begins
→ no new resource creation

unmount completed
→ revoked
```

---

# 10. `SceneHost` 第一版

推荐内部模型：

```text
SceneHost
│
├── current mounts
│
└── mount(entry)
      │
      ├── create AbortController
      ├── create MountScope
      ├── create ScopedContext
      ├── entry.mount(ctx)
      └── return HostSceneMount
```

---

# 11. MountScope

MountScope **仅内部存在**。

职责跟踪通过 Foundation Context 创建的：

```text
Data subscription
UI mount
Asset lease
Map helper resources（如果未来有）
Graphics frame callback
Host listeners
```

不跟踪 Scene 自己直接 `new THREE.*` 的对象。

Scene 自建原生 GPU 资源仍由 Scene 自己 dispose。

---

# 12. HostSceneMount

```ts
class HostSceneMount implements SceneMount {
  #state:
    | 'active'
    | 'unmounting'
    | 'unmounted'

  async unmount() {
    if (this.#state === 'unmounted') return
    if (this.#state === 'unmounting') {
      return this.#unmountPromise
    }

    this.#state = 'unmounting'

    // 1. close context for new resource creation
    // 2. abort()
    // 3. sceneMount.unmount()
    // 4. MountScope.dispose()
    // 5. revoke context
    // 6. state = unmounted
  }
}
```

---

# 13. Scene Unmount Deadline

建议 Host 允许配置：

```ts
sceneUnmountTimeoutMs
```

第一版建议：

```text
3~5 秒
```

超时：

```text
log error
continue host-owned cleanup
mark scene faulty
```

不能因为业务 Scene cleanup 错误永久卡死 Portal。

---

# 14. SceneContext Revocation

开发环境：

```text
Scene unmount 后继续调用 Context
→ throw SceneUnmountedError
```

生产环境：

```text
log once
ignore / reject
```

关键 API：

```text
data.subscribe
assets.acquire
ui.mount
map.use
graphics.use
```

都必须检查 Context 生命周期。

---

# 15. Portal SceneCatalog

```ts
export const sceneCatalog: readonly SceneDefinition[] = [
  stackYardScene,
  productionScene,
  heavyTransportScene
]
```

第一版直接静态注册即可。

不要：

```text
remote registry
plugin discovery
server-driven JS manifest
```

。

---

# 16. SceneCoordinator

职责：

```text
active scene
loading scene
route sync
permission
load()
mount()
unmount()
rollback
```

不负责：

```text
MapLibre
Three
WorldClient
GPU resources
```

。

---

# 17. SceneCoordinator 状态机

建议：

```text
IDLE
LOADING
SWITCHING
ACTIVE
ERROR
```

内部维护：

```ts
interface ActiveScene {
  definition: SceneDefinition
  mount: SceneMount
}
```

---

# 18. Last Selection Wins

每次：

```ts
switchTo(sceneId)
```

生成：

```text
generation number
+
AbortController
```

如果新 switch 到来：

```text
旧 generation 立即失效
```

旧 loader / mount 完成后不得 commit。

---

# 19. Portal 切换策略

建议第一版：

```text
1. load target code
2. ensure target can start
3. unmount current
4. mount target
5. commit
```

如果 target mount 失败：

```text
attempt remount previous scene
```

Portal 提供统一 Error Page / Error Panel。

---

# 20. Standalone Host

Standalone 不使用 SceneCoordinator。

例如：

```ts
const entry =
  await productionScene.load()

const mount =
  await sceneHost.mount(entry)
```

同一个 Scene 必须：

```text
Portal
Standalone
Test Host
```

零源码修改运行。

---

# 21. `MapEngine` 第一版职责

```text
MapEngine
├── lazy create MapLibre.Map
├── canvas / container
├── base style ownership
├── base source/layer ownership
├── resize
├── suspend/resume
├── diagnostics
└── dispose
```

不包装：

```text
addLayer
addSource
setPaintProperty
setFeatureState
```

等 MapLibre 原生 API。

---

# 22. MapAccess

推荐：

```ts
export interface MapAccess {
  use(): Promise<MapContext>
}

export interface MapContext {
  readonly instance: Map
}
```

`use()` 第一次被调用时：

```text
dynamic import map-engine
↓
create MapEngine
↓
create MapLibre
↓
return MapContext
```

如果 Application 是 3D-only：

```text
ctx.map === undefined
```

。

---

# 23. `SceneEngine` 第一版职责

```text
SceneEngine
├── renderer
├── renderScene
├── SceneMountRoot
├── CameraSystem
├── ReferenceFrameSystem
├── TilesSystem
├── EnvironmentSystem
├── render loop
├── diagnostics
└── resource policy
```

不要第一版就完整实现：

```text
复杂 EntitySystem
复杂 RepresentationSystem
高级 EffectSystem
```

Spike 中真实重复后再抽。

---

# 24. GraphicsAccess

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

第一次 `use()`：

```text
dynamic import scene-engine
↓
dynamic import Three stack
↓
create SceneEngine
↓
create SceneMountRoot
```

。

---

# 25. SceneMountRoot

每个 SceneMount：

```text
THREE.Scene
├── BaseWorldRoot
└── SceneMountRoot(<mountId>)
```

Scene 原生 Three 对象挂在：

```text
SceneMountRoot
```

下。

unmount：

```text
detach root
```

但 detach 不等于 dispose Scene 自建 GPU resources。

---

# 26. Native Three 资源规则

Scene：

```ts
const geometry =
  new THREE.BufferGeometry()

const material =
  new THREE.MeshStandardMaterial()
```

则 Scene 必须：

```ts
geometry.dispose()
material.dispose()
```

。

平台通过：

```text
Compliance test
Diagnostics
```

检测泄漏。

第一版不做 Magic Tracker。

---

# 27. Shared Asset 规则

使用：

```ts
const lease =
  await ctx.assets.acquire(assetRef)
```

Scene 不拥有底层 Texture / Geometry。

unmount：

```text
Host automatically releases tracked Lease
```

或者 Lease 由 Scene 手动 release，但 Host 作为最后兜底。

推荐：

> Foundation API 创建的 Lease 自动纳入 MountScope。

---

# 28. ViewApi 第一版

```ts
export interface ViewApi {
  getTarget():
    ViewTarget | undefined

  setTarget(
    target: ViewTarget
  ): Promise<void>

  focus(
    entity: EntityRef
  ): Promise<void>

  goToSite(
    siteId: SiteId
  ): Promise<void>
}
```

不暴露：

```text
MapLibre zoom
Three camera XYZ
```

为跨 Engine 公共协议。

---

# 29. Map ↔ Graphics 切换

同一个 Scene：

```text
map → graphics → map
```

Scene 不卸载。

Application / Scene UI 触发：

```ts
await ctx.map?.use()
await ctx.graphics?.use()
```

之后：

```text
当前主 View
```

由 Scene 或 Application 布局决定。

---

# 30. ViewTarget

```ts
export interface ViewTarget {
  target: GeodeticPosition

  scaleMeters?: number
  headingRadians?: number
}
```

Map View 与 Graphics View 通过 ViewTarget 做语义同步。

不要：

```text
MapLibre zoom → Three camera position
```

直接转换。

---

# 31. `@twin/world`

第一版只定义：

```text
WorldId
SiteId
EntityRef
WorldSession
WorldScope
WorldMode
WorldTime
Selection
```

禁止业务类型。

---

# 32. `WorldSession`

```ts
export interface WorldSession {
  worldId: WorldId

  mode:
    | 'live'
    | 'history'
    | 'simulation'

  scope: WorldScope

  time: WorldTime
}
```

不包含：

```text
Scene
ViewMode
Three
Map
```

。

---

# 33. `EntityRef`

```ts
export interface EntityRef {
  namespace: string
  id: string
}
```

示例：

```text
yard / STACK-A-001
production / CRANE-003
ais / IMO-1234567
```

。

---

# 34. `@twin/spatial`

第一阶段实现：

```text
Geodetic
ECEF
Site ENU
ReferenceFrame
ReferenceFrameGraph
Pose
SpatialAnchor
VerticalReference
ViewTarget conversion
```

必须纯 TypeScript / Math。

---

# 35. Spatial 第一批测试

必须包含：

```text
WGS84 → ECEF → WGS84

ECEF → Site ENU → ECEF

Global → Site → Global

longitude ±180

high latitude

large ECEF values

vertical reference conversions（至少接口与fixture）
```

。

---

# 36. 真实 Hello World

第一项 3D Spatial 验收：

```text
一个真实 WGS84 点
↓
MapLibre正确显示
↓
切 Three
↓
全球尺度正确显示
↓
飞近 Site
↓
切 Site ReferenceFrame
↓
对象屏幕位置不跳变
```

。

比“旋转 Cube”更重要。

---

# 37. `@twin/content`

第一阶段定义：

```text
AssetRef
AssetManifest
WorldContent
ContentManifest
AssetLease
```

不要第一版把完整 Asset Platform 塞进 package。

---

# 38. AssetManifest 初始模型

```ts
export interface AssetManifest {
  id: AssetId
  version: string

  kind:
    | 'gltf'
    | 'tileset'

  uri: string

  estimatedGpuBytes?: number
  estimatedCpuBytes?: number

  collision?: AssetRef
}
```

之后真实业务需要时再扩展。

---

# 39. Asset URL

使用不可变版本：

```text
/assets/crane/v42/model.glb
```

不要：

```text
/assets/crane/latest.glb
```

。

---

# 40. `@twin/world-client`

第一阶段只做：

```text
query
snapshot
subscribe
state cache
reconnect
quality
```

先用：

```text
JSON + WebSocket
```

不要第一阶段直接上复杂 binary protocol。

---

# 41. Data Contract

Scene / Domain 自己定义：

```ts
export const StackStateContract =
  defineContract<StackState>({
    id: 'yard.stack-state',
    version: 1
  })
```

Foundation 只理解：

```text
contract ID
version
time
revision
quality
payload
```

。

---

# 42. 高频 Spatial Fast Path

Architecture Spike B 才开始做。

触发条件：

```text
实际 profiling 证明 Object-based path 不够。
```

实现时：

```text
TypedArray
SoA
latest-value buffer
```

不要在 M0 就过度优化。

---

# 43. Stack Yard Spike

## 目标

验证：

```text
SceneHost
MapEngine
native MapLibre
Scene unmount cleanup
Standalone
Portal
optional 3D
```

。

---

## 第一版本

只做：

```text
1000~5000 堆位 polygon

状态：
empty
occupied
reserved
locked

Selection

Filter

Detail Panel
```

。

MapLibre：

```text
GeoJSON / Vector source
Feature State
Symbol
Fill
```

。

---

## 验收

```text
Portal mount
✓

Standalone mount
✓

unmount 后：
Map layer = baseline
Map source = baseline
Map listeners = baseline

反复 mount/unmount 100次
✓
```

。

---

# 44. Stack Yard 3D Spike

第二步：

```text
用户选择堆位
↓
点击 3D
↓
ctx.graphics.use()
↓
SceneEngine lazy load
```

只显示：

```text
Site base
selected stack
nearby segment models
```

。

验收：

```text
Three 仅第一次进入3D才下载

Scene mount 数量不变

Selection不变

回2D以后Scene仍活跃
```

。

---

# 45. Production Twin Spike

验证：

```text
Map + Graphics
3D Tiles
Dynamic GLB
Realtime
2D/3D
Split View
Long-lived Scene
```

对象：

```text
1 艘真实船
1 台真实龙门吊
50~200 AGV模拟
真实厂区 3D Tiles
```

先不要 1000 AGV。

---

# 46. Production 2D

显示：

```text
Site
ship
crane
AGV
production zone
alarm summary
```

。

---

# 47. Production 3D

进入：

```text
Site 3D Tiles
ship GLB
crane GLB
AGV representation
water baseline
```

。

Three Scene-owned objects全部：

```text
挂 SceneMountRoot
```

。

Site base content：

```text
SceneEngine owns
```

。

---

# 48. 3D Tiles 第一版

只需要：

```text
load one real tileset
camera integration
Site frame integration
cache diagnostics
dispose
```

。

暂时不要：

```text
多厂区背景 preload
复杂 metadata styling
自研 tiler
```

。

---

# 49. Production Realtime

模拟：

```text
AGV position
crane status
ship status
```

。

数据：

```text
WebSocket simulator
↓
WorldClient
↓
state cache
↓
Map / Three representation
```

禁止 WebSocket callback 直接改 Three。

---

# 50. Production 验收

```text
2D → 3D → 2D
100 次

Scene mount = 1
Scene unmount = 0（过程中）

Selection一致
WorldSession一致

Map listener稳定
Three resource稳定
Tiles cache plateau
```

。

---

# 51. Heavy Transport / Lifting Spike

验证：

```text
复杂业务完全可以留在 Scene
Foundation无需增加运输/吊装概念
```

。

第一阶段：

```text
2D route
3D local inspection
simple collision
```

。

---

# 52. Physics

第一版只做：

```text
Site local ENU
simple collider
collision query
```

。

不要一开始做：

```text
完整吊装动力学
钢丝绳
摆动
六自由度
```

。

验证边界即可。

---

# 53. Heavy Transport 验收

```text
Map route
↓
选风险点
↓
3D
↓
只加载局部 content
↓
碰撞验证
↓
回2D修改route
↓
再次3D
```

Scene 不重挂。

---

# 54. `SceneEngine` 资源预算

第一版 Profile：

```text
OFFICE
STANDARD
HIGH
EXHIBITION
```

最开始可只实现：

```text
STANDARD
HIGH
```

。

控制：

```text
pixel ratio
tiles byte budget
shadow
water quality
post fx
```

。

---

# 55. 初始性能指标

PoC Reference Hardware 需要公司固定。

第一阶段建议目标：

## 2D

```text
1000~5000 features
正常交互稳定
无明显主线程卡顿
```

## 3D 办公终端

```text
2560×1440
典型 Site
目标 ≥30 FPS
p95 frame time ≤33ms
```

## 展示终端

```text
4K
重点 Scene
目标 ≥45 FPS
```

。

---

# 56. Diagnostics 第一版

Portal 开发模式提供 HUD：

```text
Active Scene
Scene Mount ID

MapEngine state
SceneEngine state

WorldSession
Site

FPS
frame time

draw calls
triangles

textures
geometries

tiles cache bytes
tiles visible/loading

asset leases

subscriptions
frame callbacks
```

。

---

# 57. Scene Compliance CLI

建议 tooling 提供：

```text
pnpm scene:test stack-yard
```

执行：

```text
mount
run 5s
unmount
repeat N
```

采集：

```text
subscriptions
listeners
DOM nodes
Vue effects
Map layers/sources
asset leases
graphics callbacks
```

浏览器自动化可以后续使用 Playwright。

---

# 58. Architecture CI

至少检查：

```text
world
  cannot import vue
  cannot import three
  cannot import maplibre-gl

spatial
  cannot import three
  cannot import maplibre-gl
  cannot import vue

packages
  cannot import scenes

scene
  cannot deep-import engine internals
```

Native-first 下：

```text
scene → three
scene → maplibre-gl
```

允许。

---

# 59. Package Exports

所有 package：

```json
{
  "exports": {
    ".": "./src/public.ts"
  }
}
```

internal 不暴露。

---

# 60. Visual Regression

从 Production Spike 开始加入。

固定：

```text
camera
time
site
state fixture
quality profile
```

截图：

```text
Global
Site daylight
Site night
Water
Production
```

。

---

# 61. Golden Data Fixture

建议建立：

```text
fixtures/
  world/
  stack-yard/
  production/
  heavy-transport/
```

业务 Scene 开发无需真实 MES / AIS 才能运行。

---

# 62. Error Boundary

三层：

```text
App Error
Scene Error
Engine Error
```

Scene Error：

```text
由 SceneHost 捕获
显示统一Scene Error UI
允许返回Scene Panel
```

。

Engine Error：

```text
Map / Graphics context / asset / tiles
```

由 Engine diagnostics 管。

---

# 63. Logging

统一结构字段：

```text
app
sceneId
sceneMountId
worldId
siteId
engine
category
```

不要只有：

```text
console.log('error')
```

。

---

# 64. Scene 开发规范摘要

Scene 可以：

```text
✓ Vue
✓ Three
✓ MapLibre
✓ Domain packages
✓ Native MapLibre API
✓ Native Three API
```

Scene 不可以：

```text
✕ deep import Foundation internal
✕ dispose MapEngine
✕ dispose SceneEngine renderer
✕ clear global THREE.Scene
✕ takeover global render loop
✕ create independent 3D Tiles global cache
✕ direct-connect OT systems
✕ assume Portal exists
```

。

---

# 65. 第一批 ADR

建议实际建立文件：

```text
docs/adr/

0001-foundation-scene-boundary.md

0002-native-first-engines.md

0003-scene-lifecycle.md

0004-world-spatial-separation.md

0005-maplibre-three-separate-context.md

0006-ecef-site-enu.md

0007-content-asset-separation.md

0008-scene-portal-standalone.md

0009-no-scene-engine-metadata.md

0010-webgl2-production-baseline.md
```

。

---

# 66. 第一个 Sprint

建议只完成：

```text
Monorepo
Portal shell
ScenePanel
SceneDefinition
SceneCoordinator
SceneHost
SceneContext

MapAccess
MapEngine
Stack Yard basic Scene
```

验收：

```text
Portal
↓
Scene Panel
↓
Stack Yard
↓
MapLibre
↓
unmount
↓
回 Scene Panel
```

连续 100 次：

```text
Map layers
listeners
subscriptions
Vue effects
```

无增长。

---

# 67. 第二个 Sprint

完成：

```text
Spatial Core baseline
Site
ReferenceFrame
Map coordinate integration
GraphicsAccess
SceneEngine lazy loader
```

验收：

```text
Stack Yard 2D
↓
点击3D
↓
Three首次lazy-load
↓
显示真实地理位置Cube
↓
回2D
```

Scene 不重挂。

---

# 68. 第三个 Sprint

完成：

```text
Production Scene skeleton
real Site 3D Tiles
ship GLB
crane GLB
basic resource diagnostics
```

。

---

# 69. 第四个 Sprint

完成：

```text
WorldClient simulator
Snapshot / Delta
AGV movement
Map + Three same world state
```

。

---

# 70. 第五个 Sprint

完成：

```text
Heavy Transport
local 3D inspection
simple physics/collision
```

如果到这里 Foundation 仍无需加入：

```text
Stack
Crane
Transport
Production
```

等业务概念：

> 架构边界验证成功。

---

# 71. Freeze 后禁止的“架构优化”

开发期间遇到一个业务需求时，不要立即：

```text
新增 Foundation service
新增 SDK API
新增 manager
新增 plugin type
新增 Scene metadata
```

。

先在 Scene 内完成。

只有：

```text
多个真实 Scene 重复出现
+
业务无关
+
生命周期稳定
```

才考虑提升到 Foundation。

---

# 72. 提升 Foundation 的判断标准

候选能力必须同时满足：

```text
1. 至少 3 个 Scene 真正重复
2. 与具体业务语义无关
3. 生命周期边界清晰
4. API 可以长期稳定
5. 放入 Foundation 明显减少整体复杂度
```

否则：

```text
留在 Scene / Domain package
```

。

---

# 73. 最终实施原则

开发团队在任何设计评审中都可以问五个问题：

```text
这是平台语义还是第三方库语法？

这是 Foundation 事实还是 Scene 业务？

资源是谁拥有的？

Scene unmount 后谁负责清理？

这个抽象今天真的有至少两个/三个真实使用者吗？
```

如果这些问题都有清晰答案，架构通常不会走偏。

---

# 74. 下一阶段 Done Definition

Architecture implementation 第一阶段只有满足以下条件才算完成：

```text
[ ] Stack Yard 可 Portal 动态加载

[ ] Stack Yard 可 Standalone 运行

[ ] Stack Yard 2D-only build 不包含 Three

[ ] Stack Yard 可 lazy 进入 3D

[ ] Scene mount/unmount 100 次无增长性 leak

[ ] Production 可 Map ↔ Graphics 切换 100 次

[ ] World / Spatial 无 Vue/Three/MapLibre 依赖

[ ] Scene 可直接使用 Native Three/MapLibre

[ ] 共享 Asset 使用 Lease

[ ] Native Scene Three Resource 可正确 dispose

[ ] 真实 3D Tiles 可重复加载/释放

[ ] Diagnostics 能明确资源归属

[ ] Architecture CI 可阻止 deep import
```

达到后再开始正式 MVP 业务扩张。

---

# 75. 最终结论

Architecture Freeze v1.2 已经解决“怎么设计”。

Implementation Blueprint v0.1 的重点是证明：

```text
Scene Contract 足够小
Host 生命周期足够强
Foundation 足够薄
Native Engine 足够自由
资源所有权足够明确
```

未来平台质量的决定因素，不再是增加更多架构层，而是：

```text
SceneHost 的生命周期质量

Spatial 数学正确性

Asset Pipeline 质量

Tiles Cache 管理

Scene Compliance

Diagnostics

Performance Regression
```

因此从现在开始：

> **Architecture remains frozen; implementation becomes the source of truth.**

即：

> **架构保持冻结，真实实现成为下一阶段的事实来源。**
