# Murmur v0.2.11

## 下载

Windows 用户下载：

- `Murmur_0.2.11_x64-setup.exe`：推荐，双击安装。
- `Murmur_0.2.11_x64_en-US.msi`：备用，适合 IT 部署；普通用户优先用 `.exe`。

Apple Silicon Mac 用户下载：

- `Murmur_macOS_AppleSilicon.dmg`：推荐，M1 / M2 / M3 / M4 Mac 使用。
- `Murmur_macOS_AppleSilicon.app.zip`：备用，主要用于排错。

## 这版重点

- 首次启动最多等待本地后端 60 秒，覆盖 Windows Defender / 杀毒软件扫描 `etcli.exe` 导致的慢启动。
- 如果仍然出现 `Failed to fetch` / 后端没起来，页面会直接显示 `serve.log` 和 `tauri-shell.log` 的末尾，方便远程排查。
- 首页「密钥」按钮的 Windows 流程已和首次引导统一：先让微信停在登录页但不要关闭程序，再点 Murmur 开始，最后回微信登录。
- Mac 版会把 `~/.murmur/decrypted_keys.json` 识别为已保存密钥；缺少该文件时，更新数据会给出明确引导。
- 后台任务中心会把解密失败标成失败，而不是显示成已完成。

## Windows 安装

1. 下载 `Murmur_0.2.11_x64-setup.exe`。
2. 双击安装，安装完从桌面或开始菜单打开 Murmur。
3. 打开微信，退出到登录页，但不要关闭微信程序。
4. 回 Murmur，按引导点击「开始抓密钥」。
5. 看到等待登录事件后，回微信扫码或自动登录一次。
6. 抓到 key 后会自动解密，然后进入主界面。

如果出现 `Failed to fetch`，先等 60 秒；失败页会显示日志。手动排查可以运行：

```powershell
Get-Content "$env:USERPROFILE\Documents\Murmur\logs\serve.log" -Tail 80
Get-Content "$env:USERPROFILE\Documents\Murmur\logs\tauri-shell.log" -Tail 80
Get-NetTCPConnection -LocalPort 9100 -State Listen
tasklist | findstr /i "Murmur etcli Weixin WeChat"
```

这版继续改进 Windows 微信检测：微信装在 D 盘/自定义目录、注册表缺失时，只要 `Weixin.exe` / `WeChat.exe` 正在运行，Murmur 仍会允许继续抓 key。

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
