"""Murmur MCP server — read-only access to locally decrypted WeChat data.

Run via ``etcli mcp`` (or ``python3 cli/etcli.py mcp``). Speaks the Model
Context Protocol over stdio: one JSON-RPC 2.0 message per line on stdin /
stdout, logs on stderr. No third-party dependencies.

Protocol support is "dual-era" (see modelcontextprotocol.io, revision
2026-07-28, "Versioning and Compatibility"):

* Modern clients (2026-07-28) send ``io.modelcontextprotocol/protocolVersion``
  and ``io.modelcontextprotocol/clientCapabilities`` in every request's
  ``_meta``; we serve each request statelessly and add ``resultType``.
* Legacy clients (2025-11-25 and earlier — what most shipping Claude Code /
  Codex builds speak) open with ``initialize``; we answer it and serve the
  negotiated legacy revision.

Every tool reuses the existing query/analysis helpers in ``etcli`` (EchoStore,
stats_for, local_analysis, compute_annual_report, ...). Nothing here writes to
the decrypted databases: EchoStore opens them ``mode=ro&immutable=1`` and the
on-disk analysis cache is switched to read-only for the lifetime of the
process.
"""
from __future__ import annotations

import json
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Optional

SERVER_NAME = "murmur"
SERVER_TITLE = "Murmur"

MODERN_VERSIONS = ("2026-07-28",)
LEGACY_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
SUPPORTED_VERSIONS = MODERN_VERSIONS + LEGACY_VERSIONS

META_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities"
META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

# JSON-RPC / MCP error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
UNSUPPORTED_PROTOCOL_VERSION = -32022

DEFAULT_MAX_ROWS = 500          # hard cap on rows returned by any single call
SEARCH_TIME_BUDGET_SEC = 60.0   # stop a cross-chat scan after this long, return partial

INSTRUCTIONS = (
    "Murmur 本机微信聊天数据（只读）。先用 list_contacts / list_chats 找到人或会话的 wxid，"
    "再用 get_messages / search_messages 取原文，用 get_friend_stats / "
    "get_relationship_evidence / get_annual_summary 取统计。参数 who/chat 可以填 wxid、"
    "备注、昵称或微信号片段。所有时间均为北京时间 (UTC+8)。"
    "Read-only access to the user's locally decrypted WeChat history."
)


class ToolError(Exception):
    """Raised inside a tool → reported as a tool execution error (isError: true)."""


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


# ---------------------------------------------------------------------------
# Privacy masking — Python port of app/src/utils/privacy.ts
# ---------------------------------------------------------------------------

_FRIEND_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_NAME_STOPLIST = {
    "self", "me", "you", "unknown", "none", "null", "undefined",
    "murmur", "wechat", "weixin", "claude", "codex", "chatgpt",
    "friends", "pairs", "report", "reports",
}
_SCHEMA_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_PASSTHROUGH_KEYS = {"type", "time", "order", "resultType"}
# Strict: a loose `[0-9:.+-]*` tail let "2025-01-05 13800138000" skip masking.
_ISO_TIME_RE = re.compile(
    r"^\d{4}-\d{2}(?:-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?)?$"
)
# Containers whose dict keys / item values are words mined from chat text
# (local_analysis vocabulary, annual report top_words / top_phrases).
_WORD_DICT_KEYS = {"self_top_words", "other_top_words"}
_WORD_ITEM_KEYS = ("word", "phrase")
_CJK_RE = re.compile(r"[㐀-鿿]")
# wxid_xxx plus the `_abcd` folder suffix WeChat 4 appends (wxid_abc123_7f3a).
_WXID_RE = re.compile(r"wxid_[A-Za-z0-9_-]+")


def js_short_hash(s: str) -> int:
    """Same as privacy.ts `shortHash`: Java-style 31x hash over UTF-16 code units, int32, abs()."""
    h = 0
    data = s.encode("utf-16-le", errors="surrogatepass")
    for i in range(0, len(data), 2):
        unit = data[i] | (data[i + 1] << 8)
        h = (h * 31 + unit) & 0xFFFFFFFF
    if h >= 0x80000000:
        h -= 0x100000000
    return abs(h)


def alias_for(ident: str, is_group: bool) -> str:
    """privacy.ts `aliasFor`: 朋友 XY / 群 N."""
    h = js_short_hash(ident)
    if is_group:
        return f"群 {(h % 99) + 1}"
    if ident == "self":
        return "你"
    return f"朋友 {_FRIEND_LETTERS[h % 26]}{_FRIEND_LETTERS[(h // 26) % 26]}"


def masked_wxid_base(ident: str) -> str:
    """privacy.ts `maskedWxid` (without the collision suffix added by Privacy.mask_id)."""
    if ident == "self":
        return "self"
    if ident.endswith("@chatroom"):
        return f"group_{js_short_hash(ident) % 999}"
    return f"wxid_{js_short_hash(ident) % 9999:04d}"


def _normalize_name(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _should_mask_name(name: str) -> bool:
    n = _normalize_name(name)
    if not n:
        return False
    if n.lower() in _NAME_STOPLIST or n in ("你", "我", "自己"):
        return False
    if re.match(r"^(wxid_|gh_|openim_|group_)", n, re.I) or n.endswith("@chatroom"):
        return False
    meaningful = [ch for ch in n if ch.isalnum()]
    return len(meaningful) >= 2


def _name_variants(name: str) -> list[str]:
    n = _normalize_name(name)
    if not n:
        return []
    variants = {n, n.replace("_", " "), re.sub(r"\s+", "_", n), re.sub(r"[._-]+", " ", n)}
    compact = re.sub(r"\s+", "", n)
    if compact != n:
        variants.add(compact)
    return [v for v in (_normalize_name(x) for x in variants) if _should_mask_name(v)]


class Privacy:
    """Masks names / ids in tool output and maps masked handles back to real ids.

    Same aliases as the frontend's privacy mode (朋友 XY / 群 N, wxid_NNNN /
    group_NNN), so what the AI sees matches the app's screenshots. Differences
    from privacy.ts, all deliberate:
      * masked ids get a ``~2``/``~3`` suffix on hash collisions so they stay
        unique and can be passed back as ``who``/``chat`` arguments;
      * contact usernames that are not ``wxid_*`` (old accounts) and 微信号
        aliases are masked too, not only ``wxid_*`` patterns;
      * whole-string fields (names) are masked even when shorter than 2 chars.
    """

    def __init__(self, enabled: bool):
        self.enabled = bool(enabled)
        self._id_fwd: dict[str, str] = {}      # real id → masked id
        self._id_rev: dict[str, str] = {}      # masked id → real id
        self._alias_rev: dict[str, list[str]] = {}   # 朋友 XY → [real ids]
        self._exact: dict[str, str] = {}       # whole-string replacements
        self._tokens: dict[str, str] = {}      # substring replacements (names, odd ids)
        self._token_re: Optional[re.Pattern] = None
        self._tokens_lower: dict[str, str] = {}
        self._alias_fwd: dict[str, str] = {}   # real id → 朋友 XY / 群 N
        self._name_pool: set[str] = set()      # lowercased names / handles of every contact
        self._person_pool: set[str] = set()    # same, people only (no group names)
        self._registered = False

    # --- registration ---

    def register_store(self, store) -> None:
        if not self.enabled or self._registered:
            return
        self._registered = True
        contacts = store.contacts()
        for username in sorted(contacts):
            c = contacts[username]
            display = c.display()
            is_group = c.is_group or ("群" in (display or ""))
            alias = alias_for(username, is_group)
            self._alias_rev.setdefault(alias, []).append(username)
            self._alias_fwd[username] = alias
            masked = self.mask_id(username)
            handles = [c.remark, c.nick_name, c.alias]
            if not re.match(r"^(wxid_|gh_|openim_)", username) and not username.endswith("@chatroom"):
                handles.append(username)
            for h in handles:
                for v in ([_normalize_name(h)] + _name_variants(h)) if h else []:
                    if v:
                        self._name_pool.add(v.lower())
                        if not is_group:
                            self._person_pool.add(v.lower())
            for nm in (c.remark, c.nick_name):
                if not nm:
                    continue
                self._exact.setdefault(nm, alias)
                for v in _name_variants(nm):
                    self._tokens[v] = alias
            if c.alias:
                # 微信号 is an account handle → treat like an id.
                self._exact.setdefault(c.alias, masked)
                if len(c.alias) >= 5:
                    self._tokens.setdefault(c.alias, masked)
            if not re.match(r"^(wxid_|gh_|openim_)", username) and not username.endswith("@chatroom") \
                    and len(username) >= 5:
                self._tokens.setdefault(username, masked)
        self._token_re = None

    def mask_id(self, real: str) -> str:
        if not self.enabled or not real or real == "self":
            return real
        got = self._id_fwd.get(real)
        if got:
            return got
        base = masked_wxid_base(real)
        masked = base
        n = 2
        while masked in self._id_rev and self._id_rev[masked] != real:
            masked = f"{base}~{n}"
            n += 1
        self._id_fwd[real] = masked
        self._id_rev[masked] = real
        self._exact.setdefault(real, masked)
        return masked

    def handle_text(self, real: str) -> str:
        """What the model can see of an id (masked id + alias) — the only text a
        privacy-mode `query` filter is allowed to match against."""
        return f"{self.mask_id(real)} {self._alias_fwd.get(real, '')}"

    def is_name_fragment(self, word: str, people_only: bool = False) -> bool:
        """True if `word` could reveal (part of) a registered contact name.

        Catches what token masking can't: lowercased name parts ("alice",
        "wang" from "Alice Wang"), CJK sub-strings ("爱丽", "丽丝" from "爱丽丝"),
        and CJK bigrams straddling a name boundary ("找爱")."""
        w = _normalize_name(word or "").lower()
        if not w:
            return False
        pool = self._person_pool if people_only else self._name_pool
        for n in pool:
            if w in n or (len(n) >= 2 and n in w):
                return True
            if _CJK_RE.search(n) and _CJK_RE.search(w):
                for k in range(1, min(len(w), len(n))):
                    if w[-k:] == n[:k] or w[:k] == n[-k:]:
                        return True
        return False

    # --- reverse lookup (masked handle → real id) ---

    def unmask(self, q: str) -> Optional[str]:
        if not self.enabled:
            return None
        if q in self._id_rev:
            return self._id_rev[q]
        cands = self._alias_rev.get(_normalize_name(q))
        if not cands:
            return None
        if len(cands) == 1:
            return cands[0]
        raise ToolError(
            f"「{q}」对应多个人（隐私模式别名可能重复），请改用 masked wxid："
            + ", ".join(self.mask_id(c) for c in cands[:10])
        )

    # --- masking ---

    def _compiled_tokens(self) -> Optional[re.Pattern]:
        if self._token_re is None and self._tokens:
            parts = []
            for tok in sorted(self._tokens, key=len, reverse=True):
                esc = re.escape(tok)
                if tok.isascii():
                    parts.append(f"(?<![A-Za-z0-9]){esc}(?![A-Za-z0-9])")
                else:
                    parts.append(esc)
            self._token_re = re.compile("|".join(parts), re.IGNORECASE)
            self._tokens_lower = {k.lower(): v for k, v in self._tokens.items()}
        return self._token_re

    def mask_text(self, text: str) -> str:
        if not self.enabled or not text:
            return text
        if text in self._exact:
            return self._exact[text]
        out = _mask_local_paths(text)
        # ids first, so the name pass below never re-masks a generated id
        out = re.sub(r"[a-z0-9_-]+@chatroom", lambda m: self.mask_id(m.group(0)), out, flags=re.I)
        out = _WXID_RE.sub(self._mask_wxid_match, out)
        out = re.sub(r"(?:gh_|openim_)[a-z0-9_-]+", lambda m: f"id_{js_short_hash(m.group(0)) % 9999}", out, flags=re.I)
        tok_re = self._compiled_tokens()
        if tok_re is not None:
            lower_map = self._tokens_lower
            out = tok_re.sub(lambda m: self._tokens.get(m.group(0)) or lower_map.get(m.group(0).lower(), m.group(0)), out)
        out = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", lambda m: f"email_{js_short_hash(m.group(0)) % 999}", out, flags=re.I)
        out = re.sub(r"\b[a-f0-9]{64}\b", "key_已隐藏", out, flags=re.I)
        out = re.sub(r"\b\d{17}[\dXx]\b", lambda m: f"id卡_{js_short_hash(m.group(0)) % 999}", out)
        out = re.sub(r"\b\d{15,19}\b", lambda m: f"卡号_{js_short_hash(m.group(0)) % 999}", out)
        out = re.sub(r"(^|[^\d])(\+?\d[\d -]{6,}\d)(?!\d)",
                     lambda m: f"{m.group(1)}num_{js_short_hash(m.group(2)) % 9999}", out)

        def _quoted(m: re.Match) -> str:
            inner = m.group(1)
            if re.search(r"[。？！，、；：…]", inner):
                return m.group(0)
            if re.fullmatch(r"[一-鿿]{2,4}", inner) or re.fullmatch(r"[A-Z][a-zA-Z]{1,3}(?:\s[A-Z][a-zA-Z]+)?", inner):
                return f"「人名_{js_short_hash(inner) % 99}」"
            return m.group(0)

        return re.sub(r"「([^」]{2,4})」", _quoted, out)

    def _mask_wxid_match(self, m: re.Match) -> str:
        tok = m.group(0).rstrip("_-")
        tail = m.group(0)[len(tok):]
        if tok in self._id_rev:      # already one of our masked ids — don't mask twice
            return m.group(0)
        return self.mask_id(tok) + tail

    def mask_error(self, text: str) -> str:
        """Tool error text → always strip local paths; with privacy also names/ids."""
        text = _mask_local_paths(str(text))
        return self.mask_text(text) if self.enabled else text

    def mask(self, obj: Any) -> Any:
        """Recursively mask every string (and dict key) except timestamps."""
        if not self.enabled:
            return obj
        if isinstance(obj, dict):
            out = {}
            for k, v in obj.items():
                if k in _PASSTHROUGH_KEYS:
                    out[self._mask_key(k)] = v
                elif k in _WORD_DICT_KEYS and isinstance(v, dict):
                    # Mined words: drop anything that is (part of) a contact name —
                    # "alice" passes the schema-key check, "爱丽" isn't a whole token.
                    out[k] = {self._mask_key(w): self.mask(c) for w, c in v.items()
                              if not (isinstance(w, str) and self.is_name_fragment(w))}
                else:
                    out[self._mask_key(k)] = self.mask(v)
            return out
        if isinstance(obj, (list, tuple)):
            return [self.mask(v) for v in obj if not self._is_name_word_item(v)]
        if isinstance(obj, str):
            return self._mask_str(obj)
        return obj

    def _mask_key(self, k: Any) -> Any:
        # Our own snake_case schema keys ("ok", "name", "by_sender") must never be
        # rewritten even if some contact happens to be called "ok"; data keys
        # (wxids in by_sender, words in vocabulary) still get masked.
        if not isinstance(k, str) or (_SCHEMA_KEY_RE.match(k) and not k.startswith(("wxid_", "gh_", "openim_"))):
            return k
        return self._mask_str(k)

    def _is_name_word_item(self, v: Any) -> bool:
        # {"word": "爱丽", "count": 3} / {"phrase": ...} items in word rankings
        if not isinstance(v, dict):
            return False
        for k in _WORD_ITEM_KEYS:
            if isinstance(v.get(k), str) and self.is_name_fragment(v[k]):
                return True
        return False

    def _mask_str(self, s: str) -> str:
        if not s or _ISO_TIME_RE.match(s):
            return s
        return self.mask_text(s)


_PATH_RULES = [
    # home dirs, with or without anything after the user name
    (re.compile(r"/(?:Users|home)/[^/\s\"'<>]+(?:/[^\s\"'<>)]*)?"), "~/本机路径"),
    (re.compile(r"[A-Z]:\\(?:Users|Documents and Settings)\\[^\\\s\"'<>]+(?:\\[^\s\"'<>)]*)?", re.I), "本机路径"),
    (re.compile(r"[A-Z]:[\\/][^\s\"'<>)]*(?:xwechat_files|Documents[\\/]Murmur|Desktop[\\/]Murmur)[^\s\"'<>)]*", re.I), "本机路径"),
    (re.compile(r"(?:~/)?(?:Desktop|Documents)/Murmur/[^\s\"'<>)]*"), "Murmur/隐藏路径"),
    (re.compile(r"(?:agent_reports|decrypted|logs)[\\/][^\s\"'<>)]*"), "隐藏路径"),
]


def _mask_local_paths(text: str) -> str:
    """privacy.ts `maskLocalPaths`."""
    if "/" not in text and "\\" not in text:
        return text
    for rx, repl in _PATH_RULES:
        text = rx.sub(repl, text)
    return text


# ---------------------------------------------------------------------------
# Minimal JSON-Schema argument validation (only the keywords our schemas use)
# ---------------------------------------------------------------------------

_TYPE_CHECKS: dict[str, Callable[[Any], bool]] = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
}


def validate_args(schema: dict, args: Any) -> dict:
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise ToolError("arguments 必须是 JSON 对象 / arguments must be an object")
    props = schema.get("properties", {})
    for req in schema.get("required", []):
        if req not in args or args[req] is None or args[req] == "":
            raise ToolError(f"缺少必填参数 `{req}` / missing required argument `{req}`")
    out = {}
    for k, v in args.items():
        if k not in props:
            if schema.get("additionalProperties") is False:
                raise ToolError(f"未知参数 `{k}`，可用参数：{', '.join(props) or '无'}")
            continue
        if v is None:
            continue
        spec = props[k]
        t = spec.get("type")
        if t and not _TYPE_CHECKS[t](v):
            raise ToolError(f"参数 `{k}` 类型应为 {t}，收到 {type(v).__name__}")
        if "enum" in spec and v not in spec["enum"]:
            raise ToolError(f"参数 `{k}` 只能是 {spec['enum']} 之一，收到 {v!r}")
        if "minimum" in spec and v < spec["minimum"]:
            raise ToolError(f"参数 `{k}` 不能小于 {spec['minimum']}")
        if "maximum" in spec and v > spec["maximum"]:
            raise ToolError(f"参数 `{k}` 不能大于 {spec['maximum']}")
        out[k] = v
    for k, spec in props.items():
        if k not in out and "default" in spec:
            out[k] = spec["default"]
    return out


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

_WHO = {"type": "string", "description": "wxid、备注、昵称或微信号片段（隐私模式下也可填 masked wxid）/ wxid, remark, nickname or alias"}
_SINCE = {"type": "string", "description": "起始时间（含），YYYY-MM-DD 或 YYYY-MM-DD HH:MM，北京时间 / start (inclusive, UTC+8)"}
_UNTIL = {"type": "string", "description": "结束时间（含）；只写日期时包含当天全天 / end (inclusive; a bare date covers the whole day)"}


def _limit(default: int, maximum: int) -> dict:
    return {"type": "integer", "minimum": 1, "maximum": maximum, "default": default,
            "description": f"返回条数，默认 {default}，最多 {maximum} / max rows"}


_OFFSET = {"type": "integer", "minimum": 0, "default": 0, "description": "分页偏移 / pagination offset"}
_READONLY = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}


def build_tool_defs(max_rows: int) -> list[dict]:
    m = max_rows
    return [
        {
            "name": "list_contacts",
            "title": "联系人列表",
            "description": "列出联系人（含群），可按名字过滤、按聊天消息量排序。/ List contacts, filter by name, sort by message volume.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "按 wxid/备注/昵称/微信号模糊匹配 / substring filter"},
                    "kind": {"type": "string", "enum": ["all", "friends", "private", "groups"], "default": "all",
                             "description": "all=全部；friends=通讯录好友；private=所有单聊对象；groups=群"},
                    "sort": {"type": "string", "enum": ["messages", "recent", "name"], "default": "messages",
                             "description": "messages=按消息量；recent=按最近聊天；name=按名字"},
                    "min_messages": {"type": "integer", "minimum": 0, "default": 0,
                                     "description": "只返回消息数 ≥ 该值的 / minimum message count"},
                    "limit": _limit(50, m),
                    "offset": _OFFSET,
                },
                "additionalProperties": False,
            },
            "annotations": {"title": "联系人列表", **_READONLY},
        },
        {
            "name": "list_chats",
            "title": "会话列表",
            "description": "列出会话（单聊和群聊），默认按最近活跃排序，带消息数和最后一条摘要。/ List chat sessions, most recent first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "按名字/wxid 过滤 / name filter"},
                    "kind": {"type": "string", "enum": ["all", "private", "groups"], "default": "all"},
                    "sort": {"type": "string", "enum": ["recent", "messages"], "default": "recent"},
                    "include_empty": {"type": "boolean", "default": False, "description": "包含没有本地消息的会话"},
                    "limit": _limit(50, m),
                    "offset": _OFFSET,
                },
                "additionalProperties": False,
            },
            "annotations": {"title": "会话列表", **_READONLY},
        },
        {
            "name": "get_messages",
            "title": "读取聊天记录",
            "description": ("读取某个会话的消息，支持时间范围和分页。order=desc 时从最新一条往前翻页（页内仍按时间正序）。"
                            " / Read messages of one chat with time range + pagination."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "chat": _WHO,
                    "since": _SINCE,
                    "until": _UNTIL,
                    "order": {"type": "string", "enum": ["desc", "asc"], "default": "desc",
                              "description": "desc=从最新开始分页；asc=从最早开始"},
                    "text_only": {"type": "boolean", "default": False, "description": "只要文字消息"},
                    "limit": _limit(100, m),
                    "offset": _OFFSET,
                },
                "required": ["chat"],
                "additionalProperties": False,
            },
            "annotations": {"title": "读取聊天记录", **_READONLY},
        },
        {
            "name": "search_messages",
            "title": "搜索消息",
            "description": ("按关键词搜索文字消息（不区分大小写的子串匹配），可限定会话和时间范围。全库搜索较慢，超过 60 秒返回部分结果。"
                            " / Keyword search over text messages."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "关键词 / keyword"},
                    "chat": {**_WHO, "description": "可选，只在这个会话里搜 / optional chat scope"},
                    "since": _SINCE,
                    "until": _UNTIL,
                    "limit": _limit(50, min(m, 200)),
                },
                "required": ["keyword"],
                "additionalProperties": False,
            },
            "annotations": {"title": "搜索消息", **_READONLY},
        },
        {
            "name": "get_friend_stats",
            "title": "好友统计",
            "description": ("某个联系人/群的聊天统计：消息数、谁说得多、时段/星期/年份分布、首末消息时间。"
                            "detail=full 时附带完整本地分析（主动发起、回复速度、沉默期、高频词等）。/ Chat statistics for one contact."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "who": _WHO,
                    "detail": {"type": "string", "enum": ["basic", "full"], "default": "basic"},
                },
                "required": ["who"],
                "additionalProperties": False,
            },
            "annotations": {"title": "好友统计", **_READONLY},
        },
        {
            "name": "get_relationship_evidence",
            "title": "关系证据",
            "description": ("和某人关系的证据：关系信号（线下见面、倾诉、互相关心、冲突修复、通话、朋友圈互动等）+ 采样原文。"
                            "填了 other 时改为查两个人之间的直接证据（互相回复、提及、朋友圈互动；仅同群不算）。"
                            " / Relationship signals + sample messages; with `other`, direct A↔B evidence."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "who": _WHO,
                    "other": {**_WHO, "description": "可选，第二个人；填了就查 who 与 other 之间的证据"},
                    "sample": {"type": "integer", "minimum": 0, "maximum": min(m, 200), "default": 30,
                               "description": "附带的采样消息条数 / number of sample messages"},
                },
                "required": ["who"],
                "additionalProperties": False,
            },
            "annotations": {"title": "关系证据", **_READONLY},
        },
        {
            "name": "get_annual_summary",
            "title": "年度总结",
            "description": ("某一年的全局年度总结：总消息数、活跃天数、聊得最多的人、每月冠军、最忙的一天、连续聊天、深夜之王、"
                            "主动程度、口头禅、渐行渐远的人等。不填 year 默认取有数据的最近一年。/ Year-in-review across all chats."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "year": {"type": "integer", "minimum": 2000, "maximum": 2100},
                    "top_n": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20,
                              "description": "top_friends 最多返回几项 / max entries in top_friends"},
                },
                "additionalProperties": False,
            },
            "annotations": {"title": "年度总结", **_READONLY},
        },
    ]


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

class MurmurMCPServer:
    def __init__(self, et, *, data_dir: Optional[str] = None, privacy: bool = False,
                 max_rows: int = DEFAULT_MAX_ROWS, store=None,
                 search_time_budget: float = SEARCH_TIME_BUDGET_SEC):
        self.et = et                  # the etcli module
        self.data_dir = data_dir
        self.privacy = Privacy(privacy)
        self.max_rows = max(1, int(max_rows))
        self.search_time_budget = search_time_budget
        self._store = store
        self._store_error: Optional[str] = None
        self.legacy_version: Optional[str] = None
        self.tools = build_tool_defs(self.max_rows)
        self._tool_by_name = {t["name"]: t for t in self.tools}
        self._handlers: dict[str, Callable[[dict], dict]] = {
            "list_contacts": self.tool_list_contacts,
            "list_chats": self.tool_list_chats,
            "get_messages": self.tool_get_messages,
            "search_messages": self.tool_search_messages,
            "get_friend_stats": self.tool_get_friend_stats,
            "get_relationship_evidence": self.tool_get_relationship_evidence,
            "get_annual_summary": self.tool_get_annual_summary,
        }

    # --- identity ---

    def server_info(self) -> dict:
        return {"name": SERVER_NAME, "title": SERVER_TITLE, "version": getattr(self.et, "APP_VERSION", "0")}

    # --- store ---

    @property
    def store(self):
        if self._store is not None:
            return self._store
        et = self.et
        dd = Path(self.data_dir) if self.data_dir else et.discover_data_dir()
        if not dd or not Path(dd).is_dir():
            raise ToolError(
                "找不到 Murmur 解密后的数据目录。请先在 Murmur App 里完成解密，"
                "或者用 `etcli mcp --data-dir <目录>` / 环境变量 ETCLI_DATA_DIR 指定（目录里应有 session.db）。"
            )
        try:
            store = et.EchoStore(Path(dd))
        except FileNotFoundError as e:
            raise ToolError(f"数据目录不可用：{e}")
        try:
            # Align the per-account cache slug with the app so we can reuse its caches.
            et._MurmurAPIHandler._set_wechat_store(store)
        except Exception:
            pass
        self._store = store
        return store

    # --- JSON-RPC dispatch ---

    def handle(self, msg: Any) -> Optional[dict]:
        """Process one decoded JSON-RPC message; return the response dict or None."""
        if not isinstance(msg, dict):
            return _error(None, INVALID_REQUEST, "Invalid Request: expected a JSON object (batches are not supported)")
        if "method" not in msg:
            return None  # a response to something we never sent — ignore
        has_id = "id" in msg
        req_id = msg.get("id")
        if has_id and (req_id is None or isinstance(req_id, bool) or not isinstance(req_id, (str, int))):
            return _error(None, INVALID_REQUEST, "Invalid Request: id must be a string or integer")
        if msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
            return _error(req_id if has_id else None, INVALID_REQUEST, "Invalid Request: jsonrpc must be \"2.0\"")
        method = msg["method"]
        params = msg.get("params", {})
        if params is None:
            params = {}
        if not has_id:
            # Notifications: initialized / cancelled / roots changed … nothing to do
            # (requests are processed synchronously, so there is nothing to cancel).
            return None
        if not isinstance(params, dict):
            return _error(req_id, INVALID_PARAMS, "params must be an object")
        try:
            result, modern = self._dispatch(method, params)
        except RpcError as e:
            return _error(req_id, e.code, e.message, e.data)
        except Exception as e:  # pragma: no cover - defensive
            sys.stderr.write(f"[mcp] internal error in {method}: {traceback.format_exc()}\n")
            return _error(req_id, INTERNAL_ERROR, self.privacy.mask_error(f"Internal error: {e}"))
        if modern:
            result = {"resultType": "complete", **result}
            meta = dict(result.get("_meta") or {})
            meta[META_SERVER_INFO] = self.server_info()
            result["_meta"] = meta
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    def _dispatch(self, method: str, params: dict) -> tuple[dict, bool]:
        meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
        version = meta.get(META_VERSION)

        if method == "initialize":
            return self._initialize(params), False

        modern = False
        if version is not None:
            if version not in SUPPORTED_VERSIONS:
                raise RpcError(UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version",
                               {"supported": list(SUPPORTED_VERSIONS), "requested": version})
            if version in MODERN_VERSIONS:
                modern = True
                if not isinstance(meta.get(META_CLIENT_CAPS), dict):
                    raise RpcError(INVALID_PARAMS,
                                   f"Missing required _meta field {META_CLIENT_CAPS}")

        if method == "server/discover":
            return {
                "supportedVersions": list(SUPPORTED_VERSIONS),
                "capabilities": {"tools": {"listChanged": False}},
                "instructions": INSTRUCTIONS,
            }, True
        if method == "ping":
            return {}, modern
        if method == "tools/list":
            return {"tools": self.tools}, modern
        if method == "tools/call":
            return self._call_tool(params), modern
        raise RpcError(METHOD_NOT_FOUND, f"Method not found: {method}")

    def _initialize(self, params: dict) -> dict:
        requested = params.get("protocolVersion")
        if not isinstance(requested, str):
            raise RpcError(INVALID_PARAMS, "initialize: protocolVersion is required")
        # Legacy negotiation: echo the client's version if we support it, else offer our latest legacy one.
        chosen = requested if requested in LEGACY_VERSIONS else LEGACY_VERSIONS[0]
        self.legacy_version = chosen
        return {
            "protocolVersion": chosen,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": self.server_info(),
            "instructions": INSTRUCTIONS,
        }

    def _call_tool(self, params: dict) -> dict:
        name = params.get("name")
        if not isinstance(name, str):
            raise RpcError(INVALID_PARAMS, "tools/call: name is required")
        tool = self._tool_by_name.get(name)
        if not tool:
            raise RpcError(INVALID_PARAMS, f"Unknown tool: {name}")
        try:
            args = validate_args(tool["inputSchema"], params.get("arguments"))
            if self.privacy.enabled:
                self.privacy.register_store(self.store)
            payload = self._handlers[name](args)
            # Normalise to plain JSON (int dict keys → str, tuples → lists, sets/dates → str)
            # so structuredContent and the text block are byte-for-byte the same data.
            payload = json.loads(json.dumps(payload, ensure_ascii=False, default=_json_default))
            payload = self.privacy.mask(payload)
        except ToolError as e:
            return self._tool_error(str(e))
        except SystemExit as e:  # etcli helpers bail out with SystemExit("找不到联系人: …")
            return self._tool_error(str(e.code))
        except Exception as e:
            sys.stderr.write(f"[mcp] tool {name} failed: {traceback.format_exc()}\n")
            return self._tool_error(f"工具执行失败 / tool failed: {type(e).__name__}: {e}")
        return {
            "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
            "structuredContent": payload,
            "isError": False,
        }

    def _tool_error(self, text: str) -> dict:
        # Every isError text goes through the masker: exception strings carry
        # data-dir paths (system user name), wxid folder names and echoed queries.
        return {"content": [{"type": "text", "text": self.privacy.mask_error(text)}], "isError": True}

    # --- helpers ---

    def _query_hit(self, q: str, real_id: str, real_text: str) -> bool:
        """`query` filter: in privacy mode only masked handles are searchable,
        so the model can't probe for a contact by real name."""
        if not q:
            return True
        hay = self.privacy.handle_text(real_id) if self.privacy.enabled else real_text
        return q in hay.lower()

    def _resolve(self, query: str) -> str:
        q = query.strip()
        real = self.privacy.unmask(q)
        if real:
            return real
        if self.privacy.enabled:
            raise ToolError(
                "隐私模式下只能用 list_contacts / list_chats 返回的脱敏代号（wxid 字段，或「朋友 XY」「群 N」别名）指定对象，"
                "不能用真实名字或真实 wxid。"
            )
        store = self.store
        if q in store.contacts():
            return q
        if any(s.username == q for s in store.sessions()):
            return q
        return self.et.resolve_wxid(store, q)

    def _time(self, s: Optional[str], *, end: bool = False) -> Optional[int]:
        if not s:
            return None
        s = s.strip()
        try:
            ts = self.et.parse_date(s)
        except SystemExit:
            raise ToolError(f"无法解析时间 `{s}`，请用 YYYY-MM-DD 或 YYYY-MM-DD HH:MM")
        if ts is not None and end:
            ts += 86399 if len(s) <= 10 else 59
        return ts

    def _cap(self, n: int) -> int:
        return max(1, min(int(n), self.max_rows))

    def _counts(self) -> Callable[[str], int]:
        et, store = self.et, self.store
        try:
            et.build_msg_index(store)
        except Exception as e:
            raise ToolError(f"读取消息库失败（可能正在重新解密，稍后再试）：{e}")
        return lambda wxid: et.fast_message_count(store, wxid)

    def _iso(self, ts: Optional[int]) -> Optional[str]:
        if not ts:
            return None
        return self.et.datetime.fromtimestamp(ts, self.et.CST).isoformat()

    # --- tools ---

    def tool_list_contacts(self, a: dict) -> dict:
        store = self.store
        count_of = self._counts()
        last_ts = {s.username: s.last_timestamp for s in store.sessions()}
        q = (a.get("query") or "").lower()
        kind = a["kind"]
        rows = []
        for u, c in store.contacts().items():
            if kind == "groups" and not c.is_group:
                continue
            if kind == "private" and c.is_group:
                continue
            if kind == "friends" and not c.is_real_friend:
                continue
            if not self._query_hit(q, u, f"{u} {c.remark} {c.nick_name} {c.alias}"):
                continue
            n = count_of(u)
            if n < a["min_messages"]:
                continue
            rows.append({
                "wxid": u, "name": c.display(), "remark": c.remark, "nick_name": c.nick_name,
                "alias": c.alias, "is_group": c.is_group, "is_friend": c.is_real_friend,
                "message_count": n, "last_ts": last_ts.get(u) or 0,
            })
        sort = a["sort"]
        if sort == "messages":
            rows.sort(key=lambda r: (-r["message_count"], -r["last_ts"], r["wxid"]))
        elif sort == "recent":
            rows.sort(key=lambda r: (-r["last_ts"], r["wxid"]))
        else:
            rows.sort(key=lambda r: (r["name"], r["wxid"]))
        return self._page(rows, a, transform=lambda r: {**{k: v for k, v in r.items() if k != "last_ts"},
                                                         "last_time": self._iso(r["last_ts"])})

    def tool_list_chats(self, a: dict) -> dict:
        store = self.store
        count_of = self._counts()
        q = (a.get("query") or "").lower()
        rows = []
        for r in self.et.build_session_index(store):
            if a["kind"] == "groups" and not r["is_group"]:
                continue
            if a["kind"] == "private" and r["is_group"]:
                continue
            if not self._query_hit(q, r["wxid"], f"{r['wxid']} {r['name']}"):
                continue
            n = count_of(r["wxid"])
            if n == 0 and not a["include_empty"]:
                continue
            rows.append({**r, "message_count": n})
        if a["sort"] == "messages":
            rows.sort(key=lambda r: (-r["message_count"], -(r["last_ts"] or 0)))
        return self._page(rows, a, transform=lambda r: {k: v for k, v in r.items() if k != "last_ts"})

    def _page(self, rows: list, a: dict, transform: Callable[[Any], Any] = lambda r: r) -> dict:
        limit = self._cap(a["limit"])
        offset = a.get("offset", 0)
        page = rows[offset: offset + limit]
        nxt = offset + len(page)
        return {
            "total": len(rows), "offset": offset, "count": len(page),
            "next_offset": nxt if nxt < len(rows) else None,
            "items": [transform(r) for r in page],
        }

    def tool_get_messages(self, a: dict) -> dict:
        store = self.store
        wxid = self._resolve(a["chat"])
        since, until = self._time(a.get("since")), self._time(a.get("until"), end=True)
        msgs = list(store.messages(wxid, since=since, until=until, text_only=a["text_only"]))
        total = len(msgs)
        limit, offset = self._cap(a["limit"]), a["offset"]
        if a["order"] == "asc":
            page = msgs[offset: offset + limit]
        else:
            end = max(0, total - offset)
            page = msgs[max(0, end - limit): end]
        nxt = offset + len(page)
        return {
            "chat": wxid, "chat_name": store.contact(wxid).display(),
            "is_group": wxid.endswith("@chatroom"),
            "total": total, "offset": offset, "order": a["order"], "count": len(page),
            "next_offset": nxt if nxt < total else None,
            "messages": [m.to_dict() for m in page],
        }

    def tool_search_messages(self, a: dict) -> dict:
        # TODO(search_index): when the global search module (cli/search_index.py,
        # plan item 5) lands, route through its FTS index instead of this scan.
        # A plain SQL `LIKE` over message_content is not enough on its own: WeChat 4.x
        # keeps many text bodies zstd-compressed in compress_content, so we match on
        # the text EchoStore.messages() has already decoded.
        store = self.store
        kw = a["keyword"]
        if self.privacy.enabled and self.privacy.is_name_fragment(kw, people_only=True):
            # Hit counts for a name would confirm who is in the address book.
            raise ToolError("隐私模式下不能按联系人名字（或名字的一部分）搜索消息，请换一个关键词。")
        limit = max(1, min(a["limit"], self.max_rows, 200))
        since, until = self._time(a.get("since")), self._time(a.get("until"), end=True)
        if a.get("chat"):
            chats = [self._resolve(a["chat"])]
        else:
            count_of = self._counts()
            chats = [s.username for s in store.sessions() if count_of(s.username) > 0]
        # Same scan as etcli.search_messages (store.messages + case-insensitive
        # substring), plus chat/time scoping and a wall-clock budget so one call
        # can't hang the client on a huge account.
        truncated = False
        hits: list[dict] = []
        deadline = time.monotonic() + self.search_time_budget
        low = kw.lower()
        scanned = 0
        for chat in chats:
            if len(hits) >= limit:
                break
            if time.monotonic() > deadline:
                truncated = True
                break
            scanned += 1
            name = store.contact(chat).display()
            for m in store.messages(chat, since=since, until=until, text_only=True):
                if low in m.text.lower():
                    d = m.to_dict()
                    d["session"] = chat
                    d["session_name"] = name
                    hits.append(d)
                    if len(hits) >= limit:
                        break
        return {
            "keyword": kw, "count": len(hits), "limit": limit,
            "limit_reached": len(hits) >= limit, "time_budget_exceeded": truncated,
            "chats_scanned": scanned, "chats_total": len(chats), "results": hits,
        }

    def tool_get_friend_stats(self, a: dict) -> dict:
        store, et = self.store, self.et
        wxid = self._resolve(a["who"])
        if a["detail"] == "full":
            return et.local_analysis(store, wxid)
        return et.stats_for(store, wxid)

    def tool_get_relationship_evidence(self, a: dict) -> dict:
        store, et = self.store, self.et
        wxid = self._resolve(a["who"])
        if a.get("other"):
            other = self._resolve(a["other"])
            if other == wxid:
                raise ToolError("who 和 other 是同一个人")
            ev = et.pair_direct_evidence(store, wxid, other)
            return ev
        analysis = et.local_analysis(store, wxid)
        if not analysis.get("message_count", 1) or analysis.get("totals", {}).get("messages", 0) == 0:
            return {"wxid": wxid, "name": store.contact(wxid).display(), "message_count": 0,
                    "relationship_signals": {}, "sample_messages": []}
        dossier = et.relationship_dossier(store, wxid)
        samples = dossier.get("sample_messages", [])[: a["sample"]]
        return {
            "wxid": wxid,
            "name": analysis.get("name"),
            "is_group": analysis.get("is_group"),
            "labels": analysis.get("labels"),
            "totals": analysis.get("totals"),
            "rhythm": {k: v for k, v in (analysis.get("rhythm") or {}).items() if k not in ("by_hour",)},
            "relationship_signals": analysis.get("relationship_signals"),
            "sample_messages": samples,
        }

    def tool_get_annual_summary(self, a: dict) -> dict:
        store, et = self.store, self.et
        years = et.list_available_report_years(store)
        year = a.get("year")
        if year is None:
            if not years:
                raise ToolError("没有找到任何有消息的年份")
            year = years[-1]
        report = dict(et.compute_annual_report(store, int(year)))
        if isinstance(report.get("top_friends"), list):
            report["top_friends"] = report["top_friends"][: a["top_n"]]
        report["available_years"] = years
        return report


def _json_default(o: Any) -> Any:
    if isinstance(o, (set, frozenset)):
        return sorted(o, key=str)
    return str(o)


def _error(req_id, code: int, message: str, data: Any = None) -> dict:
    err: dict = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": err}


# ---------------------------------------------------------------------------
# stdio loop
# ---------------------------------------------------------------------------

def encode_message(msg: dict) -> bytes:
    # ensure_ascii keeps every frame plain ASCII: no embedded newlines, no
    # encoding surprises on Windows consoles. Clients decode \\uXXXX normally.
    return (json.dumps(msg, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")


def serve_stdio(server: MurmurMCPServer, stdin=None, stdout=None) -> int:
    in_stream = stdin if stdin is not None else sys.stdin.buffer
    out_stream = stdout if stdout is not None else sys.stdout.buffer
    saved_stdout = sys.stdout
    # Anything that print()s to stdout would corrupt the protocol stream.
    sys.stdout = sys.stderr
    try:
        for raw in iter(in_stream.readline, b""):
            line = raw.decode("utf-8", errors="replace").strip() if isinstance(raw, bytes) else str(raw).strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError as e:
                resp: Optional[dict] = _error(None, PARSE_ERROR, f"Parse error: {e}")
            else:
                resp = server.handle(msg)
            if resp is not None:
                out_stream.write(encode_message(resp))
                out_stream.flush()
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout = saved_stdout
    return 0


def main(args, et=None) -> int:
    """Entry point for `etcli mcp` (args = parsed argparse namespace)."""
    if et is None:
        import etcli as et  # type: ignore[no-redef]
    # Read caches the app produced, never write: keep the MCP process side-effect free.
    et._DISK_CACHE_READONLY = True
    server = MurmurMCPServer(
        et,
        data_dir=getattr(args, "data_dir", None),
        privacy=bool(getattr(args, "privacy", False)),
        max_rows=int(getattr(args, "max_rows", DEFAULT_MAX_ROWS) or DEFAULT_MAX_ROWS),
    )
    sys.stderr.write(
        f"[mcp] Murmur MCP server ready (stdio, privacy={'on' if server.privacy.enabled else 'off'}, "
        f"max_rows={server.max_rows})\n"
    )
    sys.stderr.flush()
    return serve_stdio(server)
