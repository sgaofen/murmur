# Murmur 微语 · 你的微信社交故事

> **100% 本地** · 不联网，不上传，不打点 · 把你这些年的微信聊天，变成一本可读、可分析、可分享的关系档案

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)]()
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Latest](https://img.shields.io/github/v/release/sgaofen/murmur)](https://github.com/sgaofen/murmur/releases/latest)

![cover](docs/screenshots/graph-full.png)
*所有截图开了「🔒 隐私模式」—— 真实使用显示真名。*

---

## 它能做什么

把你已登录的微信里几年的聊天记录变成 **三种东西**：

1. **关系网络** — 你和所有联系人 + 朋友与朋友之间的真实互动（私聊互相提及、群聊真互动、朋友圈点赞评论），3D 可旋转可点击
2. **离线信号矩阵** — 不靠 AI，纯本地统计就能告诉你：哪些是 4 年老朋友、谁和你互相关心、谁单方面关心你、谁正在淡出
3. **AI 关系档案**（可选）— 接入本地 [Claude Code](https://github.com/anthropics/claude-code) 或 [Codex CLI](https://github.com/openai/codex)，让它读对话样本（最多 80 条 / 朋友），输出结构化关系深度分析；**关系网页面有「批量分析关系」按钮**，一次跑完 Top N 对朋友间的关系档案

---

## 下载

**[最新 Release](https://github.com/sgaofen/murmur/releases/latest)**

| 平台 | 文件 | 大小 |
|---|---|---|
| 🪟 Windows 10/11 | **`Murmur_x.x.x_x64-setup.exe`**（推荐）| 22 MB |
| 🪟 Windows MSI | `Murmur_x.x.x_x64_en-US.msi`（IT 部署用） | 28 MB |
| 🍎 macOS Apple Silicon | **`Murmur_x.x.x_aarch64.dmg`** | 28 MB |
| 🍎 macOS Apple Silicon | `Murmur_x.x.x_aarch64.app.zip`（开发者）| 25 MB |

> Win MSI 在某些 Win11 装出 1603 错；遇到就用 NSIS 的 .exe。
> Mac Intel 暂时只能从源码跑。

---

## 上手指南（按系统）

两边的 **抓 key 机制根本不同** —— 别照对方的步骤走：

### 🪟 Windows
**保持微信登录状态** → 启动 Murmur → onboarding 让你点「开始抓密钥」→ Hook 装到正在跑的 Weixin.exe → **你去微信里手动登出再登录一次** → Hook 捕获主 key → 自动解密 → 进主界面

详见 **[Windows 上手指南](docs/ONBOARDING_WINDOWS.md)**。

### 🍎 macOS
启动 Murmur → onboarding 引导你给完全磁盘访问 + 给 WeChat 重签名 → **去 WeChat 里点 5+ 个对话 + 翻朋友圈**（让 WCDB 把 key 派生到内存）→ 回 Murmur 点「开始自动抓取」→ 系统弹密码框 → 扫内存匹配 14 个 DB 的 key → 自动解密 → 进主界面

详见 **[macOS 上手指南](docs/ONBOARDING_MAC.md)**。

---

## 它是怎么工作的

```
┌─────────────────────────────────────────────────────────────┐
│  你电脑上微信本地数据 (xwechat_files/ 或 ~/Library/...)     │
│  - 加密 SQLite (SQLCipher v4 / AES-256-CBC / 4096B 页)      │
│  - 加密 .dat 图片 / silk 语音 / 朋友圈 XML                   │
└─────────────────────────────┬───────────────────────────────┘
                              │
                  Win: hook + login event   Mac: scan + DB clicks
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  解密后 SQLite → ~/Documents/Murmur/decrypted/<wxid>/       │
│  contact.db / session.db / message_*.db / sns.db / ...      │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Tauri shell + React UI                                      │
│  └ etcli.exe (PyInstaller 后端) on 127.0.0.1:9100          │
│    - 关系图构建（mutual_reply / mention / co_group / sns）  │
│    - 离线信号矩阵                                            │
│    - 朋友圈互动解析                                          │
│    - AI 分析包构造 + 调本地 claude/codex CLI               │
└─────────────────────────────────────────────────────────────┘
```

### 核心算法

- **WCDB v4 解密**：`PBKDF2-HMAC-SHA512` 256000 轮 → AES-256-CBC，每页 4096B 含 16B IV + 64B HMAC reserve
- **群聊真互动**：5 分钟滑窗内 A 回复 B（不同发送者），按群人数对数衰减
- **朋友圈交叉互动**：解析 `SnsTimeLine.content` XML 里的 `<like_user_list>` 和 `<comment_user_list>`，识别 A↔B 互动（不经你）
- **朋友间提及**：私聊里按显示名匹配其他朋友（带 EXCLUDE 黑名单）
- **AI prompt**：强制每个结论引用具体消息（带日期）或统计数字，不接受空洞形容词

---

## 截图

### 关系网络（隐私模式开启）
97 个真实朋友 / 149 条边，按互动权重分布。点节点看详情，点连线看朋友间互动证据。
![graph-full](docs/screenshots/graph-full.png)

### 选中朋友 → 跨场景画像 + 重要连线
![graph-detail](docs/screenshots/graph-detail.png)

### 朋友档案：AI 摘要 + 离线证据卡
不接 AI 也能用：层级、持续年、线下证据条数、朋友圈双向、深夜比、通话次数 全离线统计。
![friend](docs/screenshots/friend.png)

### AI 关系档案
强制每个结论引用具体消息或统计 —— 不接受空洞形容词。
![ai-report](docs/screenshots/ai-report.png)

---

## FAQ

**Q: 微信会被封吗？**
不会。Murmur 不调任何微信 API、不模拟登录、不发消息。它只是从你电脑本地数据库读历史聊天。Win 上「Hook」是注入到本机进程读内存，跟反作弊扫描无关；Mac 上「重签名」也只改你本机 .app，不动 Tencent 服务端任何东西。

**Q: 用了 AI 会上传我的聊天吗？**
看你用的 AI 是谁：
- 接 Claude Code / Codex CLI — 对话样本（每个朋友最多 80 条）会经它们上传到 Anthropic / OpenAI（这是 CLI 的常规行为，与 Murmur 无关）
- 不接 AI — 离线信号矩阵 + 关系图 + 双人年代记 全本地，零联网

**Q: 数据会被存到云端吗？**
不会。所有产物都在你 `~/Documents/Murmur/` 和 `~/Desktop/Murmur/agent_reports/`，删了就没了。详见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

**Q: 支持微信哪些版本？**
- Win：4.x（4.1.x 测过）
- Mac：4.x
- 3.x **不支持**（数据库格式不同）

**Q: 我没装 Python / Node 也能用吗？**
用打包版不用装。Windows / macOS 安装包会带上后端运行时；源码一键脚本（`install-mac.sh` / `start-windows.bat`）才会检测并安装 Python、Node 和项目依赖。

**Q: 能合伙人/家庭成员一起用同一份数据吗？**
不能。每个微信账号是独立的，数据格式以 wxid 区分，每人各装各的。

**Q: 可以分析别人的微信吗？**
**不可以**。Murmur 设计上就是「读你自己电脑上你自己账号的数据」。读别人的电脑/账号是非法的，也违反 Tencent 用户协议。

---

## 致谢

- [chatlog](https://github.com/sjzar/chatlog) (DMCA'd) —— SQLCipher v4 解密算法参考
- [wechat-dump-rs](https://github.com/0xlane/wechat-dump-rs) (DMCA'd) —— 内存扫 key 思路参考
- echotrace（作者前作）—— silk → mp3 提取 + V4-V1 image 解密
- [Tauri](https://tauri.app/) —— 跨平台 shell
- [PyInstaller](https://pyinstaller.org/) —— Win 自包含打包

---

## License

[MIT](LICENSE) — 自己用、改、fork 都行；别拿去卖给微信用户做商业服务。
