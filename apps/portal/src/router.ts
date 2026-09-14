import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { SCENE_CATALOG } from './catalog'

/**
 * URL ↔ Scene sync (§10). The route only records which scene is selected;
 * the viewport is persistent (§27/§54: view & shell never remount the world).
 */
export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/scene/global-ships'
  },
  {
    path: '/scene/:sceneId',
    component: () => import('./shell/SceneRoute.vue')
  }
]

export function createPortalRouter() {
  return createRouter({
    history: createWebHashHistory(),
    routes,
    scrollBehavior: () => ({ left: 0, top: 0 })
  })
}

export function isKnownScene(sceneId: string): boolean {
  return SCENE_CATALOG.some((d) => d.id === sceneId)
}
