import type { Vec2 } from './public'

/**
 * 演示路网（单一事实源，A3）：行车导航场景的展示路网与演示网关的
 * AGV 行驶路线共用同一来源——AGV 沿显示的道路行驶（§90：World 定义有什么，
 * 不允许"业务手工移动模型对齐"）。
 */

export const DEMO_MAIN_ROAD: Vec2[] = [
  { x: -400, y: -250 },
  { x: 200, y: -250 },
  { x: 420, y: -120 },
  { x: 420, y: 180 }
]

export const DEMO_DOCK_ROAD: Vec2[] = [
  { x: 200, y: -250 },
  { x: 200, y: 60 },
  { x: 40, y: 160 },
  { x: -300, y: 160 }
]

export const DEMO_YARD_ROAD: Vec2[] = [
  { x: -400, y: -250 },
  { x: -430, y: 40 },
  { x: -300, y: 160 }
]

/** AGV 巡航环线：主干道去程 + 回程（闭合）。 */
export const DEMO_AGV_LOOP: Vec2[] = [
  ...DEMO_MAIN_ROAD,
  ...[...DEMO_MAIN_ROAD.slice(1, -1)].reverse()
]
