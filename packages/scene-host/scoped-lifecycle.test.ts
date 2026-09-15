// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { MountScope, SceneScopeClosedError } from './src/scope'
import {
  scopedWorldApi,
  scopedSpatialApi,
  scopedSelectionApi,
  scopedViewApi
} from './src/scopedLifecycle'
import { SceneHost, createViewService, type SceneHostOptions } from './src/public'
import { createWorldApi, createSelectionApi } from '@twin/world'
import { createSpatialApi } from '@twin/spatial'
import type { SceneContext, SceneEntry } from '@twin/sdk'

const GEO = {
  longitudeDegrees: 121.78,
  latitudeDegrees: 31.36,
  heightMeters: 4,
  verticalReference: 'ellipsoid' as const
}

function makeViewInner() {
  const sceneDriver = {
    focus: vi.fn(async () => {}),
    goToSite: vi.fn(async () => {}),
    setTarget: vi.fn(async () => {}),
    getTarget: () => undefined
  }
  const view = createViewService({
    mapDriver: sceneDriver,
    sceneDriver,
    getPrimary: () => 'scene'
  })
  return { view, sceneDriver }
}

describe('scoped lifecycle wrappers（Issue #4 zombie-write 防线）', () => {
  it('active：写操作透传到 inner', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const scoped = scopedWorldApi(world, scope)
    scoped.setMode('history')
    expect(world.session.mode).toBe('history')
    scoped.setScope({ kind: 'site', siteId: 's1' })
    expect(world.session.scope).toEqual({ kind: 'site', siteId: 's1' })
    scoped.clock.seek(1_000)
    expect(world.clock.now().epochMillis).toBe(1_000)
  })

  it('closing：状态写操作被拒（unmount 开始即不得改写平台状态）', () => {
    const scope = new MountScope()
    const selection = createSelectionApi()
    const scoped = scopedSelectionApi(selection, scope)
    scope.close()
    expect(() => scoped.setPrimary({ namespace: 'vessel', id: 'hull-1' })).toThrow(
      SceneScopeClosedError
    )
    expect(selection.current.primary).toBeUndefined()
  })

  it('disposed：world/selection 写操作抛 SceneScopeClosedError，读操作仍有效', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const selection = createSelectionApi()
    const scopedWorld = scopedWorldApi(world, scope)
    const scopedSelection = scopedSelectionApi(selection, scope)
    scope.dispose()

    // zombie write：fail-fast 抛错，inner 状态不变（Issue #4 验收语义）
    expect(() => scopedWorld.setMode('history')).toThrow(SceneScopeClosedError)
    expect(() => scopedWorld.setScope({ kind: 'global' })).toThrow(SceneScopeClosedError)
    expect(() => scopedWorld.clock.seek(1)).toThrow(SceneScopeClosedError)
    expect(world.session.mode).toBe('live')
    expect(() =>
      scopedSelection.setPrimary({ namespace: 'v', id: 'x' })
    ).toThrow(SceneScopeClosedError)
    expect(() => scopedSelection.toggle({ namespace: 'v', id: 'y' })).toThrow(
      SceneScopeClosedError
    )
    expect(() => scopedSelection.clear()).toThrow(SceneScopeClosedError)
    expect(selection.current.primary).toBeUndefined()

    // reads 仍透传：scene 可安全降级（session/current 为快照，按值比较）
    expect(scopedWorld.worldId).toBe(world.worldId)
    expect(scopedWorld.session).toEqual(world.session)
    expect(scopedSelection.current).toEqual(selection.current)
    expect(scopedWorld.clock.now()).toEqual(world.clock.now())
  })

  it('disposed：spatial 写/创建被拒，读与坐标转换仍有效', () => {
    const scope = new MountScope()
    const spatial = createSpatialApi()
    const scoped = scopedSpatialApi(spatial, scope)
    const frame = scoped.ensureEnuFrame('f1', GEO)
    scoped.setActiveFrame('f1')
    scope.dispose()

    expect(() => scoped.ensureEnuFrame('f2', GEO)).toThrow(SceneScopeClosedError)
    expect(() =>
      scoped.registerFrame({ id: 'f3', kind: 'enu', origin: GEO } as never)
    ).toThrow(SceneScopeClosedError)
    expect(() => scoped.registerVerticalOffset('ellipsoid', 'ellipsoid', 1)).toThrow(
      SceneScopeClosedError
    )
    expect(() => scoped.setActiveFrame('f2')).toThrow(SceneScopeClosedError)

    // reads 仍透传
    expect(scoped.getFrame('f1')).toBe(frame)
    expect(scoped.activeFrameId).toBe('f1')
    expect(scoped.listFrames().length).toBe(1)
  })

  it('disposed：view 异步写抛错，不触达 driver', async () => {
    const scope = new MountScope()
    const { view, sceneDriver } = makeViewInner()
    const scoped = scopedViewApi(view, scope)
    scope.dispose()

    // fail-fast：同步抛错（不产生无人处理的 rejected promise）
    expect(() => scoped.focus({ namespace: 'v', id: 'x' })).toThrow(SceneScopeClosedError)
    expect(() => scoped.goToSite('site-1')).toThrow(SceneScopeClosedError)
    expect(() => scoped.setTarget({ target: GEO })).toThrow(SceneScopeClosedError)
    expect(sceneDriver.focus).not.toHaveBeenCalled()
    expect(sceneDriver.goToSite).not.toHaveBeenCalled()
    expect(sceneDriver.setTarget).not.toHaveBeenCalled()
    // reads 仍透传
    expect(scoped.primary).toBe('scene')
  })

  it('Disposable 返回 API 立即 track：scope.dispose 后 listener/资源被兜底释放', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const selection = createSelectionApi()
    const spatial = createSpatialApi()
    const scopedWorld = scopedWorldApi(world, scope)
    const scopedSelection = scopedSelectionApi(selection, scope)
    const scopedSpatial = scopedSpatialApi(spatial, scope)

    let sessionEvents = 0
    let tickEvents = 0
    let selectionEvents = 0
    let frameEvents = 0
    scopedWorld.onSessionChanged(() => sessionEvents++)
    scopedWorld.time.onTick(() => tickEvents++)
    scopedSelection.onChange(() => selectionEvents++)
    scopedSpatial.onActiveFrameChanged(() => frameEvents++)
    scopedWorld.sites.register({
      id: 's-x',
      name: 'X',
      origin: GEO,
      bounds: { south: 1, west: 1, north: 2, east: 2 }
    })
    scopedSpatial.registerFrame({ id: 'f-t', kind: 'enu', origin: GEO } as never)

    scope.dispose()

    // Host 兜底：listener 全部移除、注册资源全部释放
    world.setMode('history')
    expect(sessionEvents).toBe(0)
    expect(tickEvents).toBe(0)
    expect(selectionEvents).toBe(0)
    expect(frameEvents).toBe(0)
    expect(world.sites.get('s-x')).toBeUndefined()
    expect(spatial.getFrame('f-t')).toBeUndefined()
  })

  it('Scene 手工 dispose 仍有效（Host 只是兜底）', () => {
    const scope = new MountScope()
    const selection = createSelectionApi()
    const scoped = scopedSelectionApi(selection, scope)
    let events = 0
    const d = scoped.onChange(() => events++)
    d.dispose()
    selection.setPrimary({ namespace: 'v', id: 'a' })
    expect(events).toBe(0)
  })
})

describe('SceneHost × scoped lifecycle 集成（缓存引用 zombie 写防线）', () => {
  it('unmount 后，Scene 缓存的 world/spatial/selection/view 写全部被拒（Issue #4 验收用例）', async () => {
    const world = createWorldApi()
    const selection = createSelectionApi()
    const spatial = createSpatialApi()
    const { view, sceneDriver } = makeViewInner()
    const services = {
      world,
      spatial,
      data: { subscribe: () => ({ dispose: () => {} }) },
      selection,
      view,
      assets: {}
    } as unknown as SceneHostOptions['services']

    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services
    })

    let cachedWorld: SceneContext['world'] | undefined
    let cachedSpatial: SceneContext['spatial'] | undefined
    let cachedSelection: SceneContext['selection'] | undefined
    let cachedView: SceneContext['view'] | undefined
    const entry: SceneEntry = {
      mount: async (ctx) => {
        // 典型 zombie 场景：Scene 在 mount 时缓存 API 引用
        cachedWorld = ctx.world
        cachedSpatial = ctx.spatial
        cachedSelection = ctx.selection
        cachedView = ctx.view
        return { unmount: () => {} }
      }
    }
    const mount = await host.mount(entry)
    await mount.unmount()

    // 缓存引用在 unmount 后写入 → 抛 SceneScopeClosedError，全局状态不变
    expect(() => cachedWorld!.setMode('history')).toThrow(SceneScopeClosedError)
    expect(world.session.mode).toBe('live')
    expect(() => cachedWorld!.clock.seek(1)).toThrow(SceneScopeClosedError)
    expect(() =>
      cachedSelection!.setPrimary({ namespace: 'v', id: 'zombie' })
    ).toThrow(SceneScopeClosedError)
    expect(selection.current.primary).toBeUndefined()
    expect(() => cachedSpatial!.setActiveFrame('f1')).toThrow(SceneScopeClosedError)
    expect(() => cachedView!.goToSite('site-1')).toThrow(SceneScopeClosedError)
    expect(sceneDriver.goToSite).not.toHaveBeenCalled()
  })

  it('mount 进行中的写操作不受影响（active 透传）', async () => {
    const world = createWorldApi()
    const services = {
      world,
      spatial: createSpatialApi(),
      data: { subscribe: () => ({ dispose: () => {} }) },
      selection: createSelectionApi(),
      view: makeViewInner().view,
      assets: {}
    } as unknown as SceneHostOptions['services']
    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services
    })
    const mount = await host.mount({
      mount: async (ctx) => {
        ctx.world.setMode('history')
        expect(world.session.mode).toBe('history')
        return { unmount: () => {} }
      }
    })
    expect(mount.state).toBe('active')
  })
})

describe('Issue #5：nested capability / mutable alias / create-before-guard', () => {
  it('A: ctx.world.selection 与 ctx.selection 是同一 scoped 实例', async () => {
    const world = createWorldApi()
    const selection = createSelectionApi()
    const services = {
      world,
      spatial: createSpatialApi(),
      data: { subscribe: () => ({ dispose: () => {} }) },
      selection,
      view: makeViewInner().view,
      assets: {}
    } as unknown as SceneHostOptions['services']
    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services
    })
    let nested: unknown
    let primaryPath: unknown
    const mount = await host.mount({
      mount: async (ctx) => {
        nested = ctx.world.selection
        primaryPath = ctx.selection
        return { unmount: () => {} }
      }
    })
    expect(nested).toBe(primaryPath)
    await mount.unmount()
    // 两条访问路径生命周期语义一致：同样被拒
    expect(() =>
      (nested as SceneContext['selection']).setPrimary({ namespace: 'v', id: 'zombie' })
    ).toThrow(SceneScopeClosedError)
    expect(selection.current.primary).toBeUndefined()
  })

  it('B1: session.scope/entity 是快照——修改返回对象不影响 inner', () => {
    const scope = new MountScope()
    const world = createWorldApi({ initialScope: { kind: 'site', siteId: 's1' } })
    const scoped = scopedWorldApi(world, scope)
    const snap = scoped.session
    if (snap.scope.kind === 'site') snap.scope.siteId = 'hijacked'
    expect(world.session.scope).toEqual({ kind: 'site', siteId: 's1' })

    world.setScope({ kind: 'entity', entity: { namespace: 'vessel', id: 'a' } })
    const snap2 = scoped.session
    if (snap2.scope.kind === 'entity') snap2.scope.entity.id = 'zombie'
    expect(world.session.scope).toEqual({
      kind: 'entity',
      entity: { namespace: 'vessel', id: 'a' }
    })
  })

  it('B2: selection.current 是快照——修改 primary/secondary 不影响 inner', () => {
    const scope = new MountScope()
    const selection = createSelectionApi()
    const scoped = scopedSelectionApi(selection, scope)
    scoped.setPrimary({ namespace: 'vessel', id: 'keep' })
    scoped.setSecondary([{ namespace: 'agv', id: 's1' }])
    const snap = scoped.current
    snap.primary!.id = 'zombie'
    snap.secondary[0]!.id = 'zombie'
    expect(selection.current.primary).toEqual({ namespace: 'vessel', id: 'keep' })
    expect(selection.current.secondary).toEqual([{ namespace: 'agv', id: 's1' }])
    expect(selection.isSelected({ namespace: 'vessel', id: 'keep' })).toBe(true)
  })

  it('B3: sites.get/list 返回克隆——修改不影响 registry truth', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const scoped = scopedWorldApi(world, scope)
    scoped.sites.register({
      id: 'site-a',
      name: 'A',
      origin: { ...GEO },
      bounds: { south: 1, west: 1, north: 2, east: 2 }
    })
    const site = scoped.sites.get('site-a')!
    site.origin.heightMeters = 99_999
    ;(site as { name: string }).name = 'Hijacked'
    expect(world.sites.get('site-a')!.origin.heightMeters).toBe(GEO.heightMeters)
    expect(world.sites.get('site-a')!.name).toBe('A')
    const listed = scoped.sites.list()[0]!
    ;(listed.bounds as { south: number }).south = -50
    expect(world.sites.list()[0]!.bounds.south).toBe(1)
  })

  it('B4: frame 冻结——getFrame/ensureEnuFrame 返回值不可变，registerFrame 存副本', () => {
    const scope = new MountScope()
    const spatial = createSpatialApi()
    const scoped = scopedSpatialApi(spatial, scope)
    const ensured = scoped.ensureEnuFrame('f1', GEO)
    const baselineX = ensured.originECEF.x
    expect(() => { (ensured.originECEF as { x: number }).x = 0 }).toThrow(TypeError)
    expect(() => { (ensured.basisECEF as { xx: number }).xx = 0 }).toThrow(TypeError)

    const callerFrame = {
      id: 'f2',
      originECEF: { x: 1, y: 2, z: 3 },
      basisECEF: { xx: 1, xy: 0, xz: 0, yx: 0, yy: 1, yz: 0, zx: 0, zy: 0, zz: 1 }
    } as never
    scoped.registerFrame(callerFrame)
    // 调用方对象后续变化不影响 registry（存储的是 frozen 副本）
    ;(callerFrame as { originECEF: { x: number } }).originECEF.x = 999
    const stored = scoped.getFrame('f2')!
    expect(stored).not.toBe(callerFrame)
    expect(stored.originECEF.x).toBe(1)
    expect(() => { (stored.originECEF as { x: number }).x = 0 }).toThrow(TypeError)
    void baselineX
  })

  it('C: close 后 sites.register 在 inner create 前拒绝（无瞬时增删）', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const scoped = scopedWorldApi(world, scope)
    scope.close()
    expect(() =>
      scoped.sites.register({
        id: 'late-site',
        name: 'Late',
        origin: { ...GEO },
        bounds: { south: 1, west: 1, north: 2, east: 2 }
      })
    ).toThrow(SceneScopeClosedError)
    expect(world.sites.get('late-site')).toBeUndefined()
    expect(world.sites.list().length).toBe(0)
  })

  it('C: close 后 onSessionChanged/onTick/onChange 在 inner create 前拒绝', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const selection = createSelectionApi()
    const spatial = createSpatialApi()
    const scopedWorld = scopedWorldApi(world, scope)
    const scopedSelection = scopedSelectionApi(selection, scope)
    const scopedSpatial = scopedSpatialApi(spatial, scope)
    scope.close()

    let sessionEvents = 0
    let tickEvents = 0
    let selectionEvents = 0
    let frameEvents = 0
    expect(() => scopedWorld.onSessionChanged(() => sessionEvents++)).toThrow(
      SceneScopeClosedError
    )
    expect(() => scopedWorld.time.onTick(() => tickEvents++)).toThrow(SceneScopeClosedError)
    expect(() => scopedSelection.onChange(() => selectionEvents++)).toThrow(
      SceneScopeClosedError
    )
    expect(() => scopedSpatial.onActiveFrameChanged(() => frameEvents++)).toThrow(
      SceneScopeClosedError
    )
    // listener 从未注册：inner 状态变化不触发任何回调
    world.setMode('history')
    selection.setPrimary({ namespace: 'v', id: 'x' })
    spatial.setActiveFrame(undefined)
    expect(sessionEvents).toBe(0)
    expect(tickEvents).toBe(0)
    expect(selectionEvents).toBe(0)
    expect(frameEvents).toBe(0)
  })
})
