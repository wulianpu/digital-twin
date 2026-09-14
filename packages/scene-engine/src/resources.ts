import type { AssetApi, AssetLease } from '@twin/sdk'
import type { AssetDescriptor, AssetRef } from '@twin/content'
import { assetRefKey } from '@twin/content'

/**
 * AssetApi / AssetLease (§43-44): platform owns shared assets; scenes only
 * lease and release. Refcounted — the last release disposes GPU resources.
 * NOTE: this module must not statically import three (the public entry
 * re-exports it); heavy loaders are dynamically imported on first use.
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
}

interface GLTFLoaderLike {
  loadAsync(url: string): Promise<{ scene: unknown }>
}

export class AssetLeaseManager implements AssetApi {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly sources = new Map<string, AssetSource>()
  private readonly resolvedBytes = new Map<string, number>()
  private gltfLoader: Promise<GLTFLoaderLike> | undefined

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
    const key = assetRefKey(ref)
    let entry = this.cache.get(key)
    if (!entry) {
      entry = { refCount: 0, load: this.load(ref) }
      this.cache.set(key, entry)
    }
    entry.refCount++
    const loaded = await entry.load
    this.resolvedBytes.set(key, loaded.estimatedBytes)
    // 内存预算（I4-2）：超预算则回退本次租约并拒绝。
    const maxBytes = this.options.maxTotalBytes
    if (maxBytes !== undefined && this.estimatedBytesTotal > maxBytes) {
      entry.refCount--
      if (entry.refCount <= 0) {
        this.cache.delete(key)
        this.resolvedBytes.delete(key)
        void entry.load.then((l) => l.dispose()).catch(() => {})
      }
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
        if (!current) return
        current.refCount--
        if (current.refCount <= 0) {
          this.cache.delete(key)
          this.resolvedBytes.delete(key)
          void current.load.then((l) => l.dispose()).catch(() => {})
        }
      }
    }
  }

  registerSource(source: AssetSource): void {
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

  dispose(): void {
    this.cache.clear()
  }
}

/** Deep-dispose a GLB scene graph's GPU resources (Owned by the manager). */
function disposeObject3D(root: Disposable3D): void {
  root.traverse?.((obj: unknown) => {
    const mesh = obj as { geometry?: { dispose(): void }; material?: unknown }
    mesh.geometry?.dispose?.()
    const material = mesh.material as
      | { dispose?(): void }
      | Array<{ dispose?(): void }>
      | undefined
    if (Array.isArray(material)) material.forEach((m) => m.dispose?.())
    else material?.dispose?.()
  })
}

interface Disposable3D {
  traverse?(cb: (obj: unknown) => void): void
}
