import { describe, expect, it, vi } from 'vitest'
import { MountScope, SceneScopeClosedError } from './src/scope'

function makeDisposable() {
  const dispose = vi.fn()
  return { dispose, disposed: false }
}

describe('MountScope（问题2 / §11-§14）', () => {
  it('active 状态：track 登记，dispose 兜底释放全部', () => {
    const scope = new MountScope()
    const d1 = makeDisposable()
    const d2 = makeDisposable()
    scope.track(d1)
    scope.track(d2)
    expect(scope.state).toBe('active')
    scope.dispose()
    expect(d1.dispose).toHaveBeenCalledTimes(1)
    expect(d2.dispose).toHaveBeenCalledTimes(1)
    expect(scope.state).toBe('disposed')
  })

  it('dispose 幂等', () => {
    const scope = new MountScope()
    const d = makeDisposable()
    scope.track(d)
    scope.dispose()
    scope.dispose()
    expect(d.dispose).toHaveBeenCalledTimes(1)
  })

  it('close 后 assertCanCreate 拒绝，track 的迟到资源立即释放', () => {
    const scope = new MountScope()
    scope.close()
    expect(scope.state).toBe('closing')
    expect(() => scope.assertCanCreate('data.subscribe')).toThrow(SceneScopeClosedError)
    const late = makeDisposable()
    // 问题6：迟到的资源自动释放，不留 zombie
    const wrapped = scope.track(late)
    expect(late.dispose).toHaveBeenCalledTimes(1)
    wrapped.dispose()
  })

  it('单个资源 dispose 失败不中断兜底释放', () => {
    const scope = new MountScope()
    const bad = { dispose: () => { throw new Error('boom') } }
    const good = makeDisposable()
    scope.track(bad)
    scope.track(good)
    scope.dispose()
    expect(good.dispose).toHaveBeenCalledTimes(1)
  })
})
