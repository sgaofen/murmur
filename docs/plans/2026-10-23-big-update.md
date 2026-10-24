# Murmur 大版本更新计划（v0.5.0）

日期：2026-10-23　状态：**草案，等用户确认范围后再动手**

完整调研报告（每条结论都附出处 URL）放在会话共享笔记 `research-similar-projects.md`，本文只摘结论。第 1 步已经单独出了 PR：[sgaofen/murmur#28](https://github.com/sgaofen/murmur/pull/28)（App 内 Frida 实时抓 key，修 #27，CI 全绿，未合并）。

---

## 1. 调研结论

### 1.1 格局
- 腾讯一直在用律师函和 DMCA 清理同类项目：chatlog、PyWxDump 在 2025-10 删光了代码，wx_key 被 DMCA 清空，wechat-dump-rs 等几个仓库现在返回 HTTP 451。留痕（WeChatMsg）只剩 readme，EchoTrace 2026-03 停更，作者让用户转去 WeFlow。
- 仍在活跃的主力：**WeFlow**（约 15k star，微信 4.0+，Win/mac/Linux）、**WeChatDataAnalysis**（3.9k）、**ChatLab**（7.6k，只导入、不解密）、**qq-chat-exporter**（5.8k）、**QQBackup** 系列（qq-win-db-key / QQDecrypt）、**WeQ**（QQ NT）。小而有料的有 chatlog-keeper、SIWX、Weport。
- WeFlow 的合规办法：仓库里不放任何解密原生组件，由用户在设置里自己填外置 dylib/dll 的路径。现存项目的共同底线是「只读本机自己的数据、只读、不改原 App」。

### 1.2 Mac 微信 4.1.9+ 拿 key
每个库的 key 都是 `PBKDF2-HMAC-SHA512(账号 passphrase, 库文件前 16 字节 salt, 256000 轮)` 派生的，新版不再把派生结果常驻内存，只能在派生或使用的那一刻抓。现有四种做法：

| 做法 | 代表 | 要求 |
|---|---|---|
| Frida hook CommonCrypto（`CCCrypt*` 拿逐库 key，`CCKeyDerivationPBKDF` 拿 passphrase） | **Murmur #28**、wechat-key-macos | 重签 + root |
| LLDB 断在 `CCKeyDerivationPBKDF` / `sqlite3_key` | WeChatDataAnalysis（抓完恢复官方签名）、SIWX（要关 SIP） | 重签或关 SIP |
| **私有副本 + 自带 PBKDF2 捕获 dylib + FIFO** | chatlog-keeper | 原 App 不动，不需要 root、Frida，也不用关 SIP；要按微信 build 号维护白名单 |
| 只读内存扫描 | 只在 Windows 4.1.13 上有公开实现（XOR 混淆的 passphrase） | Mac 上未核实 |

**对我们最有用的一点**：只要 hook 到 `CCKeyDerivationPBKDF` 拿到账号 passphrase，就能用每个库自己的 salt **离线算出全部库的 key**，不用再靠用户「把每个功能都点一遍」去一个个触发。这能把实时抓取从「多轮、靠运气」变成「一轮、拿全」。

### 1.3 QQ NT 解密（对应 #5）
- 拿 key：在 `wrapper.node` 的 `nt_sqlite3_key_v2(db, zDb, pKey, nKey)` 处断下，key 是**第 3 个参数**（x64 上是 R8，arm64 上是 x2）、长度看 nKey。
- **#5 的直接线索**：reporter 抓到的 `BD156D6710D54D8782F4` 正是 `login.db` 用的全局固定 key（QQBackup 的 `qq_key_extractor.py` 里专门跳过它）。也就是说我们的 PowerShell 断点抓到的是**最先打开的 login.db**，不是消息库，所以换哪组 SQLCipher 参数都验不过。正确做法是跳过这个常量、保持断点继续等，按 nKey 截取 16 字节 ASCII，每个候选都用 `nt_msg.db` 页 1 的 HMAC 验证。
- 其他常见「wrong key」原因：没剥文件开头的 1024 字节头；`cipher_page_size` 没写在 `key` 之前；参数应为 `kdf_iter=4000`、`HMAC_SHA1`、`PBKDF2_HMAC_SHA512`、`page_size=4096`（「HMAC 改成 SHA512」已被证实是误报）；热更新后加载的是 `versions/<ver>/wrapper.node`，地址会变。
- Mac 上的 QQ NT：lldb + 重签，不用关 SIP（QQBackup 有现成教程）。

### 1.4 用户最看重的功能
1. 年度报告、双人报告：传播效果最好。**Murmur 已有**（年度总览、双人档案）。
2. MCP / AI 接入：SIWX（11 个工具）、WeQ、ChatLab Agent（回答带原文引用）。**Murmur 目前没有 MCP**，只会调用本机 Claude/Codex CLI 写报告。
3. 增量与实时：WAL 轮询再 patch（约 70ms）、按 mtime+size+key 缓存。**Murmur 已有增量解密和 WAL 合并**，没有实时监听。
4. 全局搜索、语义搜索：只有 Weport 做了语义搜索（实验功能），竞品普遍没做，是差异化机会。**Murmur 目前没有跨会话的消息搜索**。
5. 导出生态：ChatLab / WeClone 格式、CSV/Excel/Markdown。**Murmur 只有 JSON/HTML/TXT**。
6. 语音转文字、图片 key 离线计算：Murmur 已有（`transcribe_voice.py`、kvcomm 推导）。

---

## 2. Murmur 现状与缺口

| 方面 | 现状 | 缺口 |
|---|---|---|
| Mac 抓 key | 内存扫描 + #28 的 Frida 实时抓取 | 实时抓取要多轮；没 hook `CCKeyDerivationPBKDF`；打包版带 frida 后体积增加约 117MB，公证版（hardened runtime）里能不能跑未验证；不会把官方签名恢复回去 |
| Win 抓 key | DLL hook 登录事件 | 微信 4.1.10.31+ 也不再常驻 raw key，现有方案靠登录瞬间，暂时没坏，但应补 HMAC 统一校验 |
| QQ NT | 仅 Windows；断点读入口处的 R8 | #5：抓到的是 login.db 的固定 key；Mac 不支持 |
| 性能（#24） | 已建 QQ 索引、加锁；关系网按 `(scope, top_n, …)` 分别缓存 | 切换 top N 会整张图重算。reporter 提议的「全量原始汇总缓存、在内存里筛 top N」还没做；另外 #24 里「切几个页面后卡在正在启动本地服务」「会话只剩前五个」没能复现 |
| 搜索 | 只能按好友名筛选 | 没有跨会话全文搜索，聊天视图没有跳转到日期 |
| AI | 本机 Claude/Codex CLI 写报告 | 没有 MCP；本机 agent 只认 claude/codex（共享笔记里另一组调研覆盖了 Gemini/Kimi/OpenCode 等，可复用） |
| 导出 | JSON/HTML/TXT，单人和双人 | 没有 CSV/Markdown/ChatLab；没有媒体策略选项 |
| 兼容性：微信 4.1.x / macOS 26 | 4.1.22 走 #28；`internal error in Code Signing subsystem`（#23）已在 v0.4.3 修 | 要按 build 号记录「验证过 / 未验证」，未知版本给出可读提示；macOS 26 上重签和 TCC 行为需要真机回归 |

---

## 3. UI 升级

### 3.1 现有前端盘点（`app/src`，约 8.6k 行页面代码）
- **样式全是内联**：1264 处 `style={{…}}`，只有 407 处 className。写死的颜色有 194 个 hex、315 个 `rgba(…)`，比如 `#8a5a1c`、`#3a7a4f` 这类提示色，**深色模式下不会跟着变**。#28 里的新组件也沿用了这个写法（按约定，等这次 UI 升级统一处理）。
- **深浅色**：`tokens.css` 有一套 `.et-dark` 变量，但正式版**没有切换入口**，开关只在 `VITE_SHOW_DEV_CONTROLS=1` 的开发面板里。启动时读一次系统设置，之后系统切换也不跟随。`Graph.tsx` 自己另有一份 `dark` 状态，和全局不同步。
- **字体走网络**：`tokens.css` 通过 `@import` 从 Google Fonts 拉思源宋体/黑体。离线时字体会回退，而且和「100% 本地」的承诺冲突（会向 Google 发请求）。
- **导航**：hash 路由，八个页面各自画一条顶栏（`HomeChromeBar`、`FriendChromeBar`……），没有统一的应用外壳；年度总览、报告、离线证据表这些入口散落在各页面的按钮里。
- **重复的基础组件**：`primaryBtn`、提示框、报错框在 `OnboardingDialog`、`ExtractKeyDialog`、`QQOnboardingDialog` 里各写了一份。
- **引导**：`OnboardingDialog` 1265 行，靠一个 phase 枚举串起十几个状态，没有步骤进度，也不能从中间某一步重来。报错页只显示日志末尾，没有「原因 → 怎么办」。
- **聊天浏览**：只能在好友页的抽屉里翻（`MessagesDrawer`），不能搜索、不能跳到某天。
- **空状态**：多数页面只显示一行报错文字（比如 `API /api/home-summary: 503 …` 直接露给用户）。
- `design/` 里有三轮 Claude Design 的稿子（v2/v3，奶油色纸张 + 墨蓝 + 珊瑚橙、衬线标题），视觉方向本身是好的、有辨识度，**这次不推翻品牌风格，重点是工程化和信息架构**。

### 3.2 设计方向
- 保留「纸张感」品牌（奶油色/墨蓝/珊瑚橙，标题用衬线），把它做成完整的**语义 token**：`--surface-*`、`--text-*`、`--accent-*`，以及 `--success/warning/danger-*` 的 bg/fg/border。浅色、深色各一套，不允许页面里再写 hex。
- **主题**：浅色 / 深色 / 跟随系统 三选一，放在设置里，并监听系统切换。Graph 跟全局走。
- **字体内置**：把常用字重子集化后打进包，不再联网。
- **应用外壳**：左侧窄栏导航（参考 WeFlow），账号切换和隐私模式放在侧栏底部。
- **组件库**（不引第三方 UI 库，体积和风格都可控）：`Button`、`Card`、`Callout`（info/success/warning/danger）、`Dialog`、`Stepper`、`EmptyState`、`ErrorState`（错误码 + 原因 + 处理办法 + 复制诊断包）、`Skeleton`。
- **报错目录**（参考 WeFlow 的 errorCatalog）：后端返回稳定的错误码，前端按码映射成「级别 / 原因 / 怎么办」，引导和各页面共用。

线框（左侧栏 + 内容区）：

```
┌────────┬───────────────────────────────────────────────┐
│ Murmur │  首页                          🔍 搜索全部消息  │
│        │ ┌─────────────┐ ┌─────────────┐ ┌───────────┐ │
│ ⌂ 首页  │ │ 今年聊得最多 │ │ 最长连聊     │ │ 走丢的人   │ │
│ ◎ 关系网│ └─────────────┘ └─────────────┘ └───────────┘ │
│ ☺ 朋友  │  朋友列表 / 时间线 ……                          │
│ ✉ 聊天  │                                               │
│ ⌕ 搜索  │                                               │
│ ✦ 年度  │                                               │
│ ✎ 报告  │                                               │
│        │                                               │
│ ─────  │                                               │
│ 账号 ▾  │                                               │
│ 隐私 ◐  │                                               │
│ 设置 ⚙  │                                               │
└────────┴───────────────────────────────────────────────┘
```

引导改成带步骤条的流程，每一步都能单独重来：

```
① 环境自检  →  ② 数据目录  →  ③ 权限/重签名  →  ④ 抓密钥  →  ⑤ 解密  →  ⑥ 完成
                                              （内存扫描 / 实时抓取 / 手动粘贴）
```

### 3.3 要改的页面
App 外壳（`App.tsx`）、首页（`Home`）、朋友页（`Friend`，聊天抽屉升级成独立聊天页）、关系网（`Graph`，深色同步、侧栏布局）、年度总览（`AnnualReport`/`Yearbook`）、报告（`Reports`）、离线证据表（`OfflineSignalsTable`）、引导（`OnboardingDialog`、`ExtractKeyDialog`、`QQOnboardingDialog`、`LiveKeyCapture`）、AI 抽屉（`AIAssistantDrawer`）、新增页面：搜索、设置。

### 3.4 怎么不影响 #28
- UI 系列 PR 都在 #28 **合并之后**基于新的 `origin/main` 开，不碰 #28 的分支。
- #28 的 `LiveKeyCapture` 在 UI-1 里迁移到新组件和 token，行为不变，用现有的单测和假后端走查回归。
- 如果 #28 迟迟不合并，UI-1（token 和组件库）也能先做，不改引导文件，等 #28 合并后再做引导迁移。

---

## 4. PR 拆分（按优先级）

每个 PR 都基于最新的 `origin/main`、带测试；UI 相关的附**浅色 + 深色**截图。

### P0：修 bug、补兼容
| # | 主题 | 内容 | 关联 |
|---|---|---|---|
| 1 | ✅ Frida 实时抓 key | 已提交 [#28](https://github.com/sgaofen/murmur/pull/28) | #27 |
| 2 | Mac 实时抓取「一轮拿全」 | 在 agent 里加 hook `CCKeyDerivationPBKDF`，抓到 passphrase 后按每个库的 salt 离线派生全部 key（每个都用页 1 HMAC 校验）；记录验证过的微信 build；抓完可选「恢复官方签名」 | #27 |
| 3 | QQ NT 抓 key 修复 | PowerShell 脚本跳过 login.db 的固定 key `BD156D6710D54D8782F4`、不在第一次命中就退出；按 nKey 截取；每个候选都用 `nt_msg.db` HMAC 验证；保存 key 前先验证 | #5 |
| 4 | 关系网缓存（#24） | 按 reporter 的方案建全量原始汇总缓存（联系人 + 边），切换 top N 只在内存里筛选和分层；数据库 mtime 变化时失效 | #24 |

### P1：主要新功能
| # | 主题 | 内容 |
|---|---|---|
| 5 | 全局消息搜索 | 解密后增量建 SQLite FTS5 索引（中文用 trigram）；接口支持按会话/发送者/日期/类型筛选；聊天视图可跳转到日期、定位到原消息 |
| 6 | MCP 服务 | `etcli mcp`（stdio）提供只读工具：联系人、会话、搜消息、取聊天片段、统计、关系证据；跟随隐私模式；文档写清怎么接到 Claude Code / Codex |
| 7 | 导出增强 | CSV、Markdown、ChatLab 标准格式；媒体策略（不带 / 仅原图 / 尽可能）；导出报告里列出缺失原因 |
| 8 | 错误码与诊断 | 后端统一错误码；前端报错目录；诊断包脱敏（现有 DiagBundle 的增强） |

### UI 系列（和 P1 交错进行）
| # | 主题 | 内容 |
|---|---|---|
| UI-1 | 设计基础 | 语义 token（浅/深）、主题设置（浅/深/跟随系统）、字体内置、基础组件；迁移引导相关的 4 个组件 |
| UI-2 | 应用外壳与导航 | 左侧栏、统一顶栏、设置页；Graph 深色同步 |
| UI-3 | 聊天浏览 + 搜索页 | 独立聊天页（气泡、媒体预览、跳转到日期）+ 搜索页（配合 PR 5） |
| UI-4 | 引导重做 | 步骤条、每一步都能重来、环境自检、接报错目录（配合 PR 8） |
| UI-5 | 页面打磨 | 首页、朋友页、年度、报告、离线证据表的空状态和加载骨架，清掉剩余写死的颜色 |

### P2：可选（看反馈再定）
- Mac 版 QQ NT（lldb + 重签）。
- 实时同步：监听 WAL 变化后增量 patch。
- 本机语义搜索（本地向量模型，默认关闭）。
- 本机 agent 扩展到 Gemini / Kimi / OpenCode。
- 应用锁屏（密码 / Touch ID）。
- 「私有副本 + 自带捕获 dylib」的免 Frida、免 root 方案（chatlog-keeper 思路），用来替代 Frida 版。

### 收尾 PR
README、`docs/`（MAC_RUN_GUIDE、ONBOARDING_*）、更新日志，版本号升到 `0.5.0`（`app/package.json`、`tauri.conf.json`、`Cargo.toml`）。不发 release。

建议顺序：2 → 3 → 4 → UI-1 → UI-2 → 5 + UI-3 → 8 + UI-4 → 6 → 7 → UI-5 → 收尾。

---

## 5. 风险
- **法务**：同类项目大面积被律师函和 DMCA 清理。打包版自带 frida 和抓 key 脚本会更显眼。可以考虑参考 WeFlow，把抓 key 组件做成可选下载或用户自配，README 措辞强调「只处理本机、本人数据」。**这个需要你拍板**。
- **Frida 版本**：#28 按 Frida 17 的 API 写（`Process.getModuleByName(...).getExportByName`），我用 frida 17.24.3 实际验证过 attach 流程。但有项目说要锁在 17 以下，可能是它们用了 16 的旧 API；需要在真实 WeChat 4.1.22 上确认。
- **打包体积与公证**：带 frida 后 App 增加约 117MB（DMG 约 45MB）；公证版的 hardened runtime 下 frida 是否可用没验证。
- **没有真机环境**：本机是 WeChat 4.1.15，没有 4.1.22 账号环境，没有 Windows + QQ 9.9.29 环境。P0 的 2、3 都只能靠单测、模拟和 reporter 反馈验证，PR 里会如实写明。
- **重签名风控**：重签和注入有被腾讯检测的可能，引导里应当提示风险。chatlog-keeper 的做法是按风险分级明示。
- **UI 大改的回归面**：页面多、内联样式多，分 5 个 PR 小步走，每个都附截图，并用假后端走查关键流程。
