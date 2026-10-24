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

---

# 本机语义搜索（可选，默认关闭）

实现在 `cli/semantic_index.py`。全程在本机运行，不调用任何云端 API；唯一的联网动作是用户点击后下载模型。

## 怎么工作

- 输入是上面的关键词索引（`messages` 表），所以建语义索引前会先把关键词索引补到最新。
- 同一个会话里相邻的消息合成一个片段：最多 8 条、约 400 字，两条消息间隔超过 1 小时就断开。单条消息超过 200 字会截断。
- 每个片段用嵌入模型编码成 512 维向量，以 float16 BLOB 存在 `~/Documents/Murmur/semantic/index/<platform>-<account>.sqlite`（可用 `MURMUR_SEMANTIC_DIR` 改目录）。不写入微信 / QQ 的解密库。
- 查询时把问题也编码成向量，对所有片段算余弦相似度（装了 numpy 用矩阵乘法，并按索引版本缓存在内存里，默认上限 512MB，可用 `MURMUR_SEMANTIC_CACHE_MB` 调；没有 numpy 时走纯 Python）。
- 增量：每个会话记住已编码的最后一条消息；会话最后一个片段是「开放」的，有新消息时连同新消息重新编码。已编码消息被撤回 / 编辑需要全量重建。
- 片段里记的是每条消息的定位 `(db, table, local_id)`，不是关键词索引的行 id，取结果时按定位回查并核对会话，所以关键词索引重建（行 id 全部重编号）后结果也不会串到别的会话。关键词索引每次重建会换一个 `build_id`；语义索引发现它变了，下一次增量会把所有片段重新编码，在那之前 status 的 `index.stale` 为 `true`。
- 内存里的向量矩阵按 `(build_id, generation)` 缓存；全量重建会换 `build_id`，`generation` 也只增不减，不会复用旧矩阵。
- 加载模型前会再校验一次文件的 SHA-256（每个文件按路径 + 大小 + 修改时间只算一次），校验不过时语义搜索返回 409，提示重新下载。

### 选型

| 方案 | 取舍 |
|---|---|
| **SQLite BLOB + 线性扫描（采用）** | 零额外原生扩展；macOS 自带 Python 的 sqlite3 不能 `enable_load_extension`，sqlite-vec 装不上。十几万个片段一次矩阵乘法在 1 秒内。 |
| sqlite-vec | 要加载扩展，Windows / macOS 打包都麻烦。 |
| faiss / hnswlib | 需要编译或大 wheel，这个规模用不上近似检索。 |

模型：`BAAI/bge-small-zh-v1.5`（MIT），用 `Xenova/bge-small-zh-v1.5` 仓库里的 int8 ONNX 导出（`onnx/model_quantized.onnx` 24MB + `tokenizer.json` 0.4MB，合计约 24MB），由 onnxruntime + tokenizers 运行，不需要 torch。文件固定到一个 commit，下载后校验 SHA-256，所以从镜像下载也安全。M 系列 Mac 上实测约 230 个片段/秒（100 万条消息约 12.5 万个片段，约 9 分钟），单次查询编码约 2ms。

## 可选依赖

```bash
python3.12 -m pip install -r requirements-semantic.txt   # onnxruntime, tokenizers, numpy
```

没装时各接口返回 `state = "not_installed"`，`missing_deps` 列出缺的包，`install_hint` 是安装命令。打包版 App 不带这几个依赖。

## GET /api/search/semantic/status

没有解密数据时也能调（此时 `index` 为 `null`）。

```jsonc
{
  "state": "not_installed | disabled | model_missing | downloading | empty | building | ready | error",
  "message": "给用户看的中文说明",
  "installed": true, "missing_deps": [], "install_hint": "python3.12 -m pip install -r requirements-semantic.txt",
  "enabled": false,                       // 默认关闭
  "mirror": "huggingface",
  "mirrors": [{"id": "huggingface", "label": "...", "endpoint": "https://huggingface.co"},
              {"id": "hf-mirror", "label": "...", "endpoint": "https://hf-mirror.com"}],
  "model": {"id", "name", "repo", "revision", "license", "homepage", "size_bytes", "files": [{"path", "size", "sha256"}], "downloaded", "dir"},
  "download": {"state": "idle|downloading|done|error", "mirror", "file", "done_bytes", "total_bytes", "error"},
  "local_only": true,
  "index": {"state", "phase", "done", "total", "percent", "chunks", "indexed_messages", "last_built_at", "last_error", "stale"}
}
```

旧版本（schema 不同）留下的语义索引会显示为 `empty`，搜索返回空结果，建一次索引即可。

下面三个 POST 接口都要求 `Content-Type: application/json`，否则返回 415（防止跨站的表单 / text/plain 请求绕过 CORS 预检）。

状态的先后顺序：`not_installed` → `disabled` → `model_missing` / `downloading` → `empty` / `building` / `ready` / `error`。

环境变量 `MURMUR_HF_ENDPOINT=https://...` 会多出一个 `custom` 下载源。

## POST /api/search/semantic/settings

`{"enabled": true|false, "mirror": "huggingface|hf-mirror|custom"}`，字段都可选。设置存在 `~/Documents/Murmur/semantic/settings.json`。关闭时会取消正在进行的建索引。未知的 `mirror` 返回 400。返回同 status。

## POST /api/search/semantic/download

`{"mirror": "hf-mirror"}`（可选，默认用设置里的）。后台下载并校验（单个文件超过固定大小就立即停止并删掉临时文件），进度看 status 的 `download`。界面必须先把 `model.size_bytes` 和 `model.repo` / 下载源告诉用户，用户点了才调这个接口。依赖没装时返回 409。

## POST /api/search/semantic/build

`{"full": false}`。后台增量建索引（`full: true` 为全量重建），进度看 status 的 `index`。没装依赖 / 没开启 / 没下模型时返回 409。`/api/refresh` 成功后，如果语义搜索可用，也会自动跑一次增量。

## GET /api/search?mode=semantic（或 GET /api/search/semantic）

参数：`q`、`chat`、`sender`、`from`、`to`、`limit`（1–100，默认 20）、`offset`、`min_score`（可选）。不支持 `type`。

- `chat`：片段所属会话；`sender`：片段里有这个人发的消息；`from` / `to`：片段时间范围和区间有重叠。
- 不可用时返回 409：`{"error": "semantic_unavailable", "message": "...", "status": {...同 status...}}`。

返回结构和关键词搜索一样（`mode` / `match` 为 `"semantic"`，另有 `model`），每条结果多两个字段：

```jsonc
{
  // ...和关键词结果一样的字段，指向片段里和问题字面最接近的一条消息（锚点）...
  "score": 0.6123,                         // 余弦相似度，越大越相关；按它降序排列
  "chunk": {
    "id": 12, "ts_start": 1714550400, "ts_end": 1714554000,
    "message_count": 6, "anchor_index": 2,
    "messages": [{"sender", "sender_name", "ts", "time", "type", "text", "locator"}]
  }
}
```

`total` 是参与打分的片段数（设置了 `min_score` 时是达到阈值的数量）。`snippet` / `segments` 只在锚点消息里字面出现查询词时才有高亮。隐私遮罩同上，`chunk.messages` 里的名字和文字也要遮罩。
