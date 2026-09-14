import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'tooling/**/*.test.ts',
      'scenes/**/*.test.ts',
      'domains/**/*.test.ts',
      'apps/**/*.test.ts'
    ],
    testTimeout: 20000
  }
})
