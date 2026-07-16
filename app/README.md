# Murmur 前端（`app/`）

Murmur 桌面端的 **Tauri + React + TypeScript** 前端。
- `src/` — React 组件、页面、状态（`components/`、`pages/`、`data/`、`utils/`）
- `src-tauri/` — Rust 端：命令、窗口、打包配置（`tauri.conf.json`）
- `scripts/` — 后端打包与 Tauri 构建脚本
- 聊天分析用的 Python CLI 后端在仓库根目录的 `cli/`，由 `scripts/bundle-backend.mjs` 打进桌面包

## 开发

```bash
npm ci              # 按 package-lock.json 严格安装依赖
npm run dev         # 仅前端热更新（Vite，在浏览器里调 UI）
npm run tauri:dev   # 完整桌面应用（Tauri 起 Rust 壳 + 前端）
```

## 构建

```bash
npm run build       # 类型检查 + 前端产物：tsc -b && vite build → dist/
npm run tauri:build # 打包桌面安装包：先 backend:bundle，再 tauri build
```

发布安装包由 GitHub Actions（`.github/workflows/release-build.yml`）在推送 `v*` tag 时自动构建。
