# Murmur v0.2.12

## 下载

Windows 用户下载：

- `Murmur_0.2.12_x64-setup.exe`：推荐，双击安装。
- `Murmur_0.2.12_x64_en-US.msi`：备用，适合 IT 部署；普通用户优先用 `.exe`。

Apple Silicon Mac 用户下载（待发布）：

- `Murmur_macOS_AppleSilicon.dmg`：推荐，M1 / M2 / M3 / M4 Mac 使用。
- `Murmur_macOS_AppleSilicon.app.zip`：备用，主要用于排错。

> Intel Mac 用户：本仓库目前只发 Apple Silicon 的 `.app`，Intel Mac 必须用源码安装。终端跑：
> `curl -fsSL https://raw.githubusercontent.com/sgaofen/murmur/main/install-mac.sh | bash`

## 这版重点（在 0.2.11 之上）

四个真 bug + 一个新机制：

- **后端崩了/被杀会自动重启**：Tauri 端加了 watchdog 线程，每 3 秒检测 etcli 进程；非正常退出（segfault / OOM / Python uncaught exception / 用户从 Task Manager 杀）时自动重新拉起，60 秒内最多 5 次重启，超过则进入 60 秒退避并把详情写进 `tauri-shell.log`。
- **再次启动时清理上一次的僵尸 etcli**：覆盖"上次没干净退出 → 端口 9100 被占用 → 新 etcli 直接 OSError → 前端 Failed to fetch"这条最常见的"一点开始立马 fail"症状。Python 端的 bind 也加了 8 次 × 0.5 秒重试做兜底。
- **`/api/reports` 在新装用户的 bootstrap 模式下不再 503**。第二道权限 gate 之前没把 `/api/reports` 和 `/api/report/*` 放过，导致用户首次打开「报告」页拿到 503，错误信息很迷惑。
- **抓 key 失败时如果是 wx_key.dll 被杀软隔离，错误信息现在会明确提示**："最可能的原因：杀毒软件（360 / QQ 管家 / 火绒 / Defender）把 wx_key.dll 隔离了。修复：把 Murmur 安装目录加到杀毒白名单 → 重装 → 再试一次。"之前用户只看到一个空 log + 通用"没读到密钥"。
- **WinNeedKey 的「再次检测微信」按钮**：之前页面文案让用户「点 再试一次 重新检测」但 UI 根本没那个按钮，用户得完全退出 Murmur 才能重检。现在不仅有按钮，而且在没检测到微信时每 2.5 秒自动 retry —— 用户打开微信几秒后「开始抓密钥」按钮就会自动从灰变橙。

## Windows 安装

1. 下载 `Murmur_0.2.12_x64-setup.exe`。
2. 双击安装，安装完从桌面或开始菜单打开 Murmur。
3. 打开微信，退出到登录页，但不要关闭微信程序。
4. 回 Murmur，按引导点击「开始抓密钥」。
5. 看到等待登录事件后，回微信扫码或自动登录一次。
6. 抓到 key 后会自动解密，然后进入主界面。

如果出现 `Failed to fetch`（应该比 0.2.11 罕见多了）：

- 任务管理器看下还有没有 `etcli.exe` 残留 → 应该不会有，watchdog 自己处理了
- 仍然失败时把这两份日志最后 30 行发给作者：
  ```powershell
  Get-Content "$env:USERPROFILE\Documents\Murmur\logs\serve.log" -Tail 30
  Get-Content "$env:USERPROFILE\Documents\Murmur\logs\tauri-shell.log" -Tail 30
  ```

如果出现「读不到密钥」：

- 看下错误信息有没有提到 `wx_key.dll` —— 有的话就是 AV 拦截，按提示加白名单
- 没提到则按 onboarding 提示走（先停在登录页 → 点「开始抓密钥」→ 然后回微信登录）

## Mac 安装

参见 v0.2.11 release notes。这版没改动 Mac onboarding 路径。

## 隐私

解密、统计和本地浏览都在你的电脑上完成。只有你主动点击 AI 分析时，样本才会交给本机已登录的 Claude Code / Codex CLI。
