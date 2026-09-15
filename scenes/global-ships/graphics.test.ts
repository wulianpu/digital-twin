import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { GraphicsContext, SceneContext } from '@twin/sdk'
import type { VesselState } from '@twin/domain-vessel'
import { mountGraphics } from './src/graphics'

/**
 * Issue #17：Global 3D marker ownership（不 reparent 到 Engine root）、
 * 删除/清理路径真实移除、Entity 注册走 scoped GraphicsContext。
 */

function makeFakeGraphics() {
  const root = new THREE.Group()
  const register = vi.fn(() => ({ dispose: vi.fn() }))
  const graphics: Pick<GraphicsContext, 'root' | 'global' | 'entities' | 'onPick'> = {
    root,
    global: {
      enabled: true,
      // 与 SceneEngine 相同的权威轴变换（ECEF meters → scene km）
      setObjectEcefPosition: (object, e) => {
        object.position.set(e.x / 1000, e.z / 1000, -e.y / 1000)
      }
    },
    entities: { register },
    onPick: () => ({ dispose: vi.fn() })
  }
  const ctx = {
    graphics: { use: async () => graphics },
    signal: new AbortController().signal
  } as unknown as SceneContext
  return { ctx, root, register }
}

function vessel(lon: number, lat: number): VesselState {
  return {
    longitudeDegrees: lon,
    latitudeDegrees: lat,
    headingDegrees: 0,
    speedKnots: 0,
    name: 'ship'
  } as unknown as VesselState
}

describe('global-ships marker ownership（Issue #17）', () => {
  it('marker 留在 mount subtree（group）内，placement 不 reparent 且位置为单次轴变换', async () => {
    const { ctx, root } = makeFakeGraphics()
    const handle = await mountGraphics(ctx)

    const states = new Map<string, VesselState>([
      ['s1', vessel(90, 0)], // 赤道 90°E：ECEF ≈ (0, a, 0) → scene (0, 0, -a)
      ['s2', vessel(0, 90)] // 北极：ECEF ≈ (0, 0, b) → scene (0, b, 0)
    ])
    handle.updateShips(states)

    // ownership：两个 marker 都在 group（mount subtree）内，没有逃逸到 Engine root
    expect(root.children).toHaveLength(1) // group
    const group = root.children[0]!
    expect(group.children).toHaveLength(2)
    for (const marker of group.children) {
      expect(marker.parent).toBe(group)
    }

    // 单次轴变换 anchor：90°E → (0, 0, -a km)；北极 → (0, b km, 0)
    const s1 = group.children[0]!
    expect(s1.position.x).toBeCloseTo(0, 3)
    expect(s1.position.y).toBeCloseTo(0, 3)
    expect(s1.position.z).toBeCloseTo(-6378.137, 2)
    const s2 = group.children[1]!
    expect(s2.position.x).toBeCloseTo(0, 3)
    expect(s2.position.y).toBeCloseTo(6356.752, 2)
    expect(s2.position.z).toBeCloseTo(0, 3)

    // 固定朝向（不再每帧累计 rotateX）
    const before = s1.rotation.x
    handle.updateShips(states)
    expect(s1.rotation.x).toBeCloseTo(before, 6)
    handle.dispose()
  })

  it('移除路径：消失的 ship 真实离开 group，entity 注册被释放', async () => {
    const { ctx, root, register } = makeFakeGraphics()
    const handle = await mountGraphics(ctx)
    handle.updateShips(
      new Map<string, VesselState>([
        ['s1', vessel(90, 0)],
        ['s2', vessel(0, 90)]
      ])
    )
    const group = root.children[0]!
    expect(group.children).toHaveLength(2)
    expect(register).toHaveBeenCalledTimes(2)

    handle.updateShips(new Map<string, VesselState>([['s1', vessel(90, 0)]]))
    expect(group.children).toHaveLength(1) // s2 marker 真实离开 mount subtree
    expect(register.mock.results[0]!.value.dispose).not.toHaveBeenCalled() // s1 保留
    expect(register.mock.results[1]!.value.dispose).toHaveBeenCalledTimes(1) // s2 释放

    handle.dispose()
    expect(group.children).toHaveLength(0) // dispose 全部移除
    expect(register.mock.results[0]!.value.dispose).toHaveBeenCalledTimes(1)
    expect(register.mock.results[1]!.value.dispose).toHaveBeenCalledTimes(1)
  })
})
