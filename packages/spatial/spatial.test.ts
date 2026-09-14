import { describe, expect, it } from 'vitest'
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
