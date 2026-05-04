# Murmur v0.2.18

## 下载

Windows 用户：

- 推荐下载：`Murmur_0.2.18_x64-setup.exe`
- 备用：`Murmur_0.2.18_x64_en-US.msi`

Mac 用户：

- Apple Silicon Mac 下载：`Murmur_macOS_AppleSilicon.dmg`
- 备用排错文件：`Murmur_macOS_AppleSilicon.app.zip`

## 这版修了什么

- Mac 找不到微信数据时，不再只显示「知道了」；现在可以重新检测、打开完全磁盘访问设置，或者直接粘贴微信数据目录。
- 手动保存微信数据路径后，即使处在受限扫描/排错模式，也会立刻加入检测范围。
- 修复 Mac codesign 检测：`adhoc,runtime` 这类签名现在会被正确识别为 hardened runtime，避免误判成可以直接抓密钥。

## 安装教程

- README 里保留最新下载链接和 Mac / Windows 视频教程。
- Mac 由于没有 Apple 公证，第一次打开仍需要按 README 放行。
