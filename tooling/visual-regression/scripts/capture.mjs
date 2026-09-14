#!/usr/bin/env node
/**
 * Golden Scene 基线截图（I6-2）：三帧基线 + 统一视口。
 * 用法：node scripts/capture.mjs [输出目录名=golden] [baseUrl]
 * 产物：<输出目录>/<scene>-<view>.png（golden/ 提交入库作为基线）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const toolDir = fileURLToPath(new URL('..', import.meta.url))
const outName = process.argv[2] && !process.argv[2].startsWith('http') ? process.argv[2] : 'golden'
const baseUrl = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:5199'
const outDir = join(toolDir, outName)
const VIEWPORT = { width: 1920, height: 1080 }

const GOLDEN = [
  {
    name: 'stack-yard-2d',
    hash: '#/scene/stack-yard',
    vfx3d: false,
    settleMs: 3000
  },
  {
    name: 'production-3d',
    hash: '#/scene/production',
    vfx3d: true,
    settleMs: 3000
  },
  {
    name: 'heavy-transport-3d',
    hash: '#/scene/heavy-transport',
    vfx3d: true,
    settleMs: 3000
  }
]

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
const page = await browser.newPage({ viewport: VIEWPORT })

await page.goto(`${baseUrl}/#/scene/global-ships`)
await page.waitForLoadState('domcontentloaded')
const login = page.getByRole('textbox', { name: '用户名' })
await login.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
if (await login.isVisible().catch(() => false)) {
  await login.fill('张工')
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForTimeout(3000)
}

for (const golden of GOLDEN) {
  // I9-6: fixture 模式 URL——确定性时钟 + 确定性回放数据
  await page.goto(`${baseUrl}/?vfx=1${golden.hash}`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(golden.settleMs)
  // 等 3D 引擎 boot（如需要）
  const toggle3d = page.locator('[data-view-toggle="graphics"]')
  if (golden.vfx3d && (await toggle3d.count()) > 0 && (await toggle3d.isVisible().catch(() => false))) {
    await toggle3d.click()
    await page.waitForTimeout(5000)
  }
  await golden.beforeShot?.(page)
  // I9-6: 等 vfx readiness（水体冻结 + 数据稳定）
  await page.waitForFunction(() => window.__vfxReady === true, { timeout: 15_000 })
  const target = join(outDir, `${golden.name}.png`)
  await page.screenshot({ path: target })
  console.log(`✓ ${target}`)
}

await browser.close()
console.log('基线截图完成；对比：node scripts/compare.mjs')
