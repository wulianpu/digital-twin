import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

/**
 * Shared Vite configuration for all applications (Portal + Standalone).
 * Apps are the composition root; Foundation packages are consumed as
 * workspace source via their `exports` map (single public entry only).
 */
export function createAppConfig(options: { root: string }) {
  return defineConfig({
    root: options.root,
    plugins: [vue()],
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 1600
    },
    resolve: {
      // Keep linked workspace packages as source (no prebundling) so that
      // dynamic engine imports stay lazy across package boundaries.
      dedupe: ['vue', 'three']
    },
    // MapLibre v6 的 worker 以相邻 ESM 文件加载，预打包会使其 404
    // （整页 reload 后 Map 初始化失败、场景面板丢失）→ 排除预打包，
    // dev 下直接服务真实 ESM 文件；生产构建不受影响。
    optimizeDeps: {
      exclude: ['maplibre-gl']
    },
    worker: {
      format: 'es'
    }
  })
}

export const repoRoot = fileURLToPath(new URL('.', import.meta.url))
