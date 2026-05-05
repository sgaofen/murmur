---
name: 🐛 Bug 报告 / Bug report
about: 反馈一个具体的问题。**请务必带上诊断信息**，否则定位会非常慢。
title: ''
labels: bug
assignees: ''
---

## 问题描述

<!-- 一两句话说明：你做了什么 → 期待发生什么 → 实际发生了什么 -->



## 诊断信息（必填）

> **🟢 强烈推荐：** 在 Murmur 任意「出了点小问题」屏幕上点 **「📋 复制诊断信息（粘到 issue）」** 按钮，
> 然后直接粘到下面 ↓。会自动包含 version / 平台 / profiles / init_error / 日志末尾，已脱敏。
>
> 如果你看不到那个按钮（比如 Murmur 完全打不开），请手动提供：
> - Murmur 版本（在「关于」页或安装目录看 `Murmur.exe` 属性 → 详细信息 → 文件版本）
> - Windows / macOS 版本
> - 复制 `~/Documents/Murmur/logs/serve.log` 最后 30 行
> - 复制 `~/Documents/Murmur/logs/tauri-shell.log` 最后 30 行

```
<在这里粘上诊断信息>
```

## 截图（可选）

<!-- 如果是界面问题，截图非常有用 -->

## 你已经试过的（可选）

- [ ] 升级到[最新版本](https://github.com/sgaofen/murmur/releases)
- [ ] 重启 Murmur
- [ ] 删除 `~/Documents/Murmur/decrypted/` 整个目录后重走引导
- [ ] 在微信里点开聊天列表 + 几个对话 + 朋友圈，再让 Murmur 抓 key
