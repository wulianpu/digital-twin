#!/usr/bin/env node
/**
 * Golden 对比（I6-2）：当前截图 vs 基线，像素差异 > 0.5% 即失败。
 * 用法：
 *   node scripts/capture.mjs current     # 先采集当前帧到 current/
 *   node scripts/compare.mjs             # 对比 golden/ vs current/
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const toolDir = fileURLToPath(new URL('..', import.meta.url))
const goldenDir = join(toolDir, 'golden')
const currentDir = join(toolDir, 'current')
// I9-6：确定性 fixture 模式下所有帧统一 0.5%（水体/数据已冻结）
const DEFAULT_THRESHOLD_PERCENT = 0.5

if (!existsSync(currentDir)) {
  console.error('✗ current/ 不存在：先运行 node scripts/capture.mjs current')
  process.exit(1)
}

let failed = false
for (const file of readdirSync(goldenDir)) {
  if (!file.endsWith('.png')) continue
  const golden = PNG.sync.read(readFileSync(join(goldenDir, file)))
  const currentPath = join(currentDir, file)
  if (!existsSync(currentPath)) {
    console.error(`✗ ${file}: current 缺失`)
    failed = true
    continue
  }
  const current = PNG.sync.read(readFileSync(currentPath))
  if (golden.width !== current.width || golden.height !== current.height) {
    console.error(`✗ ${file}: 尺寸不一致 ${golden.width}x${golden.height} vs ${current.width}x${current.height}`)
    failed = true
    continue
  }
  const diff = new PNG({ width: golden.width, height: golden.height })
  const diffPixels = pixelmatch(golden.data, current.data, diff.data, golden.width, golden.height, {
    threshold: 0.1
  })
  const total = golden.width * golden.height
  const percent = (diffPixels / total) * 100
  const threshold = DEFAULT_THRESHOLD_PERCENT
  if (percent > threshold) {
    console.error(`✗ ${file}: 差异 ${percent.toFixed(2)}% > ${threshold}%`)
    const diffPath = join(currentDir, 'diff', file)
    mkdirSync(dirname(diffPath), { recursive: true })
    writeFileSync(diffPath, PNG.sync.write(diff))
    failed = true
  } else {
    console.log(`✓ ${file}: 差异 ${percent.toFixed(2)}%（阈 ${threshold}%）`)
  }
}

process.exit(failed ? 1 : 0)
