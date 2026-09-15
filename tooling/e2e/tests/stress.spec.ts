import { expect, test } from '@playwright/test'

/**
 * Issue #13：短周期真实浏览器 mixed-resource stress（CI 版 ≥6 轮）。
 * mixed 场景：global-ships(3D) / stack-yard(2D↔3D toggle) / production(3D+GLTF)
 * 重入循环；验收 = SoakReport.pass（heap + 资源 counter 全部 plateau）。
 */
test.describe('mixed-resource stress（Issue #13）', () => {
  test('6 轮 mixed 循环：3D 进入、资源 counter plateau、report.pass', async ({ page }) => {
    test.setTimeout(240_000)
    await page.goto('/?soak=1&soakCycles=6#/scene/global-ships')
    const login = page.getByRole('textbox', { name: '用户名' })
    await login.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
    if (await login.isVisible().catch(() => false)) {
      await login.fill('张工')
      await page.getByRole('button', { name: '登录' }).click()
    }
    await expect
      .poll(async () => page.evaluate(() => (window.__twinSoakReport ? 'done' : 'pending')), {
        timeout: 180_000,
        intervals: [2_000, 5_000]
      })
      .toBe('done')

    const report = await page.evaluate(() => window.__twinSoakReport)
    expect(report.completedCycles).toBe(6)
    expect(report.pass).toBe(true)
    // 真实 3D 生命周期确实进入：renderer 资源 counter 已被采样
    const sampled = report.samples.filter((s) => s.resources?.textures !== undefined)
    expect(sampled.length).toBeGreaterThan(0)
  })
})
