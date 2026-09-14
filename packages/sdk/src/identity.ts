import type { Disposable } from '@twin/world'

/**
 * Identity & permission contracts (I2-1).
 *
 * The application layer owns assembly (§4: 用户与权限属于 Vue 应用层);
 * this contract lets portal/standalone swap the real IdP without touching
 * scene or foundation code. Absence of a permission is enforced at the
 * SceneCoordinator boundary (§7.1 SceneDefinition.permissions).
 */

export interface UserIdentity {
  readonly id: string
  readonly name: string
  /** Permission keys checked against SceneDefinition.permissions. */
  readonly permissions: readonly string[]
}

export interface IdentityAdapter {
  /** Resolve the current user; `undefined` means 未登录. */
  getUser(): Promise<UserIdentity | undefined>
  /**
   * Begin an interactive sign-in. The optional name hint is for demo/dev
   * adapters; a real IdP adapter typically ignores it and runs a redirect.
   */
  signIn(name?: string): Promise<UserIdentity | undefined>
  /** Subscribe to session expiry (token timeout / server-side revoke). */
  onSessionExpired(cb: () => void): Disposable
}
