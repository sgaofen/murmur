# macOS 上手指南

> 全程 **5-10 分钟**。**不需要关 SIP，不需要重启**。需要：登录过的 WeChat for Mac 4.x（腾讯官网版，不支持 App Store 版）。
>
> **只处理本机、本人的数据**：Murmur 只读这台 Mac 上你自己登录的微信。抓密钥要对微信重签名、用 Frida 附加进程，或启动一份注入了小组件的微信副本——这些都不是腾讯官方支持的用法，**有触发风控、被要求重新登录甚至限制账号的可能**，请自行权衡。

---

## 与 Windows 的本质区别

| | macOS | Windows |
|---|---|---|
| 抓 key 机制 | 三选一：**实时抓取 · Frida**（4.1.9+ 推荐）/ **实时抓取 · 免 Frida（私有副本）** / 内存扫描（4.1.9 以前）| 注入 wx_key.dll hook，等登录事件 |
| 用户动作 | 实时抓取：正常用一会儿微信（点开对话、翻翻）；私有副本：先退出原版微信，在副本里登录 | **登出再登入一次微信** |
| Key 数量 | 每个库一把 AES key；实时抓取能截到账号口令，**一轮派生出全部库的 key** | 1 把主 key 解所有 DB |
| 额外权限 | **完全磁盘访问**；Frida 和内存扫描还要给微信**重签名**并输管理员密码；私有副本两样都不要 | 无 |

**别照 Win 步骤走**。Mac 上「登出再登入」不是抓 key 的关键动作，引导会告诉你每种方式具体要做什么。

---

## 三种安装方式（任挑一个）

### 方式 1 · `.app` 安装包（最像普通 Mac App）

去 [Releases](https://github.com/sgaofen/murmur/releases/latest) 下：

- **`Murmur_macOS_AppleSilicon.dmg`** （M 系列芯片，推荐）—— 双击打开，拖 Murmur 进 `/Applications`
- 或 `Murmur_macOS_AppleSilicon.app.zip` —— 解压后拖进 `/Applications`

只想照着“下载 → 拖到应用程序 → 终端运行命令 → 打开”的短教程走，看 [macOS Release 下载后怎么打开](MAC_RELEASE_INSTALL.md)。

DMG 安装步骤：

1. 双击 `Murmur_macOS_AppleSilicon.dmg`。
2. Finder 会打开一个 `Murmur` 磁盘窗口。
3. 把里面的 `Murmur.app` 拖到 Finder 左侧的「应用程序」，或拖到 `/Applications`。
4. 等复制完成后，打开「应用程序」里的 `Murmur`。

不要直接在 DMG 窗口里双击 `Murmur.app`。DMG 是安装盘，正确做法是先拖进「应用程序」，再从「应用程序」打开。

如果系统弹出 `"Murmur" Not Opened`，按钮只有 `Done` / `Move to Trash`：

1. 点 `Done`，不要点 `Move to Trash`。
2. 打开「系统设置」→「隐私与安全性」。
3. 往下滑到「安全性」区域。
4. 如果看到 `Murmur was blocked...`，点 `仍要打开 / Open Anyway`。
5. 回到「应用程序」重新打开 Murmur。

如果「隐私与安全性」里没有 `仍要打开`，开发验证时可以用终端执行：

```bash
xattr -dr com.apple.quarantine /Applications/Murmur.app
open /Applications/Murmur.app
```

这个弹窗会在正式公证前出现；发布流程见 [Mac 签名与公证发布流程](MAC_NOTARIZATION_GUIDE.md)。

> Mac Intel x64 dmg 还没出。Intel 用户用方式 2 或方式 3。

### 方式 2 · 一行 curl 安装

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

## 首次启动：引导步骤条

v0.5.0 起，初始化是一个带步骤条的对话框，左边显示进度：

**环境自检 → 数据目录 → 授权/重签 → 取得密钥 → 解密 → 完成**

每一步出错都会显示**错误码**、原因和处理办法，旁边有「复制诊断信息」（已脱敏）。已经完成的步骤可以在步骤条上点回去单独重做。抓取正在进行时步骤条会锁住，避免把微信关掉打断这一轮。

### 1 · 环境自检

打开引导先做一遍自检，逐项显示状态和处理按钮：微信版本、数据目录、完全磁盘访问、微信签名（是否已重签）、Frida 是否安装、抓取组件、是否已有解密密钥。一般照着「处理」按钮点就行，自检结果也决定后面推荐哪种抓取方式。

### 2 · 数据目录（含完全磁盘访问）

- Murmur 会自动找 `~/Library/Containers/com.tencent.xinWeChat/.../xwechat_files/` 下的账号目录。多个账号会列出来让你选。
- **.app 版第一次需要「完全磁盘访问」**：macOS 不让任何 App 读别的 App 的容器。引导里点「打开系统设置 → 完全磁盘访问」，把 **Murmur** 打开（列表里没有就点 **+** 选 `/Applications/Murmur.app`），然后**完全退出 Murmur 再打开**。
- 找不到时可以手动粘贴微信「文件管理」里显示的路径，任何层级都能识别。

> 走 install-mac.sh 或 start-mac.sh 用浏览器版**不需要完全磁盘访问** —— 你的终端本身就有读取权限。

### 3 · 授权/重签（Frida 和内存扫描需要）

macOS 默认给 WeChat 加了 **hardened runtime**，调试器附加不上，Frida 和内存扫描都抓不了密钥。引导里点 **「确认重签名」**，系统弹认证窗口时输入开机密码，Murmur 会对微信做一次 ad-hoc 重签名并重新打开微信。**SIP 完全没动**；微信自己升级后会恢复腾讯签名，到时再重签一次即可。

> 只打算用「免 Frida（私有副本）」的话可以跳过这一步：私有副本不改 `/Applications/WeChat.app`。

### 4 · 取得密钥

引导会按微信版本推荐方式：**4.1.9 及以上推荐「实时抓取」**（4.1.9 起密钥不再常驻内存，内存扫描大概率一个都抓不到）。实时抓取页里可以选 Frida 或免 Frida 两种方式。

**A. 实时抓取 · Frida（推荐）**

1. 微信已重签名、已登录。第一次用会提示安装 Frida（装进 Murmur 自己的目录）。
2. 点开始，系统会弹一次管理员密码（附加微信进程需要）。
3. 回微信正常用一会儿：点开几个对话、翻翻朋友圈。Murmur 截到账号口令后，会在本机用 PBKDF2 派生出**全部数据库**的 key，并逐个用 HMAC 校验，一般 1–2 分钟。
4. 拿全之后自动结束这一轮，进入解密。

**B. 实时抓取 · 免 Frida（私有副本）**

不装 Frida、不输管理员密码。Murmur 把微信复制一份到 `~/.murmur/wechat-copy/`，只对副本重签名，并用 `DYLD_INSERT_LIBRARIES` 注入一个只记录加密调用的小 dylib（`murmur_keycap.dylib`），原版 `/Applications/WeChat.app` 不动。

1. **先完全退出原版微信**（菜单栏「微信 → 退出微信」，确认 Dock 里也没有了）。Murmur 检测到原版还在运行会拒绝开始——两个微信同时写同一组数据库会把库写坏。
2. 点开始，Murmur 复制、重签并启动副本。
3. **在副本里重新登录一次**，然后正常用一会儿。拿到口令后同样一轮派生、校验全部库的 key。
4. 每轮结束（成功、超时、取消、出错）Murmur 都会关掉副本进程并清掉记录文件；用完可以在界面里**删除副本**。

真机结论（微信 4.1.15，本机实测）：

- 副本和原版**共用同一个 `xwechat_files` 容器**（同一套聊天数据，不会另建一份）。
- 没有弹「想访问其他 App 的数据」的授权框。
- 需要在副本里**重新登录一次**。
- 23/23 个数据库的 key 全部通过 HMAC 校验。

所以「先完全退出原版微信」是必须的，不是建议。

**C. 内存扫描（4.1.9 以前的微信）**

1. 微信已重签名、已登录。
2. 回微信**点开 3–5 个不同的对话、翻一下朋友圈 / 收藏 / 联系人**——老版本微信是「点到哪个库才解锁哪个库」，没点开的库密钥不在内存里。
3. 回 Murmur 点「开始抓取」，输入开机密码（扫内存要管理员权限）。抓不到会提示改用实时抓取。

**D. 手动粘贴密钥**：已经有 64 位十六进制密钥（比如在 Windows 上抓过同一个账号）时，可以直接粘贴。

### 5 · 解密 → 完成

拿到 key 后自动解密全部数据库，完成页显示 key 存在哪里（`~/.murmur/decrypted_keys.json` 或 `~/.murmur/config.json`），然后进主界面。之后想要新消息自动进来，可以在首页打开「实时同步」。

---

## 进了主界面之后

左侧导航：首页 · 关系网 · 年度 · 报告 · 离线证据表 · 搜索；底部是账号切换、隐私模式和设置。

| 想看 | 怎么进 |
|---|---|
| **首页年代记** | 启动后默认页 —— 月度热度曲线 / Top 朋友 / 朋友列表；右上角「更新数据」「实时同步」 |
| **朋友档案** | 首页朋友卡 → 「故事」/「相册」/「完整对话」三个标签 |
| **完整对话** | 朋友档案 →「完整对话」进聊天页：往前翻、跳到某一天 |
| **搜索** | 左侧「搜索」—— 全部聊天全文搜索，可按时间范围筛；开启语义搜索后可以「按意思」搜；点结果直接定位到那条消息 |
| **关系网络** | 左侧「关系网」→ 3D 旋转图，悬停高亮，点节点看关系，点连线看朋友间互动证据 |
| **AI 关系档案** | 朋友档案 → 让本机 AI 分析（Claude Code / Codex / Gemini CLI / Kimi Code / OpenCode，需先装 CLI）|
| **批量分析关系** | 关系网页面右上「批量分析关系」 |
| **离线证据表** | 左侧「离线证据表」—— 多维信号矩阵，可导出 CSV |
| **设置** | 主题（浅色 / 深色 / 跟随系统）、隐私模式、应用锁、数据目录、本机 AI、复制诊断信息 |

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
~/.murmur/decrypted_keys.json          # 每个库一把 AES key（Mac）
~/.murmur/config.json                  # 口令 / 主 key、实时同步设置
~/.murmur/wechat-copy/                 # 私有副本（用过免 Frida 方式才有，界面里可删）
~/.murmur/app_lock.json                # 应用锁的密码哈希（开了应用锁才有）
~/Documents/Murmur/semantic/           # 语义搜索的模型和索引（开启后才有）
~/Desktop/Murmur/agent_reports/        # AI 分析报告
~/Documents/Murmur/cache/              # 图统计 / 首页摘要缓存
~/Documents/Murmur/logs/               # 后端日志
```

完全清掉：

```bash
rm -rf ~/Documents/Murmur ~/.murmur ~/Desktop/Murmur
```

撤销 WeChat 的 ad-hoc 重签名：等下一次 WeChat 自动更新（更新会重新走 Tencent 签名流程），或者手动重装 WeChat。私有副本方式不改原版微信，删除副本即可。

---

## 常见问题

### Q：macOS 报「Murmur 已损坏，无法打开」

这通常说明包没有正确签名或公证，或者下载文件仍带旧的损坏签名结构。开发验证时可临时跑：

```bash
xattr -dr com.apple.quarantine /Applications/Murmur.app
```

然后重新打开 Murmur.app。这个命令只是临时绕过，不是正式发行方案。

### Q：macOS 报「Murmur Not Opened」，只有 `Done` / `Move to Trash`

这是未公证 App 的 Gatekeeper 拦截。处理方式：

1. 点 `Done`，不要点 `Move to Trash`。
2. 确认 Murmur 已经拖进 `/Applications`，不要直接从 DMG 里打开。
3. 打开「系统设置」→「隐私与安全性」→「安全性」。
4. 点 `仍要打开 / Open Anyway`，再回到「应用程序」打开 Murmur。

如果没有 `仍要打开` 按钮，开发验证时运行：

```bash
xattr -dr com.apple.quarantine /Applications/Murmur.app
open /Applications/Murmur.app
```

正式发行包完成公证后，这个步骤就不应该再出现。

### Q：「开始自动抓取」点了之后没反应

最常见：你刚关掉了 macOS 弹的密码框，或者输错密码。后端已经 timeout 了。再点一次就行。

### Q：内存扫描只匹配了几个库 ⚠️

内存扫描时没点开足够多的对话，没打开的库 key 不在内存里。回 WeChat 多点几个对话 / 翻翻朋友圈，再扫一次；微信 4.1.9 及以上直接改用「实时抓取」，它截到口令后一轮派生全部库的 key。

### Q：私有副本提示「请先完全退出微信」

原版微信（`/Applications/WeChat.app` 里的任何进程）还在运行。菜单栏「微信 → 退出微信」，确认 Dock 里没有微信后再开始。两个微信同时开会写同一组数据库。

### Q：报错里有个错误码，怎么看？

错误码（如 `WECHAT_HARDENED`、`KEY_NOT_FOUND`、`KEY_CAPTURE_BUSY`）下面就写了原因和处理办法。反馈问题时点「复制诊断信息」，内容已经脱敏，可以直接贴到 GitHub issue。

### Q：忘了应用锁密码

见 [应用锁说明](app-lock.md)：完全退出 Murmur 后删除 `~/.murmur/app_lock.json` 即可，聊天数据不受影响。

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

## 应用锁

「设置 → 应用锁」可以给 Murmur 设一个密码：打开 Murmur 或闲置一段时间后要先输密码，锁定期间本地服务对所有数据接口一律拒绝。它防的是「别人坐到你电脑前打开 Murmur」，**不加密**已解密的数据库。详见 [docs/app-lock.md](app-lock.md)。

---

## 隐私模式（录视频用）

顶部状态条右侧的「PRIV」开关（⌘K 命令面板和设置页里也有）打开后：

- 朋友显示名 → 「朋友 AB」「朋友 CD」（按 wxid 哈希稳定映射，刷新不变）
- 群名 → 「群 1」「群 5」
- wxid → 「wxid_NNNN」短哈希

录演示视频 / 截图小红书 / 给朋友展示用。**注意**：AI 报告 .md 里**不会自动脱敏**（已经写到磁盘了），只在 UI 显示时遮蔽。
