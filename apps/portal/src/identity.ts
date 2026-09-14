import type { Disposable, IdentityAdapter, UserIdentity } from '@twin/sdk'

/**
 * 演示身份适配器（I2-1/I2-3）：模拟 IdP 往返 + sessionStorage 会话持久化。
 * 生产部署替换为对接真实 IdP 的适配器（OIDC 重定向 / token 刷新），
 * Portal 其余代码不感知差异。
 *
 * 权限模型（演示）：
 * - 名称以 "guest" 开头 → 基础权限（无生产场景）→ 可验证权限拒绝路径；
 * - 其他名称 → 完整演示权限。
 */

export const PERMISSIONS_FULL: readonly string[] = ['scene:production', 'scene:simulation']
export const PERMISSIONS_BASIC: readonly string[] = ['scene:simulation']

const STORAGE_KEY = 'twin.demo.identity'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface DemoIdentityAdapter extends IdentityAdapter {
  signOut(): void
  /** 测试/演示用：立即让当前会话过期并通知监听者。 */
  expireSession(): void
}

export function createDemoIdentityAdapter(options: {
  storage?: StorageLike
  /** Simulated IdP round-trip latency in ms. */
  latencyMs?: number
} = {}): DemoIdentityAdapter {
  const storage = options.storage ?? sessionStorage
  const latencyMs = options.latencyMs ?? 350
  const expiryListeners = new Set<() => void>()

  function readStored(): UserIdentity | undefined {
    try {
      const raw = storage.getItem(STORAGE_KEY)
      if (!raw) return undefined
      const parsed = JSON.parse(raw) as Partial<UserIdentity>
      if (!parsed || typeof parsed.id !== 'string' || typeof parsed.name !== 'string') {
        return undefined
      }
      return {
        id: parsed.id,
        name: parsed.name,
        permissions: Array.isArray(parsed.permissions) ? parsed.permissions : []
      }
    } catch {
      return undefined
    }
  }

  function store(user: UserIdentity | undefined): void {
    if (user) storage.setItem(STORAGE_KEY, JSON.stringify(user))
    else storage.removeItem(STORAGE_KEY)
  }

  function permissionsFor(name: string): readonly string[] {
    return name.trim().toLowerCase().startsWith('guest') ? PERMISSIONS_BASIC : PERMISSIONS_FULL
  }

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  const adapter: DemoIdentityAdapter = {
    async getUser() {
      return readStored()
    },

    async signIn(name) {
      await delay(latencyMs) // simulated IdP round-trip
      const clean = (name ?? '').trim() || '演示用户'
      const user: UserIdentity = {
        id: `demo-${clean.toLowerCase().replace(/\s+/g, '-')}`,
        name: clean,
        permissions: permissionsFor(clean)
      }
      store(user)
      return user
    },

    onSessionExpired(cb): Disposable {
      expiryListeners.add(cb)
      return {
        dispose: () => {
          expiryListeners.delete(cb)
        }
      }
    },

    signOut() {
      store(undefined)
    },

    expireSession() {
      store(undefined)
      for (const cb of [...expiryListeners]) cb()
    }
  }
  return adapter
}
