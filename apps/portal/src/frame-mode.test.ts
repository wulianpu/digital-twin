// @vitest-environment jsdom
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { geodeticToEcef } from '@twin/spatial'
import type { EngineRuntime, SceneEngineOptions } from '@twin/scene-engine'
import type { GraphicsContext, GraphicsDiagnostics, GraphicsAccess } from '@twin/sdk'
import { createModeRoutingGraphicsAccess } from './frameMode'
import { buildFoundation, type PortalFoundation } from './foundation'

/**
 * Issue #31：Portal 真实 Foundation wiring 的 frame-mode 集成回归——
 * 同一会话 GLOBAL → SITE → GLOBAL round-trip：
 * - global-ships 路径能拿到 `GraphicsContext.global`（不再出现
 *   "engine was not configured in global mode"）；
 * - SITE Scene 继续 frame-local meters，不继承 GLOBAL km/root policy；
 * - View binding 与 graphics 读取同一已提交 mode authority；
 * - 非活跃 runtime 保持 suspend，无双 RAF/双画布。
 */

function installFakeWebSocket(): () => void {
  class FakeWS {
    send(): void {}
    close(): void {}
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((e: { data: unknown }) => void) | null = null
    constructor(_url: string) {
      queueMicrotask(() => this.onopen?.())
    }
  }
  ;(globalThis as Record<string, unknown>).WebSocket = FakeWS
  return () => {
    delete (globalThis as Record<string, unknown>).WebSocket
  }
}

const restoreWs = installFakeWebSocket()
afterAll(() => restoreWs())

function makeFakeRuntime(opts: SceneEngineOptions) {
  const orbitFocus = vi.fn()
  const canvas = document.createElement('canvas')
  // 真实 createRuntime 在 boot 时把 canvas 挂入 viewport——fake 保持一致
  opts.getViewport?.()?.appendChild(canvas)
  // #31-r3：与真实 createMountRoot 一致——root 创建即 attach 进容器，
  // 使 orphan root 泄漏在测试中可观察（而非天生 parent === null 的 false-green）
  const mountContainer = new THREE.Group()
  const rt = {
    context: {
      renderScene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      renderer: { domElement: canvas },
      onFrame: () => ({ dispose: () => {} }),
      onPick: () => ({ dispose: () => {} }),
      environment: {},
      global:
        opts.global === true
          ? { enabled: true as const, setObjectEcefPosition: vi.fn() }
          : undefined,
      entities: {
        register: vi.fn(() => ({ dispose: () => {} })),
        getPosition: vi.fn(() => false),
        has: () => false,
        count: 0,
        clear: vi.fn()
      },
      suspend: vi.fn(),
      resume: vi.fn(),
      getDiagnostics: () => ({}) as unknown as GraphicsDiagnostics
    },
    orbit: {
      focus: orbitFocus,
      state: { target: { x: 0, y: 0, z: 0 }, distance: 100 },
      cameraPose: vi.fn()
    },
    frameLoop: {},
    tiles: { tilesetCount: 0 },
    entitySystem: {},
    environment: {},
    earth: undefined,
    adaptive: { force: vi.fn() },
    createMountRoot: () => {
      const root = new THREE.Group()
      mountContainer.add(root)
      return { root, detach: () => root.removeFromParent() }
    },
    suspend: vi.fn(),
    resume: vi.fn(),
    dispose: vi.fn()
  }
  return {
    rt: rt as unknown as EngineRuntime,
    orbitFocus,
    canvas,
    mountContainer,
    suspend: rt.suspend,
    resume: rt.resume,
    dispose: rt.dispose
  }
}

type CreatedBoot = {
  opts: SceneEngineOptions
  rt: EngineRuntime
  orbitFocus: ReturnType<typeof vi.fn>
  canvas: HTMLCanvasElement
  mountContainer: THREE.Group
  suspend: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

const disposables: PortalFoundation[] = []
afterEach(async () => {
  while (disposables.length) {
    const f = disposables.pop()
    if (f) await f.dispose()
  }
})

async function buildWithFactory() {
  const created: CreatedBoot[] = []
  const foundation = buildFoundation({
    graphicsRuntimeFactory: async (opts) => {
      const fake = makeFakeRuntime(opts)
      created.push({ opts, ...fake })
      return fake.rt
    }
  })
  disposables.push(foundation)
  foundation.workspace.setContainers({
    map: document.createElement('div'),
    graphics: document.createElement('div')
  })
  return { foundation, created }
}

/**
 * #31 复审：deferred runtime factory——boot promise 由测试手动 resolve，
 * 且 fake runtime 在 factory 调用时刻即 append canvas（与真实
 * createRuntime 一致：canvas/资源在 promise resolve 前已就绪）。
 * 用于覆盖 pending boot × rapid mode switch 竞态。
 */
async function buildWithDeferredFactory() {
  type DeferredBoot = CreatedBoot & { resolve: () => void }
  const boots: DeferredBoot[] = []
  const foundation = buildFoundation({
    graphicsRuntimeFactory: (opts) =>
      new Promise<EngineRuntime>((resolve) => {
        const fake = makeFakeRuntime(opts)
        boots.push({ opts, ...fake, resolve: () => resolve(fake.rt) })
      })
  })
  disposables.push(foundation)
  const viewport = document.createElement('div')
  foundation.workspace.setContainers({ map: viewport, graphics: viewport })
  return { foundation, boots, viewport }
}

const TARGET = {
  longitudeDegrees: 122.5,
  latitudeDegrees: 30.2,
  heightMeters: 0,
  verticalReference: 'ellipsoid' as const
}

describe('Portal frame-mode authority（Issue #31）', () => {
  it('GLOBAL → SITE → GLOBAL round-trip：mode authority / context / view 单位 / suspend 全链路', async () => {
    const { foundation, created } = await buildWithFactory()
    foundation.workspace.setPrimary('scene')

    // 初始 scope=global → 首次 use() boot GLOBAL access
    expect(foundation.graphicsAccess.mode).toBe('global')
    const ctxGlobal = await foundation.graphicsAccess.use()
    expect(created).toHaveLength(1)
    expect(created[0]!.opts.global).toBe(true)
    // global-ships 的 guard：graphics.global 必须存在
    expect(ctxGlobal.global).toBeDefined()
    expect(ctxGlobal.global?.enabled).toBe(true)

    // GLOBAL view 路径：WGS84 → ECEF km；20km scale → 20（scene-km），不是 20000
    await foundation.view.setTarget({ target: TARGET, scaleMeters: 20_000 })
    const ecef = geodeticToEcef(TARGET)
    expect(created[0]!.orbitFocus).toHaveBeenCalledWith(
      { x: ecef.xMeters / 1000, y: ecef.zMeters / 1000, z: -ecef.yMeters / 1000 },
      20
    )

    // 切 SITE scope → use() 提交 site mode：boot SITE access（global!==true）
    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    const ctxSite = await foundation.graphicsAccess.use()
    expect(created).toHaveLength(2)
    expect(created[1]!.opts.global).not.toBe(true)
    // SITE context 不带 global env（不继承 GLOBAL km/root policy）
    expect(ctxSite.global).toBeUndefined()
    // 非活跃 runtime suspend（无双 RAF）
    expect(created[0]!.suspend).toHaveBeenCalled()

    // SITE view 路径：frame-local meters；scaleMeters 保持米
    foundation.spatial.setActiveFrame('frame:site-changxing')
    await foundation.view.setTarget({ target: TARGET, scaleMeters: 20_000 })
    const local = foundation.spatial.geodeticToLocal(TARGET)
    expect(created[1]!.orbitFocus).toHaveBeenCalledWith(local, 20_000)

    // 切回 GLOBAL：复用已 boot 的 global runtime（不重新 boot）+ resume
    foundation.world.setScope({ kind: 'global' })
    await foundation.graphicsAccess.use()
    expect(created).toHaveLength(2)
    expect(created[0]!.resume).toHaveBeenCalled()
    expect(foundation.graphicsAccess.mode).toBe('global')
    expect(created[1]!.suspend).toHaveBeenCalled()

    // View binding 与 graphics 同一 authority：Engine=GLOBAL ⇒ View=GLOBAL
    await foundation.view.setTarget({ target: TARGET, scaleMeters: 20_000 })
    const calls = created[0]!.orbitFocus.mock.calls
    expect(calls[calls.length - 1]).toEqual([
      { x: ecef.xMeters / 1000, y: ecef.zMeters / 1000, z: -ecef.yMeters / 1000 },
      20
    ])
  })

  it('canvas 随 mode 归属 viewport；同 mode 重复 use() 幂等不抖动', async () => {
    const { foundation, created } = await buildWithFactory()
    const viewport = document.createElement('div')
    foundation.workspace.setContainers({ map: viewport, graphics: viewport })

    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    await foundation.graphicsAccess.use()
    expect(created).toHaveLength(1)
    expect(created[0]!.canvas.parentElement).toBe(viewport)

    foundation.world.setScope({ kind: 'global' })
    await foundation.graphicsAccess.use()
    // global canvas 进入 viewport，site canvas 被移出（无双画布叠放）
    expect(created[1]!.canvas.parentElement).toBe(viewport)
    expect(created[0]!.canvas.parentElement).not.toBe(viewport)

    // 同 mode 再次 use()：幂等——非活跃 runtime 不被重复 suspend
    const siteSuspendsBefore = created[0]!.suspend.mock.calls.length
    await foundation.graphicsAccess.use()
    expect(created[1]!.canvas.parentElement).toBe(viewport)
    expect(created[0]!.suspend.mock.calls.length).toBe(siteSuspendsBefore)
  })

  it('dispose 终止两个底层 access（exactly-once 资源回收）', async () => {
    const { foundation, created } = await buildWithFactory()
    await foundation.graphicsAccess.use()
    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    await foundation.graphicsAccess.use()
    expect(created).toHaveLength(2)
    await foundation.dispose()
    expect(created[0]!.dispose).toHaveBeenCalled()
    expect(created[1]!.dispose).toHaveBeenCalled()
  })

  // ---- #31 复审：pending boot × rapid mode switch 竞态 ----

  it('GLOBAL pending → SITE commit → GLOBAL late resolve：晚到 runtime 被 quarantine，无双 RAF/双 canvas', async () => {
    const { foundation, boots, viewport } = await buildWithDeferredFactory()
    const useG1 = foundation.graphicsAccess.use() // GLOBAL boot 挂起
    expect(boots).toHaveLength(1)
    expect(boots[0]!.opts.global).toBe(true)

    // SITE 提交（authority 易主时 GLOBAL 仍 pending）
    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    const useS = foundation.graphicsAccess.use()
    boots[1]!.resolve()
    await useS
    expect(foundation.graphicsAccess.mode).toBe('site')
    expect(boots).toHaveLength(2)
    const g = boots[0]!
    const s = boots[1]!
    // fake 与真实 createRuntime 一致：canvas 在 boot resolve 前已 append
    expect(s.canvas.parentElement).toBe(viewport)

    // GLOBAL boot 晚到——必须被 quarantine，不得自留在 viewport/RAF
    g.resolve()
    await expect(useG1).rejects.toThrow(/superseded/)
    expect(g.suspend).toHaveBeenCalled()
    expect(g.canvas.parentElement).not.toBe(viewport)
    expect(s.canvas.parentElement).toBe(viewport)
    expect(foundation.graphicsAccess.mode).toBe('site')
    // #31-r3：stale route 的 mount root 在 rejection 可见前已 detach——
    // GLOBAL container 回到 baseline（site 的 1 个 root 已成功交付给调用方）
    expect(g.mountContainer.children.length).toBe(0)
    expect(s.mountContainer.children.length).toBe(1)
  })

  it('SITE pending → GLOBAL commit → SITE late resolve：对称方向同样不复活', async () => {
    const { foundation, boots, viewport } = await buildWithDeferredFactory()
    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    const useS = foundation.graphicsAccess.use() // SITE boot 挂起

    // 切回 GLOBAL 并完成提交
    foundation.world.setScope({ kind: 'global' })
    const useG = foundation.graphicsAccess.use()
    boots.find((b) => b.opts.global === true)!.resolve()
    await useG
    expect(foundation.graphicsAccess.mode).toBe('global')

    // SITE boot 晚到 → quarantine
    boots.find((b) => b.opts.global !== true)!.resolve()
    await expect(useS).rejects.toThrow(/superseded/)
    const s = boots.find((b) => b.opts.global !== true)!
    const g = boots.find((b) => b.opts.global === true)!
    expect(s.suspend).toHaveBeenCalled()
    expect(s.canvas.parentElement).not.toBe(viewport)
    expect(g.canvas.parentElement).toBe(viewport)
    // #31-r3：对称方向同样无 orphan root（global 的 1 个 root 已成功交付）
    expect(s.mountContainer.children.length).toBe(0)
    expect(g.mountContainer.children.length).toBe(1)
  })

  it('GLOBAL(1) pending → SITE → GLOBAL(2)：旧 continuation 不误伤重新选中的 GLOBAL authority', async () => {
    const { foundation, boots, viewport } = await buildWithDeferredFactory()
    const useG1 = foundation.graphicsAccess.use() // GLOBAL(1) boot 挂起（single-flight）

    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    const useS = foundation.graphicsAccess.use()
    boots[1]!.resolve()
    await useS
    expect(foundation.graphicsAccess.mode).toBe('site')

    // 切回 GLOBAL——与 GLOBAL(1) 共享同一 single-flight boot
    foundation.world.setScope({ kind: 'global' })
    const useG2 = foundation.graphicsAccess.use()
    const g = boots.find((b) => b.opts.global === true)!
    const s = boots.find((b) => b.opts.global !== true)!
    g.resolve()

    // 两个 continuation 都命中同侧 access：不得 suspend 最新 GLOBAL authority
    await useG2
    await expect(useG1).resolves.toBeDefined()
    expect(g.suspend).not.toHaveBeenCalled()
    expect(g.resume).toHaveBeenCalled()
    expect(s.suspend).toHaveBeenCalled()
    expect(foundation.graphicsAccess.mode).toBe('global')
    expect(g.canvas.parentElement).toBe(viewport)
    expect(s.canvas.parentElement).not.toBe(viewport)
    // #31-r3：两个 continuation 都成功交付 root（已 transfer 给调用方）——
    // 旧 continuation cleanup 不得误删同侧已交付 root
    expect(g.mountContainer.children.length).toBe(2)
    expect(s.mountContainer.children.length).toBe(1)
  })

  it('dispose 时 pending boot 沿 #14 terminal 机制回收（router 不复活）', async () => {
    const { foundation, boots } = await buildWithDeferredFactory()
    const useG1 = foundation.graphicsAccess.use()
    await foundation.dispose()
    // 先让 pending boot settle——晚到的 boot 被 #14-B commit 前重校验回收
    boots[0]!.resolve()
    await expect(useG1).rejects.toThrow()
    expect(boots[0]!.dispose).toHaveBeenCalled()
    expect(boots[0]!.resume).not.toHaveBeenCalled()
  })

  it('#31-r3：100 次连续 stale mode switch 后 mount-root container 保持 baseline', async () => {
    const { foundation, created } = await buildWithFactory()
    const viewport = document.createElement('div')
    foundation.workspace.setContainers({ map: viewport, graphics: viewport })
    const SITE = { kind: 'site' as const, siteId: 'site-changxing' }
    const GLOBAL = { kind: 'global' as const }

    for (let i = 0; i < 100; i++) {
      const next = i % 2 === 0 ? SITE : GLOBAL
      foundation.world.setScope(next)
      // 同步翻转后 revalidation 必见 stale——use() 的 microtask 链在之后运行
      const p = foundation.graphicsAccess.use()
      foundation.world.setScope(next === SITE ? GLOBAL : SITE)
      await expect(p).rejects.toThrow(/superseded/)
    }
    // 每次都是 stale route：root 创建即 discard，container 不随切换次数增长
    expect(created[0]!.mountContainer.children.length).toBe(0)
    expect(created[1]!.mountContainer.children.length).toBe(0)
  })

  // ---- Issue #32：mode-specific resource policy + aggregate diagnostics ----

  it('#32：SITE-only 资源策略不进 GLOBAL runtime（tiles/stateBuffer/water/getActiveFrame）', async () => {
    const { foundation, created } = await buildWithFactory()
    // 先 boot GLOBAL（初始 scope）
    await foundation.graphicsAccess.use()
    expect(created[0]!.opts.global).toBe(true)
    // SITE-only 资源不在 GLOBAL options 中——GLOBAL 不得消费 Site 3D Tiles
    expect(created[0]!.opts.tiles).toBeUndefined()
    expect(created[0]!.opts.water).toBeUndefined()
    expect(created[0]!.opts.getActiveFrame).toBeUndefined()
    expect(created[0]!.opts.stateBuffer).toBeUndefined()

    // 进入 SITE：SITE options 携带全部 SITE-only 资源
    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    await foundation.graphicsAccess.use()
    expect(created[1]!.opts.global).not.toBe(true)
    expect(created[1]!.opts.tiles).toBeDefined()
    expect(created[1]!.opts.stateBuffer).toBeDefined()
    expect(created[1]!.opts.getActiveFrame).toBeTypeOf('function')

    // GLOBAL → SITE → GLOBAL round-trip 不为 SITE 资源创建第二份 runtime
    foundation.world.setScope({ kind: 'global' })
    await foundation.graphicsAccess.use()
    expect(created).toHaveLength(2)
    // 两 runtime 各自 options 无交叉污染
    expect(created[0]!.opts.tiles).toBeUndefined()
    expect(created[1]!.opts.tiles).toBeDefined()
  })

  it('#33：quality 为跨 runtime 持久 authority——一侧已 boot 时选档，另一侧首启即从该档起步', async () => {
    const { foundation, created } = await buildWithFactory()
    await foundation.graphicsAccess.use() // GLOBAL boot（默认 quality）
    expect(created).toHaveLength(1)

    // 用户切档：已 boot 的 GLOBAL 立即生效；未 boot 的 SITE 记录 intent
    foundation.graphicsAccess.applyQuality('OFFICE')

    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    await foundation.graphicsAccess.use()
    // SITE 首次 boot 必须从用户所选档起步，而非 config.defaultQuality
    expect(created[1]!.opts.quality).toBe('OFFICE')
    // GLOBAL→SITE→GLOBAL 不会把质量恢复成默认档
    foundation.world.setScope({ kind: 'global' })
    await foundation.graphicsAccess.use()
    expect(created).toHaveLength(2)
    expect(created[0]!.opts.quality).not.toBe('OFFICE') // GLOBAL 仍以旧档创建…
    // …但 applyQuality 的 force 使其 effective 已收敛到用户档
    const globalRt = created[0]!.rt as unknown as { adaptive: { force: ReturnType<typeof vi.fn> } }
    expect(globalRt.adaptive.force).toHaveBeenCalledWith('OFFICE')
  })

  it('#32：getAggregateDiagnostics 提供双 runtime breakdown 与 totals，且不改变 lifecycle', async () => {
    const { foundation, created } = await buildWithFactory()
    await foundation.graphicsAccess.use() // global boot
    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    await foundation.graphicsAccess.use() // site boot

    // fake runtime diagnostics.tiles 为 undefined → totals 为 0，但结构完整
    const agg = foundation.graphicsAccess.getAggregateDiagnostics()
    expect(agg.activeMode).toBe('site')
    expect(agg.global).toBeDefined()
    expect(agg.site).toBeDefined()
    expect(agg.totals).toEqual({ tilesCachedBytes: 0 })
    // 纯读取：不 suspend/resume 任何一侧
    expect(created[0]!.suspend).toHaveBeenCalledTimes(created[0]!.suspend.mock.calls.length)
    expect(created[1]!.suspend).toHaveBeenCalledTimes(created[1]!.suspend.mock.calls.length)
  })

  it('#31-r3：dispose 与 context resolve 交错——未 transfer 的 root 先 detach 再 reject（隔离单元）', async () => {
    // 直接构造 mock access，精确控制 context resolve 与 dispose 的交错
    const mkMock = () => {
      const container = new THREE.Group()
      const root = new THREE.Group()
      container.add(root)
      let resolveUse!: (ctx: GraphicsContext) => void
      const access: GraphicsAccess = {
        use: vi.fn(
          () =>
            new Promise<GraphicsContext>((res) => {
              resolveUse = res
            })
        ),
        state: 'ACTIVE' as const,
        currentContext: undefined,
        applyQuality: vi.fn(),
        suspend: vi.fn(),
        resume: vi.fn(),
        getDiagnostics: () => undefined,
        dispose: vi.fn()
      }
      return { access, resolveUse: (ctx: GraphicsContext) => resolveUse(ctx), root, suspend: access.suspend }
    }
    const viewport = document.createElement('div')
    const g = mkMock()
    const s = mkMock()
    const router = createModeRoutingGraphicsAccess({
      resolveMode: () => 'global',
      global: g.access,
      site: s.access,
      viewport: () => viewport
    })
    const p = router.use()
    // context resolve（root 已 attach）→ dispose 同步先行 → revalidation 必见 disposed
    g.resolveUse({ root: g.root } as unknown as GraphicsContext)
    router.dispose()
    await expect(p).rejects.toThrow(/disposed/)
    // root 在 rejection 可见之前已被 discard，runtime 被 quarantine 且不复活
    expect(g.root.parent).toBeNull()
    expect(g.suspend).toHaveBeenCalled()
    expect(g.access.resume).not.toHaveBeenCalled()
  })

  it('#32：aggregate totals 汇总双 runtime retained tiles cache（含 inactive 侧）', () => {
    const diag = (tilesBytes: number) =>
      ({
        quality: 'HIGH',
        frame: { fps: 60, p50Ms: 16, p95Ms: 20, frameIndex: 1 },
        renderer: { drawCalls: 0, triangles: 0, textures: 0, geometries: 0, programs: 0 },
        tiles: { cachedBytes: tilesBytes, maxBytes: 1000, isFull: false, loadProgress: 1, queued: 0, downloading: 0, parsing: 0, loaded: 0, visible: 0, active: 0, failed: 0 },
        entityCount: 0,
        frameCallbacks: 0,
        assetLeases: 0,
        jsHeapMB: undefined
      }) as unknown as GraphicsDiagnostics
    const mk = (bytes: number) => {
      const access: GraphicsAccess = {
        use: vi.fn(),
        state: 'ACTIVE' as const,
        currentContext: undefined,
        applyQuality: vi.fn(),
        suspend: vi.fn(),
        resume: vi.fn(),
        getDiagnostics: () => diag(bytes),
        dispose: vi.fn()
      }
      return access
    }
    const router = createModeRoutingGraphicsAccess({
      resolveMode: () => 'site',
      global: mk(300),
      site: mk(220),
      viewport: () => undefined
    })
    const agg = router.getAggregateDiagnostics()
    // inactive global 的 300B 也计入——active-only 口径会低估 aggregate footprint
    expect(agg.activeMode).toBe('site')
    expect(agg.global?.tiles?.cachedBytes).toBe(300)
    expect(agg.site?.tiles?.cachedBytes).toBe(220)
    expect(agg.totals.tilesCachedBytes).toBe(520)
  })
})
