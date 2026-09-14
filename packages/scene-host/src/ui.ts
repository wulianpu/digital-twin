import type { UiApi, UiLayer, UiLayerOptions } from '@twin/sdk'
import type { Disposable } from '@twin/world'

/**
 * UiApi implementation. Layers are Foundation-owned resources: the SceneHost
 * tracks every created layer and removes them during teardown even if the
 * scene forgets (§9 "自动跟踪 Foundation-owned resources").
 */
export class UiApiImpl implements UiApi {
  private readonly layers: UiLayer[] = []

  constructor(readonly container: HTMLElement) {}

  get layerCount(): number {
    return this.layers.length
  }

  createLayer(options: UiLayerOptions = {}): UiLayer {
    const element = document.createElement('div')
    element.className = `twin-scene-layer${options.className ? ` ${options.className}` : ''}`
    element.dataset.layerOrder = String(options.order ?? 0)
    element.style.zIndex = String(10 + (options.order ?? 0))
    this.container.appendChild(element)

    let disposed = false
    const layer: UiLayer = {
      element,
      dispose: () => {
        if (disposed) return
        disposed = true
        element.remove()
        const index = this.layers.indexOf(layer)
        if (index >= 0) this.layers.splice(index, 1)
      }
    }
    this.layers.push(layer)
    return layer
  }

  /** Host-owned cleanup: remove everything still alive. Idempotent. */
  disposeAll(): void {
    for (const layer of [...this.layers]) layer.dispose()
    this.layers.length = 0
  }
}

export type { Disposable }
