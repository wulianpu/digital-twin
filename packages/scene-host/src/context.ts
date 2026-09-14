import { SceneUnmountedError, type SceneContext, type SceneId } from '@twin/sdk'

export interface ContextServices {
  world: SceneContext['world']
  spatial: SceneContext['spatial']
  data: SceneContext['data']
  selection: SceneContext['selection']
  view: SceneContext['view']
  assets: SceneContext['assets']
  ui: UiApiLike
  map?: SceneContext['map']
  graphics?: SceneContext['graphics']
}

interface UiApiLike {
  container: HTMLElement
  createLayer(options?: { order?: number; className?: string }): {
    element: HTMLElement
    dispose(): void
  }
}

export type ContextState = 'active' | 'unmounting' | 'revoked'

/**
 * Build a SceneContext whose surface is revoked after unmount (§13):
 * after `revoke()` any property access throws `SceneUnmountedError`, so a
 * zombie scene's stale async callbacks cannot write back into the platform.
 * `signal` remains readable (it reports aborted) for finally-blocks.
 */
export function createRevocableContext(
  sceneId: SceneId,
  services: ContextServices,
  signal: AbortSignal
): { context: SceneContext; revoke(): void; state(): ContextState } {
  let state: ContextState = 'active'

  const target: SceneContext = {
    sceneId,
    world: services.world,
    spatial: services.spatial,
    data: services.data,
    selection: services.selection,
    view: services.view,
    assets: services.assets,
    ui: services.ui,
    ...(services.map !== undefined ? { map: services.map } : {}),
    ...(services.graphics !== undefined ? { graphics: services.graphics } : {}),
    signal
  }

  const context = new Proxy(target, {
    get(obj, property, receiver) {
      if (state === 'revoked' && property !== 'signal' && property !== 'sceneId') {
        throw new SceneUnmountedError(sceneId, String(property))
      }
      return Reflect.get(obj, property, receiver)
    }
  })

  return {
    context,
    state: () => state,
    revoke: () => {
      state = 'revoked'
    }
  }
}
