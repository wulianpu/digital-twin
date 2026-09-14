import type { SceneDefinition } from '@twin/sdk'

/**
 * Portal Scene catalog (§7.1): SceneDefinition only answers
 * 1) who the scene is, 2) may this user enter, 3) where code loads from.
 * It declares NO engines / assets / layers — those are scene internals (§8).
 * Scene code loads via dynamic import; hover preload warms the chunk (§61).
 */
export const SCENE_CATALOG: readonly SceneDefinition[] = [
  {
    id: 'global-ships',
    name: '全球船舶',
    description: '全球船舶态势与航迹',
    icon: '🌍',
    async load() {
      return (await import('@twin/scene-global-ships')).default
    }
  },
  {
    id: 'stack-yard',
    name: '分段堆场',
    description: '堆位状态与分段出入场',
    icon: '📦',
    async load() {
      return (await import('@twin/scene-stack-yard')).default
    }
  },
  {
    id: 'vehicle-navigation',
    name: '行车导航',
    description: '厂区 AGV / 车辆导航',
    icon: '🚚',
    async load() {
      return (await import('@twin/scene-vehicle-navigation')).default
    }
  },
  {
    id: 'production',
    name: '生产数字孪生',
    description: '船坞总装 / 龙门吊 / AGV 全要素',
    icon: '🏭',
    permissions: ['scene:production'],
    async load() {
      return (await import('@twin/scene-production')).default
    }
  },
  {
    id: 'heavy-transport',
    name: '大件运输',
    description: '重载路径规划与风险预检',
    icon: '🛻',
    async load() {
      return (await import('@twin/scene-heavy-transport')).default
    }
  }
]

/**
 * 权限模型：目录条目声明所需权限（§7.1 permissions）。
 * 用户权限来自 IdentityAdapter（见 identity.ts），由 SceneCoordinator 在
 * 进入前强制校验（I2-2），目录仅做可见性提示（置灰）。
 */
export function canEnter(definition: SceneDefinition, permissions: readonly string[]): boolean {
  if (!definition.permissions || definition.permissions.length === 0) return true
  return definition.permissions.every((p) => permissions.includes(p))
}
