import { expect, test } from '@playwright/test'

/**
 * I6-1 E2E 冒烟：登录 → 目录切换 → 2D↔3D → 世界模式。
 * 场景以用户可见行为为准（无 portal 内部 API 访问）。
 */

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  const login = page.getByRole('textbox', { name: '用户名' })
  await login.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  if (await login.isVisible().catch(() => false)) {
    await login.fill('e2e-张工')
    await page.getByRole('button', { name: '登录' }).click()
  }
  await expect(page.locator('.portal-sidebar')).toBeVisible({ timeout: 20_000 })
}

test('登录后进入 Portal 壳层，目录可见', async ({ page }) => {
  await signIn(page)
  await expect(page.getByText('场景目录')).toBeVisible()
  await expect(page.locator('[data-scene-id="production"]')).toBeEnabled()
})

test('目录切换场景：分段堆场 2D 面板出现', async ({ page }) => {
  await signIn(page)
  await page.locator('[data-scene-id="stack-yard"]').click()
  await expect(page.locator('.yard-panel')).toBeVisible({ timeout: 20_000 })
  // 2D 地图挂载（MapLibre 实例出现）
  await expect(page.locator('.maplibregl-map')).toBeVisible({ timeout: 20_000 })
})

test('2D↔3D 切换：3D 引擎懒加载并渲染 canvas', async ({ page }) => {
  await signIn(page)
  await page.locator('[data-scene-id="stack-yard"]').click()
  await expect(page.locator('.yard-panel')).toBeVisible({ timeout: 20_000 })

  await page.locator('[data-view-toggle="graphics"]').click()
  const glCanvas = page.locator('.twin-viewport-graphics canvas')
  await expect(glCanvas).toBeVisible({ timeout: 30_000 })

  // 回到 2D 不应重挂地图
  await page.locator('[data-view-toggle="map"]').click()
  await expect(page.locator('.maplibregl-map')).toBeVisible()
})

test('世界模式切换到 HISTORY', async ({ page }) => {
  await signIn(page)
  await page.getByRole('banner').getByRole('button', { name: 'HISTORY' }).click()
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'HISTORY' })
  ).toHaveAttribute('data-active', 'true')
  // 时间倍速滑块仅在非 LIVE 模式出现
  await expect(page.locator('.portal-speed')).toBeVisible()
})

test('权限强制：guest 无法进入生产场景', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  const login = page.getByRole('textbox', { name: '用户名' })
  await login.waitFor({ state: 'visible', timeout: 15_000 })
  await login.fill('guest-77')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.locator('.portal-sidebar')).toBeVisible({ timeout: 20_000 })

  await expect(page.locator('[data-scene-id="production"]')).toBeDisabled()
  // URL 直达也被协调器强制拦截（I2-2）
  await page.goto('/#/scene/production')
  await expect(page.locator('[data-coordinator-state]')).toContainText('权限不足', {
    timeout: 10_000
  })
})

test('全局实体搜索定位（I8-5/I10-4）', async ({ page }) => {
  await signIn(page)
  const input = page.getByPlaceholder('搜索实体')
  await input.fill('沪舟')
  await expect(page.locator('.portal-search-results')).toBeVisible({ timeout: 10_000 })
  await page.locator('.portal-search-item').first().click()
  // 选择后搜索框清空、壳层保持正常
  await expect(input).toHaveValue('')
  await expect(page.locator('.portal-sidebar')).toBeVisible()
})

test('告警确认与快照导出按钮存在（I8-4/I8-7）', async ({ page }) => {
  await signIn(page)
  await page.locator('[data-scene-id="production"]').click()
  await expect(page.locator('.prod-panel')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-export-snapshot]')).toBeVisible()
  // 若当前有告警则确认第一项（面板保持正常）
  const ack = page.locator('[data-ack-alarm]').first()
  if (await ack.isVisible().catch(() => false)) await ack.click()
  await expect(page.locator('.prod-panel')).toBeVisible()
})

test('HISTORY 时间线 scrubber 可见（I9-6/I10）', async ({ page }) => {
  await signIn(page)
  await page.getByRole('banner').getByRole('button', { name: 'HISTORY' }).click()
  await expect(page.locator('.portal-scrub')).toBeVisible({ timeout: 10_000 })
})

test('站点切换：范围变化触发场景重跑（I10-1）', async ({ page }) => {
  await signIn(page)
  await page.locator('[data-scene-id="stack-yard"]').click()
  await expect(page.locator('.yard-panel')).toBeVisible({ timeout: 20_000 })
  // 切换站点 → App 强制重跑场景（面板重建、数据跟随新站点）
  await page.getByRole('banner').getByRole('button', { name: '启东' }).click()
  await expect(page.locator('.yard-panel')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.portal-sidebar')).toBeVisible()
})
