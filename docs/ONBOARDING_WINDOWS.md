# Windows 上手指南

> 全程约 2 分钟。需要：登录过的微信 + Python 3.11 + Node.js（开发模式）

---

## 第一次启动 — 三步

### 1. 装依赖（一次）

如果你有：
- ✅ **Python 3.11+** （命令行 `python --version` 验证）
- ✅ **Node.js 18+** （`node --version`）

直接跳到第 2 步。否则装一下：
- Python: https://www.python.org/downloads/ （**勾选 Add Python to PATH**）
- Node: https://nodejs.org/ （选 LTS）

### 2. 下载 + 解压

从 [Releases](https://github.com/sgaofen/murmur/releases) 下载：
- **方式 A（推荐）**: `Murmur_x.x.x_x64-setup.exe` — 双击安装，桌面会有 Murmur 图标
- **方式 B（开发者）**: 克隆源码 `git clone https://github.com/sgaofen/murmur.git`

### 3. 运行

**方式 A**: 双击桌面 Murmur 图标即可。

**方式 B**: 进项目根目录，双击 `start-windows.bat`。

第一次会自动 `pip install` + `npm install`，需要等 ~1 分钟联网下载依赖。

---

## 引导流程（自动）

1. **检测系统** — Murmur 自动找你的微信安装位置 + 数据文件
2. **抓密钥** — 如果是首次：
   - 点 "开始（30 秒）"
   - **微信会自动重启** — 在弹出的微信窗口里点「登录」
   - 30 秒内你能看到 "✓ 一切就绪"
3. **解密** — 自动用 `go_decrypt.dll` 解密所有数据库到 `~/Documents/Murmur/decrypted/`
4. **进入主界面**

---

## 数据存哪

| 内容 | 路径 |
|---|---|
| 解密后的微信数据库 | `~/Documents/Murmur/decrypted/wxid_xxx/` |
| AI 分析报告 | `~/Desktop/Murmur/agent_reports/{friends,pairs}/` |
| 语音转写 | `~/Desktop/Murmur/voice_transcripts/{wxid}/` |
| 缓存（图统计等）| `~/Documents/Murmur/cache/` |
| SQLCipher 密钥 | `~/.murmur/config.json`（明文，**机密**）|

**全本地，不联网。** 如果不想留任何痕迹，删除上面所有目录即可。

---

## 可选 AI 增强

想看 AI 写的关系档案？装其中一个：

```powershell
# Claude Code（Anthropic）
npm install -g @anthropic-ai/claude-code

# 或 Codex CLI（OpenAI）
npm install -g @openai/codex
```

第一次跑 `claude` 或 `codex` 会让你登录账号。装好后 Murmur 会自动检测，每个朋友档案页有「🤖 让 claude 分析」按钮。

**注意**：用 AI 分析时，对话样本（每个朋友最多 80 条消息）会上传到 Anthropic / OpenAI 服务器（这是 AI CLI 的正常行为，与 Murmur 无关）。介意的话不装就行，离线信号矩阵也能看出关系层级。

---

## 可选语音转写

```powershell
pip install faster-whisper
winget install Gyan.FFmpeg
```

然后 `python cli\transcribe_voice.py` 把已有的 mp3 转成文字。约 30-60 分钟（CPU）/ 5 分钟（GPU）。

---

## 故障排除

### "找不到微信数据"
- 确认你登录过微信
- Murmur 会找：`D:/Documents/xwechat_files`、`~/Documents/xwechat_files`、`~/OneDrive/Documents/xwechat_files`
- 如果你的微信数据在别的盘，设环境变量：`set MURMUR_WECHAT_ROOT=E:/path/to/xwechat_files`

### "抓密钥失败 timeout"
- 微信版本变了，wx_key.dll 可能不兼容
- 临时方案：手动从内存抓 key 然后粘贴进 onboarding 的「Mac 模式」（Win 上也能用粘贴）

### "Failed to fetch / 连接错误"
- 后端 etcli serve 死了
- 重启：关闭所有 cmd 窗口，重新双击 `start-windows.bat`

### 端口 9100 被占用
- 改 `cli/etcli.py serve --port 9101` 然后改 `app/.env` 加 `VITE_ETCLI_URL=http://localhost:9101`

---

## 隐私模式（录视频用）

右下角有个「🔓 隐私模式：关」按钮。点一下变「🔒 开」，所有朋友名变成「朋友 AB」「朋友 CD」格式（按 wxid 哈希稳定映射），群名变成「群 1」「群 5」等。

适合录演示视频、截图、给朋友看不暴露具体人。
