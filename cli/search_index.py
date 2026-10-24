"""search_index.py — incremental full-text index over decrypted chat history.

Murmur keeps its own SQLite file per account under
``<murmur_home>/search_index/<platform>-<account>.sqlite`` — it never writes
into WeChat's / QQ's decrypted databases. Message rows are read through the
platform store (``EchoStore.iter_table_rows`` for WeChat 4.x,
``QQStore.iter_table_rows`` for QQ NT) so content rendering (zstd
``compress_content``, appmsg XML, QQ protobuf elements) stays in one place.

Index layout:
    messages   one row per indexed message (chat, sender, ts, type, text,
               locator = db file + table + local_id/rowid + server_id)
    msg_fts    FTS5 external-content table over messages.text with the
               ``trigram`` tokenizer (CJK substring search). Only created when
               the running SQLite supports it (3.34+); otherwise the index runs
               in ``like`` mode and searches scan ``messages.text`` with LIKE.
    progress   per (db file, table) high-water mark of the source key
    sources    per db file (mtime_ns, size) — unchanged files are skipped

Incremental rule: a source file whose (mtime, size) changed is re-scanned,
but only rows whose key is above the stored high-water mark are read. If a
table's max key drops below the mark (file was replaced), that table is
purged and re-indexed. Edits/revokes of already-indexed rows are not picked
up incrementally — a rebuild handles those.

Trigram needs >= 3 characters per term to use the index; shorter terms
(very common in Chinese: 2-character words) fall back to LIKE on the
messages table, so they still match, just without the index.

No third-party imports here: zstandard is only touched lazily inside
EchoStore._render_content.
"""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Optional

CST = timezone(timedelta(hours=8))

SCHEMA_VERSION = 1
BATCH_ROWS = 1000
MAX_TERMS = 8
MAX_LIMIT = 200
SNIPPET_RADIUS = 40

# Columns (alias `m` = messages) that format_rows() expects, in order.
ROW_COLUMNS = ("m.platform, m.chat, m.is_group, m.sender, m.sender_hint, m.ts, m.type, "
               "m.type_label, m.text, m.src, m.tbl, m.local_id, m.server_id")

MODE_FTS = "fts5_trigram"
MODE_LIKE = "like"

# A rendered message that is nothing but a type stub ("[image]", "[图片]",
# "[链接]") carries no searchable text — skip it to keep the index small.
_STUB_RE = re.compile(r"^\[[^\]\n]{0,24}\]$")

_TRIGRAM_OK: Optional[bool] = None


def fts5_trigram_available() -> bool:
    """True when the running SQLite has FTS5 with the trigram tokenizer."""
    global _TRIGRAM_OK
    if _TRIGRAM_OK is None:
        try:
            c = sqlite3.connect(":memory:")
            try:
                c.execute("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')")
                _TRIGRAM_OK = True
            finally:
                c.close()
        except sqlite3.Error:
            _TRIGRAM_OK = False
    return _TRIGRAM_OK


def default_index_dir() -> Path:
    override = os.environ.get("MURMUR_SEARCH_INDEX_DIR")
    if override:
        return Path(override).expanduser()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import paths as _paths  # noqa: E402
    return _paths.murmur_home() / "search_index"


def _safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._@-]+", "_", s)[:80] or "default"


def platform_of(store) -> str:
    return "qq" if store.__class__.__name__ == "QQStore" else "wechat"


def index_path_for(store, platform: str, base_dir: Optional[Path] = None) -> Path:
    base = Path(base_dir) if base_dir is not None else default_index_dir()
    return base / f"{platform}-{_safe_name(Path(store.dir).name)}.sqlite"


class _Cancelled(Exception):
    pass


class _RenderCtx:
    """Private zstd holder so the indexer thread never shares EchoStore._zstd."""
    _zstd = None


# ---------------------------------------------------------------------------
# Source adapters: enumerate (file, table) pairs and yield normalized rows.
# ---------------------------------------------------------------------------

class _WeChatSource:
    platform = "wechat"
    key_name = "local_id"

    def __init__(self, store):
        self.store = store
        self._ctx = _RenderCtx()
        self._chat_by_table: Optional[dict[str, str]] = None

    def chat_by_table(self) -> dict[str, str]:
        if self._chat_by_table is None:
            m: dict[str, str] = {}
            names: set[str] = set()
            try:
                names.update(s.username for s in self.store.sessions())
            except Exception:
                pass
            try:
                names.update(self.store.contacts().keys())
            except Exception:
                pass
            for u in names:
                if u:
                    m[f"Msg_{hashlib.md5(u.encode()).hexdigest()}"] = u
            self._chat_by_table = m
        return self._chat_by_table

    def files(self) -> list[str]:
        known_bad = getattr(self.store, "_known_malformed", set())
        return [f for f in self.store.message_db_files() if f not in known_bad]

    def file_path(self, fname: str) -> Path:
        return Path(self.store.dir) / fname

    def tables(self, fname: str) -> list[str]:
        c = self.store._conn(fname)
        try:
            return [r[0] for r in c.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
            ).fetchall()]
        finally:
            c.close()

    def stats(self, fname: str, table: str, after: int) -> tuple[int, int, Optional[int]]:
        """(max key in table, rows with key > after, create_time of row `after`)."""
        c = self.store._conn(fname)
        try:
            mx = c.execute(f"SELECT MAX(local_id) FROM {table}").fetchone()[0] or 0
            n = c.execute(f"SELECT COUNT(*) FROM {table} WHERE local_id > ?", (after,)).fetchone()[0]
            row = c.execute(f"SELECT create_time FROM {table} WHERE local_id = ?", (after,)).fetchone()
            return int(mx), int(n or 0), (int(row[0] or 0) if row else None)
        finally:
            c.close()

    def rows(self, fname: str, table: str, after: int) -> Iterator[dict]:
        chat = self.chat_by_table().get(table, "")
        is_group = chat.endswith("@chatroom")
        me = getattr(self.store, "me", None)
        for r in self.store.iter_table_rows(fname, table, after, is_group=is_group,
                                            render_ctx=self._ctx):
            raw = r["sender_raw"] or ""
            if raw and raw == me:
                sender = "self"
            elif chat and not is_group:
                sender = chat
            else:
                sender = raw
            yield {
                "key": r["local_id"],
                "server_id": r["server_id"],
                "chat": chat,
                "is_group": is_group,
                "sender": sender,
                "sender_hint": "",
                "ts": r["ts"],
                "type": r["type"],
                "type_label": r["type_label"],
                "text": r["text"],
            }


class _QQSource:
    platform = "qq"
    key_name = "rowid"
    TABLES = ("c2c_msg_table", "group_msg_table")

    def __init__(self, store):
        self.store = store

    def chat_by_table(self) -> dict[str, str]:
        return {}

    def files(self) -> list[str]:
        return ["nt_msg.db"]

    def file_path(self, fname: str) -> Path:
        return Path(self.store.dir) / fname

    def tables(self, fname: str) -> list[str]:
        c = self.store._conn(fname)
        try:
            have = {r[0] for r in c.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        finally:
            c.close()
        return [t for t in self.TABLES if t in have]

    def stats(self, fname: str, table: str, after: int) -> tuple[int, int, Optional[int]]:
        c = self.store._conn(fname)
        try:
            mx = c.execute(f"SELECT MAX(rowid) FROM {table}").fetchone()[0] or 0
            n = c.execute(f"SELECT COUNT(*) FROM {table} WHERE rowid > ?", (after,)).fetchone()[0]
            row = c.execute(f'SELECT "40050" FROM {table} WHERE rowid = ?', (after,)).fetchone()
            return int(mx), int(n or 0), (int(row[0] or 0) if row else None)
        finally:
            c.close()

    def rows(self, fname: str, table: str, after: int) -> Iterator[dict]:
        for r in self.store.iter_table_rows(table, after):
            yield {
                "key": r["rowid"],
                "server_id": r["msg_id"],
                "chat": r["chat"],
                "is_group": r["is_group"],
                "sender": r["sender"],
                "sender_hint": r.get("group_disp") or "",
                "ts": r["ts"],
                "type": r["type"],
                "type_label": r["type_label"],
                "text": r["text"],
            }


def _make_source(store, platform: str):
    return _QQSource(store) if platform == "qq" else _WeChatSource(store)


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------

def parse_time_param(v, *, end: bool = False) -> Optional[int]:
    """Unix seconds, 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM' (China time).

    A date-only `to` bound means the end of that day. Raises ValueError.
    """
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    for fmt, span in (("%Y-%m-%d", 86399), ("%Y-%m-%d %H:%M", 59), ("%Y-%m-%dT%H:%M", 59)):
        try:
            ts = int(datetime.strptime(s, fmt).replace(tzinfo=CST).timestamp())
            return ts + span if end else ts
        except ValueError:
            continue
    raise ValueError(f"无法解析时间: {s}（支持 unix 秒或 YYYY-MM-DD）")


def split_terms(q: str) -> list[str]:
    terms: list[str] = []
    for t in (q or "").split():
        if t and t not in terms:
            terms.append(t)
    return terms[:MAX_TERMS]


def _csv(v) -> list[str]:
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        items = []
        for x in v:
            items.extend(_csv(x))
        return items
    return [x.strip() for x in str(v).split(",") if x.strip()]


def _like_escape(t: str) -> str:
    return t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def build_snippet(text: str, terms: list[str], radius: int = SNIPPET_RADIUS) -> dict:
    """Window around the first hit plus highlight info.

    Returns {"snippet", "segments": [{"text", "hit"}], "highlights": [[s, e]]}
    where highlights are UTF-16 code-unit offsets into `snippet` (what JS
    String indices use).
    """
    text = text or ""
    # Case-insensitive like the search itself; only when lowering keeps
    # offsets aligned (it does for CJK and ASCII, not for e.g. "İ").
    hay = text.lower()
    fold = len(hay) == len(text)
    if not fold:
        hay = text
    spans: list[tuple[int, int]] = []
    for t in terms:
        needle = t.lower() if fold else t
        if len(needle) != len(t):
            needle = t
        if not needle:
            continue
        start = 0
        while True:
            i = hay.find(needle, start)
            if i < 0:
                break
            spans.append((i, i + len(needle)))
            start = i + max(1, len(needle))
    spans.sort()
    merged: list[list[int]] = []
    for s, e in spans:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    if merged:
        first = merged[0][0]
        w_start = max(0, first - radius)
        w_end = min(len(text), max(merged[0][1], first) + radius * 2)
    else:
        w_start, w_end = 0, min(len(text), radius * 3)
    prefix = "…" if w_start > 0 else ""
    suffix = "…" if w_end < len(text) else ""
    body = text[w_start:w_end]
    segments: list[dict] = []
    highlights: list[list[int]] = []
    pos = 0
    cursor16 = _utf16_len(prefix)
    if prefix:
        segments.append({"text": prefix, "hit": False})
    for s, e in merged:
        s2, e2 = max(s, w_start) - w_start, min(e, w_end) - w_start
        if e2 <= s2 or s2 < pos:
            continue
        if s2 > pos:
            seg = body[pos:s2]
            segments.append({"text": seg, "hit": False})
            cursor16 += _utf16_len(seg)
        hit = body[s2:e2]
        segments.append({"text": hit, "hit": True})
        highlights.append([cursor16, cursor16 + _utf16_len(hit)])
        cursor16 += _utf16_len(hit)
        pos = e2
    if pos < len(body):
        segments.append({"text": body[pos:], "hit": False})
    if suffix:
        segments.append({"text": suffix, "hit": False})
    return {"snippet": prefix + body + suffix, "segments": segments, "highlights": highlights}


# ---------------------------------------------------------------------------
# The index
# ---------------------------------------------------------------------------

class SearchIndex:
    def __init__(self, store, platform: str, path: Path, *, mode: Optional[str] = None):
        self.store = store
        self.platform = platform
        self.path = Path(path)
        if mode is None:
            mode = MODE_FTS if fts5_trigram_available() else MODE_LIKE
        if mode == MODE_FTS and not fts5_trigram_available():
            mode = MODE_LIKE
        self.mode = mode
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._pending: Optional[str] = None  # None | "incr" | "full"
        self._cancel = False
        self._progress = {"state": "idle", "phase": "", "done": 0, "total": 0,
                          "full": False, "started_at": None, "finished_at": None,
                          "last_error": None, "added": 0}
        self._name_cache: Optional[tuple[int, dict]] = None

    # --- connection / schema ---

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(str(self.path), timeout=30, check_same_thread=False)
        try:
            c.execute("PRAGMA journal_mode=WAL")
        except sqlite3.Error:
            pass
        c.execute("PRAGMA busy_timeout=30000")
        return c

    def _source_dir(self) -> str:
        return str(Path(self.store.dir).resolve())

    def _create_schema(self, c: sqlite3.Connection) -> None:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS sources (
                src TEXT PRIMARY KEY, mtime_ns INTEGER, size INTEGER, indexed_at REAL);
            CREATE TABLE IF NOT EXISTS progress (
                src TEXT, tbl TEXT, max_key INTEGER, key_ts INTEGER, PRIMARY KEY (src, tbl));
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY,
                platform TEXT NOT NULL,
                chat TEXT NOT NULL,
                is_group INTEGER NOT NULL DEFAULT 0,
                sender TEXT NOT NULL,
                sender_hint TEXT NOT NULL DEFAULT '',
                ts INTEGER NOT NULL,
                type INTEGER NOT NULL,
                type_label TEXT NOT NULL,
                text TEXT NOT NULL,
                src TEXT NOT NULL,
                tbl TEXT NOT NULL,
                local_id INTEGER NOT NULL,
                server_id TEXT,
                UNIQUE (src, tbl, local_id));
            CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
            CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat, ts);
            CREATE INDEX IF NOT EXISTS messages_tbl ON messages(tbl);
            CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender);
        """)
        if self.mode == MODE_FTS:
            c.execute("CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5("
                      "text, content='messages', content_rowid='id', tokenize='trigram')")
        for k, v in (("schema_version", str(SCHEMA_VERSION)), ("mode", self.mode),
                     ("platform", self.platform), ("source_dir", self._source_dir())):
            c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (k, v))
        # Row ids are only stable within one build; a fresh file / full rebuild
        # gets a new build_id so layered indexes (semantic_index) notice.
        c.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('build_id', ?)",
                  (uuid.uuid4().hex,))
        c.commit()

    def build_id(self) -> Optional[str]:
        """Identity of the current build of this index file (None if absent)."""
        if not self.path.exists():
            return None
        try:
            c = sqlite3.connect(str(self.path), timeout=5)
        except sqlite3.Error:
            return None
        try:
            return self._meta(c).get("build_id")
        finally:
            c.close()

    def _meta(self, c: sqlite3.Connection) -> dict:
        try:
            return dict(c.execute("SELECT key, value FROM meta").fetchall())
        except sqlite3.Error:
            return {}

    def _reset_file(self, c: sqlite3.Connection) -> sqlite3.Connection:
        """Start from an empty index. Deleting the file is the robust path (an
        FTS table can't even be dropped by a SQLite without FTS5); if that
        fails (Windows: a reader holds it open) drop the tables instead."""
        c.close()
        try:
            for suffix in ("", "-wal", "-shm"):
                p = Path(str(self.path) + suffix)
                if p.exists():
                    p.unlink()
            return self._connect()
        except OSError:
            c = self._connect()
            names = [r[0] for r in c.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' "
                "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'msg_fts_%'").fetchall()]
            for n in names:
                c.execute(f'DROP TABLE IF EXISTS "{n}"')
            c.commit()
            return c

    def _open_for_write(self, full: bool) -> sqlite3.Connection:
        c = self._connect()
        meta = self._meta(c)
        compatible = (meta.get("schema_version") == str(SCHEMA_VERSION)
                      and meta.get("mode") == self.mode
                      and meta.get("source_dir") == self._source_dir())
        if full or (meta and not compatible):
            c = self._reset_file(c)
        self._create_schema(c)
        return c

    # --- staleness ---

    def _file_sig(self, src, fname: str) -> Optional[tuple[int, int]]:
        try:
            st = os.stat(src.file_path(fname))
            return int(st.st_mtime_ns), int(st.st_size)
        except OSError:
            return None

    def needs_update(self) -> bool:
        """Cheap check: any source file new/changed/removed, or index missing."""
        if not self.path.exists():
            return True
        src = _make_source(self.store, self.platform)
        try:
            c = sqlite3.connect(str(self.path), timeout=5)
        except sqlite3.Error:
            return True
        try:
            meta = self._meta(c)
            if (meta.get("schema_version") != str(SCHEMA_VERSION) or meta.get("mode") != self.mode
                    or meta.get("source_dir") != self._source_dir()):
                return True
            try:
                known = {r[0]: (r[1], r[2]) for r in c.execute(
                    "SELECT src, mtime_ns, size FROM sources").fetchall()}
            except sqlite3.Error:
                return True
        finally:
            c.close()
        try:
            files = src.files()
        except Exception:
            return False
        if set(files) != set(known):
            return True
        for f in files:
            sig = self._file_sig(src, f)
            if sig is None or tuple(known[f]) != sig:
                return True
        return False

    # --- building ---

    def _check_cancel(self) -> None:
        if self._cancel:
            raise _Cancelled()

    def _purge(self, c: sqlite3.Connection, src_name: str, tbl: Optional[str] = None) -> None:
        where = "src = ?" + (" AND tbl = ?" if tbl else "")
        params = (src_name, tbl) if tbl else (src_name,)
        if self.mode == MODE_FTS:
            c.execute(f"INSERT INTO msg_fts(msg_fts, rowid, text) "
                      f"SELECT 'delete', id, text FROM messages WHERE {where}", params)
        c.execute(f"DELETE FROM messages WHERE {where}", params)
        c.execute(f"DELETE FROM progress WHERE {where}", params)

    def update(self, full: bool = False) -> dict:
        """Synchronously bring the index up to date. Returns a summary."""
        src = _make_source(self.store, self.platform)
        p = self._progress
        p.update({"phase": "scanning", "done": 0, "total": 0, "full": bool(full), "added": 0})
        c = self._open_for_write(full)
        added = 0
        try:
            known = {r[0]: (r[1], r[2]) for r in c.execute(
                "SELECT src, mtime_ns, size FROM sources").fetchall()}
            files = src.files()
            # Files that disappeared: drop their rows.
            for gone in set(known) - set(files):
                self._purge(c, gone)
                c.execute("DELETE FROM sources WHERE src = ?", (gone,))
            c.commit()

            # Plan: which (file, table) need work, and how many rows.
            plan: list[tuple[str, str, int, tuple[int, int]]] = []
            failed: set[str] = set()
            total = 0
            for fname in files:
                self._check_cancel()
                sig = self._file_sig(src, fname)
                if sig is None:
                    continue
                if fname in known and tuple(known[fname]) == sig:
                    continue
                try:
                    tables = src.tables(fname)
                except sqlite3.DatabaseError as e:
                    sys.stderr.write(f"[search-index] skip {fname}: {e}\n")
                    continue
                marks = {r[0]: (int(r[1]), r[2]) for r in c.execute(
                    "SELECT tbl, max_key, key_ts FROM progress WHERE src = ?", (fname,)).fetchall()}
                for gone_tbl in set(marks) - set(tables):
                    self._purge(c, fname, gone_tbl)
                for tbl in tables:
                    after, key_ts = marks.get(tbl, (0, None))
                    try:
                        mx, n, ts_now = src.stats(fname, tbl, after)
                        if after and (mx < after or (key_ts is not None and ts_now != key_ts)):
                            # Source table was replaced (shorter, or the row at our
                            # high-water mark is a different message) — start over.
                            self._purge(c, fname, tbl)
                            after = 0
                            mx, n, ts_now = src.stats(fname, tbl, 0)
                    except sqlite3.DatabaseError as e:
                        sys.stderr.write(f"[search-index] skip {fname}:{tbl}: {e}\n")
                        failed.add(fname)
                        continue
                    if n:
                        plan.append((fname, tbl, after, sig))
                        total += n
                plan.append((fname, "", 0, sig))  # marker: record file signature when done
            c.commit()
            p.update({"phase": "indexing", "total": total})

            for fname, tbl, after, sig in plan:
                self._check_cancel()
                if not tbl:
                    if fname in failed:
                        continue  # retry this file on the next pass
                    c.execute("INSERT OR REPLACE INTO sources(src, mtime_ns, size, indexed_at) "
                              "VALUES (?, ?, ?, ?)", (fname, sig[0], sig[1], time.time()))
                    c.commit()
                    continue
                n_added, ok = self._index_table(c, src, fname, tbl, after)
                added += n_added
                if not ok:
                    failed.add(fname)
            p["phase"] = "done"
            p["added"] = added
            return {"added": added, "total": total, "mode": self.mode}
        finally:
            c.close()

    def _index_table(self, c, src, fname: str, tbl: str, after: int) -> tuple[int, bool]:
        p = self._progress
        added = 0
        last_key = after
        last_ts: Optional[int] = None
        ok = True
        pending = 0
        ins = ("INSERT OR IGNORE INTO messages(platform, chat, is_group, sender, sender_hint, ts, type, "
               "type_label, text, src, tbl, local_id, server_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        try:
            for r in src.rows(fname, tbl, after):
                p["done"] += 1
                if int(r["key"]) >= last_key:
                    last_key, last_ts = int(r["key"]), int(r["ts"])
                text = (r["text"] or "").strip()
                if text and not _STUB_RE.match(text):
                    sid = r["server_id"]
                    cur = c.execute(ins, (
                        self.platform, r["chat"] or "", 1 if r["is_group"] else 0,
                        r["sender"] or "", r["sender_hint"] or "", int(r["ts"]), int(r["type"]),
                        r["type_label"], text, fname, tbl, int(r["key"]),
                        None if sid in (None, "", 0) else str(sid)))
                    if cur.rowcount == 1:
                        added += 1
                        if self.mode == MODE_FTS:
                            c.execute("INSERT INTO msg_fts(rowid, text) VALUES (?, ?)",
                                      (cur.lastrowid, text))
                pending += 1
                if pending >= BATCH_ROWS:
                    self._save_mark(c, fname, tbl, last_key, last_ts)
                    c.commit()
                    pending = 0
                    self._check_cancel()
        except sqlite3.DatabaseError as e:
            # Source went bad mid-read (refresh swap / malformed page): keep
            # what we have; the next update resumes from the saved mark.
            sys.stderr.write(f"[search-index] read error {fname}:{tbl}: {e}\n")
            ok = False
        if last_key > after:
            self._save_mark(c, fname, tbl, last_key, last_ts)
        c.commit()
        return added, ok

    @staticmethod
    def _save_mark(c, fname: str, tbl: str, key: int, key_ts: Optional[int]) -> None:
        c.execute("INSERT OR REPLACE INTO progress(src, tbl, max_key, key_ts) VALUES (?, ?, ?, ?)",
                  (fname, tbl, int(key), key_ts))

    # --- background driver ---

    def start_update(self, full: bool = False) -> dict:
        """Kick a background update. If one is running, queue another pass
        (a full rebuild cancels the running pass first)."""
        with self._lock:
            # _thread is cleared by the worker under this lock right before it
            # exits, so "not None" means it will still pick up _pending.
            if self._thread is not None:
                if full:
                    self._pending = "full"
                    self._cancel = True
                elif self._pending is None:
                    self._pending = "incr"
                return {"started": False, "queued": True}
            self._pending = "full" if full else "incr"
            self._cancel = False
            self._thread = threading.Thread(target=self._worker, name="murmur-search-index",
                                            daemon=True)
            self._progress["state"] = "building"
            self._thread.start()
            return {"started": True, "queued": False}

    def _worker(self) -> None:
        while True:
            with self._lock:
                job = self._pending
                self._pending = None
                self._cancel = False
                if job is None:
                    self._progress["state"] = "idle" if not self._progress.get("last_error") else "error"
                    self._progress["finished_at"] = time.time()
                    self._thread = None
                    return
                self._progress["state"] = "building"
                self._progress["started_at"] = time.time()
                self._progress["last_error"] = None
            try:
                self.update(full=(job == "full"))
            except _Cancelled:
                continue
            except Exception as e:  # keep the server alive; surface in status
                msg = f"{type(e).__name__}: {e}"
                sys.stderr.write(f"[search-index] build failed: {msg}\n")
                with self._lock:
                    self._progress["last_error"] = msg

    def wait(self, timeout: Optional[float] = None) -> None:
        t = self._thread
        if t is not None:
            t.join(timeout)

    def is_building(self) -> bool:
        return self._thread is not None

    def ensure_fresh(self) -> bool:
        """Start a background incremental update if sources changed."""
        if self.is_building():
            return False
        try:
            stale = self.needs_update()
        except Exception:
            return False
        if stale:
            self.start_update(full=False)
            return True
        return False

    # --- status ---

    def status(self) -> dict:
        p = dict(self._progress)
        building = self.is_building()
        indexed = 0
        last_built = None
        n_sources = 0
        if self.path.exists():
            try:
                c = sqlite3.connect(str(self.path), timeout=5)
                try:
                    indexed = c.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
                    row = c.execute("SELECT COUNT(*), MAX(indexed_at) FROM sources").fetchone()
                    n_sources, last_built = int(row[0] or 0), row[1]
                finally:
                    c.close()
            except sqlite3.Error:
                pass
        total = int(p.get("total") or 0)
        done = min(int(p.get("done") or 0), total) if total else int(p.get("done") or 0)
        if building:
            state = "building"
        elif p.get("last_error"):
            state = "error"
        elif not n_sources:
            state = "empty"
        else:
            state = "ready"
        return {
            "platform": self.platform,
            "account": Path(self.store.dir).name,
            "mode": self.mode,
            "state": state,
            "phase": p.get("phase") if building else "",
            "full_rebuild": bool(p.get("full")) if building else False,
            "done": done if building else 0,
            "total": total if building else 0,
            "percent": (round(done * 100.0 / total, 1) if (building and total)
                        else (100.0 if state == "ready" else 0.0)),
            "indexed_messages": int(indexed),
            "sources": n_sources,
            "last_built_at": last_built,
            "last_error": p.get("last_error"),
            "short_query_note": ("少于 3 个字的词走逐条匹配（LIKE），速度较慢但结果完整"
                                 if self.mode == MODE_FTS else
                                 "当前 SQLite 不支持 FTS5 trigram，搜索走逐条匹配（LIKE）"),
        }

    # --- search ---

    def _names(self) -> dict:
        try:
            contacts = self.store.contacts()
        except Exception:
            return {}
        return contacts

    def _table_chat_map(self) -> dict[str, str]:
        if self.platform != "wechat":
            return {}
        key = id(getattr(self.store, "_contacts", None))
        if self._name_cache is None or self._name_cache[0] != key:
            self._name_cache = (key, _WeChatSource(self.store).chat_by_table())
        return self._name_cache[1]

    def display_namer(self):
        """Callable username -> display name ("你" for self)."""
        contacts = self._names()

        def disp(u: str) -> str:
            if u == "self":
                return "你"
            ct = contacts.get(u)
            if ct is not None:
                try:
                    return ct.display()
                except Exception:
                    pass
            return u
        return disp

    def format_rows(self, rows) -> list:
        """Turn `SELECT {ROW_COLUMNS}` rows into (result item, text) pairs.

        The item has everything of a search hit except the snippet fields;
        shared with semantic_index so both result kinds have one shape.
        """
        disp = self.display_namer()
        tbl_chat = self._table_chat_map()
        out = []
        for (plat, chat_u, is_group, snd, hint, ts, mtype, label, text, src_name, tbl,
             local_id, server_id) in rows:
            chat_u = chat_u or tbl_chat.get(tbl, "")
            is_g = bool(is_group) or chat_u.endswith("@chatroom")
            if snd == "self":
                snd_name = "你"
            elif hint:
                snd_name = hint
            else:
                snd_name = disp(snd) if snd else ""
            item = {
                "platform": plat,
                "chat": chat_u,
                "chat_name": disp(chat_u) if chat_u else tbl,
                "is_group": is_g,
                "sender": snd,
                "sender_name": snd_name,
                "ts": int(ts),
                "time": datetime.fromtimestamp(int(ts), CST).isoformat(),
                "type": label,
                "type_code": int(mtype),
                "locator": {
                    "db": src_name,
                    "table": tbl,
                    "local_id": int(local_id),
                    "server_id": server_id,
                },
            }
            out.append((item, text))
        return out

    def search(self, q: str, *, chat=None, sender=None, ts_from: Optional[int] = None,
               ts_to: Optional[int] = None, types=None, limit: int = 50, offset: int = 0) -> dict:
        terms = split_terms(q)
        if not terms:
            raise ValueError("q 不能为空")
        limit = max(1, min(int(limit or 50), MAX_LIMIT))
        offset = max(0, int(offset or 0))
        wheres: list[str] = []
        params: list = []
        # Trigram phrase match == substring match for terms of >= 3 chars.
        fts_terms = [t for t in terms if self.mode == MODE_FTS and len(t) >= 3]
        like_terms = [t for t in terms if t not in fts_terms]
        if fts_terms:
            expr = " AND ".join('"' + t.replace('"', '""') + '"' for t in fts_terms)
            wheres.append("m.id IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?)")
            params.append(expr)
        for t in like_terms:
            wheres.append("m.text LIKE ? ESCAPE '\\'")
            params.append(f"%{_like_escape(t)}%")
        chats = _csv(chat)
        if chats:
            if self.platform == "wechat":
                tbls = [f"Msg_{hashlib.md5(x.encode()).hexdigest()}" for x in chats]
                wheres.append(f"(m.chat IN ({','.join('?' * len(chats))}) "
                              f"OR m.tbl IN ({','.join('?' * len(tbls))}))")
                params.extend(chats)
                params.extend(tbls)
            else:
                wheres.append(f"m.chat IN ({','.join('?' * len(chats))})")
                params.extend(chats)
        senders = _csv(sender)
        if senders:
            wheres.append(f"m.sender IN ({','.join('?' * len(senders))})")
            params.extend(senders)
        if ts_from is not None:
            wheres.append("m.ts >= ?")
            params.append(int(ts_from))
        if ts_to is not None:
            wheres.append("m.ts <= ?")
            params.append(int(ts_to))
        type_items = _csv(types)
        if type_items:
            nums = [int(x) for x in type_items if re.fullmatch(r"-?\d+", x)]
            labels = [x for x in type_items if not re.fullmatch(r"-?\d+", x)]
            ors = []
            if nums:
                ors.append(f"m.type IN ({','.join('?' * len(nums))})")
                params.extend(nums)
            if labels:
                ors.append(f"m.type_label IN ({','.join('?' * len(labels))})")
                params.extend(labels)
            wheres.append("(" + " OR ".join(ors) + ")")
        where_sql = " AND ".join(wheres) if wheres else "1"
        match = "fts" if fts_terms and not like_terms else ("like" if not fts_terms else "fts+like")

        rows: list = []
        total = 0
        if self.path.exists():
            c = sqlite3.connect(str(self.path), timeout=10)
            try:
                try:
                    total = c.execute(f"SELECT COUNT(*) FROM messages m WHERE {where_sql}",
                                      params).fetchone()[0]
                    rows = c.execute(
                        f"SELECT {ROW_COLUMNS} "
                        f"FROM messages m WHERE {where_sql} ORDER BY m.ts DESC, m.id DESC "
                        "LIMIT ? OFFSET ?", params + [limit, offset]).fetchall()
                except sqlite3.OperationalError as e:
                    # Index not built yet (no tables) — report empty instead of 500.
                    if "no such table" not in str(e):
                        raise
            finally:
                c.close()

        results = [dict(item, **build_snippet(text, terms))
                   for item, text in self.format_rows(rows)]
        return {
            "query": q,
            "terms": terms,
            "mode": self.mode,
            "match": match,
            "total": int(total),
            "limit": limit,
            "offset": offset,
            "results": results,
        }


# ---------------------------------------------------------------------------
# Process-wide registry (one SearchIndex per index file)
# ---------------------------------------------------------------------------

_REGISTRY: dict[str, SearchIndex] = {}
_REGISTRY_LOCK = threading.Lock()


def get_index(store, platform: Optional[str] = None, base_dir: Optional[Path] = None,
              mode: Optional[str] = None) -> SearchIndex:
    plat = platform or platform_of(store)
    path = index_path_for(store, plat, base_dir)
    key = str(path)
    with _REGISTRY_LOCK:
        idx = _REGISTRY.get(key)
        if idx is None:
            idx = SearchIndex(store, plat, path, mode=mode)
            _REGISTRY[key] = idx
        elif idx.store is not store:
            # Same account dir, new store object (refresh / profile switch).
            idx.store = store
            idx._name_cache = None
        return idx
