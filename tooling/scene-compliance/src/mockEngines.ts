import * as THREE from 'three'
import type {
  AssetApi,
  DataApi,
  DataEnvelope,
  DataQuery,
  EnvelopeHandler,
  GraphicsAccess,
  GraphicsContext,
  MapAccess,
  MapContext,
  PickEvent,
  SubscribeOptions,
  WaterState
} from '@twin/sdk'

/**
 * Compliance mock engines: they RECORD every scene-owned resource so the
 * harness can verify cleanup (§72). Real Three objects are used for the
 * graphics root because scenes build real geometry — no WebGL needed.
 */

export interface MockCounters {
  mapLayers: number
  mapSources: number
  mapListeners: number
  frameCallbacks: number
  pickCallbacks: number
  dataSubscriptions: number
  graphicsUseCalls: number
  graphicsSuspends: number
  graphicsResumes: number
  waterStateSets: number
  suspends: number
  resumes: number
}

export function freshCounters(): MockCounters {
  return {
    mapLayers: 0,
    mapSources: 0,
    mapListeners: 0,
    frameCallbacks: 0,
    pickCallbacks: 0,
    dataSubscriptions: 0,
    graphicsUseCalls: 0,
    graphicsSuspends: 0,
    graphicsResumes: 0,
    waterStateSets: 0,
    suspends: 0,
    resumes: 0
  }
}

type AnyRecord = Record<string, unknown>

export function createMockMap(counters: MockCounters): MapContext {
  const listeners = new Map<string, Set<(event?: unknown) => void>>()
  const featureStates = new Map<string, unknown>()

  const instance = {
    addSource(id: string) {
      counters.mapSources++
      void id
    },
    removeSource(_id: string) {
      counters.mapSources--
    },
    getSource(_id: string) {
      return counters.mapSources > 0 ? { setData: () => {} } : undefined
    },
    addLayer(layer: { id: string }) {
      counters.mapLayers++
      void layer
    },
    removeLayer(_id: string) {
      counters.mapLayers--
    },
    getLayer(_id: string) {
      return counters.mapLayers > 0 ? { id: '_id' } : undefined
    },
    on(type: string, cb: (event?: unknown) => void) {
      counters.mapListeners++
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    off(type: string, cb: (event?: unknown) => void) {
      counters.mapListeners--
      listeners.get(type)?.delete(cb)
    },
    setFeatureState(target: { source: string; id?: unknown }, state: unknown) {
      featureStates.set(`${target.source}:${String(target.id)}`, state)
    },
    setPaintProperty() {},
    setFilter() {},
    queryRenderedFeatures() {
      return []
    },
    getCanvas() {
      return { clientWidth: 1024, clientHeight: 768, addEventListener() {}, removeEventListener() {} }
    },
    stop() {},
    resize() {},
    getCenter() {
      return { lng: 121.7821, lat: 31.3622 }
    },
    getZoom() {
      return 15
    },
    getBearing() {
      return 0
    },
    getPitch() {
      return 0
    },
    flyTo() {},
    fitBounds() {},
    jumpTo() {}
  } as unknown as AnyRecord

  return {
    instance: instance as never,
    container: document.createElement('div'),
    suspend: () => {
      counters.suspends++
    },
    resume: () => {
      counters.resumes++
    },
    resize: () => {},
    styleIssues: () => [],
    getViewState: () => ({
      center: { longitudeDegrees: 121.7821, latitudeDegrees: 31.3622, heightMeters: 0, verticalReference: 'ellipsoid' as const },
      zoom: 15,
      bearingRadians: 0,
      pitchRadians: 0
    }),
    dispose: () => {}
  }
}

export class MockMapAccess implements MapAccess {
  private context: MapContext | undefined
  state = 'UNINITIALIZED' as 'UNINITIALIZED' | 'ACTIVE' | 'DISPOSED'

  constructor(private readonly counters: MockCounters) {}

  get currentContext(): MapContext | undefined {
    return this.context
  }

  use(): Promise<MapContext> {
    if (!this.context) {
      this.context = createMockMap(this.counters)
      this.state = 'ACTIVE'
    }
    return Promise.resolve(this.context)
  }

  dispose(): void {
    this.state = 'DISPOSED'
    this.context = undefined
  }
}

export class MockGraphicsAccess implements GraphicsAccess {
  readonly context: GraphicsContext
  state = 'UNINITIALIZED' as 'UNINITIALIZED' | 'ACTIVE' | 'DISPOSED'
  /**
   * Issue #18：可控 deferred use gate——Promise 未 resolve 时 use() 挂起，
   * 用于确定性复现“首次 3D boot 慢于下一次 view toggle”的竞态。
   */
  useGate: Promise<void> | undefined
  graphicsSuspends = 0
  graphicsResumes = 0
  private readonly frameSubs = new Set<
    (info: { deltaSeconds: number; elapsedSeconds: number; frameIndex: number }) => void
  >()

  constructor(private readonly counters: MockCounters) {
    const root = new THREE.Group()
    const frameSubs = this.frameSubs
    const pickSubs = new Set<(event: PickEvent) => void>()
    const entities = new Map<string, { getPosition(out: { x: number; y: number; z: number }): boolean }>()

    const waterStates: WaterState[] = []

    this.context = {
      root,
      renderScene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      renderer: {} as never,
      onFrame: (cb) => {
        counters.frameCallbacks++
        frameSubs.add(cb)
        return {
          dispose: () => {
            counters.frameCallbacks--
            frameSubs.delete(cb)
          }
        }
      },
      onPick: (cb) => {
        counters.pickCallbacks++
        pickSubs.add(cb)
        return {
          dispose: () => {
            counters.pickCallbacks--
            pickSubs.delete(cb)
          }
        }
      },
      environment: {
        setWaterState: (state) => {
          counters.waterStateSets++
          waterStates.push(state)
        },
        getWaterState: () => waterStates[waterStates.length - 1],
        get water() {
          return waterStates[waterStates.length - 1]
        }
      },
      global: {
        enabled: true,
        setObjectEcefPosition: (object) => {
          root.add(object)
        }
      },
      entities: {
        register: (entity, object) => {
          entities.set(`${entity.namespace}/${entity.id}`, {
            getPosition: (out) => {
              const p = (object as THREE.Object3D).position
              out.x = p.x
              out.y = p.y
              out.z = p.z
              return true
            }
          })
          return {
            dispose: () => {
              entities.delete(`${entity.namespace}/${entity.id}`)
            }
          }
        },
        getPosition: (entity, out) => {
          const entry = entities.get(`${entity.namespace}/${entity.id}`)
          return entry ? entry.getPosition(out) : false
        },
        has: (entity) => entities.has(`${entity.namespace}/${entity.id}`),
        get count() {
          return entities.size
        }
      },
      suspend: () => {
        counters.graphicsSuspends++
      },
      resume: () => {
        counters.graphicsResumes++
      },
      getDiagnostics: () =>
        ({
          quality: 'STANDARD',
          frame: { fps: 60, p50Ms: 16, p95Ms: 20, frameIndex: 0 },
          renderer: { drawCalls: 0, triangles: 0, textures: 0, geometries: 0, programs: 0 },
          tiles: undefined,
          entityCount: entities.size,
          frameCallbacks: frameSubs.size,
          assetLeases: 0,
          jsHeapMB: undefined
        }) as never
    }
  }

  get currentContext(): GraphicsContext | undefined {
    return this.context
  }

  use(): Promise<GraphicsContext> {
    this.counters.graphicsUseCalls++
    this.state = 'ACTIVE'
    if (this.useGate) {
      const context = this.context
      return this.useGate.then(() => context)
    }
    return Promise.resolve(this.context)
  }

  applyQuality(): void {}
  suspend(): void {
    this.graphicsSuspends++
  }
  resume(): void {
    this.graphicsResumes++
  }
  getDiagnostics(): undefined {
    return undefined
  }

  dispose(): void {
    this.state = 'DISPOSED'
  }

  /** Deterministic frame pump for the harness. */
  pumpFrames(cycles: number): void {
    const subs = [...this.frameSubs]
    for (let i = 0; i < cycles; i++) {
      for (const cb of subs) {
        cb({ deltaSeconds: 1 / 60, elapsedSeconds: (i + 1) / 60, frameIndex: i + 1 })
      }
    }
  }
}

export class MockDataApi implements DataApi {
  constructor(private readonly counters: MockCounters) {}

  readonly envelopes: DataEnvelope[] = []

  get mode(): 'live' {
    return 'live'
  }

  setMode(): void {}

  beginTimelineEpoch(): void {}

  async query(): Promise<readonly DataEnvelope[]> {
    return this.envelopes
  }

  subscribe(_query: DataQuery, _cb: EnvelopeHandler, _options?: SubscribeOptions) {
    this.counters.dataSubscriptions++
    let disposed = false
    const subscription = {
      query: _query,
      dispose: () => {
        if (disposed) return
        disposed = true
        this.counters.dataSubscriptions--
      }
    }
    return subscription
  }

  peek(): DataEnvelope | undefined {
    return undefined
  }

  emit(envelope: DataEnvelope): void {
    this.envelopes.push(envelope)
  }

  dispose(): void {}
}

export class MockAssetApi implements AssetApi {
  private readonly leases = new Map<string, { release(): void }>()

  get leaseCount(): number {
    return this.leases.size
  }

  async acquire(ref: { id: string; version?: string }): Promise<{ ref: { id: string; version?: string }; version: string; object: unknown; estimatedBytes: number; release(): void }> {
    const key = `${ref.id}@${ref.version ?? '0'}`
    const lease = {
      ref,
      version: ref.version ?? '0',
      object: {} as unknown,
      estimatedBytes: 128,
      release: () => {
        this.leases.delete(key)
      }
    }
    this.leases.set(key, lease)
    return lease
  }
}
