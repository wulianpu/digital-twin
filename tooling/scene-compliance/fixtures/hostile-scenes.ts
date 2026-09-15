import type { SceneEntry } from '@twin/sdk'
import { SceneScopeClosedError } from '@twin/scene-host'

/**
 * Hostile / broken scene fixtures（Issue #1 问题5）：
 * 每个 fixture 故意在某个环节"写坏"，验证 Host 生命周期边界——
 * 正常 Scene 能 cleanup 不够；坏 Scene 也逃不出 Host。
 */

/**
 * Issue #4 zombie-write 探针：记录 stale write 的实际结局，
 * 供 compliance 断言（必须为 REJECTED）。
 */
export const zombieWriteProbes: Record<string, string> = {}

function probe(id: string, attempt: () => void): void {
  try {
    attempt()
    zombieWriteProbes[id] = 'ALLOWED'
  } catch (error) {
    zombieWriteProbes[id] = error instanceof SceneScopeClosedError ? 'REJECTED' : 'OTHER'
  }
}

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

/** -------------------------------------------------------------- Issue #4 */

/** 忘记清理 selection.onChange listener（Host 必须 track 兜底） */
export const forgetSelectionListener: SceneEntry = {
  async mount(ctx) {
    ctx.selection.onChange(() => {})
    return { unmount() { /* 故意不清理 */ } }
  }
}

/** 忘记清理 world.onSessionChanged listener */
export const forgetWorldSessionListener: SceneEntry = {
  async mount(ctx) {
    ctx.world.onSessionChanged(() => {})
    return { unmount() { /* 故意不清理 */ } }
  }
}

/** 忘记清理 spatial.onActiveFrameChanged listener */
export const forgetSpatialListener: SceneEntry = {
  async mount(ctx) {
    ctx.spatial.onActiveFrameChanged(() => {})
    return { unmount() { /* 故意不清理 */ } }
  }
}

/** 缓存 selection 引用，unmount 后 zombie setPrimary */
export const zombieSelectionWrite: SceneEntry = {
  async mount(ctx) {
    const cached = ctx.selection
    return {
      unmount() {
        probe('selection', () => cached.setPrimary({ namespace: 'hostile', id: 'zombie' }))
      }
    }
  }
}

/** 缓存 world 引用，unmount 后 zombie setScope（改写全局会话范围） */
export const zombieWorldScopeWrite: SceneEntry = {
  async mount(ctx) {
    const cached = ctx.world
    return {
      unmount() {
        probe('world-scope', () => cached.setScope({ kind: 'global' }))
      }
    }
  }
}

/** 缓存 world 引用，unmount 后 zombie clock.seek（篡改全局时间线） */
export const zombieWorldClockWrite: SceneEntry = {
  async mount(ctx) {
    const cached = ctx.world
    return {
      unmount() {
        probe('world-clock', () => cached.clock.seek(0))
      }
    }
  }
}

/** 缓存 spatial 引用，unmount 后 zombie setActiveFrame（污染空间上下文） */
export const zombieSpatialFrameWrite: SceneEntry = {
  async mount(ctx) {
    const cached = ctx.spatial
    const frame = cached.ensureEnuFrame('hostile-frame', {
      longitudeDegrees: 0,
      latitudeDegrees: 0,
      heightMeters: 0,
      verticalReference: 'ellipsoid'
    })
    return {
      unmount() {
        void frame
        probe('spatial-frame', () => cached.setActiveFrame('hostile-frame'))
      }
    }
  }
}

/** 缓存 view 引用，unmount 后 zombie goToSite（迟到的"自动跳镜头"） */
export const zombieViewWrite: SceneEntry = {
  async mount(ctx) {
    const cached = ctx.view
    return {
      unmount() {
        probe('view', () => { void cached.goToSite('hostile-site') })
      }
    }
  }
}

/** ---------------------------------------------------- Issue #5（alias 旁路） */

/** 嵌套 capability 旁路：ctx.world.selection 必须与 ctx.selection 同一实例 */
export const zombieWorldNestedSelection: SceneEntry = {
  async mount(ctx) {
    zombieWriteProbes['nested-selection-identity'] =
      ctx.world.selection === ctx.selection ? 'IDENTITY-OK' : 'FORKED'
    const nested = ctx.world.selection
    return {
      unmount() {
        probe('nested-selection', () =>
          nested.setPrimary({ namespace: 'hostile', id: 'zombie' })
        )
      }
    }
  }
}

/** WorldSession.scope 可变别名：修改快照不得反向污染 World truth */
export const zombieWorldSessionScopeAlias: SceneEntry = {
  async mount(ctx) {
    const world = ctx.world
    const cached = world.session.scope
    const baseline = JSON.stringify(world.session.scope)
    return {
      unmount() {
        try {
          if (cached.kind === 'site') {
            ;(cached as { siteId: string }).siteId = 'hostile-site'
          } else if (cached.kind === 'entity') {
            ;(cached as { entity: { id: string } }).entity.id = 'zombie'
          }
        } catch { /* frozen 亦可 */ }
        // 经读路径回读真实 World scope（read 透传，写被拒）
        const after = JSON.stringify(world.session.scope)
        zombieWriteProbes['session-scope-alias'] = after === baseline ? 'SAFE' : 'POLLUTED'
      }
    }
  }
}

/** SelectionState.current 可变别名：修改快照不得污染唯一 Selection */
export const zombieSelectionCurrentAlias: SceneEntry = {
  async mount(ctx) {
    const selection = ctx.selection
    selection.setPrimary({ namespace: 'hostile', id: 'keep-me' })
    const cached = selection.current
    return {
      unmount() {
        try {
          if (cached.primary) cached.primary.id = 'zombie'
          for (const entity of cached.secondary) entity.id = 'zombie'
        } catch { /* frozen 亦可 */ }
        const stillIntact =
          selection.current.primary?.id === 'keep-me' &&
          selection.isSelected({ namespace: 'hostile', id: 'keep-me' })
        zombieWriteProbes['selection-current-alias'] = stillIntact ? 'SAFE' : 'POLLUTED'
      }
    }
  }
}

/** Spatial frame 可变别名：getFrame 返回值不得污染后续坐标转换 */
export const zombieSpatialFrameAlias: SceneEntry = {
  async mount(ctx) {
    const spatial = ctx.spatial
    const frame = spatial.ensureEnuFrame('hostile-alias-frame', {
      longitudeDegrees: 121.7821,
      latitudeDegrees: 31.3622,
      heightMeters: 4.2,
      verticalReference: 'ellipsoid'
    })
    const baseline = frame.originECEF.x
    return {
      unmount() {
        try {
          ;(frame.originECEF as { x: number }).x = baseline + 100_000
          ;(frame.basisECEF as { xx: number }).xx = 0
        } catch { /* frozen */ }
        const stored = spatial.getFrame('hostile-alias-frame')
        const intact =
          stored !== undefined &&
          stored.originECEF.x === baseline &&
          stored.basisECEF.xx !== 0
        zombieWriteProbes['spatial-frame-alias'] = intact ? 'SAFE' : 'POLLUTED'
      }
    }
  }
}

/** Site read model 别名：sites.get 返回值不得反向污染 registry truth */
export const zombieSiteOriginAlias: SceneEntry = {
  async mount(ctx) {
    const world = ctx.world
    const cached = world.sites.get('site-compliance-a')
    const baseline = cached?.origin.heightMeters
    return {
      unmount() {
        if (cached) {
          try {
            ;(cached.origin as { heightMeters: number }).heightMeters = 99_999
          } catch { /* frozen 亦可 */ }
        }
        const reread = world.sites.get('site-compliance-a')
        const intact =
          baseline !== undefined && reread?.origin.heightMeters === baseline
        zombieWriteProbes['site-origin-alias'] = intact ? 'SAFE' : 'POLLUTED'
      }
    }
  }
}

/** create-after-close：sites.register 必须在 inner create 前拒绝（无瞬时增删/通知） */
export const zombieSiteRegisterAfterClose: SceneEntry = {
  async mount(ctx) {
    const world = ctx.world
    const baselineCount = world.sites.list().length
    return {
      unmount() {
        try {
          world.sites.register({
            id: 'hostile-site',
            name: 'Zombie',
            origin: {
              longitudeDegrees: 0,
              latitudeDegrees: 0,
              heightMeters: 0,
              verticalReference: 'ellipsoid'
            },
            bounds: { south: 0, west: 0, north: 1, east: 1 }
          })
          zombieWriteProbes['site-register-after-close'] = 'ALLOWED'
        } catch (error) {
          const rejected = error instanceof SceneScopeClosedError
          // 无瞬时副作用：registry 计数不变（create 前 guard）
          const clean = world.sites.list().length === baselineCount
          zombieWriteProbes['site-register-after-close'] =
            rejected && clean ? 'REJECTED' : rejected ? 'DIRTY' : 'OTHER'
        }
      }
    }
  }
}
