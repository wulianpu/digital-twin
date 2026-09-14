import type { SceneEntry } from '@twin/sdk'

/**
 * Hostile / broken scene fixtures（Issue #1 问题5）：
 * 每个 fixture 故意在某个环节"写坏"，验证 Host 生命周期边界——
 * 正常 Scene 能 cleanup 不够；坏 Scene 也逃不出 Host。
 */

/** 忘记清理 data subscription */
export const forgetDataSubscription: SceneEntry = {
  async mount(ctx) {
    ctx.data.subscribe({ contract: 'twin.hostile@1' }, () => {})
    return { unmount() { /* 故意不清理 */ } }
  }
}

/** 忘记 release asset lease */
export const forgetAssetLease: SceneEntry = {
  async mount(ctx) {
    const lease = await ctx.assets.acquire({ id: 'hostile-asset' })
    return { unmount() { void lease /* 故意不 release */ } }
  }
}

/** 忘记清理 frame callback */
export const forgetFrameCallback: SceneEntry = {
  async mount(ctx) {
    if (!ctx.graphics) return { unmount() {} }
    const gfx = await ctx.graphics.use()
    gfx.onFrame(() => {})
    return { unmount() { /* 故意不清理 */ } }
  }
}

/** 忘记清理 pick callback */
export const forgetPickCallback: SceneEntry = {
  async mount(ctx) {
    if (!ctx.graphics) return { unmount() {} }
    const gfx = await ctx.graphics.use()
    gfx.onPick(() => {})
    return { unmount() { /* 故意不清理 */ } }
  }
}

/** unmount throws */
export const unmountThrows: SceneEntry = {
  async mount(ctx) {
    ctx.ui.createLayer()
    return {
      unmount() {
        throw new Error('scene cleanup exploded')
      }
    }
  }
}

/** unmount hangs forever（Host deadline 兜底） */
export const unmountHangs: SceneEntry = {
  async mount() {
    return {
      unmount: () => new Promise<void>(() => {})
    }
  }
}

/** 缓存 capability 引用，unmount 后尝试 zombie write */
export const zombieCachedContext: SceneEntry = {
  async mount(ctx) {
    const cachedData = ctx.data
    return {
      unmount() {
        // zombie write：revoke/close 后应被拒
        try { cachedData.subscribe({ contract: 'x' }, () => {}) } catch { /* expected */ }
      }
    }
  }
}

/** late graphics bootstrap（unmount 后才 resolve） */
export const lateGraphicsBootstrap: SceneEntry = {
  async mount(ctx) {
    if (!ctx.graphics) return { unmount() {} }
    void ctx.graphics.use().then(() => {
      // late resolve：scope 已 dispose → root 被 detach
    }).catch(() => {})
    return { unmount() {} }
  }
}
