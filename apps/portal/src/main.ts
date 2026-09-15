import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@twin/ui/styles.css'
import './styles.css'
import App from './App.vue'
import LoginView from './shell/LoginView.vue'
import { buildFoundation, type PortalFoundation } from './foundation'
import { SceneCoordinator } from './coordinator'
import { SCENE_CATALOG } from './catalog'
import { createPortalRouter } from './router'
import { coordinatorKey, foundationKey } from './keys'
import { createDemoIdentityAdapter, type DemoIdentityAdapter } from './identity'
import {
  createConsoleSink,
  createTelemetry,
  setupTelemetry
} from './telemetry'
import type { UserIdentity } from '@twin/sdk'
import { useSessionStore } from './stores'

/**
 * Application Shell composition root (§6): App decides what to run.
 * I2-3: bootstrap is identity-gated — 未登录时只渲染登录壳；
 * 会话过期时销毁应用并回到登录壳。
 */

const identity: DemoIdentityAdapter = createDemoIdentityAdapter()
const appHost = document.getElementById('app')!
const telemetry = createTelemetry([createConsoleSink()])

let activeApp:
  | {
      app: ReturnType<typeof createApp>
      foundation: PortalFoundation
      coordinator: SceneCoordinator
    }
  | undefined
let expiryDisposal: { dispose(): void } | undefined

async function start(): Promise<void> {
  const user = await identity.getUser()
  if (user) {
    bootstrap(user)
  } else {
    mountLogin()
  }

  // 会话过期钩子（I2-3）：token 失效 / 服务端吊销 → 回到登录壳。
  // Issue #16：teardown 为异步——旧 runtime 完整终止后才挂新登录壳/新会话。
  expiryDisposal = identity.onSessionExpired(() => {
    telemetry.captureEvent('session.expired')
    void teardown().finally(() => mountLogin('会话已过期，请重新登录'))
  })
}

function mountLogin(message?: string): void {
  const loginApp = createApp(LoginView, {
    message,
    signIn: async (name: string) => {
      const user = await identity.signIn(name)
      if (!user) throw new Error('登录失败，请重试')
      loginApp.unmount()
      telemetry.captureEvent('auth.signed-in', { role: user.permissions.join(',') })
      bootstrap(user)
    }
  })
  loginApp.mount(appHost)
}

// Issue #16：按 ownership 反向顺序终止——
// 1) close Coordinator（停止 Scene 事务生产者）
// 2) await foundation.dispose()（内含 Host shutdown：Scene unmount/MountScope/revoke，
//    然后才销毁 Data/Map/Graphics/Asset owner）
// 3) unmount Vue
async function teardown(): Promise<void> {
  expiryDisposal?.dispose()
  expiryDisposal = undefined
  if (activeApp) {
    const { app, foundation, coordinator } = activeApp
    activeApp = undefined
    await coordinator.close()
    await foundation.dispose()
    app.unmount()
  }
}

function bootstrap(user: UserIdentity): void {
  const foundation = buildFoundation({
    // I6-3: Foundation 层错误进入 telemetry（全局错误另有 window 级捕获）
    onHostError: (error, phase) => {
      telemetry.captureError({
        message: String((error as Error)?.message ?? error),
        stack: (error as Error)?.stack,
        context: { source: 'scene-host', phase }
      })
    }
  })
  const coordinator = new SceneCoordinator(foundation.host, SCENE_CATALOG, {
    // I2-2: 进入场景前强制权限校验。
    permissions: () => user.permissions,
    onError: (error, sceneId) => {
      console.error(`[portal:coordinator] scene "${sceneId}" failed`, error)
      telemetry.captureError({
        message: String((error as Error)?.message ?? error),
        stack: (error as Error)?.stack,
        context: { source: 'coordinator', sceneId }
      })
    },
    onStateChange: (state) => {
      const store = useSessionStore(pinia)
      store.setCoordinator(state as { kind: string; sceneId?: string; error?: unknown })
    }
  })

  const router = createPortalRouter()
  const pinia = createPinia()

  const app = createApp(App)
  app.use(pinia)
  app.use(router)
  app.provide(foundationKey, foundation)
  app.provide(coordinatorKey, coordinator)

  // 会话用户进入 App 级 store（§62：用户/权限属于 Application）。
  const store = useSessionStore(pinia)
  store.user = { name: user.name, permissions: [...user.permissions] }

  app.mount(appHost)
  activeApp = { app, foundation, coordinator }

  // I6-3: telemetry + 诊断导出句柄（window.__twin）。
  setupTelemetry(telemetry, foundation)
}

void start()
