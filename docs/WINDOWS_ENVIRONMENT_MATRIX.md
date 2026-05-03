# Windows 环境差异测试记录

这份给排查朋友电脑用：Murmur 安装包应该自带前端、Tauri shell、PyInstaller 后端、SQLCipher 解密 DLL、抓 key DLL，不要求用户额外安装 Python / Node / Rust。

## EchoTrace 继承点

Murmur 兼容 EchoTrace 的旧数据布局，但 onboarding 不再要求用户先跑 EchoTrace：

- 会读取旧配置：`%APPDATA%/com.example/echotrace/shared_preferences.json`
- 会读取旧解密目录：`~/Documents/EchoTrace/<wxid>/`
- 新写入目录统一为：`~/Documents/Murmur/decrypted/<wxid>/`
- Windows 仍沿用 EchoTrace 验证过的 Go 解密器和 silk/media 工具链

真正的新用户流程是：

1. 安装 Murmur `.exe`。
2. 打开微信并保持进程运行。
3. Murmur 自动发现微信数据目录。
4. 用户退出到微信登录页但不关闭微信。
5. Murmur 注入 hook，等待登录事件。
6. 用户重新登录微信，Murmur 捕获 key。
7. 自动解密并进入主界面。

## 已覆盖场景

| 场景 | 覆盖方式 | 预期 |
|---|---|---|
| 本机标准安装 | 真实 `C:/Program Files/Tencent/Weixin/Weixin.exe` + 真实微信数据 | `has_wechat_installed=true`，`can_extract_key=true` |
| 自定义微信数据目录 | `MURMUR_WECHAT_ROOT` 指向假 `xwechat_files` | 能发现 `wxid_*` profile |
| 只扫指定目录 | `MURMUR_WECHAT_ROOT_ONLY=1` | 不再扫描全盘，适合隔离测试/排错 |
| 空数据目录 | root-only 指向空目录 | `has_wechat_data=false`，onboarding 应提示先登录微信 |
| 微信装在非默认路径但进程存在 | 单元模拟：`find_weixin_exe=None` + `weixin_running=true` | 仍允许抓 key |
| 微信进程不存在 | 单元模拟：`weixin_running=false` | 不允许抓 key，提示打开微信 |
| 打包后端启动 | `app/src-tauri/etcli/etcli.exe serve` 独立端口 | `/api/info` 返回 `0.2.11`，`/api/diagnose` 正常 |
| Tauri shell 启动后端 | release `Murmur.exe` + 隔离 `USERPROFILE/APPDATA/LOCALAPPDATA` | shell 能自动拉起后端，`9100/api/info` 正常 |

## 给朋友排查时先收集

```powershell
Get-Content "$env:USERPROFILE\Documents\Murmur\logs\serve.log" -Tail 30
Get-Content "$env:USERPROFILE\Documents\Murmur\logs\tauri-shell.log"
Get-NetTCPConnection -LocalPort 9100 -State Listen
tasklist | findstr /i "Weixin WeChat Murmur etcli"
```

优先确认：

- 下载的是 `Murmur_0.2.11_x64-setup.exe`，不是旧包。
- 微信任务管理器里能看到 `Weixin.exe` 或 `WeChat.exe`。
- 端口 `9100` 没被其他程序占用。
- 杀软/Defender 没把 `etcli.exe` 或 `wx_key.dll` 隔离。
- 如果微信数据在奇怪位置，设置 `MURMUR_WECHAT_ROOT` 指到 `xwechat_files` 或 `wxid_*` 账号目录。
