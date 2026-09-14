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
    world.onSessionChanged((s) => seen.push(s.mode))
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
