# Murmur v0.2.12

## 下载

Windows 用户：

- 推荐下载：`Murmur_0.2.12_x64-setup.exe`
- 备用：`Murmur_0.2.12_x64_en-US.msi`

Mac 用户：

- Apple Silicon Mac 下载：`Murmur_macOS_AppleSilicon.dmg`
- 备用：`Murmur_macOS_AppleSilicon.app.zip`

Intel Mac 暂时没有安装包，需要从源码运行。

## Windows 安装

1. 下载 `Murmur_0.2.12_x64-setup.exe`。
2. 双击安装。
3. 从桌面或开始菜单打开 Murmur。
4. 打开微信，退出到登录页，但不要关闭微信程序。
5. 回 Murmur，按引导点击「开始抓密钥」。
6. 看到等待登录事件后，回微信扫码或自动登录一次。
7. 抓到 key 后会自动解密，然后进入主界面。

如果提示杀毒软件拦截 `wx_key.dll`，把 Murmur 安装目录加入杀毒软件白名单，然后重新安装再试。

## Mac 安装

1. 下载 `Murmur_macOS_AppleSilicon.dmg`。
2. 双击打开 dmg。
3. 把里面的 `Murmur.app` 拖到「应用程序」。
4. 不要直接在 dmg 窗口里运行。
5. 从「应用程序」里打开 Murmur。

如果 macOS 提示无法打开：

1. 先点「完成 / Done」，不要点「移到废纸篓」。
2. 打开「系统设置」。
3. 进入「隐私与安全性」。
4. 滚到底部，点击「仍要打开 / Open Anyway」。
5. 再次打开 Murmur。

如果没有「仍要打开」，打开 Terminal，运行：

```bash
xattr -dr com.apple.quarantine /Applications/Murmur.app
open /Applications/Murmur.app
```

首次使用 Mac 版时，Murmur 会继续引导你：

1. 给 Murmur「完全磁盘访问」权限。
2. 重启 Murmur。
3. 按按钮给 WeChat 重签名。
4. 回 WeChat 点开 3-5 个私聊，再翻一下朋友圈。
5. 回 Murmur 点「开始自动抓取」。
6. 等待解密完成后进入主界面。
