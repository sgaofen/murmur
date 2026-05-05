# Murmur v0.3.8 — Mac package polish for v0.3.7

## 下载

Windows 用户：

- 推荐下载：`Murmur_0.3.8_x64-setup.exe`
- 备用：`Murmur_0.3.8_x64_en-US.msi`

Mac 用户：

- Apple Silicon Mac 下载：`Murmur_macOS_AppleSilicon.dmg`
- 备用排错文件：`Murmur_macOS_AppleSilicon.app.zip`

## 这版修了什么

- 基于 v0.3.7 的 QQ NT / 多账号 / 微信路径修复继续发布。
- 修复启动后 `/api/profiles` 里当前微信账号没有被标记为 active 的问题。
- 修复多微信账号切换时后端可能加载默认账号、而不是用户点击账号的问题。
- Mac 上点击 QQ 导入时明确提示「QQ 导入目前只支持 Windows」，避免误导用户以为 Mac QQ 已经可抓 key。
- 没有账号时顶栏显示「添加账号」，不再直接诱导 Mac 用户进入 QQ 引导。
- README 和包内版本号统一到 v0.3.8。

## 平台说明

- Windows：微信 + QQ NT。
- macOS Apple Silicon：微信；QQ for Mac 适配还在开发中。
- Intel Mac：暂时没有安装包，需要源码运行。
