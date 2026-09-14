import { describe, expect, it, vi } from 'vitest'
import { FrameLoop } from './src/frameLoop'
import { AdaptiveQuality, profileSettings } from './src/adaptive'
import { TilesSystem, type TilesRendererLike } from './src/tiles'
import { AssetLeaseManager } from './src/resources'
import { createSceneViewDriver, siteExtentMeters } from './src/driver'
import { ContextLossGuard } from './src/contextLoss'

// Node 缺少浏览器 ProgressEvent（three FileLoader 的 fetch 进度路径需要），
// data: URL 全链路测试前补桩。
const globalStub = globalThis as Record<string, unknown>
globalStub.ProgressEvent ??= class {
  lengthComputable = false
  loaded = 0
  total = 0
}

describe('FrameLoop', () => {
  it('runs manual frames, reports frame index, and unregisters callbacks', () => {
    const loop = new FrameLoop()
    let calls = 0
    const dispose = loop.onFrame(() => calls++)
    loop.runFrame(0)
    loop.runFrame(16)
    loop.runFrame(33)
    expect(calls).toBe(3)
    expect(loop.frameIndex).toBe(3)
    dispose()
    loop.runFrame(50)
    expect(calls).toBe(3)
    loop.dispose()
  })

  it('computes p50/p95 from recorded frame times', () => {
    const loop = new FrameLoop(() => 0, 0)
    let t = 0
    for (let i = 0; i < 100; i++) {
      loop.runFrame(t)
      t += i < 90 ? 16 : 50
    }
    expect(loop.p50Ms).toBeLessThanOrEqual(17)
    expect(loop.p95Ms).toBeGreaterThan(30)
  })
})

describe('AdaptiveQuality', () => {
  it('downgrades under pressure and holds a cooldown afterwards', () => {
    const applied: string[] = []
    const adaptive = new AdaptiveQuality('HIGH', 'HIGH', (p) => applied.push(p))
    adaptive.sample(80)
    expect(adaptive.profile).toBe('STANDARD')
    adaptive.sample(10)
    expect(adaptive.profile).toBe('STANDARD') // cooldown: change not immediate
  })

  it('upgrades when fast and respects cooldown after a change', () => {
    const applied: string[] = []
    const adaptive = new AdaptiveQuality('STANDARD', 'HIGH', (p) => applied.push(p))
    for (let i = 0; i < 400; i++) adaptive.sample(15)
    expect(adaptive.profile).toBe('HIGH')
  })
})

describe('profileSettings', () => {
  it('maps profiles to rendering policy', () => {
    expect(profileSettings('OFFICE').shadows).toBe(false)
    expect(profileSettings('EXHIBITION').shadows).toBe(true)
    expect(profileSettings('EXHIBITION').maxPixelRatio).toBeGreaterThan(
      profileSettings('OFFICE').maxPixelRatio
    )
  })
})

describe('TilesSystem', () => {
  function fakeRenderer(): TilesRendererLike {
    return {
      group: { removeFromParent: () => {} } as never,
      setCamera: () => {},
      setResolution: () => {},
      update: () => {},
      dispose: vi.fn(),
      lruCache: {
        maxBytesSize: 0,
        maxItemSize: 0,
        cachedBytes: 1234,
        cachedItems: 3,
        isFull: false
      },
      downloadQueue: { size: 2 },
      parseQueue: { size: 1 },
      stats: { downloaded: 10, parsed: 9, failed: 1, visible: 4, inFrustum: 5 }
    }
  }

  it('enforces the explicit byte budget policy (§49)', async () => {
    const system = new TilesSystem({ maxBytes: 512 * 1024 * 1024, maxItems: 2048 }, async () => {
      const r = fakeRenderer()
      created.push(r)
      return r
    })
    const created: TilesRendererLike[] = []
    await system.addTileset('https://tiles.test/tileset.json')
    expect(created[0].lruCache?.maxBytesSize).toBe(512 * 1024 * 1024)
    expect(created[0].lruCache?.maxItemSize).toBe(2048)

    const diag = system.diagnostics()
    expect(diag.cachedBytes).toBe(1234)
    expect(diag.downloading).toBe(2)
    expect(diag.parsing).toBe(1)
    expect(diag.failed).toBe(1)

    system.dispose()
    expect(system.tilesetCount).toBe(0)
  })

  it('rejects duplicate tileset urls', async () => {
    const system = new TilesSystem({}, async () => fakeRenderer())
    await system.addTileset('https://tiles.test/a.json')
    await expect(system.addTileset('https://tiles.test/a.json')).rejects.toThrowError(/already registered/)
    system.dispose()
  })
})

describe('AssetLeaseManager', () => {
  const memorySource = {
    scheme: 'memory:',
    load: async (descriptor: { url?: string }) => ({
      object: { name: descriptor.url },
      estimatedBytes: 100,
      dispose: vi.fn()
    })
  }

  function makeManager() {
    return new AssetLeaseManager({
      resolve: (ref) =>
        ref.id === 'crane-glb'
          ? { ref, kind: 'glb', url: 'memory:crane-glb' }
          : undefined
      ,
      sources: [memorySource]
    })
  }

  it('leases share one load and refcount releases', async () => {
    const manager = makeManager()
    const lease1 = await manager.acquire({ id: 'crane-glb' })
    const lease2 = await manager.acquire({ id: 'crane-glb' })
    expect(manager.leaseCount).toBe(2)
    expect((lease1.object as { name: string }).name).toBe('memory:crane-glb')
    lease1.release()
    expect(manager.leaseCount).toBe(1)
    lease2.release()
    expect(manager.leaseCount).toBe(0)
  })

  it('double release is idempotent and unknown refs throw', async () => {
    const manager = makeManager()
    const lease = await manager.acquire({ id: 'crane-glb' })
    lease.release()
    lease.release()
    expect(manager.leaseCount).toBe(0)
    await expect(manager.acquire({ id: 'ghost' })).rejects.toThrowError(/unknown asset ref/)
  })
})

describe('AssetLeaseManager 内存预算与解码器装配 (I4-2)', () => {
  function makeManager(options: { maxTotalBytes?: number; enhancer?: (loader: unknown) => Promise<void> }) {
    return new AssetLeaseManager({
      resolve: (ref) =>
        ref.id === 'heavy-glb'
          ? { ref, kind: 'glb' as const, url: 'memory:heavy', bytes: 600 }
          : undefined,
      sources: [
        {
          scheme: 'memory:',
          load: async (descriptor: { url?: string; bytes?: number }) => ({
            object: { name: descriptor.url },
            estimatedBytes: descriptor.bytes ?? 0,
            dispose: vi.fn()
          })
        }
      ],
      maxTotalBytes: options.maxTotalBytes,
      gltfLoaderEnhancer: options.enhancer
    })
  }

  it('超内存预算拒绝 acquire 并回退租约', async () => {
    const manager = makeManager({ maxTotalBytes: 500 })
    await expect(manager.acquire({ id: 'heavy-glb' })).rejects.toThrowError(/budget exceeded/)
    expect(manager.leaseCount).toBe(0)
    expect(manager.estimatedBytesTotal).toBe(0)
  })

  it('预算内租约累计估算字节，释放后归零', async () => {
    const manager = makeManager({ maxTotalBytes: 1000 })
    const lease = await manager.acquire({ id: 'heavy-glb' })
    expect(manager.estimatedBytesTotal).toBe(600)
    lease.release()
    expect(manager.estimatedBytesTotal).toBe(0)
  })

  it('gltfLoaderEnhancer 在 GLB 解析前被调用（data: URL 全链路）', async () => {
    // 最小 GLB：一个三角形（POSITION only）
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }]
    }
    const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)
    const json = Buffer.from(JSON.stringify(gltf), 'utf8')
    const total = 12 + 8 + json.length + 8 + bin.length
    const glb = Buffer.alloc(total)
    const view = new DataView(glb.buffer)
    view.setUint32(0, 0x46546c67, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, total, true)
    view.setUint32(12, json.length, true)
    view.setUint32(16, 0x4e4f534a, true)
    json.copy(glb, 20)
    view.setUint32(20 + json.length, bin.length, true)
    view.setUint32(24 + json.length, 0x004e4942, true)
    bin.copy(glb, 28 + json.length)

    const enhanced: unknown[] = []
    const manager = new AssetLeaseManager({
      resolve: (ref) =>
        ref.id === 'tiny'
          ? {
              ref,
              kind: 'glb' as const,
              url: `data:model/gltf-binary;base64,${glb.toString('base64')}`
            }
          : undefined,
      gltfLoaderEnhancer: async (loader) => {
        enhanced.push(loader)
      }
    })
    const lease = await manager.acquire({ id: 'tiny' })
    expect(enhanced).toHaveLength(1)
    const scene = lease.object as { children: Array<unknown> }
    expect(scene.children.length).toBeGreaterThan(0)
  })

  it('enhancer 抛错 → acquire 失败（装配先于加载）', async () => {
    const manager = new AssetLeaseManager({
      resolve: (ref) =>
        ref.id === 'tiny'
          ? { ref, kind: 'glb' as const, url: 'data:model/gltf-binary;base64,AAAA' }
          : undefined,
      gltfLoaderEnhancer: async () => {
        throw new Error('decoder setup failed')
      }
    })
    await expect(manager.acquire({ id: 'tiny' })).rejects.toThrowError(/decoder setup failed/)
  })
})


describe('ContextLossGuard (§75, I5-4)', () => {
  it('丢失→停帧+preventDefault；恢复→重置状态+续跑', () => {
    const target = new EventTarget()
    let suspended = 0
    let resumed = 0
    let resets = 0
    let defaultPrevented = false
    const guard = new ContextLossGuard(target, {
      suspendLoop: () => suspended++,
      resumeLoop: () => resumed++,
      resetRendererState: () => resets++
    })
    target.addEventListener('webglcontextlost', (e) => {
      defaultPrevented = (e as Event).defaultPrevented
    })
    // 与浏览器一致：webglcontextlost 是 cancelable 事件
    target.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(suspended).toBe(1)
    expect(guard.lost).toBe(true)
    expect(defaultPrevented).toBe(true) // 允许随后恢复

    target.dispatchEvent(new Event('webglcontextrestored'))
    expect(resumed).toBe(1)
    expect(resets).toBe(1)
    expect(guard.lost).toBe(false)

    guard.dispose()
    // 与浏览器一致：webglcontextlost 是 cancelable 事件
    target.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(suspended).toBe(1) // dispose 后不再响应
  })
})

describe('SceneViewDriver', () => {
  it('delegates focus/target to the handle', async () => {
    const focusEntity = vi.fn((_entity: { namespace: string; id: string }, _range?: number) => true)
    const applyGeodeticTarget = vi.fn()
    const driver = createSceneViewDriver({
      getHandle: () => ({
        focusEntity,
        applyGeodeticTarget,
        getGeodeticTarget: () => ({
          target: {
            longitudeDegrees: 121.5,
            latitudeDegrees: 31.2,
            heightMeters: 0,
            verticalReference: 'ellipsoid' as const
          },
          scaleMeters: 800
        })
      }),
      getSites: () =>
        new Map([
          [
            'site-x',
            {
              origin: {
                longitudeDegrees: 121.5,
                latitudeDegrees: 31.2,
                heightMeters: 0,
                verticalReference: 'ellipsoid' as const
              }
            }
          ]
        ])
    })
    await driver.focus({ namespace: 'production', id: 'CRANE-003' })
    expect(focusEntity).toHaveBeenCalledTimes(1)
    expect(focusEntity.mock.calls[0][0]).toEqual({
      namespace: 'production',
      id: 'CRANE-003'
    })
    const target = driver.getTarget()
    expect(target?.scaleMeters).toBe(800)
    await driver.goToSite('site-x')
    expect(applyGeodeticTarget).toHaveBeenCalled()
  })

  it('siteExtentMeters estimates from bounds', () => {
    const extent = siteExtentMeters({ south: 31, west: 121, north: 31.1, east: 121.1 })
    expect(extent).toBeGreaterThan(8000)
    expect(extent).toBeLessThan(13000)
    expect(siteExtentMeters(undefined)).toBeUndefined()
  })
})
