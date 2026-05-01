# macOS 上手指南

> 0.2 版（2026-05）开始，Mac 不再需要 Win 协助 — 整套流程可以在你这台 Mac 上独立完成，**不需要关 SIP，不需要重启**。

---

## 三种安装方式（任挑一个）

### 方式 1 · `.app` 安装包（最像普通 Mac App）

去 [Releases](https://github.com/sgaofen/murmur/releases) 下载 `Murmur_<version>_aarch64.dmg`（M 系列）或 `Murmur_<version>_x64.dmg`（Intel），把 Murmur 拖进 `/Applications`。

> 也可以下 `Murmur.app.zip` 解压后拖进 `/Applications`。两种最终结果一样。

### 方式 2 · 一行 curl 安装（小白推荐）

打开「终端」（Spotlight 搜 Terminal），粘下面这行回车：

```bash
curl -fsSL https://raw.githubusercontent.com/sgaofen/murmur/main/install-mac.sh | bash
```

脚本会全自动：装 Homebrew → `brew install python@3.12 node ffmpeg` → `git clone` 到 `~/Applications/Murmur` → 装依赖 → 启动浏览器版。完整一遍约 3 分钟。

### 方式 3 · 从源码（开发者）

```bash
git clone https://github.com/sgaofen/murmur.git
cd murmur
bash start-mac.sh
```

需要 Python 3.11+ 和 Node.js 18+。第一次启动会自动 `pip install` 和 `npm install`。

---

## 首次启动 onboarding（不管哪种方式都一样）

### Step 1 · 给 Murmur 完全磁盘访问（仅 .app 路径）

第一次打开 .app 时，Murmur 会引导你在系统设置里给一次「完全磁盘访问」权限。这是 macOS 的硬性要求 —— 任何想读 `~/Library/Containers/<其他 App>/...` 的工具都要过这关。

操作：
1. 在 Murmur 弹出的「第一步」页点 **「打开系统设置 → 完全磁盘访问」**
2. 找到 **Murmur**，把右边开关打 **开**（如果列表里没有，点左下 **+** 选 `/Applications/Murmur.app`）
3. **完全退出 Murmur 再重新打开**（macOS 必须重启进程才生效）

> 走 install-mac.sh 或 start-mac.sh 用浏览器版的话**不需要这步** —— 你的终端 / 浏览器本身就有读取权限。

### Step 2 · 给 WeChat 重签名（一次性，不需要关 SIP）

macOS 默认给 WeChat 加了 **hardened runtime** 标记，导致系统拒绝任何调试器附加 —— 也就是抓不了 SQLCipher 密钥。

Murmur 的 onboarding 会引导你**一键重签名**：

1. 点 **「确认重签名（系统会弹密码窗口）」**
2. macOS 弹系统认证窗 → **输入你的开机密码**
3. Murmur 自动跑：
   ```bash
   codesign --remove-signature /Applications/WeChat.app/Contents/MacOS/WeChat
   codesign --force --sign - /Applications/WeChat.app/Contents/MacOS/WeChat
   ```
4. 自动重启 WeChat → 你扫码登录一次（之前的 token 还在，是免密的）

> 重签名做的事就是清掉 `flags=0x10000(runtime)` 标记，AMFI 就放行 task_for_pid。SIP 完全没动。WeChat 自己升级时会重置回原签名，不影响后续使用。

### Step 3 · 在 WeChat 里点开几个对话

WCDB（微信用的 SQLCipher 包装器）是**惰性派生 key** 的 —— 只有你打开过的 DB，对应的 key 才会被材料化到内存里。

- 点 3-5 个不同的私聊（不同朋友会触发不同的 message_*.db）
- 翻一下朋友圈
- 点一下「联系人」、「收藏」标签
- 等列表加载完

这一步做得不到位的话，抓出来的 14 个 DB 可能少几个，对应那些朋友的聊天就没法解密。

### Step 4 · 抓密钥

回到 Murmur，点 **「开始自动抓取（约 30 秒）」**。

1. 系统再弹一次密码窗口（这次是给抓密钥脚本要 root 权限 —— 因为 macOS 要求 root 才能 task_for_pid 别人的进程）
2. 输入开机密码
3. Murmur 在后台扫 WeChat 进程内存，找 WCDB 缓存格式 `x'<64hex_aes_key><32hex_salt>'`
4. 配每个 DB 的 salt 找出对应的 AES key
5. 自动解密所有 DB，进主界面

完整过程一般 30-60 秒。

---

## 进了主界面之后

| 功能 | 怎么用 |
|---|---|
| **首页年代记** | 自动呈现 — 月度热度曲线、活跃高峰、Top 朋友卡片 |
| **朋友档案** | 点首页朋友卡 → 「故事」/ 「相册」/ 「完整对话」 三个标签 |
| **离线信号矩阵** | 朋友档案里 → 关系层级 / 持续年 / 线下证据 / 通话次数 / 朋友圈双向（这些不靠 AI，纯本地统计）|
| **关系网络** | 左下「关系网络」按钮 → 3D 旋转图 → 鼠标悬停预览 → 点击查看朋友间互动证据 |
| **AI 关系档案** | 朋友档案 → 「🤖 导出 AI 分析包」→ 选 Claude Code / Codex / Gemini → 「让它分析」→ 等 1-2 分钟 → 12k 字结构化报告（带日期引文、人物画像、行动建议） |
| **离线表格视图** | 左下「加载」按钮 → 32 朋友 × 7 维信号矩阵，可导出 CSV |
| **隐私模式** | 左下角 🔓 → 把所有真名换成「朋友 AB」「朋友 CD」 — 用于截图分享 |

---

## 我电脑上没装 Claude Code / Codex / Gemini，怎么办？

可以走「导出 AI 分析包」→ 选「**通用（任何 AI）**」→ 生成一份 markdown 包 → 拖给 ChatGPT / Claude.ai / 豆包 / 文心一言 / Kimi / DeepSeek 任意一个，让它给你出报告。

装的话（任选其一即可）：

```bash
npm install -g @anthropic-ai/claude-code     # Claude Code (推荐)
npm install -g @openai/codex                  # Codex CLI
npm install -g @google/gemini-cli             # Gemini CLI
```

---

## 数据存哪？想撤销怎么办？

```bash
# 解密后的 DB （只在这里）
~/Documents/Murmur/decrypted/<wxid>/

# 14 把 AES key（只在这里）
~/.murmur/decrypted_keys.json

# AI 分析报告（只在这里）
~/Desktop/Murmur/agent_reports/
```

想完全清掉：

```bash
rm -rf ~/Documents/Murmur ~/.murmur ~/Desktop/Murmur
```

想撤销 WeChat 的 ad-hoc 重签名：等下一次 WeChat 自动更新就好（更新会重新走 Tencent 的签名流程）。或者手动重装 WeChat。

---

## 常见问题

**Q: macOS 报 *"Murmur 已损坏，无法打开"*？**
我们用 ad-hoc 签名（没有 Apple Developer ID），Gatekeeper 会拦。在终端跑：
```bash
xattr -dr com.apple.quarantine /Applications/Murmur.app
```

**Q: 「开始自动抓取」点了之后没反应？**
最常见的原因：你刚关掉了 macOS 弹的密码框，或者输错密码。后端已经 timeout 了。再点一次就行。

**Q: 抓出来 14 个 DB 但只匹配了几个？**
WCDB 没被全打开。回 WeChat 多点几个对话 / 翻翻朋友圈，让它把 key 派生到内存里，回 Murmur 再点一次「开始自动抓取」。

**Q: 关系图只能看不能选？**
0.2 版修了：现在鼠标悬停会有金色高亮 ring 预告 hit。点击去选目标节点 / 关系线。

**Q: 我能在没 Mac 的朋友那台 Win 上跑吗？**
能。WeChat 跨平台用同一个 SQLCipher key（同账号）。Win 上跑 Murmur 抓出 key（在 `~/.murmur/config.json`），拷过来塞到 Mac 同位置即可。Mac 端的 onboarding 第一次启动会问你「有保存的 key 吗」。

---

## 失败模式 / 已知边界

- macOS 14 以下未测试（架构上应该兼容到 11+，但没人手动验证）
- 微信 4.x 完整支持，3.x 不支持（DB 格式不同）
- Mac 抓 key 不支持自动重启 WeChat（不像 Win 有 wx_key.dll，会自动 kill + 等用户登录）
- 一台 Mac 一次只支持一个微信账号 — 多开账号需要逐个重签名（同 .app 不需要重签）

有问题来 [GitHub Issues](https://github.com/sgaofen/murmur/issues) 提。
