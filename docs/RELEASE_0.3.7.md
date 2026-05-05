# Murmur v0.3.7 — QQ 支持 + 多账号 + 路径修复

> **For the Mac adapter agent**: this document is the single source of truth
> for what changed between v0.2.17 and v0.3.7. Read top-to-bottom before
> touching code; the "Mac-specific TODOs" section at the bottom lists every
> place that needs a Mac analogue.

---

## TL;DR

- **新增 QQNT 支持**（Windows）：抓 key、解密 6 个 SQLCipher v3 变体 DB、protobuf 消息体解析。
- **多账号架构**：单一 `_MurmurAPIHandler.store` 现在装 EchoStore（微信）**或** QQStore（QQ）；所有现有分析函数（home_summary、friend_card、yearbook、graph）一行不改吃两边数据。
- **ProfileSwitcher**：新增顶栏切换器组件，挂在每个 chrome bar 上，全局事件触发引导。
- **路径发现 bug 修复**：WeChat 4.x 在某些 OneDrive 迁移机器上把数据嵌套到 `xwechat_files\xwechat_files\wxid_*\`，旧版本只扫第一层会拿到空壳子。现在两层都扫，按 db_storage 大小取胜。
- **多个 cache / state bug 修复**：`/api/refresh` 后 `_MSG_INDEX_CACHE` 现在会被清；空 stub session.db 会被识别为「未就绪」；`relationship_signals` 终于把 `moments_back/out` 暴露给前端。

---

## 下载（Windows）

- 推荐：`Murmur_0.3.7_x64-setup.exe`（NSIS, 21 MB）
- 备用：`Murmur_0.3.7_x64_en-US.msi`（27 MB）

## Mac

**v0.3.7 暂只发 Windows。** Mac 上 QQ 支持 + ProfileSwitcher 整合留给 Mac 适配 agent —
见本文末尾「Mac-specific TODOs」。微信侧的所有改动（路径修复、cache 修复、朋友圈
stat 暴露）在 Mac 上自动生效，无需改动。

---

## 架构核心：EchoStore-shape interface

`cli/qq_store.py` 的 `QQStore` 类**完全实现** `cli/etcli.py:EchoStore` 的 7 方法接口：

```python
class EchoStore | QQStore:
    dir: Path                                              # decrypted DB 目录
    me: Optional[str]                                      # self id (wxid 或 QQNT uid)
    def contacts(self) -> dict[str, Contact]
    def contact(self, username: str) -> Contact
    def sessions(self) -> list[Session]
    def messages(self, username, *, since=None, until=None,
                 limit=None, text_only=False) -> Iterator[Message]
    def message_count(self, username: str) -> int
```

`Contact / Session / Message` 三个 dataclass 字段也完全一致，QQ 数据通过以下映射塞进去：

| WeChat                         | QQ                                       |
| ------------------------------ | ---------------------------------------- |
| `wxid_xxx` (私聊好友)          | `u_xxx` (QQNT uid，跨设备稳定)            |
| `xxx@chatroom` (群)            | `<group_number>@chatroom`                |
| `Contact.alias` (微信号)       | QQ 号                                    |
| `Contact.nick_name`            | QQNT 昵称                                |
| `Contact.is_real_friend`       | uid 在 buddy_list 表里                    |
| `Message.sender_wxid` = "self" | 同样规则                                 |
| `Message.msg_type`             | 重映射到 WeChat 的码（1/3/34/43/47/49/...）|

这样后端的 `_MurmurAPIHandler.store` 字段就成了一个鸭子类型容器 ——
切换平台只是替换这个引用 + 清缓存，所有 `home_summary(store)` /
`friend_detail(store, wxid)` / `yearbook(store, wxid)` / 关系图 / AI 报告 /
报告生成 / 离线信号矩阵全部不需要任何代码改动。

---

## 文件变更（按目录）

### `cli/`

#### 新增

- **`cli/qq_store.py`** — QQNT 解密 DB 读取，EchoStore-shape。包含：
  - 自实现 protobuf 解析（不引入 protobuf 运行时依赖）
  - Tencent Element schema：`45001 id / 45002 type / 45101 text / 45402 fileName / 45906 voiceLen / 47602 emojiText / 47901 applicationMessage / 48214 noticeInfo`
  - QQ → WeChat msg_type 映射表 `_QQ_TO_WX_TYPE`
  - 聚合方法 `build_index() / heat_monthly() / earliest_ts()` 镜像 etcli 里 WeChat 那套（per-instance cache）

- **`cli/qq_paths.py`** — QQ 数据发现：
  - 扫 `~/Documents/Tencent Files`、`~/OneDrive/Documents/Tencent Files`、D-Z 盘根 + 各盘 Documents/Tencent Files、注册表 InstallLocation
  - `discover_qq_profiles() -> list[QQProfile]`
  - `qq_decrypted_root_for(profile)` 返回 `~/Documents/Murmur/decrypted_qq/<qq_number>`
  - `qq_running_pids()`、`find_qq_install_dir()`

- **`cli/qq_decrypt.py`** — QQNT SQLCipher v3 变体（page=4096, reserve=48,
  kdf_iter=4000, KDF=SHA512, HMAC=SHA1, strip 1024-byte QQNT 头）。
  纯 Python，无需 wcdb。

- **`cli/native/qq_get_key.ps1`** — 抓 QQNT 数据库密钥的 PowerShell 脚本
  （来自社区 [QQBackup/qq-win-db-key](https://github.com/QQBackup/qq-win-db-key)）。
  动态解析 `wrapper.node` 找到 `sqlite3_key_v2` 函数 RVA → CreateProcess 启动
  QQ 进程并 attach debugger → 用户登录瞬间断点触发拿到 16 字符 ASCII 密钥 →
  detach + 关 QQ 进程。**版本无关**，QQNT 9.9.x 系列都能用。**Windows-only**。

#### 修改：`cli/etcli.py`（最大量改动）

- **`APP_VERSION = "0.3.7"`**

- **多 store 注册表**（line ~4624）：在 `_MurmurAPIHandler` 类上加：
  ```python
  _wechat_store: Optional[EchoStore] = None
  _qq_stores: dict = {}                          # qq_number -> QQStore
  _qq_keys_cfg_path = Path.home() / ".murmur" / "qq_keys.json"
  _active_platform: str = "wechat"
  _active_id: Optional[str] = None
  ```
  + helpers：`_qq_load_keys_config`、`_qq_save_keys_config`、`_qq_get_store`、
  `_set_wechat_store(store)`、`_flush_analysis_caches()`、`_mask_id(s)`、
  `_build_profiles_payload()`、`_set_active_profile(opts)`。

- **新端点**：
  - `GET /api/profiles` — 列出所有 wechat + qq profile，含 state/last_active_ts/n_sessions/is_active
  - `POST /api/active-profile` body `{platform, id}` — 切换 active store + 清缓存

- **删除端点**（被 active-profile 取代）：
  - `GET /api/qq/info`
  - `GET /api/qq/conversations`
  - `GET /api/qq/contacts`
  - `GET /api/qq/groups`
  - `GET /api/qq/messages`

- **保留 QQ 端点**（onboarding 用）：
  - `GET /api/qq/profiles` — 给 QQOnboardingDialog 用的扫描列表
  - `POST /api/qq/extract-key`
  - `POST /api/qq/save-key`
  - `POST /api/qq/decrypt`

- **`/api/info` 响应扩展**：加入 `platform / account_id / active_id` 三个字段

- **`/api/refresh` cache flush 改写**（line ~3742）：
  ```python
  # 旧：手写一长串 *_CACHE.clear()
  # 新：
  _MurmurAPIHandler._flush_analysis_caches()
  _disk_clear()
  ```
  里面包含了 **`_MSG_INDEX_CACHE` 清理**，这是关键 bug 修复 —— 旧版本不清这个，
  导致 refresh 后 friends 列表永远是空。

- **EchoStore.__init__ 加防护**（line ~190）：检查 session.db 里是否有
  `SessionTable` 表，没有就抛 FileNotFoundError。防止空 4 KB stub 被当成「ready」。

- **`relationship_signals()` 返回值修复**（line ~1116）：
  ```python
  # 加了：
  "moments_back": moments_back,
  "moments_out": moments_out,
  ```
  之前 signature_notes 字符串里写「朋友圈互动 10 次」但侧栏 stat 取
  `sig.moments_back` 永远是 0 —— 因为返回 dict 漏了这两个 key。

- **WeChat-only 助手添加 QQ 分支**（line ~2538）：
  ```python
  def _is_qq_store(store) -> bool:
      return store and store.__class__.__name__ == "QQStore"

  def fast_message_count(store, wxid):
      if _is_qq_store(store):
          counts, _ = store.build_index()
          return counts.get(wxid, 0)
      # ... WeChat 原路径
  ```
  同样改了 `heat_monthly_via_sql()` 和 `home_summary()` 里的 `earliest_ts` 循环。

- **`home_summary` 除零修复**（line ~2616）：
  ```python
  max_v = max(values) or 1   # 旧: max_v = max(values) if values else 1
  ```
  empty/all-zero history 触发 ZeroDivisionError。

- **bootstrap 自动 promote 改用 `_set_wechat_store()`** —— 顺便设置
  `_active_platform / _active_id` 让 /api/info 的回值正确。

#### 修改：`cli/paths.py`

- **`discover_wechat_profiles()` 两层扫描修复**（line ~805）：
  ```python
  # 旧：只要外层有 wxid_*，就跳过内层 xwechat_files/ 嵌套
  # 新：两层都扫，同名 wxid 取 db_storage 大的那个
  ```
  这是用户的 11 GB 数据「丢失」的根本原因 —— 外层 89 MB 空壳子掩盖了内层
  11 GB 真数据。

- **`_is_real_decrypted_dir(p)`** 新函数：检查 session.db 是否真有 `SessionTable`
  表，不仅是文件存在。`decrypted_root_for(must_exist=True)` 调用它。

#### 修改：`cli/etcli.spec`

- 加 `qq_paths / qq_decrypt / qq_store` 到 `hiddenimports`。

---

### `app/src/`

#### 新增

- **`app/src/components/ProfileSwitcher.tsx`** — 顶栏 chip + popover 切换组件。
  - 不接受 props（除 className 之类），通过 `window.dispatchEvent('murmur:requestOnboarding', {detail:{platform}})` 触发引导
  - 用 `useProfiles()` hook 拉账号列表
  - 用 `useActivePlatform()` hook 获取当前平台
  - 微信用 `--et-orange` 系，QQ 用蓝色 (`#3a6c8c` 系，融合 Murmur 「奶油 + 蓝墨」调性，不用 QQ 品牌绿)
  - 视觉上 100% 复用 Murmur 现有 token，不引入新 CSS 变量

- **`app/src/utils/activeProfile.ts`** — 状态管理：
  - `readStoredActive() / writeStoredActive(p)` — localStorage `murmur.activeProfile`
  - `syncActiveToBackend(retries=40, delayMs=500)` — boot 时把 localStorage 同步回后端，**带重试**（之前是 fire-and-forget 有竞态）
  - `switchActiveProfile(p)` — POST /api/active-profile + 写 localStorage + reload
  - `useProfiles()` — 拉 /api/profiles + 监听 change event
  - `useActivePlatform()` — 简化版只返回 platform 字段

- **`app/src/pages/QQOnboardingDialog.tsx`** — QQ 引导模态：detect → pick-account
  → extract-key → decrypting → done。done 之后调 `setActiveProfile('qq', qq)` +
  reload，把整个 UI 切到 QQ 视角。

#### 修改

- **`app/src/App.tsx`**：
  - 删 `#qq` 路由 + `QQHomePage` import（QQ 数据走现有 Home/Friend/Graph 等页面）
  - 加 `useEffect` 监听 `murmur:requestOnboarding` event → 路由到 setOnboarding/setQQOnboarding
  - boot 流：`await syncActiveToBackend()` 在 /api/info 探测**之前**，避免竞态弹错引导
  - `<OnboardingDialog onPickQQ={() => { setOnboarding(false); setQQOnboarding(true); }} />`

- **`app/src/pages/Home.tsx`**：
  - 从 `HomeChromeBar` 删除 `🐧 QQ` 按钮（被 ProfileSwitcher 取代）
  - 在 logo 旁挂 `<ProfileSwitcher />`
  - `HomePage` 移除 `onOpenQQ` prop（不再需要）

- **`app/src/pages/OnboardingDialog.tsx`**：
  - 加 `onPickQQ?: () => void` prop
  - Welcome 步骤的「🐧 切换到 QQ」按钮：之前 hardcoded `window.location.hash = '#qq'`（已被删除的路由 → 死链），现在调 prop

- **`app/src/pages/Friend.tsx`**：挂 ProfileSwitcher；QQ 模式下隐藏「朋友圈他赞你/你赞他」两格 stat
- **`app/src/pages/Graph.tsx`**：挂 ProfileSwitcher；QQ 模式下隐藏 NodePanel 的「朋友圈：他赞你 X · 你赞他 Y」一行；EdgePanel 的「朋友圈互动」stat；批量分析说明文里的「朋友圈点赞评论」
- **`app/src/pages/Yearbook.tsx`**：挂 ProfileSwitcher；QQ 模式下隐藏「朋友圈往来」stat
- **`app/src/pages/OfflineSignalsTable.tsx`**：挂 ProfileSwitcher
- **`app/src/pages/Reports.tsx`**：挂 ProfileSwitcher

- **`app/src/data/api.ts`**：
  - 加 `ProfileEntry`、`ProfilesResponse`、`getProfiles()`、`setActiveProfile()`
  - 删 `QQInfo / QQConversation / QQMessage` + 对应 fetch 函数
  - `InfoResponse` 加 `account_id / platform / active_id` 字段
  - `APP_VERSION` → `'v0.3.7 · Murmur 微语'`

#### 删除

- **`app/src/pages/QQ.tsx`** — 旧的 bespoke QQ 页面整个删掉。QQ 数据通过
  EchoStore-compatible store 喂给所有现有微信页面。

---

## 关键修复一览

| Bug | 症状 | 根因 | Fix 位置 |
|---|---|---|---|
| 空数据被当 ready | bootstrap 后 Home 显示「后端没起来」 | EchoStore 只检查 session.db 文件存在，不查 SessionTable 表 | etcli.py:EchoStore.__init__ + paths.py:_is_real_decrypted_dir |
| Refresh 后 friends 空 | 解密成功但 /api/friends 返回 [] | `/api/refresh` 不清 `_MSG_INDEX_CACHE` | etcli.py:/api/refresh 改用 _flush_analysis_caches() |
| 11 GB 数据「丢失」 | 用户 WeChat 数据在嵌套 xwechat_files\xwechat_files\，发现到 89 MB 空壳子 | discover_wechat_profiles 两层扫描逻辑只在外层无 wxid 时才查内层 | paths.py:discover_wechat_profiles 改为两层都扫 + 按 db_storage 大小择优 |
| 朋友圈互动 N 次但 0/0 | signature_notes 字符串和 sidebar stat 数字不一致 | relationship_signals 返回 dict 漏了 moments_back/out 两个 key | etcli.py:relationship_signals 返回里加上 |
| 「切换到 QQ」按钮无效 | OnboardingDialog 上点 QQ 跳到 #qq 路由（已删）然后被 bootstrap 拽回 WeChat 引导 | hardcoded 路由跳转 + 缺 onPickQQ prop | OnboardingDialog.tsx + App.tsx |
| 任意页面「+ 添加新账号」无效 | 只有 Home 接了 onAddNew，其他页面 ProfileSwitcher 是裸的 | Prop drilling 不全 | ProfileSwitcher 改用 window CustomEvent，App.tsx 顶层监听 |
| QQ 切换后 reload 又弹微信引导 | reload 后前端 sync 是 fire-and-forget，比 /api/info 探测晚 | 竞态 | activeProfile.ts:syncActiveToBackend 改为带重试的 await，App.tsx 在探测前 await |
| home_summary ZeroDivisionError | 空 monthly 时 `max_v = 0` 然后除以它 | 边界条件 | etcli.py: `max_v = max(values) or 1` |

---

## Mac-specific TODOs（给 Mac 适配 agent 的清单）

> **必读**：本节列出每一个需要 Mac 端独立实现的部分。Windows 改动跑不到的代码
> 路径不需要动；需要新写 Mac 等价物的列在下面。

### 1. QQ Key 提取（Mac 版本）

- **现状**：`cli/native/qq_get_key.ps1` 只支持 Windows（PowerShell + DebugActiveProcess）。
- **要做**：写 `cli/native/qq_get_key_mac.{sh,py}` 或 `extract_qq_key_mac.py`：
  - 找到 `/Applications/QQ.app/Contents/MacOS/QQ` 进程
  - 用 `lldb` attach + 在 `sqlite3_key_v2`（或 QQ 内部包装函数）下断点
  - 用户登录瞬间读 `r1` 寄存器拿 16 字符 ASCII passphrase
  - 参考 Windows 实现：`cli/native/qq_get_key.ps1` 的 `KeyExtractor` C# 类
- **集成点**：在 `cli/qq_decrypt.py` 里加 Mac 分支调度
- **测试**：QQ NT for macOS 当前是 `9.9.18+`（2026-04），版本无关性需要确认

### 2. QQ 数据路径（Mac）

- **现状**：`cli/qq_paths.py:_windows_qq_search_paths()` 只扫 Windows 位置
- **要做**：加 `_mac_qq_search_paths()` 扫描：
  ```
  ~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/
  ~/Library/Application Support/QQ/                          (老版本)
  ~/Library/Containers/com.tencent.qq/Data/Documents/        (备份)
  ```
- **结构**：每个登录过的 QQ 号有一个 `<qq_number>/nt_qq/nt_db/` 目录，里面是 6 个加密 DB
- **统一入口**：`discover_qq_profiles()` 顶部 `if IS_MAC: return _mac_qq...`

### 3. QQ 解密（应该不用改）

- `cli/qq_decrypt.py` 是纯 Python SQLCipher 实现，跨平台。Mac 直接复用。
- 只要 key 提取拿到 16 字符 passphrase，解密逻辑相同。

### 4. ProfileSwitcher / activeProfile（前端通用）

- 整套前端代码已经平台无关。Mac 自动生效。
- ⚠ 但 QQ 部分依赖 `/api/qq/extract-key` 后端端点，在 Mac 上需要先把上面 1+2 完成。
- ⚠ `cli/etcli.py:_qq_get_store()` 假设 decrypted dir 在 `~/Documents/Murmur/decrypted_qq/<qq>`，Mac 可保持一致。

### 5. WeChat 路径修复（自动生效）

- `paths.py:discover_wechat_profiles` 两层扫描 fix 不分平台。Mac 上 WeChat 4.x
  如果出现 `~/Library/Containers/.../xwechat_files/xwechat_files/wxid_*` 嵌套
  问题（理论上有，因为 OneDrive 同步），自动修复。

### 6. EchoStore 防护（自动生效）

- `EchoStore.__init__` 的 SessionTable 检查跨平台，Mac 无需改动。

### 7. Build / Release（Mac 需独立 CI）

- Mac 端跑 `bash scripts/macos-notarize-release.sh`
- 安装包：`Murmur_0.3.7_x64.dmg` (Intel) + `Murmur_0.3.7_aarch64.dmg` (Apple Silicon)
- 公证 / Hardened Runtime 流程不变

---

## 测试 checklist

### 微信侧（Windows + Mac）

- [ ] 全新安装 → 引导走完 → Home 显示真实 friends（不再是 12 个，不再是 0 个）
- [ ] 多层 xwechat_files 嵌套：`<root>/xwechat_files/wxid_*` (89 MB) + `<root>/xwechat_files/xwechat_files/wxid_*` (11 GB)
      → 自动选 11 GB 那个
- [ ] 朋友圈 stat：当 signature_notes 显示「朋友圈互动 10 次」时，sidebar 也显示「他赞你 X / 你赞他 Y」非 0
- [ ] /api/refresh 后 /api/friends 返回有数据（不再因为 _MSG_INDEX_CACHE 残留返回 []）
- [ ] /api/home-summary 在空账号时不抛 ZeroDivisionError

### QQ 侧（Windows）

- [ ] discover_qq_profiles 找到所有登录过的 QQ 号
- [ ] extract-key 拿到 16 字符 ASCII passphrase
- [ ] decrypt 6 个 DB（`nt_msg.db / profile_info.db / group_info.db / ...`）成功
- [ ] /api/profiles 列出 wechat + qq 所有账号
- [ ] /api/active-profile POST {platform:qq, id:<qq_number>} → 整个 UI reload 后展示 QQ 数据
- [ ] Home 显示 QQ contacts + sessions + heat
- [ ] Friend 页面（用 QQ uid）显示 messages
- [ ] Graph / Reports / Yearbook / OfflineSignalsTable 都能切换

### ProfileSwitcher

- [ ] 顶栏 chip 显示当前账号
- [ ] 点击展开 popover 列出所有账号 + 状态
- [ ] 点 ready 账号 → 切换 + reload
- [ ] 点 needs_key/needs_decrypt 账号 → 跳对应平台引导
- [ ] 点「+ 添加新账号 → 微信/QQ」 → 跳对应引导（任何页面都生效）
- [ ] 引导窗里点「🐧 切换到 QQ」 → 切到 QQ 引导（不再回到微信引导死循环）

---

## 不打算做的事（明确写下来避免回头）

- ❌ **QQ 空间 / 动态 / 说说**：本地 QQNT DB 不存这些，腾讯云端管。要拉只能爬
  `user.qzone.qq.com` 模拟登录 + 反爬，违背 Murmur「100% 本地」原则。
  → QQ 视角下隐藏所有「朋友圈」相关 UI（已实现）。
- ❌ **跨平台关系合并**：同一个人在你微信和 QQ 都有 → 自动识别为同一人。
  涉及姓名匹配 + 手机号映射 + AI 推断，留给 v0.4。
- ❌ **QQ AI 关系档案**：当前 AI agent 报告生成 prompt 是为微信场景调的。QQ 跑能跑
  但语境不太对。需要单独的 QQ-aware prompt，留给 v0.4。

---

## Migration（升级老用户）

- **0.2.x → 0.3.7**：直接覆盖装。`~/.murmur/config.json` 兼容（`wechat_roots` 字段
  已存在）。`~/Documents/Murmur/decrypted/` 兼容（路径未变）。
- **0.3.0~0.3.6 测试版用户**：覆盖装即可。0.3.6 之前因为路径 bug 可能拿到 89 MB
  空壳子 → 0.3.7 自动切到正确的 11 GB 数据 → 启动后建议手动「更新数据」一次重解。

---

## Repo state

- 新增/修改/删除文件总数：21
- 新增源代码：~2,000 行（主要在 qq_*.py + ProfileSwitcher.tsx + activeProfile.ts）
- 修改：~500 行（etcli.py 多 store 注册表 + paths.py 路径修复）
