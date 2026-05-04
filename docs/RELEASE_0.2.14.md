# Murmur v0.2.14

## 下载

Windows 用户：

- 推荐下载：`Murmur_0.2.14_x64-setup.exe`
- 备用：`Murmur_0.2.14_x64_en-US.msi`

Mac 用户：

- Apple Silicon Mac 下载：`Murmur_macOS_AppleSilicon.dmg`
- 备用：`Murmur_macOS_AppleSilicon.app.zip`

## 本版修复

- Windows 增加 `Tencent/Weixin/xwechat_files`、`Tencent/WeChat/xwechat_files` 等常见嵌套目录扫描。
- 如果自动扫描不到微信数据，引导页现在可以直接粘贴微信「文件管理」里的路径。
- `bootstrap mode` 不再误报为「后端没起来」。
- 手动双击打包后的 `etcli.exe` 时会启动本地服务，不再只显示 usage 后退出。
- Windows hook 安装失败时，会提示杀软白名单、权限等级和 `wx_key.dll` 排查方法。
- Mac 重签名失败时，会更明确地区分系统授权取消、权限拦截和普通 codesign 失败。

## Windows 安装

1. 下载 `Murmur_0.2.14_x64-setup.exe`。
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
