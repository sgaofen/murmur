"""Scrub personal identifiers out of the diag bundle before users paste it
into a public GitHub issue.

Covered (see tests/test_diag_redact.py):
  * home directory / OS user name inside paths (macOS, Linux, Windows)
  * WeChat ids: ``wxid_…`` and custom account folder names under
    ``xwechat_files`` / ``WeChat Files``
  * group ids ``123456@chatroom``
  * QQ numbers (``qq:123…``, ``Tencent Files/<qq>``, ``QQ 123…``)
  * mainland China mobile numbers
  * long hex strings (keys, salts, md5s) — 32+ hex chars
  * nicknames: values of ``nick_name=``/``昵称:`` style fields, plus any
    caller-supplied names (e.g. the account's own nickname)

Replacements keep a short stable hash where it helps debugging (the same
wxid always maps to the same token inside one bundle, and across bundles)
without revealing the original. Pure stdlib.
"""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Iterable, Optional


def _h(s: str, n: int = 4) -> str:
    return hashlib.sha256(s.encode("utf-8", "replace")).hexdigest()[:n]


# Order matters: hex first (so a 64-hex key embedded in a path is gone before
# path rules run), then ids, then free-form numbers.
_HEX_RE = re.compile(r"(?<![0-9A-Za-z])(?:0x)?([0-9a-fA-F]{32,})(?![0-9A-Za-z])")
_WXID_RE = re.compile(r"wxid_[A-Za-z0-9_-]+")
_CHATROOM_RE = re.compile(r"\b\d{5,}@chatroom\b")
# Account folder right after xwechat_files / WeChat Files, e.g.
#   .../xwechat_files/alice_1a2b/db_storage  →  .../xwechat_files/<acct#3f9c>/db_storage
_ACCT_DIR_RE = re.compile(r"((?:xwechat_files|WeChat Files)[\\/]+)([^\\/\s`'\"]+)")
_TENCENT_QQ_RE = re.compile(r"(Tencent Files[\\/]+)(\d{5,12})")
_QQ_PREFIX_RE = re.compile(r"\b(qq[:_ ]?|QQ ?)(\d{5,12})\b", re.IGNORECASE)
# CN mobile: 1[3-9]x xxxx xxxx, optional +86 / 86 prefix and separators.
_PHONE_RE = re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)")
# Field-style nicknames in logs/JSON: nick_name=foo, "nickname": "foo", 昵称: foo, 备注：foo
_NICK_FIELD_RE = re.compile(
    r"""(?P<k>["']?(?:nick_?name|nickname|remark|display_name|昵称|备注)["']?\s*[:=：]\s*)"""
    r"""(?P<v>"[^"\n]*"|'[^'\n]*'|[^\s,;}\]）)]+)""",
    re.IGNORECASE,
)
# User-name segment in absolute paths, for homes other than the current one
# (e.g. paths logged by a root subprocess, or another user's profile).
_USER_PATH_RES = (
    re.compile(r"(/Users/)([^/\s`'\"]+)"),
    re.compile(r"(/home/)([^/\s`'\"]+)"),
    re.compile(r"([A-Za-z]:\\+Users\\+)([^\\\s`'\"]+)", re.IGNORECASE),
    re.compile(r"([A-Za-z]:/Users/)([^/\s`'\"]+)", re.IGNORECASE),
)
_KEEP_USERS = {"shared", "public", "default", "all users", "<user>", "~"}


def _home_variants(home: Optional[str]) -> list[str]:
    if not home:
        return []
    out = {home, home.replace("\\", "/"), home.replace("/", "\\")}
    return sorted((h for h in out if len(h) > 3), key=len, reverse=True)


def redact(text: Optional[str], *, home: Optional[str] = None,
           names: Iterable[str] = ()) -> Optional[str]:
    """Return ``text`` with personal identifiers replaced by placeholders.

    ``home`` defaults to the current user's home dir; ``names`` are extra
    literal strings (nicknames, remarks) to blank out wherever they appear.
    """
    if not text:
        return text
    out = str(text)
    if home is None:
        try:
            home = str(Path.home())
        except Exception:
            home = None

    # 1. Caller-supplied literal names (longest first so substrings don't win).
    for n in sorted({n.strip() for n in names if n and len(n.strip()) >= 2}, key=len, reverse=True):
        out = out.replace(n, f"<name#{_h(n)}>")

    # 2. Long hex (keys / salts / md5s).
    out = _HEX_RE.sub(lambda m: f"<hex{len(m.group(1))}>", out)

    # 3. Home dir → ~, then any remaining user-name path segment.
    for hv in _home_variants(home):
        out = out.replace(hv, "~")
    for rx in _USER_PATH_RES:
        out = rx.sub(lambda m: m.group(1) + (m.group(2) if m.group(2).lower() in _KEEP_USERS else "<user>"), out)

    # 4. WeChat / QQ identifiers.
    out = _ACCT_DIR_RE.sub(lambda m: m.group(1) + (
        m.group(2) if m.group(2).startswith(("<", "all_users")) else f"<acct#{_h(m.group(2))}>"), out)
    out = _WXID_RE.sub(lambda m: f"wxid_<{_h(m.group(0))}>", out)
    out = _CHATROOM_RE.sub(lambda m: f"<room#{_h(m.group(0))}>@chatroom", out)
    out = _TENCENT_QQ_RE.sub(lambda m: m.group(1) + f"<qq#{_h(m.group(2))}>", out)
    out = _QQ_PREFIX_RE.sub(lambda m: m.group(1) + f"<qq#{_h(m.group(2))}>", out)

    # 5. Phone numbers, then nickname-ish fields.
    out = _PHONE_RE.sub("<phone>", out)
    out = _NICK_FIELD_RE.sub(_mask_nick_field, out)
    return out


def _mask_nick_field(m: "re.Match[str]") -> str:
    v = m.group("v")
    q = v[0] if v[:1] in ("'", '"') else ""
    inner = v[1:-1] if q else v
    if inner in ("", "-") or inner.startswith("<name#"):
        return m.group(0)
    return f"{m.group('k')}{q}<name#{_h(inner)}>{q}"


def default_home() -> Optional[str]:
    try:
        return str(Path.home())
    except Exception:
        return os.environ.get("HOME") or os.environ.get("USERPROFILE")
