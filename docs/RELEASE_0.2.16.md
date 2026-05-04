# Murmur v0.2.16

## 下载

Windows 用户：

- 推荐下载：`Murmur_0.2.16_x64-setup.exe`
- 备用：`Murmur_0.2.16_x64_en-US.msi`

Mac 用户：

- Apple Silicon Mac 下载：`Murmur_macOS_AppleSilicon.dmg`（待发布）
- 备用：`Murmur_macOS_AppleSilicon.app.zip`（待发布）

Intel Mac 暂时没有安装包，需要从源码运行。

## 这版重点（基于 v0.2.15）

### 「找不到微信数据」时的体验大改

之前在非常规路径上装了微信的用户会卡在 onboarding 那一步，因为 Murmur 默认只扫盘符根、Documents、OneDrive、注册表登记的位置。这版补两条路：

**1. 一键全盘扫描（推荐路径）**

新页面提供「🔎 全盘扫描微信数据」按钮。点了之后 Murmur 用名字匹配 + 智能剪枝扫所有本地盘（跳过 Windows、Program Files、$Recycle.Bin、node_modules、.git、缓存目录等明显无关位置）。**实测一台典型 Win11 + 2 个盘 5700 个目录的机器上 1.5 秒完成**——比 Everything 慢，但比 v0.2.15 那种"如果你装了 Everything 才能用"快得多。**不读文件内容，不需要管理员权限**。扫到几个候选后直接列出来，点哪个用哪个，无需手动复制粘贴。

**2. 手动输入路径变得超级"包容"**

`/api/wechat-root` 后端加了输入归一化，以下任意一种粘贴格式都会被自动识别成正确的层级：

- `D:\Tencent\Weixin\xwechat_files`
- `…\xwechat_files\wxid_xxx`
- **`…\xwechat_files\wxid_xxx\db_storage`**（最常见的"多复制了一层"错误，现在自动 strip 掉）
- `…\db_storage\session\session.db`（直接粘文件路径也能用）
- 任意 wxid_* 子树里的子路径，都会自动往上找到 wxid_* 那层

之前用户多带 / 少带一层就 100% 失败。现在容错很宽。

输入页面也改写了引导：图文 4 步教你怎么从微信「设置 → 文件管理 → 打开文件夹」拿到正确路径。

### 嵌套目录支持

某些 WeChat 4.x 安装会把数据放成 `xwechat_files/xwechat_files/wxid_xxx`（双层 `xwechat_files` 嵌套，不是文档化的单层）。`discover_wechat_profiles` 现在会自动多走一层去找 `wxid_*`，覆盖这种安装。

## Windows 安装

1. 下载 `Murmur_0.2.16_x64-setup.exe`。
2. 双击安装。
3. 从桌面或开始菜单打开 Murmur。
4. 如果 onboarding 提示「没找到微信数据」：
   - 点「🔎 全盘扫描微信数据」(通常 30 秒以内出结果)
   - 或者点「✍ 我知道路径，手动输入」按引导粘
5. 找到数据后按引导抓密钥 → 解密 → 进主界面。

如果提示杀毒软件拦截 `wx_key.dll`，把 Murmur 安装目录加入杀毒软件白名单，然后重新安装再试。

## Mac 安装

参见 v0.2.15 release notes。这版没改动 Mac onboarding 路径。

## 隐私

解密、统计和本地浏览都在你的电脑上完成。只有你主动点击 AI 分析时，样本才会交给本机已登录的 Claude Code / Codex CLI。**全盘扫描只比对目录名（xwechat_files / wxid_*），不读文件内容**。
