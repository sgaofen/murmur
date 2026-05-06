# Murmur 微语

把多年微信聊天和朋友圈，在你电脑上做成一张可以**旋转、缩放、聚焦**的 3D 关系网，再让本地的 Claude / Codex 给每个朋友写一份关系档案。

100% 本地分析，不上云。Windows 内置 QQ NT 解密。

[下载最新版](https://github.com/sgaofen/murmur/releases/latest)

当前推荐版本：`v0.3.17`

![Murmur 关系网总览](docs/screenshots/readme-graph-overview.png)

## 它能做什么

- **3D 关系网**：自己在中心，朋友按亲密度散布周围。同一个核心圈的人会落在同一片区域，球面整体保留壮观的星空感。
- **核心圈聚焦**：右下角点「N 个核心圈」→ 列表里选一个 → **半透明 3D 包络**贴合包裹该圈成员，圈外的人和连线全部变暗。一眼看清谁和谁是一伙的。
- **点人看档案**：点任意节点 → 右侧弹出关系详情。私聊 / 群聊 / 朋友圈互动，每年沟通频率，有没有沉默后重连，全是离线就能算的硬证据。
- **AI 关系报告**：让本机的 Claude Code 或 Codex CLI 给每个朋友、每对朋友写一份关系分析。Murmur 把脱敏的样本和 prompt 整理好直接喂给 CLI，不上云。
- **隐私模式**：右下一键切，所有真名变「朋友 XX」「群 1」，wxid 和本机路径都隐藏。录视频 / 截图发朋友圈不用反复打码。
- **QQ NT 支持**：Windows 版顶栏可以加 QQ 账号，独立解密 + 独立分析。

## 关系网视觉

**关系网默认视图** — 98 个朋友、154 条朋友间互连。每个圈的成员相邻分布，但整张图仍是一个壮观的球面。

![默认视图](docs/screenshots/readme-graph-overview.png)

**核心圈聚焦** — 点击右下角「N 个核心圈」选一个，半透明 3D 包络贴合包住该圈所有成员，球外的人和连线降到几乎不可见。包络形状跟成员实际分布贴合，不是硬圆。

![核心圈聚焦](docs/screenshots/readme-graph-circle.png)

**点人看关系** — 点任意节点弹出右侧详情面板，显示私聊数、跨度、最近活跃，以及通往 ta 的所有连线。

![选中朋友](docs/screenshots/readme-graph-friend.png)

## 单人档案页

每位朋友有一份独立档案：人物介绍、AI 摘要、离线证据、共同回忆相册、定整个对话搜索。关系层级（A 老朋友 / B 常聊 / C 有联系 / D 弱联系 / E 已疏远）由本地算法基于持续年限、电话次数、朋友圈互动等离线证据自动判定。

![单人档案](docs/screenshots/readme-friend.png)

## AI 关系档案

Murmur 把每个朋友的样本消息 + 离线证据 + 评估准则 (prompt) 打包，让本机的 Claude Code 或 Codex 出一份长文分析。报告里会评估关系定性（B+ / A- / 老朋友级…），列时间持续性、沉默后重连、表达密度等具体证据。

![AI 关系档案](docs/screenshots/readme-report.png)

报告默认存到：

```text
~/Desktop/Murmur/agent_reports/
```

## 下载哪个文件

Windows 用户：

- 推荐：`Murmur_0.3.17_x64-setup.exe`
- 备用：`Murmur_0.3.17_x64_en-US.msi`

Mac 用户：

- Apple Silicon Mac：`Murmur_macOS_AppleSilicon.dmg`
- 备用排错文件：`Murmur_macOS_AppleSilicon.app.zip`

Intel Mac 暂时没有安装包，需要从源码运行。

## 视频教程

- [Mac 安装视频](https://github.com/sgaofen/murmur/releases/download/v0.3.17/Murmur_macOS_install_tutorial.mp4)
- [Windows 微信安装视频](https://github.com/sgaofen/murmur/releases/download/v0.3.17/Murmur_Windows_install_tutorial.mp4)
- [Windows QQ 安装视频](https://github.com/sgaofen/murmur/releases/download/v0.3.17/Murmur_QQ_install_tutorial.mp4)

## Windows 安装（微信）

1. 双击 `Murmur_0.3.17_x64-setup.exe`，按引导装。
2. 打开微信，**退出登录回到登录页，但不要关闭微信进程**。
3. 打开 Murmur，点「开始抓密钥」。
4. 看到等待提示后，回微信扫码登录一次。
5. 抓到 key → 自动解密 → 进入关系网。

如果杀毒软件拦截 `wx_key.dll`：把 Murmur 安装目录加白名单后重新安装。

## Windows 安装（QQ）

走完微信流程后，顶栏点「+ 添加新账号 → 🐧 QQ」（或 Welcome 页底部「🐧 切换到 QQ」）。具体见 QQ 安装视频。

## Mac 安装

1. 双击 `Murmur_macOS_AppleSilicon.dmg`。
2. 把 `Murmur.app` 拖到「应用程序」。
3. **不要直接在 dmg 窗口里运行**，要从「应用程序」打开。
4. 第一次打开如果被 Gatekeeper 拦：「系统设置 → 隐私与安全性」滚到底部点「仍要打开」。

如果完全没有「仍要打开」按钮，开 Terminal：

```bash
xattr -dr com.apple.quarantine /Applications/Murmur.app
open /Applications/Murmur.app
```

首次使用时 Murmur 会引导你：

1. 给 Murmur「完全磁盘访问」权限。
2. 重启 Murmur。
3. 按按钮给 WeChat 重签名（一次性）。
4. 回 WeChat 点开 3-5 个私聊 + 翻一下朋友圈。
5. 回 Murmur 点「开始自动抓取」。
6. 等待解密完成 → 进入关系网。

## AI 分析使用

报告页（顶部）选：

- 小样本自检（先验证几个人）
- Top 朋友 + Top 关系
- 全部朋友 + 朋友间关系
- 只补朋友间关系报告

并行数和引擎（Claude / Codex / 双跑）可以在面板里设。

## 隐私模式

右下角「🔓 隐私模式：关 / 🔒 隐私模式：开」一键切。开启后会隐藏：

- 朋友昵称、群名（变「朋友 XX」「群 N」）
- wxid、chatroom id
- 本机路径
- 邮箱、手机号样式文本
- 64 位 hex key 字符串

录视频 / 公开截图前点一下，不用反复手动打码。

## 遇到问题

`~/Documents/Murmur/logs/` 下有 `serve.log` 和 `tauri-shell.log`，涵盖后端启动 / 解密失败 / 抓 key 失败的细节。

任何「出了点小问题」屏幕上都有 **「📋 复制诊断信息（粘到 issue）」** 按钮，会自动打包脱敏的版本号 / 平台 / profiles / init_error / 日志末尾，直接粘到 [GitHub issue](https://github.com/sgaofen/murmur/issues/new) 即可。

## 隐私 / 数据流向

- 所有解密、分析、可视化 **100% 本地**，无任何网络上传
- AI 报告由你本机已登录的 Claude Code / Codex CLI 生成（这俩 CLI 自己会调云，但 Murmur 把样本脱敏后才喂给它们）
- 抓密钥仅在初始化时一次，之后不再 attach 微信 / QQ 进程
- 解密数据放在 `~/Documents/Murmur/decrypted/`，可随时手动删除
