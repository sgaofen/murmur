"""Stable error codes for the HTTP API.

Every JSON error payload keeps its original ``error`` text (backwards
compatible) and may additionally carry ``code`` — a stable, upper-snake-case
identifier the frontend maps to a human explanation via
``app/src/data/errorCatalog.ts``. Keep the two lists in sync.

Codes are derived either explicitly at the call site (``with_code``) or, for
the long tail of existing ``_send_json({"error": ...})`` branches, by matching
the raw text against ``_RULES`` (``classify``). Unknown text yields ``None``
and the frontend falls back to showing the raw message.

Pure stdlib, no side effects on import — safe to unit-test in CI.
"""
from __future__ import annotations

import re
from typing import Optional

# --- Code constants -------------------------------------------------------

# Environment / WeChat state
WECHAT_NOT_RUNNING = "WECHAT_NOT_RUNNING"
WECHAT_DATA_NOT_FOUND = "WECHAT_DATA_NOT_FOUND"
WECHAT_DB_NOT_SYNCED = "WECHAT_DB_NOT_SYNCED"
WECHAT_APP_NOT_FOUND = "WECHAT_APP_NOT_FOUND"
WECHAT_HARDENED = "WECHAT_HARDENED"
TCC_BLOCKED = "TCC_BLOCKED"
PERMISSION_DENIED = "PERMISSION_DENIED"
AUTH_CANCELLED = "AUTH_CANCELLED"
RESIGN_FAILED = "RESIGN_FAILED"
WIN_HOOK_FAILED = "WIN_HOOK_FAILED"
PLATFORM_UNSUPPORTED = "PLATFORM_UNSUPPORTED"

# Keys
KEY_NOT_FOUND = "KEY_NOT_FOUND"
KEY_INVALID = "KEY_INVALID"
KEY_FORMAT_INVALID = "KEY_FORMAT_INVALID"

# Decrypt / data
NO_DECRYPTED_DATA = "NO_DECRYPTED_DATA"
DECRYPT_INCOMPLETE = "DECRYPT_INCOMPLETE"
DECRYPT_FAILED = "DECRYPT_FAILED"
STORE_INIT_FAILED = "STORE_INIT_FAILED"
DB_MALFORMED = "DB_MALFORMED"
DB_BUSY = "DB_BUSY"
DISK_IO = "DISK_IO"

# macOS live key capture (Frida, cli/live_key.py)
FRIDA_MISSING = "FRIDA_MISSING"
LIVE_KEY_FAILED = "LIVE_KEY_FAILED"

# QQ
QQ_DATA_NOT_FOUND = "QQ_DATA_NOT_FOUND"
QQ_KEY_NOT_FOUND = "QQ_KEY_NOT_FOUND"
QQ_KEY_INVALID = "QQ_KEY_INVALID"

# Misc
TIMEOUT = "TIMEOUT"
AGENT_NOT_INSTALLED = "AGENT_NOT_INSTALLED"
ORIGIN_NOT_ALLOWED = "ORIGIN_NOT_ALLOWED"
INTERNAL_ERROR = "INTERNAL_ERROR"

ALL_CODES = frozenset(
    v for k, v in dict(globals()).items()
    if k.isupper() and isinstance(v, str) and k == v
)

# --- Text classification --------------------------------------------------

# Ordered: first match wins, so put specific patterns before generic ones
# (e.g. "key must be 64 hex" before anything matching "key"). Patterns are
# drawn from messages the backend / helper scripts actually emit today:
# etcli.py endpoints, refresh.py (incl. its _ERROR_HINTS), extract_key_mac.py,
# extract_key_dll.py, qq endpoints.
_RULES = (
    (ORIGIN_NOT_ALLOWED, r"origin_not_allowed"),
    # live_key.py job error tokens (exact) and Frida install messages
    (FRIDA_MISSING, r"^frida-missing$|不能在线安装 frida|no module named '?frida"),
    (WECHAT_HARDENED, r"^attach-denied$"),
    (AUTH_CANCELLED, r"^auth-cancelled$"),
    (WECHAT_NOT_RUNNING, r"^wechat-not-running$"),
    (WECHAT_DB_NOT_SYNCED, r"^no-dbs$"),
    (DB_MALFORMED, r"database_malformed|malformed|file is not a database"),
    (NO_DECRYPTED_DATA, r"no_decrypted_data|onboarding_required|bootstrap mode"),
    (AUTH_CANCELLED, r"user canceled|user cancelled|用户已取消|授权窗口取消|\(-128\)"),
    (WIN_HOOK_FAILED, r"hook (setup|install) failed|wx_key\.dll|注入到微信进程"),
    (WECHAT_HARDENED, r"task_for_pid denied|still has hardened runtime"),
    (KEY_FORMAT_INVALID, r"key must be 64 hex|密钥长度不对|64 位十六进制"),
    (KEY_INVALID, r"wrong key|hmac|密钥不属于|密钥校验失败"),
    (KEY_NOT_FOUND, r"找不到 ?mac ?解密密钥|找不到密钥|no key matched|no saved key|没读到密钥|没有返回可保存的密钥|no key after \d+s"),
    (WECHAT_NOT_RUNNING, r"no wechat process|weixin\.exe / wechat\.exe not|没有检测到正在运行的|is wechat running"),
    (WECHAT_DB_NOT_SYNCED, r"没找到加密 ?(db|数据库)|no encrypted dbs? found"),
    (WECHAT_APP_NOT_FOUND, r"没找到 wechat\.app|could not find weixin\.exe path"),
    (WECHAT_DATA_NOT_FOUND, r"未找到 wechat profile|未找到 wechat 账号目录|找不到微信账号数据|no wechat profile found|wxid_\*/db_storage|未找到微信数据目录|^no profile$"),
    (QQ_DATA_NOT_FOUND, r"not found in tencent files|nt_qq/nt_db/nt_msg\.db"),
    (TCC_BLOCKED, r"operation not permitted|\btcc\b|权限拦截"),
    (RESIGN_FAILED, r"codesign|重签名"),
    (PERMISSION_DENIED, r"permission denied|access is denied|拒绝访问"),
    (DECRYPT_INCOMPLETE, r"核心数据库未解密|swap 失败|部分数据库未解密"),
    (STORE_INIT_FAILED, r"no decrypted directory found|无法加载这份数据"),
    (DB_BUSY, r"being used by another process|database is locked"),
    (DISK_IO, r"disk i/o error|no space left|磁盘读写错误"),
    (PLATFORM_UNSUPPORTED, r"macos only|windows-only|只支持 windows"),
    (TIMEOUT, r"超时|timed out|timeoutexpired"),
    (LIVE_KEY_FAILED, r"^exit-\d+$"),
    (AGENT_NOT_INSTALLED, r"(claude|codex|gemini|kimi)\b.* not installed|需要同时安装"),
)
_COMPILED = tuple((code, re.compile(pat, re.IGNORECASE | re.MULTILINE)) for code, pat in _RULES)

# When the caller knows the request was about QQ, re-target WeChat-flavoured
# key codes so the frontend shows QQ-specific advice.
_QQ_REMAP = {
    KEY_INVALID: QQ_KEY_INVALID,
    KEY_FORMAT_INVALID: QQ_KEY_INVALID,
    KEY_NOT_FOUND: QQ_KEY_NOT_FOUND,
    WECHAT_DATA_NOT_FOUND: QQ_DATA_NOT_FOUND,
}


def classify(text: Optional[str], scope: str = "wechat") -> Optional[str]:
    """Best-effort map of a raw error / log blob to a stable code.

    Returns ``None`` when nothing matches so the caller can leave ``code``
    unset (frontend then shows the raw text).
    """
    if not text or not isinstance(text, str):
        return None
    for code, rx in _COMPILED:
        if rx.search(text):
            if scope == "qq":
                return _QQ_REMAP.get(code, code)
            return code
    return None


def with_code(payload: dict, code: Optional[str]) -> dict:
    """Return ``payload`` with ``code`` set (unless already present / None)."""
    if code and "code" not in payload:
        payload["code"] = code
    return payload


def annotate(payload, scope: str = "wechat"):
    """Attach ``code`` to an error payload in place, if it can be inferred.

    Only touches dicts that carry a truthy string ``error`` and no ``code`` —
    success payloads and streaming status dicts with ``error: None`` are left
    untouched, so this is safe to call on every response.
    """
    if not isinstance(payload, dict) or "code" in payload:
        return payload
    err = payload.get("error")
    if not err or not isinstance(err, str):
        return payload
    code = classify(err, scope=scope)
    if code:
        payload["code"] = code
    return payload


def refresh_failure_code(details: str, init_error: Optional[str] = None,
                         ok: bool = False) -> Optional[str]:
    """Code for a /api/refresh response.

    ``ok`` + ``init_error`` means decrypt succeeded but the store could not be
    opened afterwards — classify the init error, defaulting to
    STORE_INIT_FAILED. A failed subprocess is classified from its output,
    defaulting to DECRYPT_FAILED.
    """
    if ok:
        if not init_error:
            return None
        return classify(init_error) or STORE_INIT_FAILED
    return classify(details) or DECRYPT_FAILED


def extract_key_failure_code(log: str) -> str:
    """Code for a failed /api/extract-key response (never None)."""
    return classify(log) or KEY_NOT_FOUND
