import { defineConfig } from '@playwright/test'

/**
 * E2E 冒烟（I6-1）：登录 → 目录切换 → 2D↔3D → 世界模式。
 * 独立 workflow（.github/workflows/e2e.yml）；headless Chromium 用
 * SwiftShader 提供 WebGL2（MapLibre/Three 均可渲染）。
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    viewport: { width: 1600, height: 900 },
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    }
  },
  // 对生产构建（vite preview）执行：更接近真实部署，且无 dev 依赖优化开销。
  // 运行前需先构建：pnpm --filter @twin/portal build（e2e workflow 已包含）。
  webServer: {
    command: 'pnpm --filter @twin/portal exec vite preview --port 5173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000
  }
})
