# macOS Release 下载后怎么打开

这份只讲一件事：从 GitHub Release 下载 `Murmur_..._aarch64.dmg` 后，怎么拖进「应用程序」，以及系统拦截时终端里运行什么。

正式公证版不需要终端命令。当前验证包如果出现 `"Murmur" Not Opened`，按下面做。

---

## 1. 下载 DMG

1. 打开 [GitHub Releases](https://github.com/sgaofen/murmur/releases/latest)。
2. 下载最新版本里的 `Murmur_..._aarch64.dmg`。
3. 下载完成后，通常会在「下载 / Downloads」文件夹里。

`aarch64` 是 M 系列 Mac 用的版本，包括 M1 / M2 / M3 / M4。

---

## 2. 打开 DMG

1. 双击下载好的 `Murmur_..._aarch64.dmg`。
2. 系统会打开一个新的 Finder 窗口，里面能看到 `Murmur.app`。
3. 不要直接在这个窗口里双击 `Murmur.app`。这个窗口只是安装盘。

---

## 3. 拖到「应用程序 / Applications」

最简单做法：

1. 保持 DMG 窗口开着。
2. 打开 Finder：点击 Dock 里蓝白笑脸图标。
3. 在 Finder 左侧边栏找到「应用程序」。
4. 把 DMG 窗口里的 `Murmur.app` 图标拖到左侧边栏的「应用程序」上。
5. 等复制完成。

如果左侧没有「应用程序」：

1. 点屏幕顶部菜单栏的「前往」。
2. 点「应用程序」，或按 `Command + Shift + A`。
3. 会打开「应用程序」文件夹。
4. 把 DMG 窗口里的 `Murmur.app` 拖进这个文件夹。

如果之前装过旧版本：

1. 先打开「应用程序」。
2. 删除旧的 `Murmur.app`。
3. 再把新的 `Murmur.app` 拖进去。

拖完以后，可以在 Finder 左侧把 `Murmur` 磁盘推出。

---

## 4. 先从「应用程序」打开一次

1. 打开 Finder。
2. 进入「应用程序」。
3. 双击 `Murmur.app`。

如果能打开，就继续跟着 Murmur 里面的 onboarding 走。

如果弹窗写着 `"Murmur" Not Opened`，并且只有 `Done` / `Move to Trash`：

1. 点 `Done`。
2. 不要点 `Move to Trash`。
3. 继续看下一步。

---

## 5. 打开终端

打开 Terminal 的方法：

1. 按 `Command + Space`。
2. 输入 `Terminal`，或者输入 `终端`。
3. 按回车。

会出现一个白色或黑色的命令窗口。

---

## 6. 粘贴这两行命令

把下面整段复制到终端里，按回车：

```bash
xattr -dr com.apple.quarantine /Applications/Murmur.app
open /Applications/Murmur.app
```

第一行是移除 GitHub 下载文件上的隔离标记。第二行是打开 Murmur。

如果终端提示：

```text
No such file: /Applications/Murmur.app
```

说明 Murmur 还没有拖进「应用程序」，或者名字不叫 `Murmur.app`。回到第 3 步重新拖一次。

---

## 7. 后续启动

以后打开 Murmur：

1. 打开 Finder。
2. 进入「应用程序」。
3. 双击 `Murmur`。

也可以按 `Command + Space`，输入 `Murmur`，回车打开。

---

## 8. 接下来做什么

Murmur 打开后，会继续引导你完成：

1. 给 Murmur 完全磁盘访问。
2. 给 WeChat 做一次重签名。
3. 回 WeChat 点开几个聊天和朋友圈。
4. 回 Murmur 自动抓取并解密。

完整流程见 [macOS 上手指南](ONBOARDING_MAC.md)。
