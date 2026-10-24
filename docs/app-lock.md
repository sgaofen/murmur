# 应用锁

在「设置 → 应用锁」里开启。默认关闭。

## 它做什么

- 打开 Murmur 时、以及闲置一段时间后（5 / 15 / 30 分钟，或从不），先显示锁屏，输入密码后才显示内容。
- 锁定期间界面上什么都不挂载，不会请求任何聊天数据。
- 锁是后端（`etcli serve`）执行的：锁定期间，除了 `/api/app-lock/status`、`/api/app-lock/unlock`、`/api/app-lock/lock` 以外的所有接口都返回 `423`，错误码 `APP_LOCKED`。所以绕开界面直接请求 `http://127.0.0.1:9100` 也拿不到数据。
- 连续输错 3 次后要等待才能再试：5 秒，之后每错一次翻倍，最长 5 分钟。计数存在文件里，重启 Murmur 不会清零。

## 它不做什么

应用锁的作用是**防止旁人打开 Murmur 翻看**，它**不是加密**：

- `~/Documents/Murmur/decrypted/` 下已经解密的数据库不会被加密，能登录这台电脑账户的人仍然可以直接打开这些文件。
- `etcli mcp`（给 AI 工具用的 MCP 服务）和命令行工具直接读这些文件，不受应用锁影响。
- 要保护磁盘上的数据，请使用系统的磁盘加密（macOS FileVault / Windows BitLocker）和电脑登录密码。

## 密码怎么存

只保存加盐哈希：PBKDF2-HMAC-SHA256，60 万轮，每次设置都生成新的 16 字节随机盐。文件位置：

- macOS / Linux：`~/.murmur/app_lock.json`
- Windows：`%USERPROFILE%\.murmur\app_lock.json`

这个文件里还有闲置时间和输错计数，没有明文密码。

## 忘记密码

1. 完全退出 Murmur（macOS：菜单栏 Murmur → 退出；Windows：关闭窗口，并确认任务管理器里没有 `etcli.exe`）。
2. 删除上面那个 `app_lock.json` 文件。
3. 重新打开 Murmur，应用锁就是关闭状态，聊天数据不受影响。之后可以在设置里重新设置密码。

没有其他重置方式，也没有隐藏的万能密码。能删除这个文件的人本来就能直接读取解密后的数据库，所以这不会削弱应用锁的保护范围。

## Touch ID

暂不支持。原因和后续方案：

- 现在的 Tauri 外壳（`app/src-tauri`）只用了 `tauri` 和 `tauri-plugin-log`，没有能调用 macOS LocalAuthentication 的插件。要接入需要新增 `objc2-local-authentication` / `block2` 一类的 Rust 依赖，或者打包一个 Swift 小程序。
- 更关键的是锁由 Python 后端执行。Touch ID 的结果必须以前端页面伪造不了的方式告诉后端，否则任何能访问 `127.0.0.1:9100` 的程序都能调用一个「生物识别已通过」接口来解锁。可行做法：Tauri 启动 etcli 时通过环境变量传一个随机令牌，Rust 侧验证 Touch ID 成功后直接用这个令牌调用后端解锁，令牌不经过网页。
- 这需要在已签名的正式包里实测（权限、签名、Windows Hello 对应实现），本次没有条件验证，所以先只做密码。
