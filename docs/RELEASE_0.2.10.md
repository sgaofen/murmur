# Murmur v0.2.10

## 下载

Windows 用户下载：

- `Murmur_0.2.10_x64-setup.exe`：推荐，双击安装。
- `Murmur_0.2.10_x64_en-US.msi`：备用，适合 IT 部署；普通用户优先用 `.exe`。

Apple Silicon Mac 用户下载：

- `Murmur_macOS_AppleSilicon.dmg`：推荐，M1 / M2 / M3 / M4 Mac 使用。
- `Murmur_macOS_AppleSilicon.app.zip`：备用，主要用于排错。

## Windows 安装

1. 下载 `Murmur_0.2.10_x64-setup.exe`。
2. 双击安装，安装完从桌面或开始菜单打开 Murmur。
3. 打开微信并保持登录，或先退出到微信登录页但不要关闭微信程序。
4. Murmur 首次启动会自动检测微信数据；按引导点击「开始抓密钥」。
5. 看到「等待登录事件」后，回微信扫码或自动登录一次。
6. 抓到 key 后会自动解密，然后进入主界面。

如果出现 `Failed to fetch`，先完全退出 Murmur 再打开一次；仍失败时，把下面两份日志最后 30 行发给开发者：

```powershell
Get-Content "$env:USERPROFILE\Documents\Murmur\logs\serve.log" -Tail 30
Get-Content "$env:USERPROFILE\Documents\Murmur\logs\tauri-shell.log"
```

这版改进了 Windows 微信检测：微信装在 D 盘/自定义目录、注册表缺失时，只要 `Weixin.exe` / `WeChat.exe` 正在运行，Murmur 仍会允许继续抓 key。

高级排错时可以设置 `MURMUR_WECHAT_ROOT` 指向自定义 `xwechat_files`；如果要只扫这个目录，再设置 `MURMUR_WECHAT_ROOT_ONLY=1`。

## Mac 安装

1. 下载 `Murmur_macOS_AppleSilicon.dmg`。
2. 双击打开 dmg。
3. 把里面的 `Murmur.app` 拖到「应用程序」/ `/Applications`。
4. 不要直接在 dmg 窗口里运行；拖完后从「应用程序」打开 Murmur。
5. 如果 macOS 提示无法打开，先点「完成 / Done」，不要点移到废纸篓；然后进入「系统设置」→「隐私与安全性」→ 底部「仍要打开 / Open Anyway」。
6. 如果没有「仍要打开」，终端执行：

```bash
xattr -dr com.apple.quarantine /Applications/Murmur.app
open /Applications/Murmur.app
```

首次使用 Mac 版时，Murmur 会继续引导你：

1. 给 Murmur「完全磁盘访问」权限，并重启 Murmur。
2. 一键给 WeChat 重签名；这一步不需要关 SIP，不需要重启电脑。
3. 回 WeChat 点开 3-5 个私聊、翻一下朋友圈，让 WCDB 把 key 派生到内存。
4. 回 Murmur 点「开始自动抓取」，等待解密完成。

完整 Mac 图文流程见 `docs/ONBOARDING_MAC.md` 和 `docs/MAC_RELEASE_INSTALL.md`。

## 隐私

解密、统计和本地浏览都在你的电脑上完成。只有你主动点击 AI 分析时，样本才会交给本机已登录的 Claude Code / Codex CLI。
