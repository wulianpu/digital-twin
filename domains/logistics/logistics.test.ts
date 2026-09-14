import { describe, expect, it } from 'vitest'
import { assessRouteRisk, type ExclusionZone } from './src/public'

const zone: ExclusionZone = { id: 'z1', centerX: 0, centerY: 0, radiusMeters: 50 }

describe('assessRouteRisk 避碰（B1）', () => {
  it('中心点评估（无包络）', () => {
    const r = assessRouteRisk({ x: 40, y: 0 }, [zone])
    expect(r.violating).toBe(true) // 40 < 50
    const safe = assessRouteRisk({ x: 60, y: 0 }, [zone])
    expect(safe.violating).toBe(false) // 60 ≥ 50
  })

  it('包络半径计入运输件尺寸', () => {
    // 运输件包络 20m：60m 处进入 50+20=70m 判定圈
    const r = assessRouteRisk({ x: 60, y: 0 }, [zone], 20)
    expect(r.violating).toBe(true)
    expect(r.clearanceMeters).toBeCloseTo(60)
  })
})
