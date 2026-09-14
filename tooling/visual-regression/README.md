# Visual Regression Harness

按冻结文档 §78，任何 `three` / `maplibre-gl` / `3d-tiles-renderer` 版本升级必须
运行 Golden Scene 截图对比。本目录提供接入位置与约定；截图驱动（Playwright）
作为可选依赖在具备 GPU 的 CI/工作机上启用，不进入默认 `pnpm test`。

## 约定

- Golden Scene：`stack-yard`（2D 默认帧）、`production`（3D 默认帧）、
  `heavy-transport`（路径预演帧）三个场景为基线。
- 截图时机：进入场景后等待 tiles/资产加载稳定（`loadProgress == 1` 或 3s），
  然后统一 viewport（2560×1440, devicePixelRatio=1）截图。
- 对比：像素差异 > 0.5% 即失败，输出 diff 图。

## 接入

```bash
# 在具备浏览器的机器上（一次性）：
pnpm add -D playwright @twin/... # 安装可选依赖

# 运行三个 golden scene 并截图（脚本占位，按上述约定实现）：
pnpm dev:portal &            # 启动 portal
node tooling/visual-regression/scripts/capture.mjs http://localhost:5173 out/
```

`scripts/capture.mjs` 为实现占位：它给出截图时序与命名约定
（`<scene>-<view>-<quality>.png`），渲染差异比对可直接使用
`pixelmatch` / `resemble.js` 或 CI 供应商的截图对比能力。
