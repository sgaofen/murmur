# 隐私 & 安全

## TL;DR

Murmur 没有联网逻辑（除了你主动调 AI 的那一刻）。所有数据从你电脑里的微信本地数据库读出，分析在你电脑上完成，结果保存在你 Desktop / Documents 下。**你能删的全是文件**。

---

## 三种数据流

### 1. 离线分析（默认 / 100% 本地）

```
xwechat_files/ → decrypt_py.py / go_decrypt.dll → 你电脑上的 SQLite
                                                    │
                                                    ▼
                                                 等数据
                                                    │
                                                 Murmur 后端 (Python http server) on 127.0.0.1:9100
                                                    │
                                                    ▼
                                              React 前端 on 127.0.0.1:5173
```

**没有任何外部网络请求**。Telemetry: 0。

本地后端只给 Murmur 开发前端 `127.0.0.1:5173` / `localhost:5173` 和 Tauri 应用来源开放 CORS。普通网页、外网网页、以及其他 localhost 端口都不能跨域读取 Murmur 的本地 API。

### 2. AI 分析（可选 / 你主动触发）

如果你点了「🤖 让 claude/codex 分析」按钮：

```
你的对话样本 (≤80 条/朋友, 文字) → 通过你本机已装的 claude/codex CLI 上传到 Anthropic / OpenAI
                                                                │
                                                                ▼
                                                              AI 输出回流
                                                                │
                                                                ▼
                                                            落盘到 Desktop/Murmur/agent_reports/
```

**这一步上传到第三方**：
- Claude Code → Anthropic（你的 API key 账号）
- Codex CLI → OpenAI（你的 API key 账号；默认模型 `gpt-5.2`，可用 `MURMUR_CODEX_MODEL` 覆盖）

如果不想上传，**别点 AI 按钮**。离线信号矩阵 + 关系图 + 双人年代记 完全本地、能看出 70% 的关系深度。

### 3. 语音转写（可选 / 100% 本地）

如果你装了可选依赖 `requirements-voice.txt`：

```
echotrace 已提取的 mp3 → 本地 Whisper 模型 (CPU 或 GPU) → 文字 .txt
```

**没有外部网络**。Whisper 模型一次性下载在 `~/.cache/huggingface/`，之后离线。

---

## 你的数据存在哪 + 怎么删

| 内容 | 路径 | 怎么删 |
|---|---|---|
| 解密后的微信数据库 | `~/Documents/Murmur/decrypted/` | 删整个文件夹 |
| AI 分析报告 | `~/Desktop/Murmur/agent_reports/` | 删整个文件夹 |
| 语音转写 | `~/Desktop/Murmur/voice_transcripts/` | 删整个文件夹 |
| 缓存 | `~/Documents/Murmur/cache/` | 删整个文件夹 |
| **SQLCipher 密钥**（明文）| `~/.murmur/config.json` | 删这文件 |
| 微信原始数据 | `~/Documents/xwechat_files/` 或 `D:/...` | **不归 Murmur 管**，是微信自己的 |

**完全卸载**：删上面前 5 项 + 卸载 Murmur 即可，没有任何残留。

---

## 关于 SQLCipher 密钥

`~/.murmur/config.json` 里存的是你微信账号的解密密钥（64-hex）。

**它能干什么**：
- 解密你的本机微信数据库（任何人拿到就能看你聊天历史）

**它不能干什么**：
- 登录你的微信账号
- 看你新消息（只是历史 + 你电脑上有的）
- 解密别人的微信

**最佳实践**：
- 不要把这文件分享给任何人
- 不要把它 commit 进 git（`.gitignore` 已包含 `.murmur/`）
- 换电脑的话直接删，新电脑重新抓

---

## 隐私模式（开发者用）

UI 右下角「🔒 隐私模式：开」按钮：

- 所有朋友显示名变成 `朋友 AB`、`朋友 CD`（按 wxid 哈希稳定映射，刷新/换页都一致）
- 群名变成 `群 1`、`群 5` 等
- wxid 字符串变成 `wxid_1234`（短哈希）

**用途**：录演示视频、截图、给朋友看，不暴露真实联系人。

**注意**：
- AI 报告 .md 里的内容**不会自动脱敏**（已经写到磁盘了），只在 UI 显示时遮蔽。
- 想要永久脱敏的导出，用 `scripts/anonymize.py` （TODO）。

---

## 可审查性

- 源代码 100% 公开 (MIT License)
- 没有任何混淆
- 没有任何 telemetry / analytics 库
- 没有任何外部 API key 硬编码
- `requirements.txt` 列了主功能 Python 依赖，`requirements-voice.txt` 列了可选语音转写依赖，`package.json` 列了所有 JS 依赖

如果你不放心，可以：
- 在隔离的 VM / Docker 里跑
- 用 Wireshark 监听 localhost 之外的流量（应该是 0，除非你点 AI 按钮）

---

## 反向工程合法性

Murmur 读取**你自己微信账号的本地数据**。从司法角度（中国大陆 + 美国 EFF 立场）：
- ✅ 读取你自己设备上的数据（"自有数据访问权"）
- ✅ 不调用微信 API、不模拟登录、不发消息、不与微信服务器通信
- ✅ MIT License 开源（不构成 DMCA 规避情况下分发）

但请注意：
- 不要用 Murmur 读取**别人的**微信数据（无授权访问别人电脑/账号是非法的）
- 不要把分析结果用于骚扰、勒索、商业用途之外的目的
- 微信用户协议禁止「未经授权读取数据」—— 严格意义上 Tencent 可能挑刺，但目前没有判例针对**自有账号**

**底线**：自己用，没问题。
