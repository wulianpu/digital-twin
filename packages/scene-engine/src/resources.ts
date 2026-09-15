import type { AssetApi, AssetLease } from '@twin/sdk'
import type { AssetDescriptor, AssetRef } from '@twin/content'
import { assetRefKey } from '@twin/content'

/**
 * AssetApi / AssetLease (§43-44): platform owns shared assets; scenes only
 * lease and release. Refcounted — the last release disposes GPU resources.
 * NOTE: this module must not statically import three (the public entry
 * re-exports it); heavy loaders are dynamically imported on first use.
 *
 * Issue #12（生命周期闭环）：
 * - load reject → 失败 entry 原子驱逐（compare-by-entry identity），
 *   refCount 回滚，后续 acquire 创建新 load 并可重试，失败不再永久中毒；
 * - manager `disposed` 终态：dispose 幂等、acquire fail-fast、
 *   pending load late resolve 的 LoadedAsset 被 exactly-once 回收且不返回 Lease；
 * - `dispose()` 真正释放全部 owned 资源（resolved / pending / active lease），
 *   resolvedBytes / leaseCount 归零；
 * - GLTF GPU 回收覆盖 geometry / material / material 引用的 Texture
 *   （共享 texture 按 identity 去重）。
 */

export interface LoadedAsset {
  object: unknown
  estimatedBytes: number
  dispose(): void
}

export interface AssetSource {
  /** Scheme the source handles, e.g. 'https:', 'memory:'. */
  readonly scheme: string
  load(descriptor: AssetDescriptor): Promise<LoadedAsset>
}

export interface AssetApiOptions {
  /** Resolve a ref to a descriptor via the ContentRegistry. */
  resolve(ref: AssetRef): AssetDescriptor | undefined
  /** Extra sources, e.g. a memory source for tests/demos. */
  sources?: readonly AssetSource[]
  /**
   * 资产总字节预算（I4-2 内存预算接线）：所有活跃租约的估算字节之和
   * 超过该值时，新的 acquire 被拒绝（错误信息含当前用量）。
   */
  maxTotalBytes?: number
  /**
   * GLTFLoader 装配钩子（I4-2）：KTX2 / DRACO / meshopt 解码器在应用层
   * 组合注入（组合根持有 renderer 与部署配置，平台层保持无感知）。
   */
  gltfLoaderEnhancer?: (loader: unknown) => Promise<void> | void
}

interface CacheEntry {
  refCount: number
  load: Promise<LoadedAsset>
  /** resolve 后填充；驱逐/释放时优先用它做 exactly-once dispose。 */
  loaded?: LoadedAsset
  /** entry 已被驱逐/释放（迟到的 acquire continuation 不得再返回 Lease）。 */
  disposed: boolean
}

interface GLTFLoaderLike {
  loadAsync(url: string): Promise<{ scene: unknown }>
}

export class AssetLeaseManager implements AssetApi {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly sources = new Map<string, AssetSource>()
  private readonly resolvedBytes = new Map<string, number>()
  /** exactly-once dispose 的 identity 账本（WeakSet 不阻止 GC）。 */
  private readonly disposedAssets = new WeakSet<LoadedAsset>()
  private gltfLoader: Promise<GLTFLoaderLike> | undefined
  private disposed = false

  constructor(private readonly options: AssetApiOptions) {
    for (const source of options.sources ?? []) {
      this.sources.set(source.scheme, source)
    }
  }

  get leaseCount(): number {
    let count = 0
    for (const entry of this.cache.values()) count += entry.refCount
    return count
  }

  /** 活跃租约的估算字节总量（I4-2 预算与诊断）。 */
  get estimatedBytesTotal(): number {
    let total = 0
    for (const bytes of this.resolvedBytes.values()) total += bytes
    return total
  }

  async acquire(ref: AssetRef): Promise<AssetLease> {
    if (this.disposed) {
      throw new Error('[scene-engine] asset manager disposed (Issue #12 terminal state)')
    }
    const key = assetRefKey(ref)
    let entry = this.cache.get(key)
    if (!entry) {
      entry = { refCount: 0, load: this.load(ref), disposed: false }
      this.cache.set(key, entry)
    }
    entry.refCount++
    let loaded: LoadedAsset
    try {
      loaded = await entry.load
    } catch (error) {
      // #12-A：load reject → 本次/并发 claimant 各自回滚 refCount；
      // 最后一个 claimant 按 entry identity 原子驱逐中毒 entry——
      // 后续 acquire 会创建新的 load Promise 并可重试。
      entry.refCount--
      if (entry.refCount <= 0) this.evictEntry(key, entry)
      throw error
    }
    if (this.disposed || entry.disposed) {
      // #12-B：manager/entry teardown 后 late resolve——
      // 资源 exactly-once 回收，绝不返回逃逸的 Lease。
      this.disposeLoadedOnce(loaded)
      entry.refCount--
      throw new Error(`[scene-engine] asset "${key}" lease aborted (manager disposed)`)
    }
    entry.loaded = loaded // resolve 即登记，驱逐/释放路径可同步 exactly-once dispose
    this.resolvedBytes.set(key, loaded.estimatedBytes)
    // 内存预算（I4-2）：超预算则回退本次租约并拒绝。
    const maxBytes = this.options.maxTotalBytes
    if (maxBytes !== undefined && this.estimatedBytesTotal > maxBytes) {
      entry.refCount--
      if (entry.refCount <= 0) this.evictEntry(key, entry)
      throw new Error(
        `[scene-engine] asset budget exceeded: ${this.estimatedBytesTotal}B > ${maxBytes}B (ref "${key}")`
      )
    }
    let released = false
    return {
      ref,
      version: ref.version ?? '0',
      object: loaded.object,
      estimatedBytes: loaded.estimatedBytes,
      release: () => {
        if (released) return
        released = true
        const current = this.cache.get(key)
        if (!current) return // manager dispose 已兜底回收（幂等）
        current.refCount--
        if (current.refCount <= 0) this.evictEntry(key, current)
      }
    }
  }

  registerSource(source: AssetSource): void {
    if (this.disposed) {
      throw new Error('[scene-engine] asset manager disposed (registerSource rejected)')
    }
    this.sources.set(source.scheme, source)
  }

  private async load(ref: AssetRef): Promise<LoadedAsset> {
    const descriptor = this.options.resolve(ref)
    if (!descriptor) throw new Error(`[scene-engine] unknown asset ref "${assetRefKey(ref)}"`)
    const url = descriptor.url
    if (!url) throw new Error(`[scene-engine] asset "${assetRefKey(ref)}" has no url`)
    const scheme = url.slice(0, url.indexOf(':') + 1) || 'https:'
    const source = this.sources.get(scheme)
    if (source) return source.load(descriptor)
    // data: URL 支持（内嵌资产 / 测试）；与 http(s) 一样走 GLTFLoader。
    if (scheme === 'https:' || scheme === 'http:' || scheme === 'data:') {
      return this.loadGltf(url, descriptor)
    }
    throw new Error(`[scene-engine] no asset source for scheme "${scheme}"`)
  }

  private async loadGltf(url: string, descriptor: AssetDescriptor): Promise<LoadedAsset> {
    this.gltfLoader ??= this.buildGltfLoader()
    const loader = await this.gltfLoader
    const gltf = await loader.loadAsync(url)
    const scene = gltf.scene
    return {
      object: scene,
      // 清单声明的字节数（生成器/资产服务器提供）用于内存预算与诊断。
      estimatedBytes: descriptor.bytes ?? 0,
      dispose: () => {
        disposeObject3D(scene as Disposable3D)
      }
    }
  }

  private async buildGltfLoader(): Promise<GLTFLoaderLike> {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const loader = new GLTFLoader() as unknown as GLTFLoaderLike
    // I4-2: 解码器装配在应用层完成（组合根注入）。
    await this.options.gltfLoaderEnhancer?.(loader)
    return loader
  }

  /**
   * #12-C：terminal teardown——按 entry identity 原子驱逐：
   * resolved → exactly-once dispose；pending → resolve 后自动回收。
   * 旧失败 continuation 因 identity 不匹配不会误删新 generation entry。
   */
  private evictEntry(key: string, entry: CacheEntry): void {
    if (this.cache.get(key) !== entry) return
    this.cache.delete(key)
    entry.disposed = true
    this.resolvedBytes.delete(key)
    if (entry.loaded) {
      this.disposeLoadedOnce(entry.loaded)
    } else {
      void entry.load
        .then((loaded) => this.disposeLoadedOnce(loaded))
        .catch(() => {})
    }
  }

  private disposeLoadedOnce(loaded: LoadedAsset): void {
    if (this.disposedAssets.has(loaded)) return
    this.disposedAssets.add(loaded)
    loaded.dispose()
  }

  /**
   * #12-C：terminal teardown——真正释放全部 owned 资源：
   * resolved entry 立即 dispose，pending entry resolve 后自动 dispose，
   * resolvedBytes / cache / leaseCount 全部归零；幂等。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [key, entry] of [...this.cache]) {
      entry.disposed = true
      entry.refCount = 0
      this.resolvedBytes.delete(key)
      if (entry.loaded) {
        this.disposeLoadedOnce(entry.loaded)
      } else {
        void entry.load
          .then((loaded) => this.disposeLoadedOnce(loaded))
          .catch(() => {})
      }
    }
    this.cache.clear()
  }
}

/** Deep-dispose a GLB scene graph's GPU resources (Owned by the manager). */
/** 导出供测试与 GLTF 路径复用（不在 public.ts 暴露给 Scene）。 */
export function disposeObject3D(root: Disposable3D): void {
  // #12-D：Geometry/Material/Texture 都可能被共享——统一按 identity 去重，
  // 保证每个 GPU 对象 exactly-once dispose。
  const seen = new WeakSet<object>()
  const disposeOnce = (resource: { dispose(): void }): void => {
    if (seen.has(resource)) return
    seen.add(resource)
    resource.dispose()
  }
  root.traverse?.((obj: unknown) => {
    const mesh = obj as { geometry?: { dispose(): void }; material?: unknown }
    if (mesh.geometry) disposeOnce(mesh.geometry)
    const material = mesh.material as
      | { dispose?(): void }
      | Array<{ dispose?(): void }>
      | undefined
    const materials = Array.isArray(material) ? material : material ? [material] : []
    for (const mat of materials) {
      if (mat.dispose) disposeOnce(mat as { dispose(): void })
      // Material.dispose() 不会释放其引用的 Texture——显式遍历属性槽位
      for (const value of Object.values(mat as Record<string, unknown>)) {
        if (isTextureLike(value)) disposeOnce(value)
      }
    }
  })
}

interface TextureLike {
  isTexture: boolean
  dispose(): void
}

function isTextureLike(value: unknown): value is TextureLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTexture?: unknown }).isTexture === true &&
    typeof (value as { dispose?: unknown }).dispose === 'function'
  )
}

interface Disposable3D {
  traverse?(cb: (obj: unknown) => void): void
}
