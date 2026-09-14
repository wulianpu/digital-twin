import { defineStore } from 'pinia'
import type { SceneId, WorldMode } from '@twin/sdk'

/**
 * App-level Pinia stores (§62): ONLY user / world session / active scene /
 * portal shell state. Scene business state lives inside scenes.
 */
export const useSessionStore = defineStore('session', {
  state: () => ({
    user: { name: '演示用户', permissions: ['scene:production', 'scene:simulation'] },
    worldMode: 'live' as WorldMode,
    activeSiteId: undefined as string | undefined,
    timeSpeed: 1,
    coordinatorState: 'idle' as string,
    activeSceneId: undefined as SceneId | undefined,
    loadingSceneId: undefined as SceneId | undefined,
    lastError: undefined as string | undefined,
    diagnosticsOpen: false
  }),
  actions: {
    setCoordinator(state: { kind: string; target?: string; sceneId?: string; error?: unknown }) {
      this.coordinatorState = state.kind
      this.loadingSceneId = state.kind === 'loading' ? state.target : undefined
      this.activeSceneId = state.kind === 'active' ? state.sceneId : this.activeSceneId
      if (state.kind === 'error') {
        this.lastError = String(state.error)
      } else if (state.kind === 'denied') {
        this.lastError = `权限不足：无法进入「${state.sceneId}」`
      } else {
        this.lastError = undefined
      }
    }
  }
})
