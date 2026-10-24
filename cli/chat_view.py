"""chat_view.py — paged chat history for the chat page (GET /api/chat/messages).

The friend drawer used to load the newest N messages of a chat in one go.
The chat page needs to page backwards from the newest message, jump to a
date, and open at one message (a search hit), so every message carries a
cursor and pages are cut relative to it.

Order and cursor
    Messages are ordered by (create_time, db file name, local_id). WeChat
    4.x rolls message_*.db over time, so one chat can live in several DB
    files; local_id is only unique inside one file. A cursor is that sort
    key written as "<ts>:<local_id>:<db>" (the db part may itself contain
    ':' — it is split off last). Search hits carry the same three values in
    `locator`, so the frontend can build a cursor for any hit.

Queries
    before=<cursor>   the `limit` messages just older than the cursor
    after=<cursor>    the `limit` messages just newer than the cursor
    around=<cursor>   a window centred on the cursor (the message itself
                      included when it exists); `anchor` names it
    at=<ts|date>      a window around the first message at/after that time
    (none)            the newest `limit` messages

For EchoStore every page is a LIMITed SQL query per message DB, so paging
costs O(page) instead of re-reading the whole chat. Other stores (QQStore)
fall back to materialising the chat once per request and slicing it.

Media: image / video messages get `media = {kind, url}`; `url` is the
existing `/api/media/<md5>` route when that md5 is in media-index.json and
the file exists on disk, else null (the page then shows a type label).

Names and text are returned raw — the frontend applies privacy masking, the
same contract as /api/search. No third-party imports.
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

CST = timezone(timedelta(hours=8))

DEFAULT_LIMIT = 60
MAX_LIMIT = 200

# WeChat local_type values handled specially here.
_IMAGE = 3
_VIDEO = 43
_APPMSG = 49
_SYSTEM = 10000
_REVOKE = 10002

_IMG_MD5_RE = re.compile(r'<img\b[^>]*?\bmd5\s*=\s*"([0-9a-fA-F]{32})"')
_VIDEO_MD5_RE = re.compile(r'<videomsg\b[^>]*?\bmd5\s*=\s*"([0-9a-fA-F]{32})"')
_GROUP_PREFIX_RE = re.compile(r"^[^\s:]+:\n")
_REVOKE_RE = re.compile(r"<revokemsg>([\s\S]*?)</revokemsg>")
_CDATA_RE = re.compile(r"^<!\[CDATA\[([\s\S]*?)\]\]>$")


class CursorError(ValueError):
    pass


# ---------------------------------------------------------------- cursors

def parse_cursor(s: str) -> tuple:
    """"<ts>:<local_id>:<db>" → (ts, db, local_id) sort key."""
    parts = (s or "").split(":", 2)
    if len(parts) != 3:
        raise CursorError(f"bad cursor: {s!r}")
    try:
        ts = int(parts[0])
        local_id = int(parts[1])
    except ValueError:
        raise CursorError(f"bad cursor: {s!r}")
    db = parts[2]
    if "/" in db or "\\" in db:
        raise CursorError(f"bad cursor: {s!r}")
    return (ts, db, local_id)


def format_cursor(key: tuple) -> str:
    ts, db, local_id = key
    return f"{int(ts)}:{int(local_id)}:{db}"


def _key_at(ts: int) -> tuple:
    """A key that sorts before every real message at `ts` (db "" < any name)."""
    return (int(ts), "", -1)


def _key_just_before(key: tuple) -> tuple:
    """`after=_key_just_before(k)` returns k itself first (if it exists)."""
    ts, db, local_id = key
    return (ts, db, local_id - 1)


# ---------------------------------------------------------------- media index

_MEDIA_CACHE: dict = {}  # path → (mtime_ns, index)


def load_media_index(path: Optional[Path]) -> dict:
    """media-index.json (md5 → record), cached on mtime. {} when missing."""
    if path is None:
        return {}
    p = Path(path)
    try:
        st = p.stat()
    except OSError:
        return {}
    cached = _MEDIA_CACHE.get(str(p))
    if cached and cached[0] == st.st_mtime_ns:
        return cached[1]
    try:
        idx = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        idx = {}
    if not isinstance(idx, dict):
        idx = {}
    _MEDIA_CACHE[str(p)] = (st.st_mtime_ns, idx)
    return idx


def media_for(kind: str, raw: Optional[str], media_index: dict) -> dict:
    rx = _IMG_MD5_RE if kind == "image" else _VIDEO_MD5_RE
    m = rx.search(raw or "")
    url = None
    if m:
        md5 = m.group(1).lower()
        rec = media_index.get(md5) or media_index.get(m.group(1))
        if isinstance(rec, dict) and rec.get("exists") and rec.get("source_path"):
            url = f"/api/media/{md5}"
    return {"kind": kind, "url": url}


# ---------------------------------------------------------------- EchoStore paging

def _is_echo(store) -> bool:
    return hasattr(store, "_locate_msg_dbs") and hasattr(store, "_conn")


def _bound(fname: str, key: tuple, direction: str) -> tuple:
    """SQL condition for rows of `fname` strictly before/after `key`."""
    ts, db, local_id = key
    if direction == "before":
        if fname < db:
            return "create_time <= ?", [ts]
        if fname == db:
            return "(create_time < ? OR (create_time = ? AND local_id < ?))", [ts, ts, local_id]
        return "create_time < ?", [ts]
    if fname < db:
        return "create_time > ?", [ts]
    if fname == db:
        return "(create_time > ? OR (create_time = ? AND local_id > ?))", [ts, ts, local_id]
    return "create_time >= ?", [ts]


def _echo_rows(store, chat: str, key: Optional[tuple], direction: str, limit: int) -> tuple:
    """Up to `limit` raw rows next to `key` → (rows ascending, has_more).

    direction "before" (key None = newest) or "after". A row is
    (ts, db, local_id, sender_raw, mtype, content).
    """
    want = limit + 1
    rows: list = []
    malformed = getattr(store, "_known_malformed", set())
    for fname, table in store._locate_msg_dbs(chat):
        if fname in malformed:
            continue
        c = store._conn(fname)
        try:
            cols = {r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
            compress = "compress_content" if "compress_content" in cols else "NULL"
            where, params = ("", [])
            if key is not None:
                cond, params = _bound(fname, key, direction)
                where = " WHERE " + cond
            order = "DESC" if direction == "before" else "ASC"
            sql = (f"SELECT local_id, create_time, real_sender_id, local_type, message_content, "
                   f"{compress} FROM {table}{where} "
                   f"ORDER BY create_time {order}, local_id {order} LIMIT ?")
            got = c.execute(sql, params + [want]).fetchall()
            ids = sorted({r[2] for r in got if r[2] is not None})
            n2i: dict = {}
            if ids:
                try:
                    for i in range(0, len(ids), 500):
                        part = ids[i:i + 500]
                        n2i.update(c.execute(
                            f"SELECT rowid, user_name FROM Name2Id WHERE rowid IN ({','.join('?' * len(part))})",
                            part).fetchall())
                except sqlite3.DatabaseError:
                    n2i = {}
            for local_id, ts, sender_id, mtype, content, comp in got:
                content = _prefer_compressed(int(mtype or 0), content, comp)
                rows.append((int(ts or 0), fname, int(local_id or 0),
                             n2i.get(sender_id, f"<id_{sender_id}>"), int(mtype or 0), content))
        except sqlite3.DatabaseError as e:
            if "malformed" in str(e).lower():
                try:
                    malformed.add(fname)
                except AttributeError:
                    pass
                sys.stderr.write(f"[chat-view] skipping malformed DB {fname}\n")
                continue
            raise
        finally:
            c.close()
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    has_more = len(rows) > limit
    if direction == "before":
        rows = rows[-limit:] if limit else []
    else:
        rows = rows[:limit]
    return rows, has_more


def _prefer_compressed(mtype: int, content, compress):
    # Same rule as etcli._prefer_compressed_text (not imported: under
    # `etcli.py serve` that module is __main__, and importing it by name
    # would load a second copy): text rows keep their real body in a
    # zstd-wrapped compress_content.
    if (mtype == 1
            and isinstance(compress, (bytes, bytearray))
            and len(compress) >= 4
            and bytes(compress[:4]) == b"\x28\xb5\x2f\xfd"):
        return bytes(compress)
    return content


def _base_type(mtype: int) -> int:
    # WeChat 4.x packs the appmsg sub-type into the high 32 bits of local_type.
    if mtype > 0xFFFFFFFF and (mtype & 0xFFFFFFFF) == _APPMSG:
        return _APPMSG
    return mtype


def _label_for(store, mtype: int) -> str:
    if _base_type(mtype) != mtype:
        return "share"
    # MSG_TYPES lives next to the store class (etcli, possibly as __main__).
    labels = getattr(sys.modules.get(type(store).__module__), "MSG_TYPES", None) or {}
    return labels.get(mtype, f"type_{mtype}")


def _system_text(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    s = raw.strip()
    if not s.startswith("<"):
        s = _GROUP_PREFIX_RE.sub("", s, count=1).strip()
        return s or None
    m = _REVOKE_RE.search(s)
    if m:
        inner = m.group(1).strip()
        cd = _CDATA_RE.match(inner)
        return (cd.group(1) if cd else inner).strip() or None
    return None


def _echo_items(store, chat: str, rows: list, media_index: dict) -> list:
    is_group = chat.endswith("@chatroom")
    contacts = store.contacts()
    me = getattr(store, "me", None)

    def name_of(wxid: str) -> str:
        if wxid == "self":
            return "你"
        ct = contacts.get(wxid)
        if ct:
            return ct.display()
        return f"~{wxid[-6:]}" if wxid.startswith("wxid_") else wxid

    out = []
    for ts, fname, local_id, sender_raw, mtype, content in rows:
        if is_group:
            sender = "self" if sender_raw == me else sender_raw
        else:
            sender = "self" if sender_raw == me else chat
        base = _base_type(mtype)
        try:
            text = store._render_content(base, content, is_group)
        except Exception:
            text = ""
        media = None
        if base in (_IMAGE, _VIDEO, _SYSTEM, _REVOKE):
            try:
                raw = store._decode_raw(content)
            except Exception:
                raw = None
            if base == _IMAGE:
                media = media_for("image", raw, media_index)
            elif base == _VIDEO:
                media = media_for("video", raw, media_index)
            else:
                text = _system_text(raw) or text
        out.append({
            "id": format_cursor((ts, fname, local_id)),
            "ts": ts,
            "time": datetime.fromtimestamp(ts, CST).isoformat(),
            "from": name_of(sender),
            "from_id": sender,
            "type": _label_for(store, mtype),
            "type_code": mtype,
            "text": text,
            "media": media,
        })
    return out


def _echo_meta(store, chat: str) -> dict:
    count = 0
    first = None
    last = None
    malformed = getattr(store, "_known_malformed", set())
    for fname, table in store._locate_msg_dbs(chat):
        if fname in malformed:
            continue
        c = store._conn(fname)
        try:
            n, lo, hi = c.execute(f"SELECT COUNT(*), MIN(create_time), MAX(create_time) FROM {table}").fetchone()
        except sqlite3.DatabaseError:
            continue
        finally:
            c.close()
        count += int(n or 0)
        if lo is not None:
            first = int(lo) if first is None else min(first, int(lo))
        if hi is not None:
            last = int(hi) if last is None else max(last, int(hi))
    return {"count": count, "first_ts": first, "last_ts": last}


# ---------------------------------------------------------------- generic fallback

class _ListSource:
    """Any store with messages(): materialise once, page in memory."""

    def __init__(self, store, chat: str):
        msgs = list(store.messages(chat, text_only=False))
        msgs.sort(key=lambda m: int(m.create_time))
        self.msgs = msgs
        self.keys = [(int(m.create_time), "", i) for i, m in enumerate(msgs)]

    def rows(self, key: Optional[tuple], direction: str, limit: int) -> tuple:
        import bisect
        if direction == "before":
            hi = len(self.keys) if key is None else bisect.bisect_left(self.keys, key)
            lo = max(0, hi - limit)
            return list(range(lo, hi)), lo > 0
        lo = bisect.bisect_right(self.keys, key) if key is not None else 0
        hi = min(len(self.keys), lo + limit)
        return list(range(lo, hi)), hi < len(self.keys)

    def items(self, idxs: list) -> list:
        out = []
        for i in idxs:
            m = self.msgs[i]
            out.append({
                "id": format_cursor(self.keys[i]),
                "ts": int(m.create_time),
                "time": datetime.fromtimestamp(int(m.create_time), CST).isoformat(),
                "from": m.sender_name,
                "from_id": m.sender_wxid,
                "type": m.raw_type_label,
                "type_code": int(getattr(m, "msg_type", 0) or 0),
                "text": m.text,
                "media": None,
            })
        return out

    def meta(self) -> dict:
        return {
            "count": len(self.msgs),
            "first_ts": self.keys[0][0] if self.keys else None,
            "last_ts": self.keys[-1][0] if self.keys else None,
        }


# ---------------------------------------------------------------- entry point

def chat_page(store, chat: str, *, before: Optional[str] = None, after: Optional[str] = None,
              around: Optional[str] = None, at: Optional[int] = None,
              limit: int = DEFAULT_LIMIT, media_index_path: Optional[Path] = None) -> dict:
    """Build the /api/chat/messages payload. Raises CursorError on bad input."""
    given = [n for n, v in (("before", before), ("after", after), ("around", around), ("at", at))
             if v not in (None, "")]
    if len(given) > 1:
        raise CursorError("only one of before / after / around / at")
    limit = max(1, min(int(DEFAULT_LIMIT if limit is None else limit), MAX_LIMIT))
    echo = _is_echo(store)
    media_index = load_media_index(media_index_path) if echo else {}
    src = None if echo else _ListSource(store, chat)

    def page(key, direction, n):
        # n == 0 still runs (cheaply) so has_more stays accurate.
        if echo:
            rows, more = _echo_rows(store, chat, key, direction, n)
            return _echo_items(store, chat, rows, media_index), more
        idxs, more = src.rows(key, direction, n)
        return src.items(idxs), more

    payload: dict = {"messages": [], "has_more_before": None, "has_more_after": None, "anchor": None}
    if before not in (None, ""):
        msgs, more = page(parse_cursor(before), "before", limit)
        payload.update(messages=msgs, has_more_before=more)
        return payload
    if after not in (None, ""):
        msgs, more = page(parse_cursor(after), "after", limit)
        payload.update(messages=msgs, has_more_after=more)
        return payload

    # Initial loads also describe the chat.
    target = None
    if around not in (None, ""):
        target = parse_cursor(around)
        older_key, newer_key = target, _key_just_before(target)
    elif at not in (None, ""):
        older_key = newer_key = _key_at(int(at))
    else:
        older_key = newer_key = None

    if older_key is None:
        msgs, more_before = page(None, "before", limit)
        payload.update(messages=msgs, has_more_before=more_before, has_more_after=False)
    else:
        n_newer = limit - limit // 2
        newer, more_after = page(newer_key, "after", n_newer)
        older, more_before = page(older_key, "before", limit - len(newer))
        msgs = older + newer
        payload.update(messages=msgs, has_more_before=more_before, has_more_after=more_after)
        anchor = None
        if target is not None:
            want = format_cursor(target)
            anchor = next((m["id"] for m in newer if m["id"] == want), None)
        if anchor is None and newer:
            anchor = newer[0]["id"]
        if anchor is None and older:
            anchor = older[-1]["id"]
        payload["anchor"] = anchor

    try:
        contact = store.contact(chat)
        name = contact.display() if contact else chat
    except Exception:
        name = chat
    meta = _echo_meta(store, chat) if echo else src.meta()
    payload["chat"] = {
        "id": chat,
        "name": name or chat,
        "is_group": chat.endswith("@chatroom"),
        "platform": "wechat" if echo else "qq",
        **meta,
    }
    return payload
