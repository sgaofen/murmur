# 在 Mac 上跑 Murmur

> 完整测试指南。你在 Mac 上第一次起 Murmur 时，先看这一份。

## 前置

- macOS 10.15+ (建议 12+)
- Python 3.11+ (`python3.12 --version`；`start-mac.sh` 会自动优先找 3.13/3.12/3.11)
- Node.js 18+ (`node --version`)
- Python 依赖：`zstandard` / `cryptography`（`start-mac.sh` 会自动安装）
- 可选语音转写依赖：`python3.12 -m pip install -r requirements-voice.txt`

## Mac 功能状态

| 功能 | Mac 状态 |
|------|---------|
| 数据库解密 (微信 → SQLite) | ✅ 支持（纯 Python WCDB v4 解密） |
| 抓 SQLCipher 密钥 | ✅ 支持（扫描 WeChat 进程内存，需完全磁盘访问 + WeChat ad-hoc 重签名） |
| 抓 image AES key | ⚠️ 暂不支持自动抓取 |
| **浏览/分析已解密的数据** | ✅ 完全支持 |
| AI agent 调用 (claude / codex) | ✅ 完全支持 |
| 媒体相册 / 完整对话 / AI 分析 | ✅ 完全支持 |
| 视频 / 已解密图片预览 | ✅ 完全支持 |

**推荐工作流**：直接跑 `bash start-mac.sh`。首次没有解密数据时，应用内 onboarding 会引导你授权完全磁盘访问、重签名 WeChat、点开几个对话并抓取 per-DB key。

## 一键检查（先跑这个）

```bash
cd ~/murmur/cli
python3.12 paths.py
```

期望输出：
```
Platform   : Darwin <版本>
Python     : 3.x.x
Murmur home: /Users/<you>/Documents/Murmur
WeChat exe : /Applications/WeChat.app  (或 None)

WeChat profiles found:
  wxid_xxx (...)
    encrypted: ~/Library/Containers/com.tencent.xinWeChat/...

Capabilities:
  can_decrypt_db                : True
  can_extract_key               : True 或 False（取决于权限 / WeChat 签名状态）
  has_wechat_data               : True 或 False
```

如果 `has_wechat_data: False`，说明你 Mac 上没用过微信，没有数据可以分析。先在这台 Mac 登录 WeChat，或跳到下面的“从 Windows 同步数据”。

## 从 Windows 同步数据到 Mac (若 Mac 上没数据)

在 Windows 上：
```
C:\Users\YY\Documents\Murmur\decrypted\wxid_xxx\   ← 整个拷过来
```

放到 Mac 的相同位置：
```bash
~/Documents/Murmur/decrypted/wxid_xxx/
```

然后 `python3.12 paths.py` 应该能看到 profile + `has_decrypted_data: True`。

## 启动后端

```bash
cd ~/murmur/cli
python3.12 etcli.py serve --port 9100
```

后端会自动发现 `~/Documents/Murmur/decrypted/<wxid>/` 里的 SQLite，所有读取/分析都不依赖 Windows DLL。

期望输出：
```
[etcli serve] Murmur API listening on http://127.0.0.1:9100/
  data_dir   : ~/Documents/Murmur/decrypted/wxid_xxx
  self wxid  : wxid_xxx
  export dir : ~/Desktop/Murmur
```

## 启动前端

```bash
cd ~/murmur/app
npm install     # 第一次需要装依赖
npm run dev -- --host 127.0.0.1
```

打开浏览器：[http://127.0.0.1:5173](http://127.0.0.1:5173)

第一次启动时会弹出 onboarding 引导，按页面提示完成 Mac 授权、抓 key 和解密。

## 打包 Mac App

```bash
cd ~/murmur/app
npm run tauri:build
```

默认只打 `.app`，避免本地开发时卡在 Finder/AppleScript 装饰 DMG 的步骤。发布 DMG 时再跑：

```bash
npm run tauri:build:dmg
```

## AI 分析

如果你 Mac 上装了 `claude` 或 `codex` CLI（如 npm 全局），Murmur 会自动检测：

```bash
npm install -g @anthropic-ai/claude-code   # 或者用 brew，看具体安装方式
npm install -g @openai/codex               # 可选：用 Codex CLI
```

然后在某个朋友页 → 「导出 AI 分析包」 → 顶部会出现「让 Claude Code 直接分析」选项。
Reports 页面也可以跑批量分析：小样本自检、Top N、全部朋友、以及按关系图权重补全朋友间关系。

Codex CLI 默认用 `gpt-5.2`，避免旧 CLI 默认模型过新导致报错。需要覆盖时：

```bash
MURMUR_CODEX_MODEL=gpt-5.4 npm run dev
```

## 调试 / 排错

### 后端启动失败
```bash
python3.12 etcli.py serve --port 9100 --data-dir ~/Documents/Murmur/decrypted/wxid_xxx
```
显式传 `--data-dir`，看具体报错。

### 前端报「连不上后端」
- 确认后端跑了：`curl http://127.0.0.1:9100/api/info`
- 确认浏览器没拦截 (浏览器开发工具 → Network → 看 fetch 请求)

### 媒体不显示
- 跑一次媒体索引：`cd ~/murmur/cli && python3.12 media.py index`
- 检查：`ls ~/Documents/Murmur/media-index.json` 应该存在

### TypeScript 报错
- `cd app && npx tsc --noEmit` 看具体错误
- 项目已经在 Windows 上 0 错误测试过；Mac 上应该一样

## 完整开发流（高级用户）

```bash
# Terminal A: 后端
cd ~/murmur/cli
python3.12 etcli.py serve

# Terminal B: 前端
cd ~/murmur/app
npm run dev -- --host 127.0.0.1
```

修改任意 .ts/.tsx 文件 → vite 自动热重载。修改 .py 文件 → 重启 etcli serve。

## 反馈渠道

跑出来什么问题，请记录：
- `python3 paths.py` 的完整输出
- 后端报错（终端里那段）
- 前端浏览器 console 里的红色错误（F12 打开）

把这三块发给我，我能定位 99% 的问题。
