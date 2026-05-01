# macOS 上手指南

> 当前 Mac 上 Murmur 不能从微信内存抓密钥（SIP 限制）。但**解密/分析/可视化全能用** —— 你需要从 Win 拷一份密钥过来。

---

## 路径 A：从 Win 已经跑过 Murmur（最简单）

如果你在 Win 上跑过 Murmur，你的 Win 上已经有：
- 解密好的数据库 `~/Documents/Murmur/decrypted/wxid_xxx/`

**直接拷过来**：
```bash
# 在 Mac 上
mkdir -p ~/Documents/Murmur/
# 用 USB / Airdrop / 网盘把 Win 上的 ~/Documents/Murmur/decrypted/ 整个目录拷到 Mac 同位置
```

然后 `bash start-mac.sh` —— 直接进主界面。Mac 上能用 100% 功能（图、AI 分析、双人年代记）。

---

## 路径 B：只在 Mac 上、想自己解密

**需要：** 64 位 SQLCipher 密钥（hex）。

Mac 自己抓 key 比较折腾（要关 SIP + lldb），现实方案是借一台 Win 临时抓一次。

### 方案 B1：用 Win 抓 key，Mac 用

1. 在任意一台 Win 上：
   ```powershell
   git clone https://github.com/sgaofen/murmur.git
   cd murmur\cli
   python extract_key_dll.py --auto-restart
   ```
   会输出 64-hex 密钥，复制下来。

2. Mac 上启动 Murmur，第一次会弹「Mac 粘贴密钥」窗口 —— 把密钥粘进去
3. 自动用纯 Python 实现解密所有库到 `~/Documents/Murmur/decrypted/`
4. 进入主界面

### 方案 B2：直接用 Mac WeChat 内存抓（高级）

需要：
- 关闭 SIP（recovery mode → `csrutil disable`）
- `task_for_pid` 权限
- `lldb` 附加 WeChat 进程扫内存

文档稍后补。绝大多数人走方案 B1 更快。

---

## 装依赖

```bash
brew install python@3.11 node ffmpeg
pip3 install -r requirements.txt
```

可选 AI：
```bash
npm install -g @anthropic-ai/claude-code
# 或
npm install -g @openai/codex
```

---

## 启动

```bash
cd murmur
bash start-mac.sh
```

第一次会自动 `npm install` + `pip install`。约 1 分钟。

---

## 数据存哪（同 Win）

- `~/Documents/Murmur/decrypted/`
- `~/Desktop/Murmur/agent_reports/`
- `~/.murmur/config.json`

---

## Mac 限制

| 功能 | Win | Mac |
|---|---|---|
| 自动抓微信内存密钥 | ✅ | ❌（用 B1）|
| 解密数据库 | ✅ | ✅（纯 Python）|
| 浏览/分析 | ✅ | ✅ |
| AI 关系档案 | ✅ | ✅ |
| 图片解密（V4-V2）| ⚠ 阻塞 | ⚠ 阻塞 |
| 语音转写 | ✅ | ✅ |
| 关系图 3D | ✅ | ✅ |

剩下的 1% 差异都在抓 key 这一步，过了之后体验完全一致。
