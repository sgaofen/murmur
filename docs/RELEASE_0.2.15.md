# Murmur v0.2.15

## 下载

Windows 用户：

- 推荐下载：`Murmur_0.2.15_x64-setup.exe`
- 备用：`Murmur_0.2.15_x64_en-US.msi`

Mac 用户：

- Apple Silicon Mac 下载：`Murmur_macOS_AppleSilicon.dmg`
- 备用：`Murmur_macOS_AppleSilicon.app.zip`

## 本版修复

- Windows 如果已经安装 Everything 的 `es.exe` 命令行工具，会自动借用 Everything 索引快速发现 `xwechat_files` / `db_storage`。
- 保留 v0.2.14 的自定义微信数据路径粘贴兜底：自动扫描不到时，按引导打开微信「设置 → 文件管理 → 打开文件夹」，把路径粘进 Murmur。
- 保留 v0.2.14 的 Windows hook 失败提示、bootstrap 误报修复、Mac 重签名错误说明。

## Windows 安装

1. 下载 `Murmur_0.2.15_x64-setup.exe`。
2. 双击安装。
3. 打开微信，退出到登录页，但不要关闭微信程序。
4. 打开 Murmur，按引导点击「开始抓密钥」。
5. 看到等待登录事件后，回微信扫码或自动登录一次。
6. 抓到 key 后会自动解密，然后进入主界面。

如果提示杀毒软件拦截 `wx_key.dll`，把 Murmur 安装目录加入杀毒软件白名单，然后重新安装再试。

## Mac 安装

1. 下载 `Murmur_macOS_AppleSilicon.dmg`。
2. 双击打开 dmg。
3. 把里面的 `Murmur.app` 拖到「应用程序」。
4. 不要直接在 dmg 窗口里运行。
5. 从「应用程序」里打开 Murmur。

如果 macOS 提示无法打开，先点「完成 / Done」，再到「系统设置 → 隐私与安全性」底部点「仍要打开 / Open Anyway」。
