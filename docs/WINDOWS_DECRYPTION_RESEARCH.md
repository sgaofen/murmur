# Windows 解密路线研究

日期：2026-05-02

结论先放前面：Windows 可以做到比 Mac 更短的用户流程，但目前不建议把“直接扫内存”做成默认方案。Murmur 现有的“先 hook 正在运行的微信，再让用户退出登录并重新登录一次”的路线，是现在更适合普通用户的稳定默认路径。

---

## 当前 Murmur Windows 路线

文件：

- `cli/extract_key_dll.py`
- `cli/extract_key.py`
- `cli/refresh.py`
- `app/src/pages/ExtractKeyDialog.tsx`
- `app/src/pages/OnboardingDialog.tsx`

当前默认流程：

1. 用户保持微信已运行、已登录。
2. Murmur 点击「开始抓密钥」。
3. 后端把 `wx_key.dll` hook 装进当前 `Weixin.exe` / `WeChat.exe`。
4. UI 提示用户去微信里退出登录，再登录一次。
5. hook 在登录事件里拿到 64-hex 主 key。
6. Murmur 保存到 `~/.murmur/config.json`。
7. `refresh.py` 用同一把主 key 批量解密所有数据库。

这个流程的优点：

- Windows 只需要一把主 key，不像 Mac 要匹配 14 把 per-DB key。
- 不需要 macOS 的完全磁盘访问、WeChat 重签名、系统密码框。
- 用户动作可以稳定压缩成“一键开始 + 微信重新登录一次”。
- 解密阶段可以继续复用 `go_decrypt.dll`，速度快。

当前 UI 里 `autoRestart` 是关闭的，这是有原因的：代码注释记录了 Win11 + WeChat 4.1.x 下 kill/relaunch 后新进程可能在 hook 挂上前退出，所以产品默认改成让用户手动重新登录。

---

## 方案对比

| 方案 | 用户感觉 | 稳定性 | 风险 | 建议 |
|---|---|---:|---:|---|
| hook 当前微信 + 手动重新登录 | 简单，2-5 分钟 | 高 | 中 | 默认保留 |
| 自动关闭并重启微信 + hook | 看起来更自动 | 中 | 中高 | 只做高级/实验按钮 |
| 纯内存扫描主 key | 看起来最省事 | 低到中 | 高 | 不做默认 |
| 要求用户降级微信获取 key | 麻烦 | 中 | 高 | 不做主流程 |
| 用户手动粘贴已有 key | 不适合多数用户 | 高 | 低 | 保留为故障排除 |

---

## 为什么不把“纯内存扫描”当默认

Murmur 仓库里已经有 `cli/extract_key.py`，它会：

1. 找到微信进程。
2. 枚举可读内存。
3. 对 32 字节窗口做候选过滤。
4. 用样本数据库验证候选 key。

这条路在旧版本上可能有用，但不适合当前默认体验。上游 `chatlog` 的 FAQ 明确提到，传统内存读取方案依赖密钥在微信进程内存中停留；在 Windows 4.0.3.36 之后，密钥信息不再长时间保留在内存里，所以这种方案会变得不稳定：见 [sjzar/chatlog FAQ #197](https://github.com/sjzar/chatlog/issues/197)。`chatlog` 的 Go 包页面也把密钥获取兼容范围标注为 `Windows < 4.0.3.36 / macOS < 4.0.3.80`：见 [pkg.go.dev chatlog README](https://pkg.go.dev/github.com/kingyuluk/chatlog)。

所以，“打开 Murmur 后自动扫一下就拿到 key”听起来很美，但在新版微信上很容易变成：

- 用户等很久。
- 没有明确进度。
- 扫不到 key。
- 换机器、换微信小版本后结果不一致。

这会比现在的“请重新登录一次”更让用户困惑。

---

## 上游工具状态

调研到的几个外部信号：

- `chatlog` 原仓库目前只保留移除通知，说明项目核心功能有合规风险，已移除代码和预编译程序：见 [sjzar/chatlog](https://github.com/sjzar/chatlog)。
- `PyWxDump` 原仓库也已移除代码和历史，只保留移除通知：见 [xaoyaoo/PyWxDump](https://github.com/xaoyaoo/PyWxDump)。
- 现存 fork 或包索引仍能看到旧思路：读取本地数据库、获取密钥、解密、提供 HTTP/MCP 查询，但兼容性普遍把新版微信密钥获取列为问题。

对 Murmur 的含义：

1. 不要直接把外部工具代码并进来。
2. 不要把“降级微信获取 key”写成主路线。
3. 文档和 UI 都要明确：只处理用户自己本机、自己账号、已授权的数据。
4. Windows 默认方案应以现有 hook 登录事件为核心，把用户引导做清楚。

---

## 能不能做得像 Mac 一样“一键”

准确说，Windows 比 Mac 更容易做成产品化流程，但不是完全无动作。

Mac 必须处理：

- 完全磁盘访问。
- WeChat hardened runtime。
- 重签名。
- 多个 DB 的 per-DB key。
- 用户必须点开聊天/朋友圈让 key 进内存。

Windows 只需要：

- 微信正在运行。
- Murmur 安装 hook。
- 用户重新登录一次。

所以 Windows 最合适的目标不是“后台偷偷全自动”，而是：

1. 一键开始。
2. 明确显示“hook 已安装，正在等你重新登录微信”。
3. 给用户一个倒计时和步骤提示。
4. 捕获 key 后自动验证、保存、解密。
5. 失败时给出下一步，而不是只显示错误日志。

---

## 推荐改进

短期：

1. 保留当前默认：`extractKey({ autoRestart: false, timeout: 90 })`。
2. Windows onboarding 文案继续强调“先点开始，再去微信退出登录并重新登录”。
3. 失败页区分三类错误：
   - 没找到微信进程。
   - hook 装上了但超时，没有登录事件。
   - 拿到 key 但验证数据库失败。
4. 保留手动粘贴 key 入口，作为故障排除。

中期：

1. 可以加一个「自动重启微信并尝试抓取」高级按钮，对应 `--auto-restart`。
2. 这个按钮必须标注“如果失败，回到手动重新登录流程”。
3. 只在 Windows 真实机器上验证至少：
   - Win10 + WeChat 4.x
   - Win11 + WeChat 4.x
   - `Weixin.exe`
   - `WeChat.exe`
   - 默认安装路径
   - 非默认安装路径

不建议：

1. 不建议默认纯内存扫描。
2. 不建议要求用户装旧版微信。
3. 不建议把第三方移除项目的代码复制进仓库。

---

## 给 Windows agent 的测试清单

1. 新机器没有 Python / Node，只装 release `.exe`，Murmur 能启动。
2. 微信已登录时，onboarding 能检测到 `Weixin.exe` 或 `WeChat.exe`。
3. 点击「开始抓密钥」后，UI 进入等待登录事件状态。
4. 用户退出微信登录再登录后，90 秒内捕获 key。
5. 捕获 key 后写入 `~/.murmur/config.json`，包含 `key` 和 `decrypt_key`。
6. 自动刷新解密数据到 `~/Documents/Murmur/decrypted/<wxid>/`。
7. 重启 Murmur 后不再要求重复抓 key，直接进入主界面。
8. 删除 `~/.murmur/config.json` 后，流程能重新引导抓 key。
9. 没开微信时，UI 不应卡死，要提示先打开微信。
10. hook 超时时，UI 要明确告诉用户“保持 Murmur 等待页打开，再去微信重新登录一次”。
