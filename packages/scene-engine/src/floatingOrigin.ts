import * as THREE from 'three'

/** SITE floating-origin rebase 阈值（frame-local meters，§37.2）。 */
export const FLOAT_ORIGIN_THRESHOLD_M = 20_000

/**
 * Issue #29：floating-origin 状态的唯一权威（Engine 内部 helper，不出 SDK）。
 *
 * 坐标不变量：
 *
 *   render = logical + offset
 *   logical = render - offset
 *
 * - GLOBAL：offset = -cameraPose（camera-relative ECEF，§37.2 / #17-r2）；
 * - SITE：offset 仅在 rebase 时离散更新（updateSite，Issue #30）。
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

  /**
   * Issue #30：SITE 离散 rebase 状态机（无 WebGL、逐帧确定性）。
   *
   * 判定基于 **camera 相对当前 render origin 的位置**（render = p + offset），
   * 而非未重基准的 logical pose——否则同一 logical pose 会在阈值外每帧
   * 重复触发、offset 按 -p 无界累积。rebase 把当前 logical camera 设为新的
   * render origin（offset = -p），camera render position 回到原点。
   *
   * 关键不变量：logical camera 不再跨越阈值时，下一帧判定必为 false，
   * offset 保持稳定；返回值指示本帧是否发生了 rebase。
   */
  updateSite(
    p: { x: number; y: number; z: number },
    thresholdM: number = FLOAT_ORIGIN_THRESHOLD_M
  ): boolean {
    const rx = p.x + this.offset.x
    const ry = p.y + this.offset.y
    const rz = p.z + this.offset.z
    if (rx * rx + ry * ry + rz * rz <= thresholdM * thresholdM) return false
    this.set(-p.x, -p.y, -p.z)
    return true
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
