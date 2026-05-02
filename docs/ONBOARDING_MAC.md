# macOS 上手指南

> 全程 **5-10 分钟**。**不需要关 SIP，不需要重启**。需要：登录过的 WeChat for Mac 4.x。

---

## 与 Windows 的本质区别

| | macOS | Windows |
|---|---|---|
| 抓 key 机制 | 扫描 WeChat 进程内存找 WCDB 缓存 `x'<key><salt>'` | 注入 wx_key.dll hook，等登录事件 |
| 用户动作 | **去 WeChat 里点 5+ 个对话 + 翻朋友圈**（让 WCDB 把 key 派生到内存）| **登出再登入一次微信** |
| Key 数量 | 14 把 per-DB AES key（每 DB 一把）| 1 把主 key 解所有 DB |
| 额外权限 | **完全磁盘访问** + WeChat **重签名** | 无 |

**别照 Win 步骤走**。Mac 上「登出再登入」啥都不会发生。**正确动作是「点开各个对话」**，让 WCDB 把对应 DB 的 AES key 派生到内存，Murmur 才能扫到。

---

## 三种安装方式（任挑一个）

### 方式 1 · `.app` 安装包（最像普通 Mac App）

去 [Releases](https://github.com/sgaofen/murmur/releases/latest) 下：

- **`Murmur_x.x.x_aarch64.dmg`** （M 系列芯片，推荐）—— 双击打开，拖 Murmur 进 `/Applications`
- 或 `Murmur_x.x.x_aarch64.app.zip` —— 解压后拖进 `/Applications`

> 注意：只有 **Developer ID 签名 + Apple notarization** 后，才算真正“小白从 GitHub 下载后可直接打开”。未公证测试包会被 macOS Gatekeeper 拦截，只适合开发验证；正式发布流程见 [Mac 正式签名与公证发布教程](MAC_NOTARIZATION_GUIDE.md)。

> Mac Intel x64 dmg 还没出。Intel 用户用方式 2 或方式 3。

### 方式 2 · 一行 curl 安装（小白推荐）

打开「终端」（Spotlight 搜 Terminal），粘下面这行回车：

```bash
curl -fsSL https://raw.githubusercontent.com/sgaofen/murmur/main/install-mac.sh | bash
```

脚本全自动：装 Homebrew → `brew install python@3.12 node ffmpeg` → `git clone` 到 `~/Applications/Murmur` → 装依赖 → 启动浏览器版。完整一遍约 3 分钟。

### 方式 3 · 从源码（开发者）

```bash
git clone https://github.com/sgaofen/murmur.git
cd murmur
bash start-mac.sh
```

需要 Python 3.11+ + Node.js 18+。第一次启动自动 `pip install` 和 `npm install`。

---

## 首次启动 onboarding（4 步）

### Step 1 · 给 Murmur 完全磁盘访问（仅 .app 路径）

第一次打开 Murmur.app 时，Murmur 会引导你在系统设置里给一次「完全磁盘访问」权限。这是 macOS 硬性要求 —— 任何想读 `~/Library/Containers/<其他 App>/...` 的工具都要过这关。

操作：

1. Murmur 弹出「第一步」页 → 点 **「打开系统设置 → 完全磁盘访问」**
2. 找到 **Murmur**，把右边开关打 **开**（如果列表里没有，点左下 **+** 选 `/Applications/Murmur.app`）
3. **完全退出 Murmur 再重新打开**（macOS 必须重启进程才生效）

> 走 install-mac.sh 或 start-mac.sh 用浏览器版**不需要这步** —— 你的终端 / 浏览器本身就有读取权限。

### Step 2 · 给 WeChat 重签名（一次性，不需要关 SIP）

macOS 默认给 WeChat 加了 **hardened runtime** 标记，导致 AMFI 拒绝任何调试器附加 —— 也就是抓不了 SQLCipher 密钥。

Murmur onboarding 引导你**一键重签名**：

1. 点 **「确认重签名（系统会弹密码窗口）」**
2. macOS 弹系统认证 → **输入你的开机密码**
3. Murmur 自动跑：
   ```bash
   codesign --remove-signature /Applications/WeChat.app/Contents/MacOS/WeChat
   codesign --force --sign - /Applications/WeChat.app/Contents/MacOS/WeChat
   ```
4. 自动重启 WeChat → 你扫码或自动登录回来

> 重签名做的事就是清掉 `flags=0x10000(runtime)` 标记，AMFI 放行 task_for_pid。**SIP 完全没动**。WeChat 自己升级时会重置回原签名（不影响后续使用，下次更新后再做一次重签名即可）。

### Step 3 · 在 WeChat 里点开几个对话 ⚠️

这是 **Mac 路径专属** 步骤。WCDB（微信用的 SQLCipher 包装器）是**惰性派生 key** —— 只有你打开过的 DB，对应 AES key 才会被材料化到内存里。

Murmur 此时会显示「请去 WeChat 里点开几个对话」。**回 WeChat 做这些**：

- ✅ 点 **3-5 个不同的私聊**（不同朋友会触发不同的 message_*.db）
- ✅ **翻一下朋友圈**（触发 SnsTimeLine.db）
- ✅ 点一下「联系人」、「收藏」标签
- ✅ 等列表加载完

**做不到位的话**：抓出来的 14 个 DB 可能少几个，对应那些朋友的聊天就**没法解密**。这是用户最常踩的坑。

### Step 4 · 抓密钥

回 Murmur，点 **「开始自动抓取（约 30 秒）」**：

1. 系统再弹一次密码窗口（这次是给抓密钥脚本要 root 权限 —— macOS 要求 root 才能 `task_for_pid` 别人的进程）
2. 输入开机密码
3. Murmur 后台扫 WeChat 进程内存，找 WCDB 缓存格式 `x'<64hex aes_key><32hex salt>'`
4. 配每个 DB 文件的 salt（每个 DB 头 16 字节）找出对应 AES key
5. 自动解密所有 DB，进主界面

完整过程一般 30-60 秒。

---

## 进了主界面之后

| 想看 | 怎么进 |
|---|---|
| **首页年代记** | 启动后默认页 —— 月度热度曲线 / Top 朋友 / 总览 |
| **朋友档案** | 首页朋友卡 → 「故事」/ 「相册」/ 「完整对话」 三个标签 |
| **离线信号矩阵** | 朋友档案 → 关系层级 / 持续年 / 线下证据 / 通话次数 / 朋友圈双向（不靠 AI 纯本地）|
| **关系网络** | 顶部「🌌 关系网」按钮 → 3D 旋转图，鼠标悬停金色 ring，点节点查看 mini 关系网，点连线看朋友间互动证据 |
| **AI 关系档案** | 朋友档案 → 「🤖 让 claude/codex 分析」（需先装 CLI）|
| **批量分析关系** | 关系网页面右上「🤖 批量分析关系」—— 一键跑 Top 10/20/40 对朋友间的 AI 档案 |
| **离线表格视图** | 顶部「📊 表格」 —— 多维信号矩阵，可导出 CSV |
| **隐私模式** | 右下角 🔓 → 真名换成「朋友 AB」、群名「群 1」 — 录视频/截图分享用 |

---

## 我电脑上没装 Claude Code / Codex，怎么办？

走「导出 AI 分析包」→ 选「**通用（任何 AI）**」→ 生成 markdown 包 → 拖给 ChatGPT / Claude.ai / 豆包 / 文心一言 / Kimi / DeepSeek 任一。

或者装其一：

```bash
npm install -g @anthropic-ai/claude-code     # Claude Code（推荐）
npm install -g @openai/codex                  # Codex CLI
```

装完 Murmur 自动检测，每个朋友档案页 + 关系网批量按钮会自动可用。

---

## 数据存哪 + 怎么撤销

```bash
~/Documents/Murmur/decrypted/<wxid>/   # 解密后的 DB
~/.murmur/decrypted_keys.json          # 14 把 per-DB AES key
~/.murmur/config.json                  # （Win 主 key —— Mac 不用）
~/Desktop/Murmur/agent_reports/        # AI 分析报告
~/Documents/Murmur/cache/              # 图统计 / 首页摘要缓存
~/Documents/Murmur/logs/               # 后端日志
```

完全清掉：

```bash
rm -rf ~/Documents/Murmur ~/.murmur ~/Desktop/Murmur
```

撤销 WeChat 的 ad-hoc 重签名：等下一次 WeChat 自动更新（更新会重新走 Tencent 签名流程），或者手动重装 WeChat。

---

## 常见问题

### Q：macOS 报「Murmur 已损坏，无法打开」

这通常说明包没有正确签名、公证，或者下载文件仍带旧的损坏签名结构。正式面向小白的包必须走 Developer ID + notarization。开发验证时可临时跑：

```bash
xattr -dr com.apple.quarantine /Applications/Murmur.app
```

然后重新打开 Murmur.app。这个命令只是临时绕过，不是正式发行方案。

### Q：「开始自动抓取」点了之后没反应

最常见：你刚关掉了 macOS 弹的密码框，或者输错密码。后端已经 timeout 了。再点一次就行。

### Q：抓出来 14 个 DB 但只匹配了几个 ⚠️

**Step 3 没做到位**。WCDB 没被全打开 → 对应 key 不在内存。

修：回 WeChat 多点几个对话 / 翻翻朋友圈，让它派生更多 key 到内存，回 Murmur 再点一次「开始自动抓取」。

### Q：重签名失败

可能你装的不是标准位置 `/Applications/WeChat.app`。看 onboarding 的错误日志，把 `codesign` 命令手动复制到终端跑一遍，看 stderr。

### Q：「后端没起来 / Failed to fetch」

后端 etcli 死了。看日志：

```bash
tail -30 ~/Documents/Murmur/logs/serve.log
cat ~/Documents/Murmur/logs/tauri-shell.log
```

简单办法：完全退出 Murmur（cmd-Q），重新打开。

### Q：关系图只能看不能选？

0.2 版修了：现在鼠标悬停有金色高亮 ring 预告 hit。点击去选目标节点 / 关系线。

---

## 隐私模式（录视频用）

右下角浮动按钮「🔓 隐私模式：关」 → 点一下变 **「🔒 开」**：

- 朋友显示名 → 「朋友 AB」「朋友 CD」（按 wxid 哈希稳定映射，刷新不变）
- 群名 → 「群 1」「群 5」
- wxid → 「wxid_NNNN」短哈希

录演示视频 / 截图小红书 / 给朋友展示用。**注意**：AI 报告 .md 里**不会自动脱敏**（已经写到磁盘了），只在 UI 显示时遮蔽。
