# 全局消息搜索接口

后端实现：`cli/search_index.py`；HTTP 路由在 `cli/etcli.py`；前端类型和函数在 `app/src/data/api.ts`（`searchMessages` / `getSearchStatus` / `rebuildSearchIndex`）。搜索页面留给 UI-3 做。

## 索引

- 每个账号一个索引文件：`~/Documents/Murmur/search_index/<platform>-<账号目录名>.sqlite`（开发时可用环境变量 `MURMUR_SEARCH_INDEX_DIR` 改位置）。**不写入微信 / QQ 的解密库。**
- 支持 FTS5 trigram 的 SQLite（3.34+）用 `fts5_trigram` 模式；不支持时自动退化为 `like` 模式（逐条 LIKE 匹配，结果一样，只是慢）。当前模式在所有接口的 `mode` 字段里。
- trigram 需要每个词至少 3 个字才能走索引。1–2 个字的词（比如「晚饭」）在两种模式下都走 LIKE，结果完整但较慢；返回里的 `match` 字段说明本次用了哪种（`fts` / `like` / `fts+like`）。
- 索引内容：文字消息、引用/链接/文件等 appmsg 的标题和摘要（和聊天抽屉里看到的文字一致）。纯占位的图片、语音、表情等（`[image]`、`[图片]`）不进索引。
- 增量规则：按库文件的 mtime + 大小判断是否变化；变化的文件只读取 `local_id`（QQ 为 `rowid`）大于上次进度的行。若某张表被整体替换（最大 id 变小，或进度点那一行的时间变了），清掉该表重新建。已入索引的消息被编辑/撤回不会增量更新，需要「重建」。
- 触发时机：
  - `POST /api/refresh` 解密成功后，后台跑一次增量（第一次就是全量）；
  - `GET /api/search` 和 `GET /api/search/status` 发现库文件有变化时，后台自动开始增量（不阻塞本次请求）；
  - `POST /api/search/rebuild` 全量重建。
- QQ NT 也支持（平台跟随当前激活账号）。QQ 解密完成后不会立刻建索引，而是在下次调用搜索 / 状态接口时自动开始。

## GET /api/search

参数：

| 参数 | 说明 |
|---|---|
| `q` | 必填。空格分隔多个词，全部命中才算（AND），最多 8 个词。英文不区分大小写。`%`、`_` 按字面匹配。 |
| `chat` | 会话 username，可逗号分隔多个（`wxid_xxx`、`xxx@chatroom`、QQ uid）。 |
| `sender` | 发送者，可逗号分隔：`self` 表示自己，其他为 wxid / QQ uid。私聊里对方发的消息，sender 就是会话 username。 |
| `from` / `to` | unix 秒，或 `YYYY-MM-DD`（`YYYY-MM-DD HH:MM`），按北京时间。只写日期的 `to` 包含当天。 |
| `type` | 消息类型，可逗号分隔：标签（`text`、`share`…）或数字（`1`、`49`…）。 |
| `limit` / `offset` | 分页，`limit` 1–200，默认 50。按时间倒序。 |

返回：

```json
{
  "query": "吃晚饭", "terms": ["吃晚饭"], "mode": "fts5_trigram", "match": "fts",
  "total": 3, "limit": 50, "offset": 0,
  "results": [{
    "platform": "wechat", "chat": "wxid_alice", "chat_name": "爱丽丝", "is_group": false,
    "sender": "wxid_alice", "sender_name": "爱丽丝",
    "ts": 1716192000, "time": "2024-05-20T16:00:00+08:00", "type": "text", "type_code": 1,
    "snippet": "生日快乐🎂一起吃晚饭",
    "segments": [{"text": "生日快乐🎂一起", "hit": false}, {"text": "吃晚饭", "hit": true}],
    "highlights": [[8, 11]],
    "locator": {"db": "message_1.db", "table": "Msg_…", "local_id": 1, "server_id": "123…"}
  }],
  "index": { "...": "同 /api/search/status" }
}
```

- `highlights` 是 `snippet` 里的 **UTF-16 偏移**（直接对应 JS 字符串下标）。也可以直接用 `segments` 渲染。
- `locator` 用于以后在聊天页定位原消息：微信是 `message_N.db` + `Msg_<md5(username)>` + `local_id`，QQ 是 `nt_msg.db` + `c2c_msg_table`/`group_msg_table` + `rowid`。`server_id`（QQ 为 `40001` msg id）用字符串返回，避免 JS 丢精度。
- 索引还在建时也能搜，只是结果不全；`index.state` 为 `building`。
- `q` 为空或日期格式错误返回 400。

## GET /api/search/status

```json
{
  "platform": "wechat", "account": "wxid_xxx", "mode": "fts5_trigram",
  "state": "building", "phase": "indexing", "full_rebuild": false,
  "done": 12000, "total": 50000, "percent": 24.0,
  "indexed_messages": 11800, "sources": 3, "last_built_at": 1729670000.0,
  "last_error": null, "short_query_note": "…", "auto_started": false
}
```

`state`：`empty`（还没建过）/ `building` / `ready` / `error`（`last_error` 里有原因，下次触发会重试）。

## POST /api/search/rebuild

无参数。后台全量重建；正在建时会取消当前这轮并排队重建。返回状态 + `{ok, started, queued}`。

## 隐私模式

后端没有隐私模式（隐私遮罩只在前端，`app/src/utils/privacy.ts`）。搜索接口返回真实的会话名、发送者名和消息文字，前端展示时要像其他页面一样用 `displayName(wxid, 真名)` 和 `maskText` 处理；高亮建议按 `segments` 逐段遮罩后再拼接，不要直接用 `highlights` 偏移去切遮罩后的文字。

## 引导期

和其他数据接口一样，没有解密数据时三个接口都返回 503（`no_decrypted_data` / `onboarding_required`）。
