# Windows 上手指南

> 全程 **2-5 分钟**。**不需要装 Python / Node**（v0.2.0 的 MSI 自包含 Python runtime）。
>
> **只处理本机、本人的数据**：Murmur 只读这台电脑上你自己登录的微信。抓密钥要把 hook（`wx_key.dll`）装进正在运行的微信进程，这不是腾讯官方支持的用法，**有触发风控、被要求重新登录甚至限制账号的可能**，请自行权衡。

---

## 第一次启动 — 完整流程

### 0. 准备

确认你的微信状态：

- ✅ **微信 4.x 已安装并登录过** —— Murmur 不会替你装微信
- ✅ **此刻微信正在运行**（任务栏看得到，或者托盘里）—— 这一步很关键，下面解释

不需要装任何东西。下面这些都是**可选**的：

- Python / Node — 不需要（除非走开发模式）
- Claude Code / Codex CLI — 想用 AI 关系档案才装
- faster-whisper — 想转语音消息才装

### 1. 下载 + 装

去 [Releases](https://github.com/sgaofen/murmur/releases/latest) 下：

- **`Murmur_x.x.x_x64-setup.exe`** （推荐，约 22 MB）—— NSIS 安装器，双击装
- 或 `Murmur_x.x.x_x64_en-US.msi` —— MSI 装包，IT 部署用

> **避坑**：MSI 在某些 Win11 上装出 1603 错（Tauri MSI 已知问题），用 NSIS .exe 更稳。

装完桌面 / 开始菜单会有「Murmur」图标，安装路径 `~/AppData/Local/Murmur/`。

### 2. 启动 Murmur：引导步骤条

双击图标。第一次启动会弹出带步骤条的初始化引导（v0.5.0 起）：

**环境自检 → 数据目录 → 取得密钥 → 解密 → 完成**

（Windows 不需要 Mac 那一步「授权/重签」。）每一步出错都会显示**错误码**、原因和处理办法，旁边有「复制诊断信息」（已脱敏）；已完成的步骤可以在步骤条上点回去单独重做。

1. **环境自检**（自动）—— 逐项显示：微信版本、数据目录、抓取组件、是否已有解密密钥。
2. **数据目录** —— 自动找到 `xwechat_files` 下的账号目录，多个账号会列出来让你选；找不到时可以粘贴微信「设置 → 文件管理」里显示的路径（任何层级、任何自定义目录名都能识别），或让 Murmur 扫一遍磁盘。

### 3. 取得密钥 —— Win 路径的关键

> Win 用 `wx_key.dll` 注入 hook 到正在跑的 Weixin.exe。Hook 等的是 **登录事件**：你下次登录微信时它会捕获主 key。

引导会显示 **「请按这个顺序做」**：

1. 先去微信里 **退出登录**，让微信停在登录页；**不要关闭微信程序**
2. 回到 Murmur，点 **「开始抓密钥」** —— Murmur 把 hook 装到当前 Weixin.exe 进程
3. 看到 **「等待登录事件」** 提示后（通常 2-3 秒），回微信点 **登录 / 扫码登录**
4. Hook 捕获主 key（一次成功）→ Murmur 自动保存到 `~/.murmur/config.json`

微信没在运行时，引导每 2.5 秒自动重新检测一次，打开微信即可继续。

**为什么要先停在登录页？**因为 hook 等的是 WeChat 登录时把 key 派生到内存的瞬间。如果 WeChat 一直开着没动过，那个内存窗口已经过去了；如果先点开始再慢慢找退出登录入口，也容易错过/超时。最稳的是：先停在登录页 → Murmur 开始扫描 → 立刻登录。

已经有 64 位十六进制密钥的话，也可以在这一步手动粘贴。

### 4. 解密（自动）

抓到 key 后 Murmur 自动跑 `go_decrypt.dll` 解密所有 14+ 个 SQLCipher v4 数据库到：

```
~/Documents/Murmur/decrypted/<wxid>/
```

5 年的微信数据约 30 秒 - 2 分钟（go_decrypt.dll 是 C 速度，比纯 Python 快 10x）。

### 5. 完成 → 进主界面

完成页会写明 key 存在哪里，然后进入首页年代记 + 朋友卡片。之后想让微信里的新消息自动进来，可以在首页右上角打开「实时同步」（后台每隔几秒增量解密，含还没写回主库的 WAL 新消息）。

---

## 主界面用法速查

左侧导航：首页 · 关系网 · 年度 · 报告 · 离线证据表 · 搜索；底部是账号切换、隐私模式和设置。

| 想看 | 怎么进 |
|---|---|
| **首页年代记** | 启动后默认页 —— 月度热度曲线 / Top 朋友 / 朋友列表；右上角「更新数据」「实时同步」 |
| **朋友档案** | 首页朋友卡片 → 「故事」/「相册」/「完整对话」 |
| **完整对话** | 朋友档案 →「完整对话」进聊天页：往前翻、跳到某一天 |
| **搜索** | 左侧「搜索」—— 全部聊天全文搜索，可按时间范围筛；开启语义搜索后可以「按意思」搜 |
| **关系网络** | 左侧「关系网」—— 3D 旋转图，点节点看关系，点连线看朋友间互动证据 |
| **AI 关系档案** | 朋友档案 → 让本机 AI 分析（Claude Code / Codex / Gemini CLI / Kimi Code / OpenCode，需先装 CLI）|
| **批量分析关系** | 关系网页面右上「批量分析关系」 |
| **双人年代记** | 朋友档案 → 「双人年代记」 |
| **离线证据表** | 左侧「离线证据表」—— 多维信号矩阵，可导出 CSV |
| **设置** | 主题（浅色 / 深色 / 跟随系统）、隐私模式、应用锁、数据目录、本机 AI、复制诊断信息 |

---

## 数据存哪

| 内容 | 路径 |
|---|---|
| 解密后的 SQLite DB | `~/Documents/Murmur/decrypted/<wxid>/` |
| AI 分析报告 | `~/Desktop/Murmur/agent_reports/{friends,pairs}/` |
| 缓存（图统计、首页摘要等）| `~/Documents/Murmur/cache/` |
| **SQLCipher 主密钥** | `~/.murmur/config.json` （明文 64-hex，**机密**）|
| 应用锁（开了才有）| `~/.murmur/app_lock.json`（只存密码哈希）|
| 语义搜索模型和索引（开启后才有）| `~/Documents/Murmur/semantic/` |
| 后端日志 | `~/Documents/Murmur/logs/{tauri-shell,serve}.log` |

**完全清掉痕迹**：

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.murmur"
Remove-Item -Recurse -Force "$env:USERPROFILE\Documents\Murmur"
Remove-Item -Recurse -Force "$env:USERPROFILE\Desktop\Murmur"
```

加上从开始菜单卸载 Murmur，所有痕迹都没了。

---

## 可选：装 AI CLI

想看 AI 写的关系档案 / 用「批量分析关系」功能，装其中一个：

```powershell
# Claude Code（推荐）
npm install -g @anthropic-ai/claude-code

# 或 Codex CLI
npm install -g @openai/codex
```

第一次跑 `claude` 或 `codex` 命令会让你登录账号 / 设 API key。装好后 Murmur 自动检测，每个朋友档案页 + 关系网批量按钮会自动可用。

**隐私提示**：用 AI 分析时，对话样本（每个朋友 ≤80 条）会经 CLI 上传到 Anthropic / OpenAI 服务器。介意的话不装就行 —— 离线信号矩阵已经能看出 70% 的关系深度。

---

## 故障排除

### Q：onboarding 一直「等待登录事件」抓不到 key

**最常见原因**：你点了「开始」之后，微信没有发生新的登录事件。

复盘：Win 上 hook 等的是登录事件。如果 WeChat 已经登录在跑、你只是放着不动，hook 永远不触发。

**修法**：先去微信 → 我 → 设置 → 退出登录，让微信停在登录页但不要关闭程序。然后回 Murmur 点「开始抓密钥」，再立刻去微信扫码 / 自动登录，90 秒内会看到 ✓。

### Q：点「开始抓密钥」后一秒就失败

这不是等登录超时，而是 hook 没有成功装到微信进程。先确认：

- 微信程序还开着，并停在登录页；不要把窗口关掉。
- 任务管理器里能看到 `Weixin.exe` 或 `WeChat.exe`。
- 微信和 Murmur 权限等级一致。最稳是重启电脑后都普通打开；不要一个管理员权限、一个普通权限。
- 把 Murmur 安装目录加入 Defender / 火绒 / 360 / QQ 管家白名单，并确认 `wx_key.dll` 没被隔离。
- 如果微信装在 D 盘或自定义目录，v0.2.11 起只要进程正在运行，Murmur 也会继续抓 key；安装路径只影响“自动打开/重启微信”这类辅助动作。
- 如果失败页有日志，把最后几行一起发 issue；Murmur 会显示 DLL/进程注入的真实错误。

### Q：「后端没起来 / Failed to fetch」

后端 etcli.exe 死了。看日志：

```powershell
Get-Content "$env:USERPROFILE\Documents\Murmur\logs\serve.log" -Tail 30
Get-Content "$env:USERPROFILE\Documents\Murmur\logs\tauri-shell.log"
```

最简单：完全退出 Murmur（任务管理器看），重新打开。

如果是给朋友装，优先让对方确认下载的是 `.exe` 安装器，不是 `.msi`；然后把上面两份日志的最后 30 行发回来。v0.2.11 的诊断会把“微信正在运行但安装路径不标准”和“真的没看到微信进程”区分开。

### Q：Murmur 装上了但启动后白屏

99% 是 etcli.exe 启动失败。看 `tauri-shell.log` 里：

- `etcli located: ...` 后面跟着 `spawn err: ...` —— PyInstaller bundle 损坏，重装一次
- `locate_etcli_exe FAILED` —— MSI 没把后端装进去（重新下 .exe 装）

### Q：MSI 装出 1603 错

Tauri MSI 在某些 Win11 已知不稳。下 NSIS `.exe` 替代。

### Q：找不到微信数据

Murmur 默认找：
- `E:/xwechat_files/`、`D:/xwechat_files/` 等各个盘符根目录
- `D:/Documents/xwechat_files/`
- `~/Documents/xwechat_files/`
- `~/OneDrive/Documents/xwechat_files/`
- `Tencent/Weixin/xwechat_files`、`Tencent/WeChat/xwechat_files` 这类常见嵌套目录
- 微信注册表里记录的自定义保存路径
- 如果电脑上已经装了 Everything 的命令行工具 `es.exe`，Murmur 会自动借用它的索引秒查 `xwechat_files` / `db_storage`

新版引导页可以直接粘贴路径：打开电脑微信 → 设置 → 文件管理 → 打开文件夹，把包含 `xwechat_files` 的路径粘进 Murmur。

不建议让 Murmur 默认整盘递归搜索。Everything 快是因为它读 NTFS 文件索引，不是普通地遍历每个文件夹；Murmur 只把 Everything 当成可选加速器，没有安装 Everything 也能正常走保守扫描和粘贴路径兜底。

如果你的微信数据在别处，也可以设环境变量：

```powershell
[Environment]::SetEnvironmentVariable("MURMUR_WECHAT_ROOT", "E:/path/to/xwechat_files", "User")
```

也可以直接指向某个账号目录，例如 `E:/path/to/xwechat_files/wxid_xxx_abcd`。多个候选目录用英文分号 `;` 分隔。

然后重启 Murmur。

如果是开发/排错，需要只扫你指定的目录、不要再扫全盘，可以额外设置：

```powershell
[Environment]::SetEnvironmentVariable("MURMUR_WECHAT_ROOT_ONLY", "1", "User")
```

排错完记得清掉：

```powershell
[Environment]::SetEnvironmentVariable("MURMUR_WECHAT_ROOT_ONLY", $null, "User")
```

### Q：抓 key 后解密了一些 DB，但有些朋友打不开

不太可能 —— Win 是单 master key，要么全解开要么一个都没解开。如果真出现，先看 `serve.log` 末尾报错。

### Q：端口 9100 被占用

Murmur 写死 9100。如果有别的服务占用：

```powershell
# 找占用方
Get-NetTCPConnection -LocalPort 9100 -State Listen
# 看 OwningProcess，决定要不要 kill
```

---

## 应用锁

「设置 → 应用锁」可以给 Murmur 设一个密码：打开 Murmur 或闲置一段时间后要先输密码，锁定期间本地服务对所有数据接口一律拒绝。它防的是「别人坐到你电脑前打开 Murmur」，**不加密**已解密的数据库（要保护磁盘数据请用 BitLocker）。忘记密码：完全退出 Murmur（任务管理器里也没有 `etcli.exe`）后删除 `%USERPROFILE%\.murmur\app_lock.json`。详见 [docs/app-lock.md](app-lock.md)。

---

## 隐私模式（录视频用）

左侧栏底部「隐私模式」开关（设置页里也有）打开后：

- 朋友显示名 → 「朋友 AB」「朋友 CD」（按 wxid 哈希稳定映射，刷新不变）
- 群名 → 「群 1」「群 5」
- wxid → 「wxid_NNNN」短哈希

适合录演示视频、截图发小红书、给朋友看不暴露真实联系人。

> 注意：AI 报告 `.md` 里**不会自动脱敏**（已经写到磁盘了），只在 UI 显示时遮蔽。

---

## 进阶：开发模式

想改代码 / 调试，从源码跑：

```powershell
git clone https://github.com/sgaofen/murmur.git
cd murmur
.\start-windows.bat
```

需要：Python 3.11+ + Node.js 18+。第一次会自动 `pip install -r requirements.txt` + `npm install`，约 1 分钟联网下载。

## 进阶：从源码打 Windows 安装包

想自己构建给用户安装的 `.exe` / `.msi`，在 Windows PowerShell 里运行：

```powershell
.\build-windows.ps1
```

脚本会按顺序完成：

1. 安装 Python 后端依赖和 PyInstaller
2. 构建 `cli/dist/etcli/etcli.exe`
3. 自动复制到 `app/src-tauri/etcli/`
4. 运行 Tauri 构建，产物在 `app/src-tauri/target/release/bundle/`

这一步很关键：安装包必须包含 PyInstaller 后端，否则用户双击 Murmur 会白屏或提示后端连接失败。
