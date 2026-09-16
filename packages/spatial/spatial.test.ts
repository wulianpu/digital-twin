import { describe, expect, it, vi } from 'vitest'
import {
  createEnuFrame,
  createSpatialApi,
  ecefToGeodetic,
  ecefToFrameLocal,
  frameLocalToGeodetic,
  geodeticToEcef,
  geodeticToFrameLocal,
  quatSlerp,
  vec3
} from './src/public'

const siteOrigin = {
  longitudeDegrees: 121.7821,
  latitudeDegrees: 31.3622,
  heightMeters: 4.2,
  verticalReference: 'ellipsoid' as const
}

describe('wgs84 <-> ecef', () => {
  it('round-trips within sub-millimeter', () => {
    const p = { ...siteOrigin }
    const back = ecefToGeodetic(geodeticToEcef(p))
    expect(Math.abs(back.longitudeDegrees - p.longitudeDegrees)).toBeLessThan(1e-9)
    expect(Math.abs(back.latitudeDegrees - p.latitudeDegrees)).toBeLessThan(1e-9)
    expect(Math.abs(back.heightMeters - p.heightMeters)).toBeLessThan(1e-4)
  })

  it('matches known ECEF value for a reference point', () => {
    // Greenwich equator at ellipsoid height 0 => x = a
    const e = geodeticToEcef({
      longitudeDegrees: 0,
      latitudeDegrees: 0,
      heightMeters: 0,
      verticalReference: 'ellipsoid'
    })
    expect(e.xMeters).toBeCloseTo(6378137.0, 3)
    expect(e.yMeters).toBeCloseTo(0, 6)
    expect(e.zMeters).toBeCloseTo(0, 6)
  })
})

describe('site ENU frame (X=East, Y=Up, Z=-North)', () => {
  it('moves east along +X, north along -Z, up along +Y', () => {
    const frame = createEnuFrame('site-test', siteOrigin)
    const metersPerDegLat = 111320
    // one arc-second north
    const northPoint = {
      ...siteOrigin,
      latitudeDegrees: siteOrigin.latitudeDegrees + 1 / 3600
    }
    const local = geodeticToFrameLocal(frame, northPoint)
    expect(local.x).toBeCloseTo(0, 0)
    expect(local.z).toBeCloseTo(-metersPerDegLat / 3600, -1)
    expect(Math.abs(local.y)).toBeLessThan(1)

    const eastPoint = {
      ...siteOrigin,
      longitudeDegrees: siteOrigin.longitudeDegrees + 1 / 3600
    }
    const eastLocal = geodeticToFrameLocal(frame, eastPoint)
    expect(eastLocal.x).toBeGreaterThan(20)
    expect(eastLocal.x).toBeLessThan(40)
    expect(Math.abs(eastLocal.z)).toBeLessThan(2)
  })

  it('round-trips local <-> geodetic', () => {
    const frame = createEnuFrame('site-test', siteOrigin)
    const local = vec3(152.3, -2.1, -88.4)
    const back = geodeticToFrameLocal(frame, frameLocalToGeodetic(frame, local))
    expect(Math.hypot(back.x - local.x, back.y - local.y, back.z - local.z)).toBeLessThan(1e-4)
  })

  it('keeps precision for far-from-origin ECEF (Float64 core)', () => {
    const frame = createEnuFrame('site-test', siteOrigin)
    const ecef = geodeticToEcef(siteOrigin)
    const local = ecefToFrameLocal(frame, ecef)
    expect(Math.hypot(local.x, local.y, local.z)).toBeLessThan(1e-3)
  })
})

describe('SpatialApi', () => {
  it('requires an active frame for local conversions', () => {
    const spatial = createSpatialApi()
    expect(() => spatial.geodeticToLocal(siteOrigin)).toThrowError(/active reference frame/)
  })

  it('activates registered frames and notifies listeners', () => {
    const spatial = createSpatialApi()
    const seen: (string | undefined)[] = []
    spatial.onActiveFrameChanged((id) => seen.push(id))
    const frame = spatial.ensureEnuFrame('site-a', siteOrigin)
    spatial.setActiveFrame(frame.id)
    expect(spatial.activeFrameId).toBe('site-a')
    expect(seen).toEqual(['site-a'])
    spatial.setActiveFrame(undefined)
    expect(seen).toEqual(['site-a', undefined])
  })

  it('enforces vertical datum before frame conversion', () => {
    const spatial = createSpatialApi()
    const frame = spatial.ensureEnuFrame('site-a', siteOrigin)
    spatial.setActiveFrame(frame.id)
    const chartHeight = {
      ...siteOrigin,
      heightMeters: 1.0,
      verticalReference: 'chart-datum' as const
    }
    expect(() => spatial.geodeticToLocal(chartHeight)).toThrowError(/vertical offset/)

    const disposal = spatial.registerVerticalOffset('chart-datum', 'ellipsoid', 2.34)
    const local = spatial.geodeticToLocal(chartHeight)
    // height 1.0 chart == 3.34 ellipsoid == 4.2-0.86... origin height 4.2 => -0.86 up
    expect(local.y).toBeCloseTo(-0.86, 3)
    disposal.dispose()
    expect(() => spatial.geodeticToLocal(chartHeight)).toThrowError(/vertical offset/)
  })
})

describe('quaternion math', () => {
  it('slerp endpoints and midpoint behave', () => {
    const a = { x: 0, y: 0, z: 0, w: 1 }
    const b = { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }
    const mid = quatSlerp(a, b, 0.5)
    expect(mid.y).toBeCloseTo(Math.sin(Math.PI / 8), 5)
    expect(quatSlerp(a, b, 0).w).toBeCloseTo(1)
    expect(quatSlerp(a, b, 1).y).toBeCloseTo(Math.sin(Math.PI / 4), 5)
  })
})

describe('Registration ownership（Issue #7）', () => {
  const ORIGIN = {
    longitudeDegrees: 121.7821,
    latitudeDegrees: 31.3622,
    heightMeters: 4.2,
    verticalReference: 'ellipsoid' as const
  }
  const FRAME = {
    id: 'frame:x',
    originECEF: { x: 1, y: 2, z: 3 },
    basisECEF: { xx: 1, xy: 0, xz: 0, yx: 0, yy: 1, yz: 0, zx: 0, zy: 0, zz: 1 }
  }

  it('duplicate frame id fail-fast：拒绝覆盖，baseline frame 不变', () => {
    const spatial = createSpatialApi()
    const baseline = spatial.registerFrame(FRAME)
    expect(() =>
      spatial.registerFrame({
        id: 'frame:x',
        originECEF: { x: 9, y: 9, z: 9 },
        basisECEF: FRAME.basisECEF
      })
    ).toThrowError(/duplicate frame registration/)
    expect(spatial.getFrame('frame:x')!.originECEF).toEqual({ x: 1, y: 2, z: 3 })
    baseline.dispose()
  })

  it('duplicate datum pair fail-fast：拒绝覆盖，基准值保持', () => {
    const spatial = createSpatialApi()
    const d = spatial.registerVerticalOffset('chart-datum', 'ellipsoid', 2.34)
    expect(() =>
      spatial.registerVerticalOffset('chart-datum', 'ellipsoid', 9.99)
    ).toThrowError(/duplicate vertical datum offset/)
    expect(spatial.toEllipsoidal({
      ...ORIGIN,
      heightMeters: 10,
      verticalReference: 'chart-datum' as never
    }).heightMeters).toBeCloseTo(12.34)
    d.dispose()
  })

  it('stale frame disposer：不得删除后来 owner 的 registration', () => {
    const spatial = createSpatialApi()
    const first = spatial.registerFrame(FRAME)
    first.dispose()
    const second = spatial.registerFrame({ ...FRAME, originECEF: { x: 5, y: 5, z: 5 } })
    first.dispose() // stale：no-op
    expect(spatial.getFrame('frame:x')!.originECEF).toEqual({ x: 5, y: 5, z: 5 })
    second.dispose()
    expect(spatial.getFrame('frame:x')).toBeUndefined()
  })

  it('active frame 不变量：owner 合法移除 active frame 时自动清除并通知', () => {
    const spatial = createSpatialApi()
    const d = spatial.registerFrame(FRAME)
    spatial.setActiveFrame('frame:x')
    expect(spatial.activeFrameId).toBe('frame:x')
    const seen: Array<string | undefined> = []
    spatial.onActiveFrameChanged((id) => seen.push(id))
    d.dispose()
    expect(spatial.activeFrameId).toBeUndefined()
    expect(seen).toEqual([undefined])
    expect(() => spatial.geodeticToLocal(ORIGIN)).toThrow(/no active reference frame/)
  })

  it('disposer 幂等：重复 dispose 不影响后续重注册', () => {
    const spatial = createSpatialApi()
    const d = spatial.registerFrame(FRAME)
    d.dispose()
    d.dispose()
    expect(() => spatial.registerFrame(FRAME)).not.toThrow()
    expect(spatial.getFrame('frame:x')).toBeDefined()
  })
})

describe('ensureEnuFrame definition conflict（Issue #8-C）', () => {
  const ORIGIN_A = {
    longitudeDegrees: 121.7821,
    latitudeDegrees: 31.3622,
    heightMeters: 4.2,
    verticalReference: 'ellipsoid' as const
  }
  const ORIGIN_B = {
    longitudeDegrees: 121.6523,
    latitudeDegrees: 31.6857,
    heightMeters: 3.8,
    verticalReference: 'ellipsoid' as const
  }

  it('同 id 同定义：幂等返回', () => {
    const spatial = createSpatialApi()
    const first = spatial.ensureEnuFrame('site-a', ORIGIN_A)
    const second = spatial.ensureEnuFrame('site-a', ORIGIN_A)
    expect(second).toBe(first)
    expect(spatial.listFrames()).toHaveLength(1)
  })

  it('同 id 不同 origin：fail-fast，不静默复用旧 frame', () => {
    const spatial = createSpatialApi()
    spatial.ensureEnuFrame('site-a', ORIGIN_A)
    expect(() => spatial.ensureEnuFrame('site-a', ORIGIN_B)).toThrowError(
      /conflicting definition/
    )
    // baseline 保持
    const kept = spatial.getFrame('site-a')!
    expect(kept.originECEF.x).toBeCloseTo(
      createEnuFrame('probe', ORIGIN_A).originECEF.x,
      6
    )
  })

  it('registerEnuFrame：scene-owned 创建 → dispose 回收；借用 app-owned → no-op', () => {
    const spatial = createSpatialApi()
    const appFrame = spatial.ensureEnuFrame('frame:app', ORIGIN_A)

    // 借用同定义 app-owned frame
    const borrowed = spatial.registerEnuFrame('frame:app', ORIGIN_A)
    expect(borrowed.frame).toBe(appFrame)
    borrowed.dispose()
    expect(spatial.getFrame('frame:app')).toBe(appFrame)

    // 借用不同定义 → 冲突 fail-fast
    expect(() => spatial.registerEnuFrame('frame:app', ORIGIN_B)).toThrowError(
      /conflicting definition/
    )

    // 新 id → scene-owned，dispose 回收
    const owned = spatial.registerEnuFrame('frame:scene', ORIGIN_B)
    expect(spatial.getFrame('frame:scene')).toBeDefined()
    owned.dispose()
    expect(spatial.getFrame('frame:scene')).toBeUndefined()
  })
})

describe('Frame registration ownership（Issue #9）', () => {
  const ORIGIN_A = {
    longitudeDegrees: 121.7821,
    latitudeDegrees: 31.3622,
    heightMeters: 4.2,
    verticalReference: 'ellipsoid' as const
  }
  it('scene-owned duplicate：registration-owned existing 不得返回伪 borrow lease', () => {
    const spatial = createSpatialApi()
    const a = spatial.registerEnuFrame('frame:x', ORIGIN_A)
    expect(() => spatial.registerEnuFrame('frame:x', ORIGIN_A)).toThrowError(
      /duplicate frame registration/
    )
    // 原持有者 dispose 后才可重新注册；旧 disposer 不影响新 owner
    a.dispose()
    const b = spatial.registerEnuFrame('frame:x', ORIGIN_A)
    expect(spatial.getFrame('frame:x')).toBeDefined()
    a.dispose()
    expect(spatial.getFrame('frame:x')).toBeDefined()
    b.dispose()
    expect(spatial.getFrame('frame:x')).toBeUndefined()
  })

  it('registerFrame-owned existing 不得被 registerEnuFrame 误判为 app-owned borrow', () => {
    const spatial = createSpatialApi()
    // 同定义（由同一 origin 计算的 ENU frame）→ registration-owned →
    // fail-fast，不得被误判为 app-owned no-op borrow
    const original = spatial.registerFrame(createEnuFrame('frame:x', ORIGIN_A))
    expect(() => spatial.registerEnuFrame('frame:x', ORIGIN_A)).toThrowError(
      /duplicate frame registration/
    )
    // registerEnuFrame 的 borrow 不影响原 owner 的 token 生命周期
    original.dispose()
    expect(spatial.getFrame('frame:x')).toBeUndefined()
  })

  it('ensureEnuFrame 不把 registration-owned entry 静默提升为 app baseline', () => {
    const spatial = createSpatialApi()
    const reg = spatial.registerEnuFrame('frame:scene-tmp', ORIGIN_A)
    expect(() => spatial.ensureEnuFrame('frame:scene-tmp', ORIGIN_A)).toThrowError(
      /duplicate frame registration/
    )
    reg.dispose()
    // 回收后 ensure 可正常建立 app baseline
    const appFrame = spatial.ensureEnuFrame('frame:scene-tmp', ORIGIN_A)
    expect(spatial.getFrame('frame:scene-tmp')).toBe(appFrame)
  })

  it('app-owned borrow 语义保持：ensure → registerEnuFrame → dispose no-op', () => {
    const spatial = createSpatialApi()
    const appFrame = spatial.ensureEnuFrame('frame:baseline', ORIGIN_A)
    const borrowed = spatial.registerEnuFrame('frame:baseline', ORIGIN_A)
    expect(borrowed.frame).toBe(appFrame)
    borrowed.dispose()
    expect(spatial.getFrame('frame:baseline')).toBe(appFrame)
  })

  it('active frame invariant：registration-owned active frame 移除时清除并通知', () => {
    const spatial = createSpatialApi()
    const reg = spatial.registerEnuFrame('frame:active', ORIGIN_A)
    spatial.setActiveFrame('frame:active')
    const seen: Array<string | undefined> = []
    spatial.onActiveFrameChanged((id) => seen.push(id))
    reg.dispose()
    expect(spatial.activeFrameId).toBeUndefined()
    expect(seen).toEqual([undefined])
  })
})

/** -------- Issue #20：Spatial onActiveFrameChanged listener fault boundary */

describe('spatial listener fault boundary（Issue #20）', () => {
  it('listener A throw → B 仍收到 frame change，setActiveFrame 不抛错', () => {
    const spatial = createSpatialApi((error) => {
      expect((error as Error).message).toBe('A failed')
    })
    const ORIGIN = {
      longitudeDegrees: 121.7821,
      latitudeDegrees: 31.3622,
      heightMeters: 4.2,
      verticalReference: 'ellipsoid' as const
    }
    const d = spatial.registerEnuFrame('frame:x', ORIGIN)
    spatial.setActiveFrame('frame:x')
    const seen: Array<string | undefined> = []
    spatial.onActiveFrameChanged(() => {
      throw new Error('A failed')
    })
    spatial.onActiveFrameChanged((id) => seen.push(id))

    spatial.setActiveFrame(undefined)
    expect(seen).toEqual([undefined])
    expect(spatial.activeFrameId).toBeUndefined()
    void d
  })

  it('限频：同一 listener 持续 throw 只上报一次', () => {
    const onListenerError = vi.fn()
    const spatial = createSpatialApi(onListenerError)
    const d = spatial.registerEnuFrame('frame:y', {
      longitudeDegrees: 0,
      latitudeDegrees: 0,
      heightMeters: 0,
      verticalReference: 'ellipsoid' as const
    })
    spatial.onActiveFrameChanged(() => {
      throw new Error('boom')
    })
    spatial.setActiveFrame('frame:y')
    spatial.setActiveFrame(undefined)
    spatial.setActiveFrame('frame:y')
    expect(onListenerError).toHaveBeenCalledTimes(1)
    d.dispose()
  })
})
