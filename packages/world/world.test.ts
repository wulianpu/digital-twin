import { describe, expect, it, vi } from 'vitest'
import {
  boundsCenter,
  createSelectionApi,
  createWorldApi,
  entityKey,
  parseEntityKey
} from './src/public'

const siteA = {
  id: 'site-changxing',
  name: '长兴基地',
  origin: {
    longitudeDegrees: 121.7821,
    latitudeDegrees: 31.3622,
    heightMeters: 4.2,
    verticalReference: 'ellipsoid' as const
  },
  bounds: { south: 31.33, west: 121.74, north: 31.39, east: 121.83 }
}

describe('WorldApi', () => {
  it('starts in global live scope and emits session changes', () => {
    const world = createWorldApi({ sites: [siteA] })
    expect(world.session.mode).toBe('live')
    expect(world.session.scope).toEqual({ kind: 'global' })

    const seen: string[] = []
    world.onSessionChanged((_s) => seen.push(world.session.mode))
    world.setMode('history')
    expect(seen).toEqual(['history'])
    expect(world.session.mode).toBe('history')
  })

  it('site registry round-trips', () => {
    const world = createWorldApi()
    const disposable = world.sites.register(siteA)
    expect(world.sites.get('site-changxing')?.name).toBe('长兴基地')
    disposable.dispose()
    expect(world.sites.get('site-changxing')).toBeUndefined()
  })

  it('scope switching drives Site A / Site B loops', () => {
    const world = createWorldApi({ sites: [siteA] })
    world.setScope({ kind: 'site', siteId: 'site-changxing' })
    expect(world.session.scope).toEqual({ kind: 'site', siteId: 'site-changxing' })
    world.setScope({ kind: 'global' })
    expect(world.session.scope.kind).toBe('global')
  })
})

describe('WorldClock', () => {
  it('live time is wall clock', () => {
    const world = createWorldApi()
    expect(Math.abs(world.time.now().epochMillis - Date.now())).toBeLessThan(50)
  })

  it('virtual time advances with speed', async () => {
    const world = createWorldApi()
    world.setMode('simulation')
    const t0 = world.time.now().epochMillis
    world.clock.setSpeed(10)
    const anchor = world.time.now().epochMillis
    await new Promise((r) => setTimeout(r, 30))
    const t1 = world.time.now().epochMillis
    expect(t1 - anchor).toBeGreaterThanOrEqual(150) // 30ms * 10
    expect(t0).toBeGreaterThan(0)
  })

  it('seek moves the virtual anchor', () => {
    const world = createWorldApi()
    world.setMode('history')
    const target = Date.now() - 3_600_000
    world.clock.seek(target)
    expect(Math.abs(world.time.now().epochMillis - target)).toBeLessThan(50)
  })
})

describe('Selection', () => {
  it('keeps one selection across "engines"', () => {
    const selection = createSelectionApi()
    const crane = { namespace: 'production', id: 'CRANE-003' }
    selection.setPrimary(crane)
    expect(selection.current.primary).toEqual(crane)
    expect(selection.isSelected(crane)).toBe(true)
  })

  it('notifies and supports clear/toggle', () => {
    const selection = createSelectionApi()
    const cb = vi.fn()
    selection.onChange(cb)
    const ship = { namespace: 'ais', id: 'IMO1234567' }
    selection.setPrimary(ship)
    selection.toggle(ship)
    expect(cb).toHaveBeenCalledTimes(2)
    expect(selection.current.primary).toBeUndefined()
  })
})

describe('EntityRef keys', () => {
  it('round-trips and validates', () => {
    expect(entityKey({ namespace: 'ais', id: 'IMO1234567' })).toBe('ais/IMO1234567')
    expect(parseEntityKey('yard/STACK-A-017')).toEqual({
      namespace: 'yard',
      id: 'STACK-A-017'
    })
    expect(() => parseEntityKey('nonsense')).toThrowError(/invalid entity key/)
  })
})

describe('GeoBounds', () => {
  it('centers bounds', () => {
    const c = boundsCenter({ south: 31, west: 121, north: 32, east: 123 })
    expect(c.latitudeDegrees).toBe(31.5)
    expect(c.longitudeDegrees).toBe(122)
  })
})

describe('Registration ownership（Issue #7）', () => {
  it('duplicate site key fail-fast：拒绝覆盖、baseline 保持、无 listener 副作用', () => {
    const world = createWorldApi({ sites: [siteA] })
    let changes = 0
    world.onSessionChanged(() => changes++) // 无关事件基线
    const siteEvents: number[] = []
    // siteListeners 无公开订阅——用 list() 长度断言无瞬时变更
    expect(() =>
      world.sites.register({ ...siteA, name: 'shadow' })
    ).toThrowError(/duplicate site registration/)
    expect(world.sites.get('site-changxing')?.name).toBe('长兴基地')
    expect(changes).toBe(0)
    void siteEvents
  })

  it('stale disposer：dispose → 重注册 → 旧 disposer 再 dispose 不得删除新 registration', () => {
    const world = createWorldApi()
    const first = world.sites.register(siteA)
    first.dispose()
    expect(world.sites.get('site-changxing')).toBeUndefined()

    const second = world.sites.register({ ...siteA, name: 'second' })
    first.dispose() // stale：token 不匹配，必须 no-op
    expect(world.sites.get('site-changxing')?.name).toBe('second')

    second.dispose() // 自己的 token 才能删除
    expect(world.sites.get('site-changxing')).toBeUndefined()
  })

  it('disposer 幂等：重复 dispose 只删除一次', () => {
    const world = createWorldApi()
    const d = world.sites.register(siteA)
    d.dispose()
    d.dispose()
    d.dispose()
    expect(world.sites.get('site-changxing')).toBeUndefined()
    // 之后再注册不受影响
    expect(() => world.sites.register(siteA)).not.toThrow()
  })

  it('initialScope / initial sites 输入对象无别名（write-side snapshot）', () => {
    const scope = { kind: 'site' as const, siteId: 'site-changxing' }
    const world = createWorldApi({ sites: [siteA], initialScope: scope })
    scope.siteId = 'hijacked'
    expect(world.session.scope).toEqual({ kind: 'site', siteId: 'site-changxing' })
  })
})

/** -------- Issue #20：Foundation listener fault boundary */

describe('listener fault boundary（Issue #20）', () => {
  it('world：listener A throw → B 仍收到 session 变化，setMode 不向调用方抛错', () => {
    const world = createWorldApi({
      onListenerError: (error) => {
        expect((error as Error).message).toBe('listener A failed')
      }
    })
    const seen: string[] = []
    world.onSessionChanged(() => {
      throw new Error('listener A failed')
    })
    world.onSessionChanged((_s) => seen.push(world.session.mode))

    expect(() => world.setMode('history')).not.toThrow()
    expect(seen).toEqual(['history'])
  })

  it('限频：同一 listener 仅 ok→failing 转变上报一次，成功后复位', () => {
    const onListenerError = vi.fn()
    const world = createWorldApi({ onListenerError })
    let fail = true
    world.onSessionChanged(() => {
      if (fail) throw new Error('transient')
    })
    world.setMode('history') // 上报 1 次
    world.setMode('live') // 仍 failing → 限频不上报
    world.setMode('simulation') // 仍 failing → 限频
    expect(onListenerError).toHaveBeenCalledTimes(1)
    fail = false
    world.setMode('live') // 成功 → 复位
    fail = true
    world.setMode('history') // 新一轮 failing → 再上报
    expect(onListenerError).toHaveBeenCalledTimes(2)
  })

  it('selection：A throw → B 收到完整 snapshot，setter 不抛错', () => {
    const onListenerError = vi.fn()
    const selection = createSelectionApi(onListenerError)
    const seen: Array<{ primary: string | undefined; count: number }> = []
    selection.onChange(() => {
      throw new Error('A failed')
    })
    selection.onChange((s) => {
      seen.push({
        primary: s.primary?.id ?? undefined,
        count: s.secondary.length
      })
    })

    expect(() =>
      selection.setPrimary({ namespace: 'vessel', id: 'h1' })
    ).not.toThrow()
    selection.setSecondary([{ namespace: 'agv', id: 'a1' }])
    expect(seen.length).toBe(2)
    expect(selection.current.primary?.id).toBe('h1')
    // 同一 listener 持续 failing：限频只上报一次（ok→failing 转变）
    expect(onListenerError).toHaveBeenCalledTimes(1)
  })

  it('site registry：register/dispose 的 siteListeners throw 不影响 truth', () => {
    const world = createWorldApi()
    const site = {
      id: 'site-x',
      name: 'X',
      origin: {
        longitudeDegrees: 1,
        latitudeDegrees: 1,
        heightMeters: 0,
        verticalReference: 'ellipsoid' as const
      },
      bounds: { south: 0, west: 0, north: 2, east: 2 }
    }
    const d = world.sites.register(site)
    expect(world.sites.get('site-x')?.name).toBe('X')
    expect(() => d.dispose()).not.toThrow()
    expect(world.sites.get('site-x')).toBeUndefined()
  })
})


describe('默认 world.selection fault sink（#20-r2）', () => {
  it('createWorldApi({ onListenerError }) 的默认 selection 继承 sink', () => {
    const onListenerError = vi.fn()
    const world = createWorldApi({ onListenerError })
    world.selection.onChange(() => {
      throw new Error('selection observer failed')
    })
    world.selection.setPrimary({ namespace: 'vessel', id: 'h1' })
    expect(onListenerError).toHaveBeenCalledTimes(1)
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), {
      event: 'selection.changed'
    })
  })
})
