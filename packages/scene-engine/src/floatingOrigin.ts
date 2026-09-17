import * as THREE from 'three'

/**
 * Issue #29：floating-origin 状态的唯一权威（Engine 内部 helper，不出 SDK）。
 *
 * 坐标不变量：
 *
 *   render = logical + offset
 *   logical = render - offset
 *
 * - GLOBAL：offset = -cameraPose（camera-relative ECEF，§37.2 / #17-r2）；
 * - SITE：offset 仅在 orbit pose 超过 FLOAT_ORIGIN_THRESHOLD_M 后累积重基准平移。
 *
 * 渲染期变换不得反向污染逻辑坐标（ViewApi / entity 定位 / 诊断）：
 * 任何从 render space 读回的坐标必须经 renderToLogical 恢复。
 */
export class FloatingOriginState {
  /** 当前 floating-origin 平移（render = logical + offset）。 */
  readonly offset = new THREE.Vector3()

  set(x: number, y: number, z: number): void {
    this.offset.set(x, y, z)
  }

  /** logical → render：把逻辑 scene 坐标平移进当前 render space（原地）。 */
  logicalToRender(v: THREE.Vector3): void {
    v.add(this.offset)
  }

  /** render → logical：剔除 floating-origin shift，恢复 Engine 逻辑坐标（原地）。 */
  renderToLogical(v: THREE.Vector3): void {
    v.sub(this.offset)
  }
}
