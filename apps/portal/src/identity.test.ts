import { describe, expect, it, vi } from 'vitest'
import { createDemoIdentityAdapter, PERMISSIONS_BASIC, PERMISSIONS_FULL, type StorageLike } from './identity'

function fakeStorage(): StorageLike & { dump(): Map<string, string> } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    dump: () => map
  }
}

describe('演示身份适配器 (I2-1)', () => {
  it('未登录时 getUser 返回 undefined', async () => {
    const adapter = createDemoIdentityAdapter({ storage: fakeStorage(), latencyMs: 0 })
    expect(await adapter.getUser()).toBeUndefined()
  })

  it('signIn 往返并持久化会话，完整权限角色', async () => {
    const storage = fakeStorage()
    const adapter = createDemoIdentityAdapter({ storage, latencyMs: 0 })
    const user = await adapter.signIn('张工')
    expect(user?.name).toBe('张工')
    expect(user?.permissions).toEqual(PERMISSIONS_FULL)
    // 会话持久化：新适配器（模拟刷新页面）读取同一 storage。
    const fresh = createDemoIdentityAdapter({ storage, latencyMs: 0 })
    expect((await fresh.getUser())?.name).toBe('张工')
  })

  it('guest 角色获得受限权限（可验证权限拒绝路径）', async () => {
    const adapter = createDemoIdentityAdapter({ storage: fakeStorage(), latencyMs: 0 })
    const user = await adapter.signIn('guest-01')
    expect(user?.permissions).toEqual(PERMISSIONS_BASIC)
    expect(user?.permissions).not.toContain('scene:production')
  })

  it('expireSession 清除会话并通知监听者', async () => {
    const storage = fakeStorage()
    const adapter = createDemoIdentityAdapter({ storage, latencyMs: 0 })
    await adapter.signIn('张工')
    const cb = vi.fn()
    const sub = adapter.onSessionExpired(cb)
    adapter.expireSession()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(await adapter.getUser()).toBeUndefined()
    sub.dispose()
    adapter.expireSession()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('signOut 清除会话', async () => {
    const storage = fakeStorage()
    const adapter = createDemoIdentityAdapter({ storage, latencyMs: 0 })
    await adapter.signIn('李四')
    adapter.signOut()
    expect(await adapter.getUser()).toBeUndefined()
  })
})
