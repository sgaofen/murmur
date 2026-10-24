# 在 Mac 上跑 Murmur

> 完整测试指南。你在 Mac 上第一次起 Murmur 时，先看这一份。普通用户装 App 的流程见 [ONBOARDING_MAC.md](ONBOARDING_MAC.md)。
>
> **只处理本机、本人的数据。** 下面所有抓 key 方式（重签名、Frida 附加、私有副本注入）都只应该用在你自己的电脑、你自己登录的微信上；它们都不是腾讯官方支持的用法，**有触发风控、被要求重新登录甚至限制账号的可能**。

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
| 抓 SQLCipher 密钥 | ✅ 支持，三种方式：① Frida 实时抓取（4.1.9+ 推荐，需重签名，截到账号口令后一轮派生全部库的 key）；② 免 Frida 私有副本（不重签原版、不要管理员密码，见下方「免 Frida：私有副本」）；③ 内存扫描 `extract_key_mac.py`（4.1.9 以前） |
| 实时同步（WAL） | ✅ 支持（首页「实时同步」开关，后台轮询、快照、增量解密，含未 checkpoint 的 WAL 帧） |
| 全局搜索 / 语义搜索 / 聊天浏览 | ✅ 支持（语义搜索可选，需 `requirements-semantic.txt`，打包版按需下载模型） |
| MCP 服务 | ✅ 支持（`python3.12 cli/etcli.py mcp`，见 [MCP.md](MCP.md)） |
| 应用锁 | ✅ 支持（见 [app-lock.md](app-lock.md)） |
| 抓 image AES key | ✅ 支持（从 kvcomm 缓存推导 + 用真实密文校验，`media.py extract-image-key`，只需磁盘访问，不需要 root） |
| 语音 silk → mp3 | ✅ 支持（`pip install pilk` 本地解码 + ffmpeg 转 mp3，见 `requirements.txt`；不再依赖 Windows 的 silk_v3_decoder.exe。真实音频数据在 `media_*.db` 的 `VoiceInfo` 表，不在 `message_*.db` 里，`voice.py` 已按这个改） |
| **浏览/分析已解密的数据** | ✅ 完全支持 |
| AI agent 调用 (claude / codex) | ✅ 完全支持 |
| 媒体相册 / 完整对话 / AI 分析 | ✅ 完全支持 |
| 视频 / 已解密图片预览 | ✅ 完全支持 |

**推荐工作流**：直接跑 `bash start-mac.sh`。首次没有解密数据时，应用内引导会用步骤条带你走「环境自检 → 数据目录（完全磁盘访问）→ 授权/重签 → 取得密钥 → 解密 → 完成」，并按微信版本推荐抓取方式。

## WeChat 4.1.9+ 抓密钥（内存扫描 0 命中时）

`extract_key_mac.py` 靠扫描 WeChat 进程内存找 WCDB 缓存的密钥。这个方法在 WeChat 4.1.9 以下工作正常，但 **4.1.9 之后的版本，内存扫描（无论是找 ASCII 文本格式，还是直接找已知 salt 原始字节）经常直接 0 命中** —— 密钥材料不再稳定驻留内存，扫不到不代表哪里配置错了。

遇到这种情况，改用 `cli/hook_cc_key_frida.py`（Frida 实时 hook，跟 WCDB 调用 CommonCrypto 加密函数的那一刻直接截获 key，不用等它"留"在内存里）。

**App 里已经集成了**：引导检测到 WeChat 4.1.9+ 会直接推荐「实时抓取」；内存扫描 0 命中也会自动切过去。界面会显示倒计时和已匹配的数据库数，一轮不够可以「再抓一轮」，抓完接着解密。源码运行时没装 frida 可以在界面里一键安装（`pip install --user`）；打包版 App 自带 frida。挂钩需要管理员权限时会弹 macOS 密码窗口。

想在终端里手动跑也可以：

```bash
python3.12 -m pip install -r requirements-mac-keyextract.txt   # 装 frida，一次性
python3.12 cli/hook_cc_key_frida.py --seconds 60
```

**关键：脚本跑起来之后要主动去用微信**（发消息、发语音、发/看图片、点开还没打开过的对话、翻朋友圈、点通讯录/收藏/表情面板）——WCDB 只有在某个数据库真正被用到时才会把 key 传给加密函数，光晾在那不操作基本抓不到。发送新内容（不只是看历史）最可靠，因为一定会触发新的加密写入。

WeChat 4.x 有 20 来个独立加密库（联系人、会话、每个消息分片、朋友圈、收藏、表情、图片/视频、头像……）。现在实时抓取会同时截获 `CCKeyDerivationPBKDF` 里的**账号口令**：拿到口令后在本机用 PBKDF2 按每个库自己的 salt 派生 key，并逐个做 page-1 HMAC 校验，所以**一轮就能拿全所有库**，不用等每个库都被用到。口令按账号（wxid）保存，换账号不会拿旧口令白算。没截到口令时退回逐库截 key，多跑几轮即可，`decrypted_keys.json` 里已有的 key 会保留，只找还缺的。

`cli/hook_cc_key.py` 是同样思路的 lldb 版本，不需要装 frida，但**不推荐默认用**——lldb 断点会让微信在抓取窗口内整个卡住/掉帧（后台 WCDB 线程调用加密函数太频繁），Frida 版本是内联 hook，不涉及"暂停整个进程"，实测同样调用量下完全无感。lldb 版本留着当免依赖兜底。

两个脚本都需要跟 `extract_key_mac.py` 一样的前提：完全磁盘访问 + WeChat 已经 ad-hoc 重签名去掉 hardened runtime（见上面「首次启动 onboarding」）。不需要额外 sudo，但如果 attach 失败可以加上试试。

## 免 Frida：私有副本

不想装 Frida、不想输管理员密码时用这条路（实现在 `cli/mac_private_copy.py`，接口 `/api/private-copy/{status,start,cancel,delete}`）：

1. 把 `/Applications/WeChat.app` 复制到 `~/.murmur/wechat-copy/`，**只对副本**做 ad-hoc 重签名（加 `get-task-allow` 等 entitlement，不带 hardened runtime），原版不动。
2. 用 `DYLD_INSERT_LIBRARIES` 注入 `murmur_keycap.dylib`（源码 `cli/native/murmur_keycap.c`，`build_keycap.sh` 编成 universal；打包版放在 `_internal/native/`）。它只 interpose CommonCrypto 的 `CCCrypt` / `CCCryptorCreate*` / `CCKeyDerivationPBKDF`，把候选写到 `0600` 的临时文件，不含微信特定逻辑。
3. 拿到口令 → 本地派生并 HMAC 校验全部库 → 合并进 `decrypted_keys.json`。
4. 每轮结束（成功 / 超时 / 取消 / 出错）都会结束副本及其 helper 进程，并覆写删除候选文件；`delete` 删除整个副本。

**真机结论（WeChat 4.1.15）**：

- 副本和原版**共用同一个 `xwechat_files` 容器**，不会另建一套数据。
- 没有弹「想访问其他 App 的数据」的授权框。
- 需要在副本里**重新登录一次**。
- 23/23 个库的 key 全部通过 HMAC 校验。

因为共用容器，**用之前必须先完全退出原版微信**：`start` 检测到 `/Applications/WeChat.app` 里有任何进程在运行就拒绝（`original-running`），启动副本前还会再查一次。其他版本（如 4.1.22）还没在真机上跑过。

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
Reports 页面也可以跑批量分析：先选 Claude / Codex / 双引擎对照，再选并发速度（1 / 2 / 4 路），然后点小样本自检、Top N、全部朋友，或按关系图权重补全朋友间关系。双引擎会同时跑 Claude 和 Codex，并在报告文件名追加 `__claude` / `__codex`，避免互相覆盖。

批量报告会把这些上下文喂给 LLM：
- 你和朋友的私聊时间分布样本、非文本互动（语音 / 图片 / 视频 / 通话）样本；
- 朋友在共同群聊里的完整历史抽样，不只截前几千条；
- 你和其他朋友聊到这个人的提及证据；
- 你和朋友的朋友圈互动明细，以及朋友和朋友之间的朋友圈互动；
- 朋友间关系报告会同时看提及、共同群聊直接接话、朋友圈互评，而不是只靠聊天量。

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

### 微信数据目录不在默认位置
如果 WeChat 的 `xwechat_files` 放在外接盘、迁移目录或别的用户目录，可以先指定源目录：

```bash
MURMUR_WECHAT_ROOT=/path/to/xwechat_files python3.12 paths.py
MURMUR_WECHAT_ROOT=/path/to/xwechat_files python3.12 etcli.py serve --port 9100
```

`MURMUR_WECHAT_ROOT` 也可以直接指向某个 `wxid_*/` 账号目录。

### 前端报「连不上后端」
- 确认后端跑了：`curl http://127.0.0.1:9100/api/info`
- 确认浏览器没拦截 (浏览器开发工具 → Network → 看 fetch 请求)
- 返回 `403` + `HOST_NOT_ALLOWED`：后端只接受 Host 为 `127.0.0.1` / `localhost` / `[::1]` 加实际端口的请求（防 DNS 重绑定）。用局域网 IP 或自定义域名访问会被拒；需要的话用 `--host <那个 IP>` 启动，该地址也会被接受。
- 返回 `423` + `APP_LOCKED`：开了应用锁，先在界面里解锁。

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
