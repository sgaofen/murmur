# MCP 服务：让 Claude Code / Codex 直接读你的聊天数据

`etcli mcp` 会启动一个 [MCP](https://modelcontextprotocol.io)（Model Context Protocol）服务，让本机的 AI 助手（Claude Code、Codex CLI、Claude Desktop、Cursor 等支持 MCP 的客户端）**只读**地查询 Murmur 已经解密好的微信数据：找人、翻聊天记录、搜关键词、看统计和年度总结。

- 走 stdio：客户端把 `etcli mcp` 当子进程拉起来，通过标准输入输出通信，**不开任何网络端口**。
- 只读：数据库以 `mode=ro&immutable=1` 打开；Murmur App 的分析缓存只读不写。
- 不需要额外依赖：协议部分只用 Python 标准库。
- 前提：先在 Murmur App 里完成过一次解密（`~/Documents/Murmur/decrypted/<账号>/` 下有 `session.db`）。

> ⚠️ 隐私提醒：接入后，AI 助手读到的聊天内容会发给对应的模型服务商（Anthropic / OpenAI 等）。只在你愿意的时候接入，不需要时删掉配置即可。介意真名的话加 `--privacy`（见下文）。

---

## 1. 找到 etcli

| 场景 | 命令 |
|---|---|
| 源码运行（推荐开发者） | `python3 /path/to/murmur/cli/etcli.py mcp` |
| macOS 打包版 | `/Applications/Murmur.app/Contents/Resources/etcli/etcli mcp` |
| Windows 打包版 | `"%LOCALAPPDATA%\Murmur\etcli\etcli.exe" mcp`（默认的按用户安装位置；如果装在别处，就是安装目录下的 `etcli\etcli.exe`） |

源码运行时需要先 `pip install -r requirements.txt`（主要是 `zstandard`：微信 4.x 有不少文字消息是 zstd 压缩的，没装的话这些消息会显示为空）。打包版已经内置。

先在终端里试一下能不能起来（会停在那里等输入，`Ctrl+C` 退出）：

```bash
python3 /path/to/murmur/cli/etcli.py mcp
# stderr 打印：[mcp] Murmur MCP server ready (stdio, privacy=off, max_rows=500)
```

### 参数

| 参数 | 说明 |
|---|---|
| `--data-dir <目录>` | 指定解密数据目录（里面有 `session.db`）。不填就和 App 一样自动找；也可以用环境变量 `ETCLI_DATA_DIR`。多账号时用它选账号。 |
| `--privacy` | 隐私模式：名字、wxid、微信号、手机号、邮箱、身份证/银行卡号等脱敏后再交给 AI（规则见下）。 |
| `--max-rows <N>` | 单次调用最多返回多少条，默认 500。 |

---

## 2. 接到 Claude Code

```bash
# 源码版
claude mcp add murmur -- python3 /path/to/murmur/cli/etcli.py mcp

# 隐私模式
claude mcp add murmur -- python3 /path/to/murmur/cli/etcli.py mcp --privacy

# macOS 打包版
claude mcp add murmur -- /Applications/Murmur.app/Contents/Resources/etcli/etcli mcp

# 想在所有项目里都能用，加 --scope user
claude mcp add --scope user murmur -- python3 /path/to/murmur/cli/etcli.py mcp
```

`--` 后面的内容原样作为启动命令，所以 `--privacy`、`--data-dir` 要写在 `--` 之后。

装好后在 Claude Code 里输入 `/mcp` 能看到 `murmur` 和 7 个工具。删掉：`claude mcp remove murmur`。

## 3. 接到 Codex CLI

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.murmur]
command = "python3"
args = ["/path/to/murmur/cli/etcli.py", "mcp"]
# 隐私模式：args = ["/path/to/murmur/cli/etcli.py", "mcp", "--privacy"]
# 全库搜索可能要几十秒，适当放宽超时：
tool_timeout_sec = 120

# macOS 打包版写法：
# [mcp_servers.murmur]
# command = "/Applications/Murmur.app/Contents/Resources/etcli/etcli"
# args = ["mcp"]
```

Windows 下 `command` 写 `etcli.exe` 的完整路径，反斜杠要转义（`"C:\\Users\\you\\AppData\\Local\\Murmur\\etcli\\etcli.exe"`）或者改用正斜杠。

也可以用命令添加：`codex mcp add murmur -- python3 /path/to/murmur/cli/etcli.py mcp`。

## 4. 其他客户端（Claude Desktop / Cursor 等）

大多数客户端用同一种 JSON 配置：

```json
{
  "mcpServers": {
    "murmur": {
      "command": "python3",
      "args": ["/path/to/murmur/cli/etcli.py", "mcp", "--privacy"]
    }
  }
}
```

---

## 5. 工具一览

所有工具都是只读的（`readOnlyHint: true`）。`who` / `chat` 参数可以填 wxid、备注、昵称或微信号片段；匹配到多个人时取消息最多的那个。时间一律按北京时间（UTC+8），格式 `YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM`，`until` 只写日期时包含当天全天。

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `list_contacts` | 联系人列表，可按名字过滤、按聊天量排序 | `query`、`kind`（all/friends/private/groups）、`sort`（messages/recent/name）、`min_messages`、`limit`、`offset` |
| `list_chats` | 会话列表（默认最近活跃在前），带消息数和最后一条摘要 | `query`、`kind`、`sort`（recent/messages）、`include_empty`、`limit`、`offset` |
| `get_messages` | 读某个会话的消息，支持时间范围和分页 | `chat`（必填）、`since`、`until`、`order`（desc=从最新往前翻，asc=从最早开始）、`text_only`、`limit`、`offset` |
| `search_messages` | 关键词搜文字消息（不区分大小写），可限定会话、时间 | `keyword`（必填）、`chat`、`since`、`until`、`limit`（≤200） |
| `get_friend_stats` | 某人/群的统计：消息数、谁说得多、时段/星期/年份分布 | `who`（必填）、`detail`（basic / full：完整本地分析，含主动发起、回复速度、沉默期、高频词） |
| `get_relationship_evidence` | 关系信号（线下见面、倾诉、互相关心、冲突修复、通话、朋友圈互动等）+ 采样原文；填 `other` 时查两人之间的直接证据（同群不算） | `who`（必填）、`other`、`sample` |
| `get_annual_summary` | 某年的全局年度总结：总量、聊得最多的人、每月冠军、最忙的一天、连续聊天、深夜之王、口头禅、渐行渐远的人等 | `year`（默认有数据的最近一年）、`top_n` |

分页类工具返回 `total` / `offset` / `next_offset`，`next_offset` 为 `null` 表示已经到底。

`search_messages` 目前是逐个会话扫描解密后的文字（和 `etcli search` 一样），全库搜索在大账号上可能较慢，超过 60 秒会返回已找到的部分并标记 `time_budget_exceeded: true`。限定 `chat` 或 `since/until` 会快很多。之后全局搜索索引合并后会切换过去。

---

## 6. 隐私模式（`--privacy`）

规则跟 App 里「隐私模式」一致（`app/src/utils/privacy.ts` 的 Python 移植），同一个人在截图和 AI 回答里是同一个代号：

- 好友名 → `朋友 XY`，群名 → `群 N`，自己 → `你`；
- wxid / 老账号 username / 微信号 → `wxid_NNNN`，群 id → `group_NNN`；
- 消息正文里出现的好友名、wxid、手机号、邮箱、身份证号、银行卡号、本机路径、64 位 key 一并替换；
- 时间戳不动。

和前端的差别（都是为了让 AI 能把代号再传回来查询）：

- 脱敏后的 id 如果撞了，会加 `~2`、`~3` 后缀保证唯一；
- AI 可以直接拿 `wxid_1801`、`group_613` 或 `朋友 WL` 当 `who` / `chat` 参数（`朋友 XY` 只有 676 种组合，重名时会提示改用 `wxid_NNNN`）；
- 非 `wxid_` 开头的老账号 username、微信号也会脱敏；整段字段就是名字时，1 个字的名字也会替换。

隐私模式是**尽力而为**：没在你通讯录里的第三方人名（比如聊天里提到的「我妈」「小李」）不一定能识别；图片、语音本来就不会返回。

---

## 7. 示例对话

> **你**：我和谁聊得最多？列前 5 个。
>
> *Claude 调用* `list_contacts {"kind": "private", "sort": "messages", "limit": 5}`
>
> **Claude**：按私聊消息数，前五是：爱丽丝（12,408 条）、老王头（6,032 条）……

> **你**：去年我和爱丽丝都聊了些什么？有没有约过见面？
>
> *Claude 调用* `get_relationship_evidence {"who": "爱丽丝", "sample": 30}`，再调用 `search_messages {"keyword": "见面", "chat": "爱丽丝", "since": "2025-01-01", "until": "2025-12-31"}`
>
> **Claude**：2025 年你们一共 3,120 条消息，线下证据 14 处，比如 3 月 9 日「周末一起打羽毛球吧」……

> **你**：帮我看看 2025 年的年度总结，写成一段朋友圈文案。
>
> *Claude 调用* `get_annual_summary {"year": 2025}`

> **你**：把 10 月 1 日羽毛球群里的聊天翻出来。
>
> *Claude 调用* `get_messages {"chat": "羽毛球群", "since": "2025-10-01", "until": "2025-10-01", "order": "asc"}`

---

## 8. 常见问题

- **工具调用返回「找不到 Murmur 解密后的数据目录」**：先在 App 里完成解密；或者在命令里加 `--data-dir`。服务本身照常启动，修好后不用重启客户端，下一次调用会重新查找。
- **macOS 上第一次调用卡住或报权限错误**：数据在 `~/Documents` 下，系统可能弹窗询问终端 / Claude Code 是否允许访问「文稿」文件夹，点允许；或者在「系统设置 → 隐私与安全性 → 文件与文件夹」里给终端开权限。
- **Windows 上打开 Murmur App 后 MCP 断了**：App 启动时会结束残留的 `etcli.exe` 进程，正在运行的 MCP 服务也会被结束。在客户端里重连一次即可（Claude Code：`/mcp` → reconnect）。
- **重新解密后数据没更新**：MCP 进程会缓存消息索引，重启客户端（或重连 MCP）即可。
- **想看协议交互**：stderr 是日志，stdout 只有 JSON-RPC 消息。可以手动试：

  ```bash
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_chats","arguments":{"limit":3}}}' \
  | python3 cli/etcli.py mcp
  ```

## 9. 协议说明（给开发者）

- 传输：stdio，每行一条 JSON-RPC 2.0 消息，输出全部是 ASCII（中文以 `\uXXXX` 转义）。
- 协议版本：同时支持最新的 `2026-07-28`（每个请求在 `_meta` 里带 `io.modelcontextprotocol/protocolVersion`，无握手，支持 `server/discover`）和旧的握手式版本 `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05`（`initialize` → `notifications/initialized`）。
- 方法：`initialize`、`server/discover`、`ping`、`tools/list`、`tools/call`。未知方法返回 `-32601`，未知工具返回 `-32602`；参数校验失败、找不到人等以 `isError: true` 的工具结果返回，方便模型自己改参数重试。
- 工具结果同时给 `structuredContent`（JSON 对象）和一段等价的 JSON 文本。
- 代码：`cli/mcp_server.py`；测试：`tests/test_mcp_server.py`。
