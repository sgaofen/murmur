#!/usr/bin/env python3
"""etcli — EchoTrace 数据查询 CLI

读取 echotrace 解密后的 SQLite 数据库，输出 JSON / JSONL，
方便交给 Claude Code、Codex 等模型做人际关系分析。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Iterable, Iterator, Optional

CST = timezone(timedelta(hours=8))

MSG_TYPES = {
    1: "text", 3: "image", 34: "voice", 42: "card", 43: "video",
    47: "emoji", 48: "location", 49: "share", 50: "voip",
    62: "video_call", 10000: "system", 10002: "revoke",
}


# ---------- config / discovery ----------

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paths as _paths  # noqa: E402  (cross-platform discovery helper)


def _flutter_prefs_path() -> Path:
    """Legacy echotrace shared prefs (read for back-compat key reuse)."""
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData/Roaming")
    return Path(base) / "com.example/echotrace/shared_preferences.json"


def _spawn_etcli_args(subcmd: str, *args: str) -> list:
    """Build subprocess argv for invoking an etcli sub-task.

    When frozen (PyInstaller etcli{.exe}), sys.executable IS the binary and
    accepts these subcommands: refresh / extract-key / extract-key-mac / batch.
    When dev mode (python etcli.py), we dispatch to the original .py scripts.
    """
    if getattr(sys, "frozen", False):
        if subcmd == "batch":
            return [sys.executable, "batch", "--", *args]
        return [sys.executable, subcmd, *args]
    cli_dir = Path(__file__).resolve().parent
    if subcmd == "refresh":
        return [sys.executable, str(cli_dir / "refresh.py"), *args]
    if subcmd == "extract-key":
        return [sys.executable, "-u", str(cli_dir / "extract_key_dll.py"), *args]
    if subcmd == "extract-key-mac":
        return [sys.executable, "-u", str(cli_dir / "extract_key_mac.py"), *args]
    if subcmd == "batch":
        return [sys.executable, str(cli_dir / "batch_analyze.py"), *args]
    raise ValueError(f"unknown subcmd: {subcmd}")


def discover_data_dir() -> Optional[Path]:
    """Find the decrypted-DB directory: env > config > Murmur layout > legacy echotrace.

    All filesystem walks here go through `_paths._safe_listdir` so a TCC-blocked
    directory (e.g. ~/Documents on macOS without FDA) can never hang the
    backend startup."""
    env = os.environ.get("ETCLI_DATA_DIR")
    if env and Path(env).is_dir():
        return Path(env)

    profiles = _paths.discover_wechat_profiles()
    if profiles:
        for prof in profiles:
            d = _paths.decrypted_root_for(prof, must_exist=True)
            if d:
                return d

    # Final fallback: scan common dirs for any wxid_* subdir
    for docs in [Path("D:/Documents"), Path.home() / "Documents", Path.home() / "OneDrive/Documents"]:
        for prefix in ("Murmur/decrypted", "EchoTrace"):
            root = docs / prefix
            try:
                if not root.is_dir():
                    continue
            except (PermissionError, OSError):
                continue
            entries = _paths._safe_listdir(root)
            if entries is None:
                continue  # TCC-blocked or hung
            for sub in entries:
                try:
                    if sub.is_dir() and (sub / "session.db").exists():
                        return sub
                except (PermissionError, OSError):
                    continue
    return None


def _tail_text(path: Path, max_lines: int = 80, max_bytes: int = 64_000) -> str:
    """Best-effort tail for small diagnostic logs."""
    try:
        if not path.exists() or not path.is_file():
            return ""
        with path.open("rb") as f:
            try:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - max_bytes))
            except OSError:
                pass
            data = f.read(max_bytes)
        text = data.decode("utf-8", errors="replace")
        return "\n".join(text.splitlines()[-max_lines:])
    except Exception as e:
        return f"(failed to read {path.name}: {e})"


def read_diagnostic_logs(max_lines: int = 80) -> dict:
    logs_dir = _paths.murmur_home() / "logs"
    return {
        "logs_dir": str(logs_dir),
        "serve": _tail_text(logs_dir / "serve.log", max_lines=max_lines),
        "tauri_shell": _tail_text(logs_dir / "tauri-shell.log", max_lines=max_lines),
    }


def self_wxid(prefs_path: Optional[Path] = None) -> Optional[str]:
    """Best-effort self wxid: legacy echotrace prefs first, else from active profile."""
    p = prefs_path or _flutter_prefs_path()
    if p.exists():
        try:
            v = json.loads(p.read_text(encoding="utf-8")).get("flutter.manual_wxid")
            if v:
                return v
        except Exception:
            pass
    profs = _paths.discover_wechat_profiles()
    return profs[0].wxid if profs else None


# ---------- DB layer ----------

@dataclass
class Contact:
    username: str
    remark: str
    nick_name: str
    alias: str
    is_group: bool
    is_real_friend: bool = False  # in your contact list (local_type=1) — not just a stranger seen in groups

    def display(self) -> str:
        return self.remark or self.nick_name or self.alias or self.username


@dataclass
class Session:
    username: str
    last_timestamp: int
    summary: str
    is_group: bool


@dataclass
class Message:
    create_time: int       # unix seconds
    sender_wxid: str       # "self" if from me, else the actual wxid (stable across renames)
    sender_name: str       # display name (备注 > 昵称 > 微信号 > wxid). 自己 = "你"
    msg_type: int
    text: str              # cleaned text or [tag] for non-text
    raw_type_label: str

    def to_dict(self) -> dict:
        return {
            "ts": self.create_time,
            "time": datetime.fromtimestamp(self.create_time, CST).isoformat(),
            "from": self.sender_name,
            "from_id": self.sender_wxid,
            "type": self.raw_type_label,
            "text": self.text,
        }


class EchoStore:
    """Cached read-only access to echotrace's decrypted databases."""

    def __init__(self, data_dir: Path, me: Optional[str] = None):
        self.dir = Path(data_dir)
        sess = self.dir / "session.db"
        if not sess.exists():
            raise FileNotFoundError(f"session.db not found in {self.dir}")
        # Guard against empty 4 KB stub session.db files — without this the
        # store loads "successfully" with zero contacts and Home stays stuck
        # on an "after-init but no data" state.
        try:
            c = sqlite3.connect(f"file:{sess.as_posix()}?mode=ro", uri=True)
            try:
                has_table = c.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='SessionTable' LIMIT 1"
                ).fetchone()
            finally:
                c.close()
            if not has_table:
                raise FileNotFoundError(f"session.db in {self.dir} has no SessionTable (likely empty stub)")
        except sqlite3.Error as e:
            raise FileNotFoundError(f"session.db in {self.dir} unreadable: {e}")
        self.me = me or self._guess_self_wxid()
        self._contacts: Optional[dict[str, Contact]] = None
        self._sessions: Optional[list[Session]] = None
        self._msg_db_for_session: dict[str, str] = {}  # username → msg_*.db filename
        self._zstd = None

    # --- connection helpers ---

    def _conn(self, fname: str) -> sqlite3.Connection:
        c = sqlite3.connect(f"file:{(self.dir / fname).as_posix()}?mode=ro", uri=True)
        c.text_factory = lambda b: b.decode("utf-8", errors="replace") if isinstance(b, bytes) else b
        return c

    def _guess_self_wxid(self) -> Optional[str]:
        # echotrace stores decrypted dbs under .../EchoTrace/<self_wxid_short>/
        # so the directory name itself is the authoritative short-form self wxid.
        name = self.dir.name
        if name.startswith("wxid_"):
            return name
        return None

    # --- contacts ---

    def contacts(self) -> dict[str, Contact]:
        if self._contacts is not None:
            return self._contacts
        c = self._conn("contact.db")
        # System / built-in contacts that have local_type=1 but aren't actual friends.
        SYS = {
            "filehelper", "qqmail", "qmessage", "fmessage", "weibo", "tmessage",
            "newsapp", "facebookapp", "blogapp", "voiceinputapp", "weixin",
            "medianote", "floatbottle", "officialaccounts",
        }
        try:
            rows = c.execute(
                "SELECT username, COALESCE(remark,''), COALESCE(nick_name,''), "
                "COALESCE(alias,''), COALESCE(local_type,0) FROM contact"
            ).fetchall()
            chatroom_set = {r[0] for r in c.execute("SELECT username FROM chat_room").fetchall()}
        finally:
            c.close()
        self._contacts = {}
        for (u, rk, nk, al, lt) in rows:
            is_group = u in chatroom_set or u.endswith("@chatroom")
            # local_type=1 = real friend; =3 = chatroom-stranger; =2 = subscription;
            # also exclude system shells, group-only people, and OA.
            is_real = (lt == 1) and (not is_group) and (u not in SYS) \
                       and (not u.startswith("gh_"))  # gh_ = official account
            self._contacts[u] = Contact(u, rk, nk, al, is_group, is_real)
        return self._contacts

    def contact(self, wxid: str) -> Contact:
        c = self.contacts().get(wxid)
        if c:
            return c
        return Contact(wxid, "", "", "", wxid.endswith("@chatroom"))

    # --- sessions ---

    def sessions(self) -> list[Session]:
        if self._sessions is not None:
            return self._sessions
        c = self._conn("session.db")
        try:
            rows = c.execute(
                "SELECT username, last_timestamp, COALESCE(summary,'') FROM SessionTable ORDER BY last_timestamp DESC"
            ).fetchall()
        finally:
            c.close()
        self._sessions = [
            Session(u, ts, sm, u.endswith("@chatroom")) for (u, ts, sm) in rows
        ]
        return self._sessions

    # --- messages ---

    def _locate_msg_dbs(self, username: str) -> list[tuple[str, str]]:
        """Returns ALL (msg_db_filename, table_name) pairs for a session.

        WeChat 4.x rolls message_*.db over time — the same Msg_<md5(username)> table
        can appear in multiple .db files, each holding a different time period.
        Reading only one would silently lose history.
        """
        if username in self._msg_db_for_session:
            dbs = self._msg_db_for_session[username]
            table = f"Msg_{hashlib.md5(username.encode()).hexdigest()}"
            return [(db, table) for db in dbs]  # type: ignore[list-item]
        table = f"Msg_{hashlib.md5(username.encode()).hexdigest()}"
        found: list[str] = []
        for fname in sorted(p.name for p in self.dir.glob("message_*.db")
                            if "_fts" not in p.name and "_resource" not in p.name and "biz_" not in p.name):
            c = self._conn(fname)
            try:
                exists = c.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
                ).fetchone()
            finally:
                c.close()
            if exists:
                found.append(fname)
        self._msg_db_for_session[username] = found  # type: ignore[assignment]
        return [(db, table) for db in found]

    # Back-compat alias for any callers that expected the singular form
    def _locate_msg_db(self, username: str):  # type: ignore[override]
        locs = self._locate_msg_dbs(username)
        return locs[0] if locs else None

    def message_count(self, username: str) -> int:
        total = 0
        for fname, table in self._locate_msg_dbs(username):
            c = self._conn(fname)
            try:
                total += c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            finally:
                c.close()
        return total

    def messages(
        self,
        username: str,
        since: Optional[int] = None,
        until: Optional[int] = None,
        limit: Optional[int] = None,
        text_only: bool = False,
    ) -> Iterator[Message]:
        locs = self._locate_msg_dbs(username)
        if not locs:
            return
        is_group = username.endswith("@chatroom")
        contacts = self.contacts()  # cached lookup, ~free
        # Stable-display-name resolver: same wxid → same name forever, regardless of nickname changes
        # (we use the *current* contact record as the canonical name).
        def resolve_name(wxid: str) -> str:
            if wxid == "self":
                return "你"
            c = contacts.get(wxid)
            if c:
                return c.display()
            # Fallback for ex-members no longer in the contact table:
            # render a short id chip so LLM can still distinguish (and it's the same chip every time).
            return f"~{wxid[-6:]}" if wxid.startswith("wxid_") else wxid

        # Aggregate rows from ALL matching dbs (chronologically), merge, then yield.
        # WeChat 4.x can have the same Msg_<md5> table in multiple message_*.db files
        # (one per rolled period). We need to read every one and merge.
        all_rows: list[tuple[int, int, str, str, str]] = []  # (ts, mtype, sender_wxid, sender_name, text)
        seen_keys: set[tuple[int, int, str]] = set()  # dedupe by (ts, sender_id, stable_content_hash)

        for fname, table in locs:
            c = self._conn(fname)
            try:
                n2i = {row[0]: row[1] for row in c.execute("SELECT rowid, user_name FROM Name2Id").fetchall()}
                wheres = []
                params: list = []
                if since is not None:
                    wheres.append("create_time >= ?")
                    params.append(since)
                if until is not None:
                    wheres.append("create_time <= ?")
                    params.append(until)
                if text_only:
                    wheres.append("local_type = 1")
                sql = f"SELECT local_id, create_time, real_sender_id, local_type, message_content FROM {table}"
                if wheres:
                    sql += " WHERE " + " AND ".join(wheres)
                sql += " ORDER BY create_time ASC, local_id ASC"
                # Don't apply limit here; we'll cap after merging
                for local_id, ts, sender_id, mtype, content in c.execute(sql, params):
                    # Light dedup against duplicates that may sit at db-rollover boundaries
                    if isinstance(content, bytes):
                        content_bytes = content
                    elif content is None:
                        content_bytes = b""
                    else:
                        content_bytes = str(content).encode("utf-8", errors="replace")
                    content_hash = hashlib.sha1(content_bytes).hexdigest()
                    key = (int(ts or 0), int(sender_id or 0), content_hash)
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    sender_wxid_raw = n2i.get(sender_id, f"<id_{sender_id}>")
                    if not is_group:
                        sender_wxid = "self" if sender_wxid_raw == self.me else username
                    else:
                        sender_wxid = "self" if sender_wxid_raw == self.me else sender_wxid_raw
                    sender_name = resolve_name(sender_wxid)
                    text = self._render_content(mtype, content, is_group)
                    all_rows.append((ts, mtype, sender_wxid, sender_name, text))  # type: ignore[arg-type]
            finally:
                c.close()

        # Sort chronologically and yield
        all_rows.sort(key=lambda r: r[0])
        if limit:
            n = max(0, int(limit))
            all_rows = all_rows[-n:] if n else []
        for ts, mtype, sender_wxid, sender_name, text in all_rows:
            yield Message(ts, sender_wxid, sender_name, mtype, text,
                          MSG_TYPES.get(mtype, f"type_{mtype}"))

    def _render_content(self, mtype: int, content, is_group: bool) -> str:
        if mtype == 1:
            if isinstance(content, bytes):
                # Some messages are zstd-compressed (magic = 28 b5 2f fd). Most are raw.
                if content.startswith(b"\x28\xb5\x2f\xfd"):
                    try:
                        if self._zstd is None:
                            import zstandard as _zs
                            self._zstd = _zs.ZstdDecompressor()
                        content = self._zstd.decompress(content)
                    except Exception:
                        pass
                content = content.decode("utf-8", errors="replace")
            if not content:
                return ""
            # Strip "wxid_xxx:\n" prefix on chatroom messages
            if is_group:
                m = re.match(r"^[^\s:]+:\n", content)
                if m:
                    content = content[m.end():]
            # If after all that the text still has lots of replacement chars (zstd-stream
            # we couldn't decode), filter it out so the LLM doesn't see noise.
            if content.count("�") > max(2, len(content) // 8):
                return ""
            return content
        # non-text: try a tagged stub. Avoid decompressing big blobs by default.
        label = MSG_TYPES.get(mtype, f"type_{mtype}")
        return f"[{label}]"


# ---------- query / report builders ----------

def build_session_index(store: EchoStore) -> list[dict]:
    contacts = store.contacts()
    out = []
    for s in store.sessions():
        c = contacts.get(s.username)
        out.append({
            "wxid": s.username,
            "name": (c.display() if c else s.username),
            "is_group": s.is_group,
            "last_ts": s.last_timestamp,
            "last_time": datetime.fromtimestamp(s.last_timestamp, CST).isoformat() if s.last_timestamp else None,
            "summary": s.summary,
        })
    return out


def stats_for(store: EchoStore, username: str) -> dict:
    msgs = list(store.messages(username))
    if not msgs:
        return {"wxid": username, "message_count": 0}
    by_sender = Counter(m.sender_wxid for m in msgs)
    by_type = Counter(m.raw_type_label for m in msgs)
    by_hour = Counter(datetime.fromtimestamp(m.create_time, CST).hour for m in msgs)
    by_year = Counter(datetime.fromtimestamp(m.create_time, CST).year for m in msgs)
    by_dow = Counter(datetime.fromtimestamp(m.create_time, CST).weekday() for m in msgs)
    text_msgs = [m for m in msgs if m.msg_type == 1 and m.text]
    total_chars = sum(len(m.text) for m in text_msgs)
    self_chars = sum(len(m.text) for m in text_msgs if m.sender_wxid == "self")
    other_chars = total_chars - self_chars
    contact = store.contact(username)
    return {
        "wxid": username,
        "name": contact.display(),
        "is_group": contact.is_group,
        "remark": contact.remark,
        "nick_name": contact.nick_name,
        "alias": contact.alias,
        "message_count": len(msgs),
        "text_count": len(text_msgs),
        "first_message": datetime.fromtimestamp(msgs[0].create_time, CST).isoformat(),
        "last_message": datetime.fromtimestamp(msgs[-1].create_time, CST).isoformat(),
        "days_span": (msgs[-1].create_time - msgs[0].create_time) // 86400,
        "by_sender": dict(by_sender.most_common()),
        "by_type": dict(by_type),
        "by_hour": {str(h): by_hour.get(h, 0) for h in range(24)},
        "by_weekday": {str(d): by_dow.get(d, 0) for d in range(7)},
        "by_year": dict(sorted(by_year.items())),
        "total_chars": total_chars,
        "self_chars": self_chars,
        "other_chars": other_chars,
        "self_share_chars": round(self_chars / total_chars, 3) if total_chars else None,
    }


def relationship_dossier(store: EchoStore, username: str, sample_n: int = 50) -> dict:
    s = stats_for(store, username)
    if s["message_count"] == 0:
        return s
    msgs = list(store.messages(username, text_only=True))
    # Sample: first 10, last 20, and a stratified middle 20
    head = msgs[:10]
    tail = msgs[-20:]
    middle = msgs[len(msgs) // 4: 3 * len(msgs) // 4]
    step = max(1, len(middle) // 20)
    mid_sample = middle[::step][:20]
    sample = [m.to_dict() for m in head + mid_sample + tail]
    s["sample_messages"] = sample
    s["sample_size"] = len(sample)
    return s


# ---------- local (no-LLM) analysis ----------

# Light Chinese stopword list — kept short on purpose
STOPWORDS = set("的 了 是 我 你 他 她 也 都 在 就 不 和 与 这 那 一 个 有 没 啊 吧 呀 嗯 哦 嘛 呢 吗 哈 呜 哇 噢 哎 唉 哟 唔 嗷 嘿 哼 啦 喔 等 把 被 让 给 从 向 对 跟 比 又 再 才 还 但 而 或 因 所 之 以 上 下 里 外 中 后 前 时 日 年 月 来 去 到 过 上 下 看 想 知 道 觉 得 说 讲 问 答 听 啥 那 这 谁 哪 哎 喂 哈 哈哈 嗯嗯 好 行 OK ok yes no 是 不是 可以 不行 不要 别 再 多 少 大 小 老 新 真 假 好的".split())
STOPWORDS.update("这个 那个 一下 还是 就是 没有 什么 怎么 为啥 因为 然后 但是 现在 时候 感觉 确实 真的 知道 不知 我们 你们 他们 一个 今天 明天 昨天 哦哦 啧啧 看看 人家 不能 不会 应该 可能 还有 这么 那么 刚才 之前 之后 这里 那里 反正 okok okay yeah nope lol lmao".split())
STOP_CHARS = set("的了是我你他她也都在就不和与这那一个有没啊吧呀嗯哦嘛呢吗哈呜哇噢哎唉哟唔嗷嘿哼啦喔把被让给从向对跟比又再才还但而或因所以之上下里外中后前时日年月来去到过")
NON_TEXT = re.compile(r"\[[^\]]+\]")
URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
APP_VERSION = "0.3.10"
YEARBOOK_CACHE_VERSION = 5


def _ts_to_dt(ts: int):
    return datetime.fromtimestamp(ts, CST)


def _format_seconds(sec: int) -> str:
    if sec < 60:
        return f"{sec}秒"
    if sec < 3600:
        return f"{sec // 60}分{sec % 60}秒"
    if sec < 86400:
        return f"{sec // 3600}小时{(sec % 3600) // 60}分"
    return f"{sec // 86400}天{(sec % 86400) // 3600}小时"


def _word_counts(texts: list[str]) -> Counter:
    """Lightweight topic tokenizer: English words plus Chinese bigrams."""
    cnt: Counter = Counter()
    for t in texts:
        t = URL_RE.sub(" ", NON_TEXT.sub(" ", t or ""))
        tokens = re.findall(r"[\u4e00-\u9fff]+|[A-Za-z]{2,}", t)
        for tk in tokens:
            if re.fullmatch(r"[A-Za-z]{2,}", tk):
                w = tk.lower()
                if w not in STOPWORDS:
                    cnt[w] += 1
                continue
            for i in range(len(tk) - 1):
                bi = tk[i:i + 2]
                if bi in STOPWORDS:
                    continue
                if bi[0] in STOP_CHARS or bi[-1] in STOP_CHARS:
                    continue
                cnt[bi] += 1
    return cnt


# ---------- Relationship-quality signal extraction ----------
# Volume ≠ closeness. The signals that actually matter for relationship depth:
#   1. Longevity (multi-year continuity, especially across life events)
#   2. Resilience (re-emerging naturally after long silences)
#   3. Mutuality (both sides initiate, both ask "你怎么样")
#   4. Vulnerability sharing (low-defense disclosures)
#   5. Offline-life evidence (logistics, place names, real-world plans)
#   6. Inside jokes / private references
#   7. Voice/video calls (deeper than text)
#   8. Conflict-recovery patterns (apology + continued contact)

VULN_KEYWORDS = ['累', '烦', '难受', '想死', '抑郁', '裸辞', '分手', '出问题', '崩溃', '哭',
                  '医院', '病了', '没钱', '吵架', '失眠', '压力', '焦虑', '怕', '伤心',
                  '孤独', '无助', '后悔', '心里', '说实话', '真的不行', '熬夜', '受不了']

OFFLINE_KEYWORDS = ['周末', '明天见', '今天见', '一起去', '带你', '咱们', '我俩', '楼下',
                     '几点', '在哪', '几号', '约', '吃饭', '咖啡', '电影', '吃', '喝',
                     '出去', '过来', '过去', '我家', '你家', '你们家', '机场', '火车',
                     '高铁', '打车', '地铁', '车上', '到了', '下楼', '上车', '到站',
                     '请客', '一顿', '聚', '聚会', '生日', '庆祝', '酒', '撸串', '夜宵']

CARE_KEYWORDS = ['你怎么样', '最近怎么样', '还好吗', '在干嘛', '工作累不累', '吃了吗',
                  '到家了吗', '休息了吗', '注意身体', '别熬夜', '小心', '保重', '加油',
                  '我担心你', '担心', '怎么了', '没事吧']

APOLOGY_KEYWORDS = ['对不起', '抱歉', '我错了', 'sorry', 'sry', '不好意思', '原谅',
                     '是我不对', '怪我']

LIFECYCLE_KEYWORDS = ['毕业', '入职', '辞职', '搬家', '结婚', '订婚', '怀孕', '生娃',
                       '换工作', '考研', '考公', '出国', '回国', '生病', '住院',
                       '过生日', '过年', '新年', '中秋', '春节', '高考']


def _count_msg_with_kw(msgs: list, kws: list[str]) -> int:
    """Count messages whose text contains any of the keywords."""
    n = 0
    for m in msgs:
        if not m.text or m.msg_type != 1:
            continue
        for k in kws:
            if k in m.text:
                n += 1
                break
    return n


def _find_msg_with_kw(msgs: list, kws: list[str], limit: int = 3) -> list:
    """Find up to `limit` matching msgs with their kw."""
    out = []
    for m in msgs:
        if not m.text or m.msg_type != 1:
            continue
        for k in kws:
            if k in m.text:
                out.append({"ts": m.create_time,
                            "date": _ts_to_dt(m.create_time).strftime("%Y-%m-%d"),
                            "from": m.sender_name,
                            "from_id": m.sender_wxid,
                            "text": m.text[:160],
                            "kw": k})
                if len(out) >= limit:
                    return out
                break
    return out


_SNS_SIGNALS_CACHE = {"data": None, "ts": 0}
_GRAPH_CACHE: dict[str, tuple[float, dict]] = {}        # key=qs-hash → (ts, payload)
_FF_MOMENTS_CACHE = {"data": None, "ts": 0}             # friend↔friend SNS pairs
_CONN_CACHE: dict[str, tuple[float, dict]] = {}         # per-wxid connections
_FRIEND_DETAIL_CACHE: dict[str, tuple[float, dict]] = {}    # per-wxid friend_detail
_HOME_SUMMARY_CACHE = {"data": None, "ts": 0}           # /api/home-summary
_FRIENDS_LIST_CACHE: dict[str, tuple[float, list]] = {}   # /api/friends per kind
_YEARBOOK_CACHE: dict[str, tuple[float, dict]] = {}     # per-wxid yearbook
_PAIR_PACK_CACHE: dict[str, tuple[float, dict]] = {}    # sorted-pair-key → pack
_PAIR_REPORT_CACHE: dict[str, tuple[float, dict]] = {}  # sorted-pair-key → report metadata
_MENTIONS_CACHE: dict[str, tuple[float, dict]] = {}     # mentions(top_n,min_mc) → result
_PAIR_STREAM: dict[str, dict] = {}    # pair_key → {running, output, error, started_at, finished_at, name_a, name_b, cli}
_FRIEND_STREAM: dict[str, dict] = {}  # wxid → same shape as pair stream (single-friend invoke)
_BATCH_PROCS: dict[int, subprocess.Popen] = {}  # pid → child batch process, so status can reap and not hang on zombies
_CACHE_TTL = 86400  # 1 day — caches are persisted to disk so a stale day-old cache is fine.
_YEARBOOK_QUOTE_FIELDS = (
    "vulnerability_quotes",
    "offline_quotes",
    "lifecycle_quotes",
    "apology_quotes",
    "care_quotes",
)


def _yearbook_has_quote_ids(payload: dict) -> bool:
    """Reject pre-v0.2.6 yearbook caches that cannot drive privacy-safe UI labels."""
    if payload.get("cache_version") != YEARBOOK_CACHE_VERSION:
        return False
    for year in payload.get("years", []):
        for field in _YEARBOOK_QUOTE_FIELDS:
            for quote in year.get(field, []) or []:
                if "from_id" not in quote:
                    return False
        signature = year.get("signature")
        if signature and "from_id" not in signature:
            return False
    return True

# Build locks: SQLite + heavy Python construction is not safe to call from N threads concurrently
# on the SAME EchoStore instance. Crashes the process (segfaults in C extensions). Serialize.
import threading as _t
_PACK_BUILD_LOCK = _t.Lock()
_PAIR_BUILD_LOCK = _t.Lock()
_STORE_READ_LOCK = _t.RLock()

# ---- per-account isolation ----
# Disk cache + AI report layout (post-v0.3.1):
#   ~/Documents/Murmur/cache/<slug>/<key>.json
#   ~/Desktop/Murmur/agent_reports/<slug>/...
# where <slug> = "wechat-<wxid>" or "qq-<qq_number>".
# This stops cross-account data bleed when the user toggles the ProfileSwitcher:
# previously a WeChat home_summary.json or AI report stayed on disk and got
# served back when the active store was QQ.

def _account_slug() -> str:
    """Per-account directory slug for caches/reports.

    Late-binds against `_MurmurAPIHandler` because the class is defined later
    in this module. Returns "default" during the bootstrap window before any
    store loads — keeps imports + module init from crashing on cold start.
    """
    try:
        plat = _MurmurAPIHandler._active_platform
        ident = _MurmurAPIHandler._active_id
        if plat and ident:
            return f"{plat}-{_safe_filename(ident)}"
    except Exception:
        pass
    return "default"


def _disk_cache_dir() -> Path:
    p = Path.home() / "Documents" / "Murmur" / "cache" / _account_slug()
    p.mkdir(parents=True, exist_ok=True)
    return p

def _agent_workspace_root() -> Path:
    override = os.environ.get("MURMUR_AGENT_WORKDIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / "Desktop" / "Murmur"

def _agent_reports_root() -> Path:
    override = os.environ.get("MURMUR_AGENT_REPORTS_DIR")
    if override:
        return Path(override).expanduser()
    return _agent_workspace_root() / "agent_reports" / _account_slug()

def _codex_model_args() -> list[str]:
    model = os.environ.get("MURMUR_CODEX_MODEL", "gpt-5.2").strip()
    return ["-m", model] if model else []

def _safe_filename(s: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "_", s)[:80]

def _batch_progress_from_log(log_text: str) -> dict:
    progress = {
        "friends_done": 0,
        "friends_total": 0,
        "pairs_done": 0,
        "pairs_total": 0,
        "failures": 0,
        "skipped": 0,
        "last_stage": "",
        "crashed": False,
    }
    seen_terminal: set[tuple[str, int, str]] = set()
    saw_traceback = False
    for raw in log_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("Traceback ") or line.startswith("[X]") or "ConnectionRefusedError" in line:
            saw_traceback = True
            progress["last_stage"] = line
        if "Phase 1:" in line or "Phase 2:" in line or line.startswith("[DONE]"):
            progress["last_stage"] = line

        m = re.search(r"\[(F|P)\s+(\d+)/(\d+)\]\s+(.+)", line)
        if not m:
            continue
        kind, idx_s, total_s, rest = m.groups()
        idx = int(idx_s)
        total = int(total_s)
        done_key = "friends_done" if kind == "F" else "pairs_done"
        total_key = "friends_total" if kind == "F" else "pairs_total"
        progress[total_key] = max(progress[total_key], total)
        progress["last_stage"] = line

        terminal = None
        if re.search(r"\bOK\b", rest):
            terminal = "OK"
        elif re.search(r"\bSKIP\b", rest):
            terminal = "SKIP"
        elif re.search(r"\bFAIL\b", rest) or " err:" in rest or "failed:" in rest:
            terminal = "FAIL"

        if terminal:
            key = (kind, idx, terminal)
            if key not in seen_terminal:
                seen_terminal.add(key)
                if terminal == "SKIP":
                    progress["skipped"] += 1
                elif terminal == "FAIL":
                    progress["failures"] += 1
            progress[done_key] = max(progress[done_key], idx)
    if saw_traceback:
        progress["crashed"] = True
        if progress["failures"] == 0:
            progress["failures"] = 1
    return progress

def _disk_load(key: str) -> dict | None:
    """Try to load a cached payload from disk. Returns None if not present or stale."""
    p = _disk_cache_dir() / f"{_safe_filename(key)}.json"
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        # Stored shape: {"_ts": <unix>, "_payload": <data>}
        return d
    except Exception:
        return None

def _disk_save(key: str, payload) -> None:
    p = _disk_cache_dir() / f"{_safe_filename(key)}.json"
    try:
        p.write_text(json.dumps({"_ts": _time.time(), "_payload": payload},
                                  ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass

def _disk_clear() -> None:
    try:
        for f in _disk_cache_dir().glob("*.json"):
            f.unlink(missing_ok=True)
    except Exception:
        pass


def get_friend_mentions_cached(store: EchoStore, top_n: int = 50,
                               min_mention_count: int = 3) -> dict:
    ck = f"mentions:{top_n}:{min_mention_count}"
    cached = _MENTIONS_CACHE.get(ck)
    if cached and (_time.time() - cached[0]) < _CACHE_TTL:
        return cached[1]
    disk = _disk_load(ck)
    if disk and (_time.time() - disk["_ts"]) < _CACHE_TTL:
        mentions = disk["_payload"]
        _MENTIONS_CACHE[ck] = (disk["_ts"], mentions)
        return mentions
    with _STORE_READ_LOCK:
        cached = _MENTIONS_CACHE.get(ck)
        if cached and (_time.time() - cached[0]) < _CACHE_TTL:
            return cached[1]
        mentions = extract_friend_mentions(store, top_n=top_n, min_mention_count=min_mention_count)
        _MENTIONS_CACHE[ck] = (_time.time(), mentions)
        _disk_save(ck, mentions)
        return mentions


def _graph_cache_key(scope: str, min_private: int, recent_days: int,
                     top_n: int, show_clusters: bool) -> str:
    # v3 adds the direct-evidence gate for pair packs/reports. Keep it separate
    # from older graph caches so stale co-group-only edges cannot pass as evidence.
    return f"graph_v3:{scope}:{min_private}:{recent_days}:{top_n}:{show_clusters}"


def get_relationship_graph_cached(store: EchoStore, *,
                                  scope: str = "all",
                                  min_private: int = 10,
                                  recent_days: int = 365,
                                  top_n: int = 600,
                                  show_clusters: bool = False) -> dict:
    ck = _graph_cache_key(scope, min_private, recent_days, top_n, show_clusters)
    cached = _GRAPH_CACHE.get(ck)
    if cached and (_time.time() - cached[0]) < _CACHE_TTL:
        return cached[1]
    disk = _disk_load(ck)
    if disk and (_time.time() - disk["_ts"]) < _CACHE_TTL:
        _GRAPH_CACHE[ck] = (disk["_ts"], disk["_payload"])
        return disk["_payload"]
    with _STORE_READ_LOCK:
        graph = build_relationship_graph(
            store, scope=scope, min_private=min_private,
            recent_days=recent_days, top_n=top_n, show_clusters=show_clusters,
        )
    _GRAPH_CACHE[ck] = (_time.time(), graph)
    _disk_save(ck, graph)
    return graph


def pair_direct_evidence(store: EchoStore, wxid_a: str, wxid_b: str) -> dict:
    """Return direct A<->B evidence. Co-presence in groups alone is intentionally not enough."""
    pair = {wxid_a, wxid_b}
    graph = get_relationship_graph_cached(store, scope="all", top_n=600)
    contacts = store.contacts()
    ca = contacts.get(wxid_a)
    cb = contacts.get(wxid_b)
    direct_edges = []
    weak_edges = []
    for e in graph.get("edges", []):
        if {e.get("source"), e.get("target")} != pair:
            continue
        if e.get("source") == "self" or e.get("target") == "self":
            continue
        et = e.get("type")
        has_direct_meta = (e.get("mention_count") or 0) >= 1 or (e.get("moments_cross") or 0) >= 1
        if et in {"mutual_reply", "mention", "moments_cross"} or has_direct_meta:
            direct_edges.append(e)
        else:
            weak_edges.append(e)
    return {
        "ok": bool(direct_edges),
        "a": wxid_a,
        "b": wxid_b,
        "name_a": (ca.display() if ca else wxid_a),
        "name_b": (cb.display() if cb else wxid_b),
        "direct_edges": direct_edges,
        "weak_edges": weak_edges,
        "message": (
            "找到直接证据"
            if direct_edges
            else "没有找到直接关系证据；共同群/共同出现不能证明两人认识，已拒绝生成 AI 关系推断。"
        ),
    }


def get_sns_signals_cached(store: EchoStore) -> dict:
    """Returns wxid → {you_liked_them, you_commented_them, they_liked_you, they_commented_you, they_posted_count}.
    Cached for 5 minutes since this scans 3896 timeline entries."""
    if _SNS_SIGNALS_CACHE["data"] is not None and (_time.time() - _SNS_SIGNALS_CACHE["ts"]) < 300:
        return _SNS_SIGNALS_CACHE["data"]
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import sns as _sns_mod
        sigs = _sns_mod.per_friend_signals(store.dir, store.me or "")
    except Exception as e:
        sys.stderr.write(f"[sns] failed: {e}\n")
        sigs = {}
    _SNS_SIGNALS_CACHE["data"] = sigs
    _SNS_SIGNALS_CACHE["ts"] = _time.time()
    return sigs


def relationship_signals(msgs: list, *, is_group: bool, me: str = "self",
                          sns_signals: dict | None = None) -> dict:
    """The non-volume signals that actually predict closeness."""
    if not msgs:
        return {}

    # ---- Longevity: spread across years ----
    by_year = Counter(_ts_to_dt(m.create_time).year for m in msgs)
    active_years = sorted([y for y, n in by_year.items() if n >= 30])
    longevity_years = (active_years[-1] - active_years[0]) if len(active_years) >= 2 else 0

    # ---- Resurrection events: gaps > 60 days followed by sustained re-engagement ----
    days_active = sorted(set(_ts_to_dt(m.create_time).date() for m in msgs))
    resurrections = []
    if len(days_active) > 1:
        for i in range(1, len(days_active)):
            gap = (days_active[i] - days_active[i - 1]).days
            if gap > 60:
                resurrections.append({
                    "before": days_active[i - 1].isoformat(),
                    "after": days_active[i].isoformat(),
                    "gap_days": gap,
                })

    # ---- Vulnerability sharing (only meaningful for non-group) ----
    self_msgs = [m for m in msgs if m.sender_wxid == me]
    other_msgs = [m for m in msgs if m.sender_wxid != me]
    vuln_self = _count_msg_with_kw(self_msgs, VULN_KEYWORDS)
    vuln_other = _count_msg_with_kw(other_msgs, VULN_KEYWORDS)
    vuln_examples = _find_msg_with_kw(msgs, VULN_KEYWORDS, limit=3)

    # ---- Offline-life evidence ----
    offline_count = _count_msg_with_kw(msgs, OFFLINE_KEYWORDS)
    offline_examples = _find_msg_with_kw(msgs, OFFLINE_KEYWORDS, limit=3)

    # ---- Mutual care ----
    care_self_to_other = _count_msg_with_kw(self_msgs, CARE_KEYWORDS)
    care_other_to_self = _count_msg_with_kw(other_msgs, CARE_KEYWORDS)

    # ---- Apologies / conflict recovery ----
    apology_count = _count_msg_with_kw(msgs, APOLOGY_KEYWORDS)
    apology_examples = _find_msg_with_kw(msgs, APOLOGY_KEYWORDS, limit=2)

    # ---- Voice / video calls (much higher signal than text) ----
    call_count = sum(1 for m in msgs if m.msg_type in (50, 62))

    # ---- Lifecycle markers (major life events shared) ----
    lifecycle_examples = _find_msg_with_kw(msgs, LIFECYCLE_KEYWORDS, limit=3)
    lifecycle_count = _count_msg_with_kw(msgs, LIFECYCLE_KEYWORDS)

    # ---- Avg response time bidirectionality ----
    # Healthy relationships have similar reply latencies in both directions
    # (We compute these in stats already — use the ratio)

    # ---- Recent activity vs historical ----
    now_ts = datetime.now(CST).timestamp()
    last_30d = sum(1 for m in msgs if (now_ts - m.create_time) < 30 * 86400)
    last_30d_to_90d = sum(1 for m in msgs if 30 * 86400 <= (now_ts - m.create_time) < 90 * 86400)
    days_since_last = (now_ts - msgs[-1].create_time) // 86400 if msgs else 9999

    # ---- Moments (朋友圈) signals — extra evidence for closeness ----
    sns = sns_signals or {}
    moments_back = sns.get("they_liked_you", 0) + sns.get("they_commented_you", 0)
    moments_out = sns.get("you_liked_them", 0) + sns.get("you_commented_them", 0)

    # ---- Closeness tier (heuristic, conservative) ----
    # A: 老朋友级 — 4+ years, ≥1 resurrection, mutual care, offline evidence
    # B: 常聊朋友 — 2+ years OR strong recent activity + offline
    # C: 有联系朋友 — has some activity but mostly transactional
    # D: 弱联系 — long silent or one-sided
    # E: 已疏远/工具型
    if is_group:
        tier = "group"
        tier_label = "群聊"
    else:
        if (longevity_years >= 4 and len(resurrections) >= 1 and
                offline_count >= 5 and (care_self_to_other + care_other_to_self) >= 3):
            tier = "A"; tier_label = "老朋友级（多年线下持续互动）"
        elif (longevity_years >= 2 and offline_count >= 3) or \
             (last_30d >= 50 and offline_count >= 3 and (care_self_to_other + care_other_to_self) >= 1):
            tier = "B"; tier_label = "常聊朋友（线下有交集）"
        elif days_since_last < 90 and offline_count >= 1:
            tier = "C"; tier_label = "有联系朋友"
        elif days_since_last >= 365:
            tier = "E"; tier_label = "已疏远"
        elif days_since_last >= 90 and offline_count == 0:
            tier = "D"; tier_label = "弱联系（线上为主）"
        else:
            tier = "C"; tier_label = "有联系朋友"

    # ---- Signature pattern ----
    # Lead with HARD time-line and frequency signals (less noisy than keyword counts).
    # Keyword-based signals (vuln/apology/lifecycle) get downgraded — too many false
    # positives from polite "对不起", memes mentioning "毕业", etc.
    signature_notes = []

    # Compute frequency / continuity stats fresh
    days_active_set = sorted({_ts_to_dt(m.create_time).date() for m in msgs})
    n_active_days = len(days_active_set)
    span_days = max(1, (msgs[-1].create_time - msgs[0].create_time) // 86400)
    msgs_per_active_day = len(msgs) / n_active_days if n_active_days else 0
    active_days_per_year = n_active_days / max(1, span_days / 365)

    # 1) Continuity — most predictive
    if longevity_years >= 4:
        signature_notes.append(f"持续 {longevity_years}+ 年（{active_years[0] if active_years else '?'}–{active_years[-1] if active_years else '?'}）— 老朋友级时间线")
    elif longevity_years >= 2:
        signature_notes.append(f"持续 {longevity_years} 年的关系（{n_active_days} 天有交流，全年覆盖）")
    elif longevity_years == 1:
        signature_notes.append(f"认识 1 年内（{n_active_days} 天有交流）")

    # 2) Frequency cadence
    if active_days_per_year >= 100:
        signature_notes.append(f"每年 {int(active_days_per_year)} 天有交流（约每 3-4 天聊一次，非常稳定）")
    elif active_days_per_year >= 30:
        signature_notes.append(f"每年 {int(active_days_per_year)} 天有交流（约每月 2-3 次）")
    elif active_days_per_year >= 10:
        signature_notes.append(f"每年仅 {int(active_days_per_year)} 天有交流（间断性联系）")
    if msgs_per_active_day >= 50:
        signature_notes.append(f"聊起来一天平均 {int(msgs_per_active_day)} 条（高频深聊型）")

    # 3) Resurrection: surviving silences
    if len(resurrections) >= 2:
        max_gap = max(r["gap_days"] for r in resurrections)
        signature_notes.append(f"经历过 {len(resurrections)} 次 60+ 天沉默后重新联系（最长 {max_gap} 天）— 关系有韧性")
    elif len(resurrections) == 1:
        signature_notes.append(f"经历过 1 次 {resurrections[0]['gap_days']} 天沉默后重新联系")

    # 4) Recent vs historical: is this relationship LIVE or fading?
    recent_rate = last_30d / 30  # msgs/day in last 30d
    historical_rate = (len(msgs) - last_30d) / max(1, span_days - 30)
    if days_since_last <= 7 and last_30d >= 50:
        signature_notes.append(f"最近 30 天 {last_30d} 条 — 当下是热联系")
    elif days_since_last >= 180:
        signature_notes.append(f"已经 {int(days_since_last)} 天没说话 — 关系已凉")
    elif historical_rate > 0 and recent_rate < historical_rate * 0.3 and last_30d >= 5:
        signature_notes.append(f"最近 30 天频率掉到历史水平的 {int(recent_rate / historical_rate * 100)}% — 关系在淡")

    # 5) Calls — strong real-life signal
    if call_count >= 10:
        signature_notes.append(f"打过 {call_count} 次电话/视频（多次远比文字深）")
    elif call_count >= 3:
        signature_notes.append(f"打过 {call_count} 次电话/视频")

    # 6) Moments — independent reciprocity signal
    if moments_back > 5 and moments_out == 0:
        signature_notes.append(f"⚠ 朋友圈不对等：他给你 {moments_back} 次互动，你 0 次回应")
    elif moments_out + moments_back >= 20:
        signature_notes.append(f"朋友圈互动 {moments_out + moments_back} 次（你→他 {moments_out} / 他→你 {moments_back}）")
    elif moments_out + moments_back >= 5:
        signature_notes.append(f"朋友圈互动 {moments_out + moments_back} 次")

    # 7) Offline-life keyword (still useful but less weighted)
    if offline_count >= 30:
        signature_notes.append(f"{offline_count} 条消息含线下约见线索")
    elif offline_count >= 10:
        signature_notes.append(f"{offline_count} 次提到线下见面（约/吃/玩）")

    # 8) Keyword-based softer signals — only if substantial; LLM should re-verify
    if vuln_self + vuln_other >= 10:
        signature_notes.append(f"⚙ 关键词扫描出 {vuln_self + vuln_other} 次脆弱表达（建议 LLM 复核语境）")
    if apology_count >= 5:
        signature_notes.append(f"⚙ {apology_count} 次出现「对不起/抱歉」类词（可能是礼貌也可能是真冲突）")
    if lifecycle_count >= 5:
        signature_notes.append(f"⚙ {lifecycle_count} 次提到毕业/入职/搬家类词（需 LLM 核实是否真事件）")

    return {
        "longevity_years": longevity_years,
        "active_years": active_years,
        "resurrections": resurrections[:5],
        "resurrection_count": len(resurrections),
        "vulnerability": {
            "self_disclose_count": vuln_self,
            "other_disclose_count": vuln_other,
            "examples": vuln_examples,
        },
        "offline_evidence": {
            "count": offline_count,
            "examples": offline_examples,
        },
        "mutual_care": {
            "self_to_other": care_self_to_other,
            "other_to_self": care_other_to_self,
        },
        "conflict_recovery": {
            "apology_count": apology_count,
            "examples": apology_examples,
        },
        "calls": call_count,
        "lifecycle": {
            "count": lifecycle_count,
            "examples": lifecycle_examples,
        },
        "recent_activity": {
            "last_30d_msgs": last_30d,
            "last_30d_to_90d_msgs": last_30d_to_90d,
            "days_since_last": int(days_since_last),
        },
        # Expose so friend_detail can pass these straight to the sidebar /
        # OfflineSignalsTable. Without them, sig_block.get("moments_back", 0)
        # returned 0 forever even when signature_notes said "朋友圈互动 10 次".
        "moments_back": moments_back,
        "moments_out": moments_out,
        "tier": tier,
        "tier_label": tier_label,
        "signature_notes": signature_notes,
    }


def local_analysis(store: EchoStore, username: str) -> dict:
    """Pure-statistical analysis. No LLM needed."""
    msgs = list(store.messages(username))
    if not msgs:
        return {"wxid": username, "message_count": 0}
    contact = store.contact(username)
    is_group = contact.is_group
    me = "self"

    # --- Basic counts ---
    self_msgs = [m for m in msgs if m.sender_wxid == me]
    other_msgs = [m for m in msgs if m.sender_wxid != me]
    text_self = [m for m in self_msgs if m.msg_type == 1 and m.text]
    text_other = [m for m in other_msgs if m.msg_type == 1 and m.text]

    # --- Conversation initiation (gap > 4h = new conversation) ---
    GAP = 4 * 3600
    init_self = init_other = 0
    prev_ts = None
    for m in msgs:
        if prev_ts is None or m.create_time - prev_ts > GAP:
            if m.sender_wxid == me:
                init_self += 1
            else:
                init_other += 1
        prev_ts = m.create_time

    # --- Reply latency (only for adjacent messages where sender flips) ---
    self_reply_lats = []
    other_reply_lats = []
    for i in range(1, len(msgs)):
        prev, cur = msgs[i - 1], msgs[i]
        if prev.sender_wxid == cur.sender_wxid:
            continue
        delta = cur.create_time - prev.create_time
        if delta < 0 or delta > 24 * 3600:
            continue
        if cur.sender_wxid == me:
            self_reply_lats.append(delta)
        else:
            other_reply_lats.append(delta)

    def _med(lst):
        if not lst:
            return None
        s = sorted(lst)
        return s[len(s) // 2]

    # --- Word frequency (light, top 25 of each side; dedupe stopwords) ---
    def _words(texts: list[str]) -> Counter:
        cnt: Counter = Counter()
        for t in texts:
            t = NON_TEXT.sub("", t)
            # split chinese chars individually + english words
            tokens = re.findall(r"[一-鿿]|[A-Za-z]{2,}", t)
            # Build bigrams from chinese chars (rough word approx)
            chars = [tk for tk in tokens if len(tk) == 1 and "一" <= tk <= "鿿"]
            words = [tk for tk in tokens if len(tk) > 1]
            for w in words:
                if w.lower() not in STOPWORDS:
                    cnt[w.lower()] += 1
            for i in range(len(chars) - 1):
                bi = chars[i] + chars[i + 1]
                if bi not in STOPWORDS:
                    cnt[bi] += 1
        return cnt

    self_words = _word_counts([m.text for m in text_self])
    other_words = _word_counts([m.text for m in text_other])

    # --- Date density: most active day, longest silence ---
    by_day = Counter(_ts_to_dt(m.create_time).date().isoformat() for m in msgs)
    busiest_day, busiest_day_n = (by_day.most_common(1)[0] if by_day else (None, 0))
    days_with_msgs = sorted(by_day.keys())
    longest_silence = (None, None, 0)  # (start, end, days)
    if len(days_with_msgs) > 1:
        for i in range(1, len(days_with_msgs)):
            a = datetime.strptime(days_with_msgs[i - 1], "%Y-%m-%d")
            b = datetime.strptime(days_with_msgs[i], "%Y-%m-%d")
            gap = (b - a).days
            if gap > longest_silence[2]:
                longest_silence = (days_with_msgs[i - 1], days_with_msgs[i], gap)

    # --- Solo monologue: longest streak of same-sender messages ---
    longest_streak_self = longest_streak_other = 0
    cur_sender = None
    cur_n = 0
    for m in msgs:
        if m.sender_wxid == cur_sender:
            cur_n += 1
        else:
            cur_sender, cur_n = m.sender_wxid, 1
        if cur_sender == me:
            longest_streak_self = max(longest_streak_self, cur_n)
        else:
            longest_streak_other = max(longest_streak_other, cur_n)

    # --- Late night (23-04) ratio ---
    late_night = sum(1 for m in msgs if _ts_to_dt(m.create_time).hour in (23, 0, 1, 2, 3, 4))

    # --- Counts of special interactions ---
    voice_count = sum(1 for m in msgs if m.msg_type == 34)
    image_count = sum(1 for m in msgs if m.msg_type == 3)
    video_count = sum(1 for m in msgs if m.msg_type == 43)
    voip_count = sum(1 for m in msgs if m.msg_type in (50, 62))

    # --- Average message length ---
    avg_self_len = round(sum(len(m.text) for m in text_self) / len(text_self), 1) if text_self else 0
    avg_other_len = round(sum(len(m.text) for m in text_other) / len(text_other), 1) if text_other else 0

    # --- Active span ---
    first_ts, last_ts = msgs[0].create_time, msgs[-1].create_time
    span_days = max(1, (last_ts - first_ts) // 86400)
    msgs_per_active_day = round(len(msgs) / len(days_with_msgs), 1) if days_with_msgs else 0
    active_day_ratio = round(len(days_with_msgs) / span_days, 3)

    # --- Auto labels ---
    labels = []
    if not is_group:
        if init_self + init_other > 0:
            self_init_share = init_self / (init_self + init_other)
            if self_init_share > 0.65:
                labels.append("你更主动")
            elif self_init_share < 0.35:
                labels.append("对方更主动")
            else:
                labels.append("互动均衡")
        if late_night / len(msgs) > 0.25:
            labels.append("深夜聊天")
        if voice_count > 30:
            labels.append("语音密")
        if voip_count > 5:
            labels.append("打电话")
        if span_days > 365 and active_day_ratio > 0.3:
            labels.append("老朋友")
        if (datetime.now(CST).timestamp() - last_ts) > 60 * 86400:
            labels.append("近期断联")
        if msgs_per_active_day > 50:
            labels.append("话痨型")

    # Compute the deeper relationship signals — pass SNS (Moments) for the friend
    sns_for_friend = None
    if not is_group:
        try:
            sns_data = get_sns_signals_cached(store)
            sns_for_friend = sns_data.get(username) or {}
        except Exception:
            sns_for_friend = None
    signals = relationship_signals(msgs, is_group=is_group, me=me, sns_signals=sns_for_friend)

    return {
        "wxid": username,
        "name": contact.display(),
        "is_group": is_group,
        "remark": contact.remark,
        "nick_name": contact.nick_name,
        "alias": contact.alias,
        "labels": labels,
        "relationship_signals": signals,  # ⭐ time-persistence, offline evidence, vulnerability
        "totals": {
            "messages": len(msgs),
            "self_messages": len(self_msgs),
            "other_messages": len(other_msgs),
            "text_messages": len(text_self) + len(text_other),
            "voice": voice_count,
            "image": image_count,
            "video": video_count,
            "voip_calls": voip_count,
        },
        "balance": {
            "self_share_msgs": round(len(self_msgs) / len(msgs), 3),
            "self_share_chars": round(sum(len(m.text) for m in text_self) /
                                     max(1, sum(len(m.text) for m in text_self) + sum(len(m.text) for m in text_other)), 3),
            "avg_self_msg_len": avg_self_len,
            "avg_other_msg_len": avg_other_len,
            "conversations_initiated_by_self": init_self,
            "conversations_initiated_by_other": init_other,
            "longest_self_streak": longest_streak_self,
            "longest_other_streak": longest_streak_other,
        },
        "responsiveness": {
            "self_median_reply": _med(self_reply_lats),
            "self_median_reply_human": _format_seconds(_med(self_reply_lats)) if _med(self_reply_lats) else None,
            "other_median_reply": _med(other_reply_lats),
            "other_median_reply_human": _format_seconds(_med(other_reply_lats)) if _med(other_reply_lats) else None,
            "self_replies_within_1min": sum(1 for s in self_reply_lats if s <= 60),
            "other_replies_within_1min": sum(1 for s in other_reply_lats if s <= 60),
        },
        "rhythm": {
            "first_message": _ts_to_dt(first_ts).isoformat(),
            "last_message": _ts_to_dt(last_ts).isoformat(),
            "span_days": span_days,
            "active_days": len(days_with_msgs),
            "active_day_ratio": active_day_ratio,
            "msgs_per_active_day": msgs_per_active_day,
            "busiest_day": busiest_day,
            "busiest_day_count": busiest_day_n,
            "longest_silence_days": longest_silence[2],
            "longest_silence_from": longest_silence[0],
            "longest_silence_to": longest_silence[1],
            "late_night_ratio": round(late_night / len(msgs), 3),
            "by_hour": {str(h): sum(1 for m in msgs if _ts_to_dt(m.create_time).hour == h) for h in range(24)},
            "by_year": dict(sorted(Counter(_ts_to_dt(m.create_time).year for m in msgs).items())),
        },
        "vocabulary": {
            "self_top_words": dict(self_words.most_common(25)),
            "other_top_words": dict(other_words.most_common(25)),
        },
    }


def format_report_markdown(a: dict) -> str:
    """Render local_analysis dict as a human-readable Markdown report."""
    if a.get("totals", {}).get("messages", 0) == 0:
        return f"# {a.get('name') or a.get('wxid')}\n\n暂无消息记录。\n"

    name = a["name"] or a["wxid"]
    t, b, r, rh, v = a["totals"], a["balance"], a["responsiveness"], a["rhythm"], a["vocabulary"]
    labels = " · ".join(a["labels"]) if a["labels"] else "—"

    def pct(x): return f"{round(x * 100, 1)}%"

    sig = a.get("relationship_signals", {})

    out = []
    out.append(f"# 与 {name} 的关系档案\n")
    out.append(f"> **wxid**: `{a['wxid']}` · **类型**: {'群聊' if a['is_group'] else '私聊'} · **标签**: {labels}\n")
    if a.get("remark") or a.get("nick_name") or a.get("alias"):
        out.append(f"> 备注: {a['remark'] or '-'} · 昵称: {a['nick_name'] or '-'} · 微信号: {a['alias'] or '-'}\n")
    out.append("")

    # ===== TIER + SIGNATURES (LEAD WITH RELATIONSHIP-QUALITY SIGNALS, NOT VOLUME) =====
    if sig.get("tier") and not a["is_group"]:
        out.append("## 关系画像（基于线下交流证据 + 时间持续，不是消息量）\n")
        out.append(f"- **关系层级**: {sig.get('tier_label', '—')} (内部代号 `{sig.get('tier')}`)")
        if sig.get("signature_notes"):
            out.append("- **关键判据**:")
            for n in sig["signature_notes"]:
                out.append(f"  - ✓ {n}")
        out.append("")

    out.append("## 时间持续性（强信号 — 比消息量更能说明关系）\n")
    if sig.get("longevity_years"):
        out.append(f"- **跨年关系**: {sig['longevity_years']} 年（{sig.get('active_years', [None,None])[0]} → {sig.get('active_years', [None])[-1]}）")
        out.append(f"  > 多年持续 = 高概率有线下纽带 / 真感情；3+ 年是关系深度的硬门槛")
    out.append(f"- **首次到最近**: {rh['first_message'][:10]} → {rh['last_message'][:10]}（{rh['span_days']:,} 天）")
    out.append(f"- **活跃日数**: {rh['active_days']} 天（占跨度的 {pct(rh['active_day_ratio'])})")
    if sig.get("resurrection_count", 0) > 0:
        out.append(f"- **沉默后重连**: {sig['resurrection_count']} 次长沉默后又联系")
        out.append(f"  > 这是关系韧性的关键标志：能 沉得住 也能 接得回来")
        if sig.get("resurrections"):
            for res in sig["resurrections"][:3]:
                out.append(f"  - {res['before']} → {res['after']}（沉默 {res['gap_days']} 天）")
    out.append("")

    out.append("## 线下交流证据（关键 — 有就是真朋友）\n")
    off = sig.get("offline_evidence", {})
    out.append(f"- **含线下约见线索的消息**: {off.get('count', 0)} 条")
    out.append(f"  > 关键词：周末/明天见/带你/我家/几点/吃饭 …")
    if off.get("count", 0) > 0:
        out.append(f"  - 含义：你们在微信之外有真实交集，关系不只是赛博的")
    else:
        out.append(f"  - 一条没有 → 大概率纯线上关系，慎重评估深度")
    if off.get("examples"):
        out.append("- **样例**：")
        for ex in off["examples"][:3]:
            out.append(f"  - `[{ex['date']}]` {ex['from']}: {ex['text'][:80]} （触发词「{ex['kw']}」）")
    out.append("")

    if not a["is_group"]:
        out.append("## 信任与脆弱（深关系指标）\n")
        vuln = sig.get("vulnerability", {})
        out.append(f"- **你的脆弱表达**: {vuln.get('self_disclose_count', 0)} 次（关键词：累/烦/想死/分手/吵架等）")
        out.append(f"- **对方的脆弱表达**: {vuln.get('other_disclose_count', 0)} 次")
        if (vuln.get('self_disclose_count', 0) + vuln.get('other_disclose_count', 0)) >= 3:
            out.append(f"  > 双方都有脆弱表达 → 高信任，是可以打破社交礼仪的对象")
        if vuln.get("examples"):
            out.append("- **样例**：")
            for ex in vuln["examples"][:2]:
                out.append(f"  - `[{ex['date']}]` {ex['from']}: {ex['text'][:80]}")
        out.append("")

        care = sig.get("mutual_care", {})
        out.append("## 相互关心\n")
        out.append(f"- 你问候对方: {care.get('self_to_other', 0)} 次（你怎么样 / 还好吗 / 注意身体 等）")
        out.append(f"- 对方问候你: {care.get('other_to_self', 0)} 次")
        diff = abs(care.get('self_to_other', 0) - care.get('other_to_self', 0))
        if diff > 5 and (care.get('self_to_other', 0) + care.get('other_to_self', 0)) > 0:
            higher = "你" if care.get('self_to_other', 0) > care.get('other_to_self', 0) else "对方"
            out.append(f"  > **关心不对等**：{higher} 主动关怀更多。这是关系投入度差异的明显信号")
        out.append("")

        rec = sig.get("conflict_recovery", {})
        if rec.get("apology_count", 0) > 0:
            out.append("## 冲突修复\n")
            out.append(f"- **道歉/和解次数**: {rec['apology_count']}")
            out.append(f"  > 真朋友/亲密关系的标志：经历过冲突还能继续。比从没吵过架的关系更稳")
            for ex in rec.get("examples", [])[:2]:
                out.append(f"  - `[{ex['date']}]` {ex['from']}: {ex['text'][:80]}")
            out.append("")

        if sig.get("calls", 0) > 0:
            out.append("## 语音/视频通话\n")
            out.append(f"- **通话次数**: {sig['calls']}")
            out.append(f"  > 通话比文字深一个量级。打过 5 次以上电话的人通常是真朋友。")
            out.append("")

        lc = sig.get("lifecycle", {})
        if lc.get("count", 0) > 0:
            out.append("## 重大人生事件分享\n")
            out.append(f"- **共享的人生节点**: {lc['count']} 次（毕业/入职/搬家/结婚/生病/过年 等）")
            for ex in lc.get("examples", [])[:3]:
                out.append(f"  - `[{ex['date']}]` {ex['from']}: {ex['text'][:80]} (`{ex['kw']}`)")
            out.append("")

        # Moments (朋友圈) section — pulls from signature_notes which already contains
        # the prepared "你给他/他给你的点赞/评论" strings.
        moments_notes = [n for n in sig.get("signature_notes", []) if "朋友圈" in n]
        if moments_notes:
            out.append("## 朋友圈互动（隐性关系信号）\n")
            for mn in moments_notes:
                out.append(f"- {mn}")
            out.append("  > 朋友圈是低社交成本的表达，互动频次反映「想到对方」的真实程度。")
            out.append("  > 单方面的朋友圈点赞/评论是关系不对等的强信号。")
            out.append("")

    # ===== Volume metrics (DOWNRANKED — supporting role only) =====
    out.append("## 互动量（仅作参考，不能单独说明关系深度）\n")
    out.append(f"- **总消息数**: {t['messages']:,} 条（你 {t['self_messages']:,} · 对方 {t['other_messages']:,}）")
    out.append(f"- **平均每个聊天日**: {rh['msgs_per_active_day']} 条")
    out.append(f"- **最热闹的一天**: {rh['busiest_day']}（{rh['busiest_day_count']} 条）")
    if rh["longest_silence_days"] > 0:
        out.append(f"- **最长沉默**: {rh['longest_silence_days']} 天（{rh['longest_silence_from']} → {rh['longest_silence_to']}）")
    out.append("")

    out.append("## 谁更主动\n")
    out.append(f"- 消息条数占比 — 你: **{pct(b['self_share_msgs'])}** · 对方: {pct(1 - b['self_share_msgs'])}")
    out.append(f"- 字数占比 — 你: **{pct(b['self_share_chars'])}** · 对方: {pct(1 - b['self_share_chars'])}")
    out.append(f"- 单条平均字数 — 你: {b['avg_self_msg_len']} · 对方: {b['avg_other_msg_len']}")
    out.append(f"- 主动开启对话次数（间隔>4h算新对话） — 你: **{b['conversations_initiated_by_self']}** · 对方: {b['conversations_initiated_by_other']}")
    out.append(f"- 单方连发最长一串 — 你: {b['longest_self_streak']} 条 · 对方: {b['longest_other_streak']} 条")
    out.append("")

    out.append("## 回复速度\n")
    out.append(f"- 你的回复中位数: **{r['self_median_reply_human'] or '—'}** （1 分钟内秒回 {r['self_replies_within_1min']} 次）")
    out.append(f"- 对方回复中位数: **{r['other_median_reply_human'] or '—'}** （1 分钟内秒回 {r['other_replies_within_1min']} 次）")
    out.append("")

    out.append("## 互动节奏\n")
    out.append(f"- **深夜（23-4 点）消息占比**: {pct(rh['late_night_ratio'])}")
    # Top 5 hours
    sorted_hours = sorted(rh["by_hour"].items(), key=lambda x: -x[1])[:5]
    out.append("- **最常聊天时段**: " + " · ".join(f"{h}时({n}条)" for h, n in sorted_hours if n > 0))
    out.append("- **按年分布**: " + " · ".join(f"{y}: {n:,}" for y, n in rh["by_year"].items()))
    out.append("")

    out.append("## 媒体类型\n")
    out.append(f"- 文本: {t['text_messages']:,} · 图片: {t['image']} · 语音: {t['voice']} · 视频: {t['video']} · 通话: {t['voip_calls']}")
    out.append("")

    out.append("## 高频词（粗略）\n")
    if v["self_top_words"]:
        out.append("**你常说**: " + " · ".join(f"{w}({n})" for w, n in list(v["self_top_words"].items())[:15]))
    if v["other_top_words"]:
        out.append("**对方常说**: " + " · ".join(f"{w}({n})" for w, n in list(v["other_top_words"].items())[:15]))
    out.append("")

    return "\n".join(out)


def find_friend_in_groups(store: EchoStore, friend_wxid: str,
                            max_groups: int = 8, msgs_per_group: int = 25,
                            context_before: int = 1, context_after: int = 1) -> list[dict]:
    """Find groups where `friend_wxid` and self both appear, with surrounding context.

    Critical for relationship analysis: a friend's messages in isolation are useless —
    you need to see WHO ELSE is in the group and WHO they're talking to. Group nicknames
    are unreliable (people rename freely), so we resolve every speaker by their stable
    wxid → contact.display() (your own contact-book remark/nickname). That way "凯" in the
    group is rendered as "kevin" if that's how you saved him.

    Returns list of {
        group_name, group_id, total_msgs_in_group,
        members_known: [{wxid, name, msg_count}],   # other people in this group you have in contacts
        sample_windows: [{date, lines: [{from, from_id, text, is_friend, is_self}]}]
    }, sorted by friend's activity.
    """
    contacts = store.contacts()
    me = store.me

    def stable_name(wxid: str) -> str:
        if wxid == "self" or wxid == me:
            return "你"
        c = contacts.get(wxid)
        if c:
            return c.display()
        return f"~{wxid[-6:]}" if wxid and wxid.startswith("wxid_") else (wxid or "?")

    out: list[dict] = []
    for s in store.sessions():
        if not s.is_group:
            continue
        try:
            all_msgs = list(store.messages(s.username, text_only=True))
        except Exception:
            continue
        if not all_msgs:
            continue

        # Indices where the target friend spoke
        friend_indices = [i for i, m in enumerate(all_msgs) if m.sender_wxid == friend_wxid]
        if len(friend_indices) < 5:
            continue

        # Members you also know — count messages per recognised wxid
        member_counts: dict[str, int] = {}
        for m in all_msgs:
            w = m.sender_wxid
            if not w or w == "self" or w == friend_wxid:
                continue
            if w in contacts:
                member_counts[w] = member_counts.get(w, 0) + 1
        members_known = [
            {"wxid": w, "name": contacts[w].display(), "msg_count": n}
            for w, n in sorted(member_counts.items(), key=lambda kv: -kv[1])
        ][:12]

        # Pick spread of friend-message indices: head + middle + tail
        n_pick = min(msgs_per_group, len(friend_indices))
        if n_pick >= 6:
            n_head = n_pick // 3
            n_tail = n_pick // 3
            n_mid = n_pick - n_head - n_tail
            mid_pool = friend_indices[len(friend_indices) // 4: -max(1, len(friend_indices) // 4)]
            if mid_pool:
                step = max(1, len(mid_pool) // max(1, n_mid))
                mid_picks = mid_pool[::step][:n_mid]
            else:
                mid_picks = []
            picked_indices = friend_indices[:n_head] + mid_picks + friend_indices[-n_tail:]
        else:
            picked_indices = friend_indices[:n_pick]

        # Build context windows around each pick: ±context msgs
        used_idx: set[int] = set()
        windows: list[list[int]] = []
        for fi in picked_indices:
            lo = max(0, fi - context_before)
            hi = min(len(all_msgs), fi + context_after + 1)
            window_idxs = [k for k in range(lo, hi) if k not in used_idx]
            if not window_idxs:
                continue
            for k in window_idxs:
                used_idx.add(k)
            windows.append(window_idxs)

        # Render each window as a small dialogue snippet
        sample_windows = []
        for win in windows:
            lines = []
            for k in win:
                m = all_msgs[k]
                lines.append({
                    "from": stable_name(m.sender_wxid),
                    "from_id": m.sender_wxid,
                    "text": (m.text or "")[:200],
                    "is_friend": m.sender_wxid == friend_wxid,
                    "is_self": m.sender_wxid == "self" or m.sender_wxid == me,
                })
            if lines:
                sample_windows.append({
                    "date": _ts_to_dt(all_msgs[win[0]].create_time).strftime("%Y-%m-%d"),
                    "lines": lines,
                })

        c = contacts.get(s.username)
        out.append({
            "group_name": (c.display() if c else s.username),
            "group_id": s.username,
            "total_msgs_in_group": len(friend_indices),
            "members_known": members_known,
            "sample_windows": sample_windows,
            # Backwards-compat: keep the old flat list too in case anything else reads it
            "sample_msgs": [
                {"date": w["date"],
                 "text": next((ln["text"] for ln in w["lines"] if ln["is_friend"]), w["lines"][0]["text"])}
                for w in sample_windows
            ],
        })

    out.sort(key=lambda r: -r["total_msgs_in_group"])
    return out[:max_groups]


_MENTION_EXCLUDE = {"你", "我", "他", "她", "好", "对", "嗯", "哈", "啊", "OK", "ok",
                    "nt", "no", "yes", "yo", "hi", "lol", "lmao",
                    "妈妈", "爸爸", "今天", "昨天", "明天", "时候", "什么", "怎么",
                    "狗屎", "傻逼", "卧槽", "牛逼", "牛批", "操", "靠", "妈的", "废物",
                    "垃圾", "tmd", "nmsl", "sb", "wcnm", "cnm", "傻瓜", "傻子", "笨蛋", "白痴"}


def _mention_names_for_contact(c: Contact) -> list[str]:
    names: list[str] = []
    for raw in (c.remark, c.nick_name, c.alias, c.display()):
        if not raw:
            continue
        n = str(raw).strip()
        if not n or n in names:
            continue
        is_ascii = all(ord(ch) < 128 for ch in n)
        min_len = 3 if is_ascii else 2
        if len(n) < min_len:
            continue
        if n.lower() in _MENTION_EXCLUDE or n in _MENTION_EXCLUDE:
            continue
        names.append(n)
    names.sort(key=len, reverse=True)
    return names


def _text_mentions_name(text: str, name: str) -> bool:
    if not text or not name:
        return False
    is_ascii = all(ord(ch) < 128 for ch in name)
    if is_ascii:
        return re.search(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])",
                         text, flags=re.IGNORECASE) is not None
    return name in text


def _scan_mentions_in_chat(store: EchoStore, chat_wxid: str, target_wxid: str,
                           max_examples: int = 5) -> dict:
    contact = store.contact(target_wxid)
    names = _mention_names_for_contact(contact)
    out = {"count": 0, "examples": [], "names": names}
    if not names:
        return out
    for m in store.messages(chat_wxid, text_only=True):
        matched = next((n for n in names if _text_mentions_name(m.text, n)), None)
        if not matched:
            continue
        out["count"] += 1
        if len(out["examples"]) < max_examples:
            out["examples"].append({
                "ts": m.create_time,
                "date": _ts_to_dt(m.create_time).strftime("%Y-%m-%d"),
                "from": m.sender_name,
                "text": m.text[:180],
                "matched_name": matched,
            })
    return out


def extract_mentions_of_friend(store: EchoStore, target_wxid: str,
                               min_count: int = 1, max_chats: int = 10) -> list[dict]:
    """Find private chats with other friends where the target person is mentioned."""
    contacts = store.contacts()
    related: list[dict] = []
    for s in store.sessions():
        if s.is_group or s.username == target_wxid:
            continue
        c = contacts.get(s.username)
        if not c or not c.is_real_friend:
            continue
        rec = _scan_mentions_in_chat(store, s.username, target_wxid, max_examples=3)
        if rec["count"] >= min_count:
            related.append({
                "other": c.display() or s.username,
                "other_wxid": s.username,
                "count": rec["count"],
                "examples": rec["examples"],
            })
    related.sort(key=lambda r: -r["count"])
    return related[:max_chats]


def extract_pair_mentions_direct(store: EchoStore, wxid_a: str, wxid_b: str) -> dict:
    """Direct, pair-specific mention scan; avoids the top-50 global cache missing long-tail pairs."""
    canonical = tuple(sorted([wxid_a, wxid_b]))
    b_in_a_chat = _scan_mentions_in_chat(store, wxid_a, wxid_b, max_examples=5)
    a_in_b_chat = _scan_mentions_in_chat(store, wxid_b, wxid_a, max_examples=5)
    return {
        "wxid_a": canonical[0],
        "wxid_b": canonical[1],
        f"mentions_in_chat_with_{wxid_a}": b_in_a_chat["count"],
        f"mentions_in_chat_with_{wxid_b}": a_in_b_chat["count"],
        "total_mentions": b_in_a_chat["count"] + a_in_b_chat["count"],
        "examples": sorted((b_in_a_chat["examples"] + a_in_b_chat["examples"])[:10],
                           key=lambda x: x.get("ts", 0), reverse=True),
        "names_a": a_in_b_chat["names"],
        "names_b": b_in_a_chat["names"],
    }


def _pick_spread(items: list, limit: int) -> list:
    """Pick head/middle/tail samples without biasing only to old messages."""
    if limit <= 0 or len(items) <= limit:
        return items
    n_head = max(1, limit // 4)
    n_tail = max(1, limit // 4)
    n_mid = max(0, limit - n_head - n_tail)
    head = items[:n_head]
    tail = items[-n_tail:] if n_tail else []
    middle = items[n_head:len(items) - n_tail] if n_tail else items[n_head:]
    mid = []
    if n_mid > 0 and middle:
        step = max(1, len(middle) // n_mid)
        mid = middle[::step][:n_mid]
    seen = set()
    out = []
    for it in head + mid + tail:
        key = (getattr(it, "create_time", None), getattr(it, "sender_wxid", None), getattr(it, "msg_type", None))
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def _pick_spread_indices(indices: list[int], limit: int) -> list[int]:
    if limit <= 0 or len(indices) <= limit:
        return indices
    n_head = max(1, limit // 4)
    n_tail = max(1, limit // 4)
    n_mid = max(0, limit - n_head - n_tail)
    head = indices[:n_head]
    tail = indices[-n_tail:] if n_tail else []
    middle = indices[n_head:len(indices) - n_tail] if n_tail else indices[n_head:]
    mid = []
    if n_mid > 0 and middle:
        step = max(1, len(middle) // n_mid)
        mid = middle[::step][:n_mid]
    picked = head + mid + tail
    return sorted(dict.fromkeys(picked))


def sample_non_text_events(store: EchoStore, username: str, limit: int = 12) -> list[dict]:
    """Small, time-spread sample of voice/images/videos/calls so LLM sees non-text intimacy signals."""
    picked = []
    try:
        non_text = [m for m in store.messages(username, text_only=False) if m.msg_type != 1]
        picked = _pick_spread(non_text, limit)
    except Exception:
        picked = []
    out = []
    for m in picked:
        out.append({
            "date": _ts_to_dt(m.create_time).strftime("%Y-%m-%d"),
            "from": "你" if m.sender_wxid == "self" or m.sender_wxid == store.me else m.sender_name,
            "type": m.raw_type_label,
            "text": m.text,
        })
    return out


def build_analysis_pack(store: EchoStore, username: str, sample_n: int = 80,
                         include_group_context: bool = True) -> str:
    """Returns a Markdown file (本地分析报告 + 数据样本 + LLM prompt) that any chatbot can ingest.

    If include_group_context=True (default), also pulls this person's messages from all shared groups
    so the LLM sees their public-facing self in addition to the private chat.
    """
    a = local_analysis(store, username)
    if a.get("totals", {}).get("messages", 0) == 0:
        return f"# {a.get('name') or username}\n\n暂无消息记录。\n"

    # Pull samples — never exceed sample_n total
    msgs = list(store.messages(username, text_only=True))
    # Allocate budget: ~25% head, ~25% tail, ~50% middle (adjusts for tiny sample_n)
    n_head = max(1, min(int(sample_n * 0.25), 20))
    n_tail = max(1, min(int(sample_n * 0.30), 30))
    n_mid = max(0, sample_n - n_head - n_tail)
    head = msgs[:n_head]
    tail = msgs[-n_tail:] if n_tail else []
    middle = msgs[n_head: len(msgs) - n_tail] if n_tail else msgs[n_head:]
    if n_mid > 0 and middle:
        step = max(1, len(middle) // n_mid)
        mid = middle[::step][:n_mid]
    else:
        mid = []
    # Dedupe by (ts, sender_wxid) in case of overlap on tiny corpora
    seen = set()
    samples = []
    for m in head + mid + tail:
        k = (m.create_time, m.sender_wxid, m.text[:20])
        if k in seen:
            continue
        seen.add(k)
        samples.append(m)

    name = a["name"] or username
    parts = []
    parts.append(format_report_markdown(a))
    parts.append("\n---\n")
    parts.append("## 抽样对话（按时间分布）\n")
    if a["is_group"]:
        # 在群聊里，每个发送者都有自己的稳定显示名 + 后缀的 wxid 末 6 位作为唯一标识符，
        # 防止"群里有同名/改名导致看起来像两个人"。
        parts.append("> 头 15 条 + 中段抽样 + 尾 25 条。`你:` = 我自己。其他人按"
                     "「显示名 (~wxid后6位)」格式列出 —— 同一个尾号始终是同一个人，"
                     "即使他改名也不会被算成两个人。\n")
        for m in samples:
            if m.sender_wxid == "self":
                who = "你"
            else:
                tail = m.sender_wxid[-6:] if m.sender_wxid.startswith("wxid_") else m.sender_wxid[-6:]
                who = f"{m.sender_name} (~{tail})"
            parts.append(f"- `[{m.to_dict()['time'][:16]}]` **{who}**: {m.text}")
    else:
        parts.append("> 头 15 条 + 中段抽样 + 尾 25 条。`你:` = 我自己，其他都是对方。\n")
        for m in samples:
            who = "你" if m.sender_wxid == "self" else name
            parts.append(f"- `[{m.to_dict()['time'][:16]}]` **{who}**: {m.text}")

        non_text_events = sample_non_text_events(store, username, limit=12)
        if non_text_events:
            parts.append("\n---\n")
            parts.append(f"## 非文本互动样本（图片 / 语音 / 视频 / 通话）\n")
            parts.append(
                "> 非文本消息不展开原始内容，只保留时间、方向和类型。"
                "语音、图片、视频和通话往往是亲密度、线下协作或实时求助的补充证据。\n"
            )
            for ev in non_text_events:
                parts.append(f"- `[{ev['date']}]` **{ev['from']}**: {ev['text'] or '[' + ev['type'] + ']'}")

    # === Cross-scene context: this person's behavior in shared groups ===
    if include_group_context and not a["is_group"]:
        try:
            group_ctx = find_friend_in_groups(store, username, max_groups=6, msgs_per_group=20)
        except Exception:
            group_ctx = []
        if group_ctx:
            parts.append("\n---\n")
            parts.append(f"## 跨场景：「{name}」 在群聊里的发言（公开侧的他）\n")
            parts.append(
                "> 上方是私聊里的他，下面是同一个人**在你们都在的群里**怎么说话。\n"
                "> 每段都包含 ±1 条上下文 —— 是谁问的、谁接话，能看出他在群里和谁互动。\n"
                "> **重要**：群里每个发言者都按你通讯录里的备注/昵称显示（**不受群昵称改名影响**）。"
                "同一个人即使改了群昵称也是同一个名字。\n"
            )
            for g in group_ctx:
                parts.append(f"\n### 群「{g['group_name']}」（共 {g['total_msgs_in_group']} 条他的发言）\n")
                if g.get("members_known"):
                    members_line = "、".join(
                        f"{mk['name']}({mk['msg_count']}条)" for mk in g["members_known"][:8]
                    )
                    parts.append(f"**这个群里你认识的人**：{members_line}\n")
                # Render context windows as small dialogue blocks
                if g.get("sample_windows"):
                    for w in g["sample_windows"]:
                        parts.append(f"\n`[{w['date']}]`")
                        for ln in w["lines"]:
                            marker = "**→**" if ln["is_friend"] else "  "
                            parts.append(f"{marker} **{ln['from']}**: {ln['text']}")
                else:
                    # Fallback: old flat sample_msgs
                    for m in g.get("sample_msgs", []):
                        parts.append(f"- `[{m['date']}]` {m['text']}")

    # === Cross-references: this person being mentioned in your chats with OTHER friends ===
    if not a["is_group"]:
        try:
            related = extract_mentions_of_friend(store, username, min_count=1, max_chats=10)
        except Exception:
            related = []
        if related:
            parts.append("\n---\n")
            parts.append(f"## 跨场景：你和**别的朋友**聊到「{name}」时\n")
            parts.append(
                "> 这是全量扫描你的所有私聊后得到的结果，不再只看 Top 50 好友。"
                "你在和谁聊天时提到这个人，是推断「他在你社交圈里的角色」的关键证据。\n"
            )
            for r in related[:8]:
                parts.append(f"\n**当你和「{r['other']}」聊天时**，提到「{name}」 {r['count']} 次：")
                for ex in r["examples"]:
                    parts.append(f"- `[{ex['date']}]` {ex['from']}: {ex['text']}")

    # === Voice transcripts (Whisper-decoded) ===
    if not a["is_group"]:
        try:
            tx_idx_path = Path.home() / "Desktop" / "Murmur" / "voice_transcripts" / "_index.json"
            if tx_idx_path.exists():
                tx_idx = json.loads(tx_idx_path.read_text(encoding="utf-8"))
                tx_for_friend = tx_idx.get(username, {})
                clips = tx_for_friend.get("clips", [])
                if clips:
                    parts.append("\n---\n")
                    parts.append(f"## 语音消息（Whisper 转写）— 共 {len(clips)} 条\n")
                    parts.append(
                        "> 这是「这个人发给你的语音」转成的文字。语音里说的话往往比打字更亲昵 / 更随性 / "
                        "更敢吐露真情，对推断关系深度（特别是 vulnerability + 线下生活）极有价值。\n"
                    )
                    # Sample: head 8 + middle 4 + tail 8 to show evolution
                    n = len(clips)
                    if n <= 20:
                        picked = clips
                    else:
                        head = clips[:8]
                        tail = clips[-8:]
                        mid_pool = clips[8:-8]
                        step = max(1, len(mid_pool) // 4)
                        mid = mid_pool[::step][:4]
                        picked = head + mid + tail
                    for clip in picked:
                        ts = clip.get("ts", 0)
                        date_s = datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%d") if ts else "?"
                        text = (clip.get("text") or "").strip()
                        if text:
                            parts.append(f"- `[{date_s}]` 「{text[:200]}」")
        except Exception:
            pass

    # === Direct self↔friend Moments examples ===
    if not a["is_group"]:
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import sns as _sns_mod
            direct_moments = _sns_mod.direct_interaction_examples(store.dir, store.me or "", username, limit=12)
        except Exception:
            direct_moments = []
        if direct_moments:
            parts.append("\n---\n")
            parts.append(f"## 朋友圈互动明细：你 ↔ 「{name}」\n")
            parts.append(
                "> 朋友圈互动是独立于聊天的信号。下面列出方向、互动类型、评论原文或朋友圈正文片段，"
                "供 LLM 判断是否单向、不对等、礼貌性点赞，还是长期真实关注。\n"
            )
            for ex in direct_moments:
                direction = "他/她 → 你" if ex.get("direction") == "friend_to_you" else "你 → 他/她"
                kind = "评论" if ex.get("type") == "comment" else "点赞"
                detail = ex.get("text") or ex.get("post_text") or ""
                parts.append(f"- `[{ex.get('date')}]` **{direction}** {kind}: {detail[:180] or '（无文字）'}")

    # === Cross-scene: friend-to-friend Moments interactions (no chat involved) ===
    if not a["is_group"]:
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import sns as _sns_mod
            ff_moments = _sns_mod.friend_to_friend_signals(store.dir, store.me or "")
        except Exception:
            ff_moments = {}
        contacts_map = store.contacts()
        cross_pairs = []
        for (pa, pb), s in ff_moments.items():
            if username not in (pa, pb):
                continue
            other = pb if pa == username else pa
            if other not in contacts_map:
                continue
            other_to_me = s["a_liked_b"] + s["a_commented_b"] if other == pa else s["b_liked_a"] + s["b_commented_a"]
            me_to_other = s["b_liked_a"] + s["b_commented_a"] if other == pa else s["a_liked_b"] + s["a_commented_b"]
            tot = other_to_me + me_to_other
            if tot >= 2:
                cross_pairs.append({
                    "other": contacts_map[other].display(),
                    "other_to_target": other_to_me,
                    "target_to_other": me_to_other,
                    "examples": [ex for ex in s["examples"] if ex.get("text")][:3],
                })
        cross_pairs.sort(key=lambda r: -(r["other_to_target"] + r["target_to_other"]))
        if cross_pairs:
            parts.append("\n---\n")
            parts.append(f"## 跨场景：「{name}」与你**其他朋友**之间的朋友圈互动（不经你）\n")
            parts.append(
                "> 这是 A↔B 关系最干净的独立证据——两个人在朋友圈互相点赞/评论，与你毫无关系。"
                "如果出现了，说明他们认识、并且至少有一定来往。\n"
            )
            for r in cross_pairs[:8]:
                parts.append(
                    f"- **「{r['other']}」**：「{name}」给他 {r['target_to_other']} 次互动 / "
                    f"他给「{name}」 {r['other_to_target']} 次"
                )
                for ex in r["examples"]:
                    if ex.get("text"):
                        parts.append(f"    - 评论样本：「{ex['text']}」")

    # === Alias hint ===
    # Mention extraction matches by display name. If the friend is referred to via
    # nickname / pet name (e.g. 女神/老婆/我哥), those mentions are missed. Tell the LLM
    # to scan the chat samples for honorific patterns and connect the dots.
    if not a["is_group"]:
        parts.append("\n---\n")
        parts.append("## 别名提示（LLM 必读）\n")
        parts.append(
            f"> 上方的「跨场景提及」只匹配 `{name}` 这个字面名字。"
            f"现实里朋友常用别名/外号/敬称（女神 / 老婆 / 哥 / 姐 / 老大 / 大佬 / 哥们 / 宝宝 / "
            f"老 X / 小 X / 英文名 / 网名）。**请你阅读样本对话时主动找：**\n"
            f"> 1. 「{name}」是否被对方叫过别的称呼？\n"
            f"> 2. 在你与其他朋友的聊天里，是否有外号经常指向同一个人（即使没出现 `{name}` 字面）？\n"
            f"> 3. 如果发现别名，**这是关系亲密的强信号**（陌生人/工具型联系不会起外号）。\n"
        )

    parts.append("\n---\n")
    parts.append("## ⬇️ 把上面整份资料 + 下面这段提示词复制粘贴给 ChatGPT / Claude / 豆包 / 文心，即可获得分析\n")
    parts.append("""```
你是一位资深的人际关系研究者。上面是我和「""" + name + """」的微信聊天数据。
请基于这些数据，输出一份**结论先行、有具体例证**的关系分析报告。

# ⚠️ 评估关系的核心原则（请反复内化，不要被数字带偏）

**消息量大 ≠ 关系好**。微信里两个人聊得多可能只是因为：群里@、转发段子、工作消息、突发新闻、共同游戏。这些都不能证明真正的人际纽带。

**真正能从聊天记录看出关系深度的 6 个硬信号**（按重要性排序）：

1. **时间持续性 (longevity)** — 跨越 3+ 年还在聊的，几乎一定是真朋友（普通熟人会自然消散）。
   特别注意：2 个 100 条消息但持续了 5 年的人，**比** 2 个 5000 条消息但只聊了 3 个月的人，**关系更深**。

2. **沉默后的重连 (resurrection)** — 经历过 60+ 天甚至几年没说话，又能自然重新联系（不是"在吗""好久不见"那种尴尬开场）的，是关系韧性的关键证明。这种关系往往是**线下/真实生活有锚点**的——比如老同学、家人朋友、长期工作伙伴。

3. **线下交流证据 (offline_evidence)** — 消息里提到"周末/明天见/我家/带你去/几点/吃饭/喝/约/一起去/聚会"等线下交集词。**这是判断"真朋友 vs 网友"的金标准**。如果 0 条线下证据，几乎可以确定是纯线上弱关系，无论聊得多 high。

4. **脆弱性表达 (vulnerability_disclosure)** — 一方或双方有"累/烦/想死/分手/吵架/抑郁/没钱/医院"等低防御性的内心话。能听这种话/讲这种话的对象，是社交防线被打破的少数人——朋友圈的内圈。

5. **相互关心 (mutual_care)** — 双方都问候对方（"你怎么样""到家了吗""注意身体"），不是单向的。如果只是一方在关心，另一方只回工具性回复，关系是不平等的，长期不可持续。

6. **冲突修复 (conflict_recovery)** — 出现过"对不起/抱歉/我错了"且**之后还在继续聊**。能吵架还能复合的关系，比从没吵过的关系更深、更真。

**附加加分项**：
- 通话次数（语音/视频）≥ 5 次 → 关系一般在朋友以上（普通熟人不会通话）
- 重大人生事件分享（毕业/入职/搬家/结婚/生病等被提到）→ 不是泛泛之交
- 内部梗、私密玩笑、互相起的外号

**减分项**：
- 永远是工作/任务/转发链接，没有日常闲聊 → 工具型关系
- 一方主动率超过 70% → 关系投入度严重不对等
- 最近 90 天活跃度断崖下降但之前很活跃 → 关系正在流逝

# 你的分析报告结构（请按此输出）

## 1. 关系定性 + 层级
基于上面 6 个硬信号，给出层级判定：
- **A 级** — 老朋友/亲人级（多年持续 + 强线下证据 + 双方有过脆弱表达）
- **B 级** — 常聊朋友（2+ 年线下有交集，互动均衡）
- **C 级** — 有联系朋友（最近还有互动，线下偶有交集）
- **D 级** — 弱联系/线上为主（可能是网友/同好友/同事旧识）
- **E 级** — 已疏远 / 工具型（很久没聊或纯任务往来）

判定时**必须引用具体数据点和消息样本**，不要光给结论。例如不要说"你们关系很好"，而要说"你们持续了 5 年（2021-2026），中间经历过 2 次 90+ 天的沉默都重新联系，offline_evidence 14 条，所以是 A 级"。

## 2. 时间维度的深度解读
- 关系是哪一年开始的？哪段时间最浓？最近的趋势？
- 沉默与回归是否对应人生重大节点（推测毕业、出国、搬家、换工作等）？
- **不要只看消息数量曲线，要看跨年份持续度**

## 3. 线下/真实生活的痕迹
- 列出 3-5 条最有"真生活"气息的对话样本（含地名/时间/具体活动）
- 评估：你们是"真生活里也会见面"还是"主要在微信里"？
- 这个判断会直接决定关系层级

## 4. 信任与情感深度
- 谁向谁吐露过什么？引用具体例子
- 关心是双向还是单向？是否对称？
- 是否经历过冲突？冲突后是怎么修复的？

## 5. 人物画像（对方大约是个什么人）
- 不仅靠词频。结合：什么时间最爱聊？聊什么话题？回复风格（短碎/长段）？情绪基调？
- 推测：他是表达型还是保守型？高情感投入还是分寸感强？

## 6. 关系走向 + 行动建议
- 升温 / 平稳 / 降温 / 已结束？依据是什么？
- 如果你想维护这段关系，下一步具体该做什么？（比如"主动发起一次见面"比"多发消息"重要得多）
- 如果关系已经在淡，是值得挽回还是顺其自然？

# 写作要求

- **每个结论都要引用至少 1 条具体消息（带日期）或 1 个统计数字作为依据。**
- 不要用空洞的形容词（"很要好""挺亲密""一般般"），要给具体的判定层级 + 证据链。
- 长度：5000 字以上。这是一段重要关系的详细体检，不是 280 字微博。
- 中文写作，温度感和洞察力并重——你是观察者，不是数据吐槽员。
```\n""")
    return "\n".join(parts)


def top_contacts(store: EchoStore, limit: int = 30, exclude_groups: bool = False) -> list[dict]:
    rows = []
    for s in store.sessions():
        if exclude_groups and s.is_group:
            continue
        cnt = fast_message_count(store, s.username)
        if cnt == 0:
            continue
        c = store.contact(s.username)
        rows.append({
            "wxid": s.username,
            "name": c.display(),
            "is_group": s.is_group,
            "message_count": cnt,
            "last_time": datetime.fromtimestamp(s.last_timestamp, CST).isoformat() if s.last_timestamp else None,
        })
    rows.sort(key=lambda r: r["message_count"], reverse=True)
    return rows[:limit]


def search_messages(store: EchoStore, keyword: str, limit: int = 100) -> list[dict]:
    out = []
    kw = keyword.lower()
    for s in store.sessions():
        for m in store.messages(s.username, text_only=True):
            if kw in m.text.lower():
                d = m.to_dict()
                d["session"] = s.username
                d["session_name"] = store.contact(s.username).display()
                out.append(d)
                if len(out) >= limit:
                    return out
    return out


# ---------- CLI ----------

def emit(obj, pretty: bool = False):
    if isinstance(obj, list) and obj and not pretty and not isinstance(obj[0], (str, int, float)):
        # JSONL for lists of dicts
        for item in obj:
            sys.stdout.write(json.dumps(item, ensure_ascii=False) + "\n")
    else:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, indent=2 if pretty else None))
        sys.stdout.write("\n")


def resolve_wxid(store: EchoStore, query: str) -> str:
    """Allow looking up by remark / nickname / alias as well as wxid."""
    if query in store.contacts():
        return query
    q = query.lower()
    matches = []
    for u, c in store.contacts().items():
        if q in (c.remark or "").lower() or q in (c.nick_name or "").lower() or q in (c.alias or "").lower():
            matches.append(c)
    if not matches:
        raise SystemExit(f"找不到联系人: {query}")
    if len(matches) > 1:
        # Disambiguate by message count
        scored = sorted(matches, key=lambda c: store.message_count(c.username), reverse=True)
        if len(scored) > 1 and store.message_count(scored[1].username) > 0:
            sys.stderr.write(f"警告: 匹配到 {len(matches)} 个联系人，使用消息最多的: {scored[0].display()} ({scored[0].username})\n")
            sys.stderr.write(f"  其他: {', '.join(c.display() + '/' + c.username for c in scored[1:5])}\n")
        return scored[0].username
    return matches[0].username


def parse_date(s: Optional[str]) -> Optional[int]:
    if not s:
        return None
    try:
        return int(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=CST).timestamp())
    except ValueError:
        try:
            return int(datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=CST).timestamp())
        except ValueError:
            raise SystemExit(f"无法解析日期: {s} (期望 YYYY-MM-DD)")


def get_store(args) -> EchoStore:
    data_dir = Path(args.data_dir) if args.data_dir else discover_data_dir()
    if not data_dir or not data_dir.exists():
        sys.stderr.write(
            "找不到 echotrace 解密数据目录。\n"
            "请检查：\n"
            "  1) 已经在 echotrace 应用里完成「批量解密」\n"
            "  2) 用 --data-dir 显式指定路径，或设环境变量 ETCLI_DATA_DIR\n"
        )
        sys.exit(2)
    return EchoStore(data_dir)  # self wxid auto-detected from data dir name


def main(argv=None):
    if argv is None and getattr(sys, "frozen", False) and len(sys.argv) == 1:
        # Packaged users sometimes find etcli.exe and double-click it when the
        # app says "backend did not start". With argparse's required subcommand
        # that used to flash a console and exit with code 2, which looked like
        # a crash. In a frozen bundle, no-arg launch should do the useful thing:
        # start the local API server on the default port.
        argv = ["serve"]
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--data-dir", help="echotrace 解密后的数据目录（默认自动检测）")
    common.add_argument("--pretty", action="store_true", help="美化 JSON 输出")

    p = argparse.ArgumentParser(prog="etcli", parents=[common],
                                description="EchoTrace 数据 CLI（输出 JSON/JSONL，给 LLM 喂数据用）")
    sub = p.add_subparsers(dest="cmd", required=True, parser_class=lambda **kw: argparse.ArgumentParser(parents=[common], **kw))

    sp = sub.add_parser("info", help="显示当前配置 / 自我 wxid / 数据目录")
    sp = sub.add_parser("contacts", help="列出所有联系人")
    sp.add_argument("--filter", help="按昵称/备注/wxid 模糊匹配")
    sp.add_argument("--groups", action="store_true", help="只列群聊")
    sp.add_argument("--no-groups", action="store_true", help="排除群聊")

    sp = sub.add_parser("sessions", help="列出所有会话（按 last_timestamp 排序）")

    sp = sub.add_parser("top", help="按消息数排序的前 N 个会话")
    sp.add_argument("--limit", type=int, default=30)
    sp.add_argument("--no-groups", action="store_true")

    sp = sub.add_parser("messages", help="导出某联系人/群的所有消息（默认 JSONL）")
    sp.add_argument("who", help="wxid 或备注/昵称片段")
    sp.add_argument("--since", help="起始日期 YYYY-MM-DD")
    sp.add_argument("--until", help="结束日期 YYYY-MM-DD")
    sp.add_argument("--limit", type=int)
    sp.add_argument("--text-only", action="store_true", help="只要文本消息")

    sp = sub.add_parser("stats", help="某联系人/群的统计")
    sp.add_argument("who")

    sp = sub.add_parser("relationship", help="人际档案：身份+统计+采样消息（适合喂给 LLM 分析）")
    sp.add_argument("who")
    sp.add_argument("--sample", type=int, default=50, help="采样消息数（默认 50）")

    sp = sub.add_parser("search", help="全局关键词搜索")
    sp.add_argument("keyword")
    sp.add_argument("--limit", type=int, default=100)

    sp = sub.add_parser("report", help="本地数据分析报告（无需 LLM，直接可读 Markdown）")
    sp.add_argument("who")
    sp.add_argument("--out", help="输出 .md 路径，默认打印到 stdout")
    sp.add_argument("--json", action="store_true", help="输出原始 JSON 而非 Markdown")

    sp = sub.add_parser("analyze", help="生成可直接喂给任意 chatbot 的「分析包」(本地分析 + 数据 + prompt)")
    sp.add_argument("who")
    sp.add_argument("--sample", type=int, default=80)
    sp.add_argument("--out", help="输出文件路径，默认 ./<联系人名>_AI分析包.md")

    sp = sub.add_parser("serve", help="启动 HTTP API 服务，给 Murmur 前端用")
    sp.add_argument("--port", type=int, default=9100)
    sp.add_argument("--host", default="127.0.0.1")
    sp.add_argument("--export-dir", help="AI 分析包默认输出目录（默认 ~/Desktop/Murmur）")

    sp = sub.add_parser("refresh", help="(PyInstaller) 调用 refresh.py 主函数解密")
    sp.add_argument("--wxid", default=None)
    sp.add_argument("--key", default=None)

    sp = sub.add_parser("extract-key", help="(PyInstaller) 调用 extract_key_dll.py 抓 key")
    sp.add_argument("--timeout", type=int, default=90)
    sp.add_argument("--auto-restart", action="store_true")

    sp = sub.add_parser("extract-key-mac", help="(PyInstaller) 调用 extract_key_mac.py 抓 key (macOS)")
    sp.add_argument("--timeout", type=int, default=120)
    sp.add_argument("--salts", default=None)
    sp.add_argument("--out-keys", default=None)
    sp.add_argument("--pid", type=int, default=None)
    sp.add_argument("--auto-restart", action="store_true")

    sp = sub.add_parser("batch", help="(PyInstaller) 调用 batch_analyze.py 跑批量")
    sp.add_argument("rest", nargs=argparse.REMAINDER, help="所有参数原样传给 batch_analyze")

    args = p.parse_args(argv)

    if args.cmd == "serve":
        return _run_server(args)

    if args.cmd == "refresh":
        import refresh as _refresh
        rest = []
        if args.wxid: rest += ["--wxid", args.wxid]
        if args.key: rest += ["--key", args.key]
        sys.argv = ["refresh"] + rest
        return _refresh.main()

    if args.cmd == "extract-key":
        import extract_key_dll as _ekd
        rest = ["--timeout", str(args.timeout)]
        if args.auto_restart: rest.append("--auto-restart")
        sys.argv = ["extract_key_dll"] + rest
        return _ekd.main() if hasattr(_ekd, "main") else _ekd.run()

    if args.cmd == "extract-key-mac":
        import extract_key_mac as _ekm
        forwarded = ["--timeout", str(args.timeout)]
        if args.salts:    forwarded += ["--salts", args.salts]
        if args.out_keys: forwarded += ["--out-keys", args.out_keys]
        if args.pid:      forwarded += ["--pid", str(args.pid)]
        if args.auto_restart: forwarded += ["--auto-restart"]
        sys.argv = ["extract_key_mac"] + forwarded
        return _ekm.main()

    if args.cmd == "batch":
        import batch_analyze as _ba
        rest = list(args.rest or [])
        if rest and rest[0] == "--": rest = rest[1:]
        sys.argv = ["batch_analyze"] + rest
        return _ba.main()

    if args.cmd == "info":
        dd = Path(args.data_dir) if args.data_dir else discover_data_dir()
        emit({
            "data_dir": str(dd) if dd else None,
            "self_wxid": self_wxid(),
            "prefs_path": str(_flutter_prefs_path()),
        }, pretty=True)
        return

    store = get_store(args)

    if args.cmd == "contacts":
        out = []
        for u, c in store.contacts().items():
            if args.groups and not c.is_group:
                continue
            if args.no_groups and c.is_group:
                continue
            if args.filter:
                f = args.filter.lower()
                hay = f"{u} {c.remark} {c.nick_name} {c.alias}".lower()
                if f not in hay:
                    continue
            out.append({
                "wxid": u, "name": c.display(),
                "remark": c.remark, "nick_name": c.nick_name, "alias": c.alias,
                "is_group": c.is_group,
            })
        emit(out, pretty=args.pretty)
    elif args.cmd == "sessions":
        emit(build_session_index(store), pretty=args.pretty)
    elif args.cmd == "top":
        emit(top_contacts(store, args.limit, exclude_groups=args.no_groups), pretty=args.pretty)
    elif args.cmd == "messages":
        wxid = resolve_wxid(store, args.who)
        gen = store.messages(wxid, since=parse_date(args.since), until=parse_date(args.until),
                             limit=args.limit, text_only=args.text_only)
        if args.pretty:
            emit([m.to_dict() for m in gen], pretty=True)
        else:
            for m in gen:
                sys.stdout.write(json.dumps(m.to_dict(), ensure_ascii=False) + "\n")
    elif args.cmd == "stats":
        wxid = resolve_wxid(store, args.who)
        emit(stats_for(store, wxid), pretty=True)
    elif args.cmd == "relationship":
        wxid = resolve_wxid(store, args.who)
        emit(relationship_dossier(store, wxid, sample_n=args.sample), pretty=args.pretty)
    elif args.cmd == "search":
        emit(search_messages(store, args.keyword, args.limit), pretty=args.pretty)
    elif args.cmd == "report":
        wxid = resolve_wxid(store, args.who)
        a = local_analysis(store, wxid)
        if args.json:
            emit(a, pretty=True)
        else:
            md = format_report_markdown(a)
            if args.out:
                Path(args.out).write_text(md, encoding="utf-8")
                sys.stdout.write(f"已生成本地分析报告：{args.out}\n")
            else:
                sys.stdout.write(md)
    elif args.cmd == "analyze":
        wxid = resolve_wxid(store, args.who)
        pack = build_analysis_pack(store, wxid, sample_n=args.sample)
        name = store.contact(wxid).display() or wxid
        out_path = Path(args.out) if args.out else Path(f"{name}_AI分析包.md")
        out_path.write_text(pack, encoding="utf-8")
        sys.stdout.write(f"已生成 AI 分析包：{out_path}\n")
        sys.stdout.write(f"用法：把这个文件直接拖进 ChatGPT / Claude / 豆包 / 文心一言 即可开始分析。\n")
        sys.stdout.write(f"      或者复制全部内容粘贴到对话框（已包含分析 prompt）。\n")


# ---------- HTTP server (for Murmur React frontend) ----------

import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
import threading
import time as _time


# Auto-derive friend cards (mirrors what the React app expects)

_HUE_FOR_NAME_CACHE: dict[str, int] = {}


def _hue_for(name: str) -> int:
    if name not in _HUE_FOR_NAME_CACHE:
        h = int(hashlib.md5(name.encode()).hexdigest()[:6], 16) % 360
        _HUE_FOR_NAME_CACHE[name] = h
    return _HUE_FOR_NAME_CACHE[name]


def _glyph_for(name: str) -> str:
    if not name:
        return "·"
    # First non-emoji char if Chinese, else first uppercase letter, else first char
    for ch in name:
        if "一" <= ch <= "鿿":
            return ch
    for ch in name:
        if ch.isascii() and ch.isalpha():
            return ch.upper()
    return name[0]


def _humanise_last(ts: int) -> str:
    if not ts:
        return "—"
    now = datetime.now(CST)
    dt = datetime.fromtimestamp(ts, CST)
    delta = now - dt
    if delta.days < 1 and dt.date() == now.date():
        return f"今天 {dt.strftime('%H:%M')}"
    if delta.days < 2:
        return f"昨天 {dt.strftime('%H:%M')}"
    if delta.days < 7:
        return f"{delta.days} 天前"
    if delta.days < 30:
        return f"{delta.days // 7} 周前"
    if delta.days < 365:
        return f"{delta.days // 30} 个月前"
    return dt.strftime("%Y-%m-%d")


def _bond_for(stats: dict) -> str:
    """Pick a one-line characterisation from the local-analysis labels + numbers."""
    labels = stats.get("labels", [])
    if "深夜聊天" in labels:
        return "凌晨破窗的那个朋友"
    if "话痨型" in labels:
        return "聊起来就停不下来"
    if "对方更主动" in labels:
        return "对方一直在主动找你"
    if "你更主动" in labels:
        return "你一直在主动找他"
    if "近期断联" in labels:
        return "已经很久没说话了"
    if "老朋友" in labels:
        return "认识很久的朋友"
    if "语音密" in labels:
        return "经常发语音"
    return "—"


def _knew(stats: dict) -> str:
    days = stats.get("rhythm", {}).get("span_days", 0)
    if days >= 365:
        return f"认识 {days // 365} 年"
    if days >= 30:
        return f"认识 {days // 30} 个月"
    return f"认识 {days} 天"


_TAG_KIND_FOR_LABEL = {
    "夜聊伙伴": "orange", "深夜聊天": "orange",
    "正在升温": "orange", "话痨型": "orange",
    "互动均衡": "ink", "你更主动": "ink", "对方更主动": "ink",
    "老朋友": "amber", "语音密": "amber", "打电话": "amber",
    "心事树洞": "sage",
    "已疏远": "faint", "近期断联": "faint", "久未联系": "faint",
}


def _primary_tag(labels: list[str]) -> tuple[str, str]:
    if not labels:
        return ("—", "faint")
    # Priority: 升温 > 深夜 > 老朋友 > 主动型 > 断联
    priority = ["正在升温", "深夜聊天", "夜聊伙伴", "话痨型", "你更主动", "对方更主动",
                "互动均衡", "老朋友", "语音密", "打电话", "近期断联", "已疏远", "久未联系"]
    for p in priority:
        if p in labels:
            return (p, _TAG_KIND_FOR_LABEL.get(p, "ink"))
    lab = labels[0]
    return (lab, _TAG_KIND_FOR_LABEL.get(lab, "ink"))


def _quick_label(msg_count: int, last_ts: int, is_group: bool) -> tuple[str, str]:
    """Cheap, no-DB-scan label assigned just from count + recency."""
    if last_ts == 0:
        return ("—", "faint")
    days_since = (datetime.now(CST).timestamp() - last_ts) // 86400
    if is_group:
        if days_since < 7 and msg_count > 3000:
            return ("活跃群", "orange")
        if days_since > 365:
            return ("已沉寂", "faint")
        return ("群聊", "ink")
    # Private chats
    if days_since > 365:
        return ("久未联系", "faint")
    if days_since > 60:
        return ("近期断联", "faint")
    if msg_count > 2000 and days_since < 14:
        return ("话痨型", "orange")
    if msg_count > 1500 and days_since < 30:
        return ("老朋友", "amber")
    if days_since < 3 and msg_count > 500:
        return ("正在升温", "orange")
    if days_since < 7:
        return ("最近常聊", "amber")
    if msg_count > 1000:
        return ("熟人", "ink")
    return ("私聊", "faint")


def friend_card(store: EchoStore, session_username: str, msg_count: int, last_ts: int) -> dict:
    """Build the dict shape Murmur React frontend expects."""
    contact = store.contact(session_username)
    name = contact.display() or session_username
    is_group = contact.is_group
    tag, tag_kind = _quick_label(msg_count, last_ts, is_group)
    return {
        "id": session_username,
        "name": name,
        "count": msg_count,
        "last": _humanise_last(last_ts),
        "tag": tag,
        "tagKind": tag_kind,
        "hue": _hue_for(name),
        "glyph": _glyph_for(name),
        "knew": "—",
        "bond": "—",
        "isGroup": is_group,
    }


_MSG_INDEX_CACHE: dict = {"counts": None, "locations": None, "last_ts": None}


def _list_msg_tables(c: sqlite3.Connection) -> list[str]:
    """Return Msg_<md5> table names in this DB; [] if the file isn't a real
    SQLite (still-encrypted residue / junk / corrupt). Used by every WeChat
    message scan so a single bad message_*.db doesn't 500 the whole endpoint.
    """
    try:
        return [r[0] for r in c.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
        ).fetchall()]
    except sqlite3.DatabaseError:
        return []


def build_msg_index(store: EchoStore) -> tuple[dict[str, int], dict[str, list[str]], dict[str, int]]:
    """Scan every Msg_<md5> table across ALL message_*.db files, return:
       counts:    md5_table_name → SUM of row counts across all containing dbs
       locations: md5_table_name → LIST of db filenames containing it
       last_ts:   md5_table_name → MAX(create_time) across all
    """
    if _MSG_INDEX_CACHE["counts"] is not None:
        return _MSG_INDEX_CACHE["counts"], _MSG_INDEX_CACHE["locations"], _MSG_INDEX_CACHE["last_ts"]
    counts: dict[str, int] = {}
    locations: dict[str, list[str]] = {}
    last_ts: dict[str, int] = {}
    for p in sorted(store.dir.glob("message_*.db")):
        if any(skip in p.name for skip in ("_fts", "_resource", "biz_")):
            continue
        c = store._conn(p.name)
        try:
            for t in _list_msg_tables(c):
                try:
                    n = c.execute(f"SELECT COUNT(*), MAX(create_time) FROM {t}").fetchone()
                    if n and n[0]:
                        counts[t] = counts.get(t, 0) + n[0]
                        locations.setdefault(t, []).append(p.name)
                        if (n[1] or 0) > last_ts.get(t, 0):
                            last_ts[t] = n[1] or 0
                except sqlite3.DatabaseError:
                    continue
        finally:
            c.close()
    _MSG_INDEX_CACHE["counts"] = counts
    _MSG_INDEX_CACHE["locations"] = locations
    _MSG_INDEX_CACHE["last_ts"] = last_ts
    return counts, locations, last_ts


def _is_qq_store(store) -> bool:
    """Return True if `store` is a QQStore (vs EchoStore for WeChat).

    Used to branch helper functions whose implementations differ between
    WeChat's Msg_<md5(username)> tables and QQ's nt_msg.db schema.
    """
    return store is not None and store.__class__.__name__ == "QQStore"


def fast_message_count(store: EchoStore, wxid: str) -> int:
    if _is_qq_store(store):
        counts, _last = store.build_index()  # type: ignore[attr-defined]
        return counts.get(wxid, 0)
    counts, _locs, _ = build_msg_index(store)
    table = f"Msg_{hashlib.md5(wxid.encode()).hexdigest()}"
    return counts.get(table, 0)


def heat_monthly_via_sql(store: EchoStore) -> Counter:
    """Aggregate message counts per YYYY-MM by running GROUP BY across every Msg_* table."""
    if _is_qq_store(store):
        return store.heat_monthly()  # type: ignore[attr-defined]
    monthly: Counter = Counter()
    for p in sorted(store.dir.glob("message_*.db")):
        if any(skip in p.name for skip in ("_fts", "_resource", "biz_")):
            continue
        c = store._conn(p.name)
        try:
            for t in _list_msg_tables(c):
                try:
                    rows = c.execute(
                        f"SELECT strftime('%Y-%m', datetime(create_time, 'unixepoch', '+8 hours')) AS m, "
                        f"COUNT(*) FROM {t} GROUP BY m"
                    ).fetchall()
                    for ym, cnt in rows:
                        if ym:
                            monthly[ym] += cnt
                except sqlite3.DatabaseError:
                    continue
        finally:
            c.close()
    return monthly


def _earliest_message_ts_OLD(store: EchoStore) -> int:
    earliest = 0
    for p in sorted(store.dir.glob("message_*.db")):
        if any(skip in p.name for skip in ("_fts", "_resource", "biz_")):
            continue
        c = store._conn(p.name)
        try:
            for t in _list_msg_tables(c):
                try:
                    r = c.execute(f"SELECT MIN(create_time) FROM {t}").fetchone()
                    if r and r[0] and (earliest == 0 or r[0] < earliest):
                        earliest = r[0]
                except sqlite3.DatabaseError:
                    continue
        finally:
            c.close()
    return earliest


# Cached: home_summary recomputed at most every N seconds
_HOME_CACHE: dict = {"ts": 0, "data": None}
_HOME_CACHE_TTL = 60  # seconds


def home_summary(store: EchoStore) -> dict:
    if _HOME_CACHE["data"] and (_time.time() - _HOME_CACHE["ts"]) < _HOME_CACHE_TTL:
        return _HOME_CACHE["data"]

    sessions = store.sessions()
    private_sessions = [s for s in sessions if not s.is_group]
    scored = []
    for s in private_sessions:
        cnt = fast_message_count(store, s.username)
        if cnt > 0:
            scored.append((s, cnt))
    scored.sort(key=lambda x: -x[1])
    top5 = [friend_card(store, s.username, cnt, s.last_timestamp) for s, cnt in scored[:5]]

    monthly = heat_monthly_via_sql(store)
    months_sorted = sorted(monthly.keys())[-12:] if monthly else []
    values = [monthly[m] for m in months_sorted] or [0] * 12
    max_v = max(values) or 1  # guard: empty / all-zero history (fresh / tiny accounts)
    norm = [round(v / max_v, 3) for v in values]
    short_labels = [m.split("-")[1].lstrip("0") + "月" for m in months_sorted] or [
        f"{i+1}月" for i in range(12)
    ]
    if values:
        peak_idx = values.index(max(values))
        trough_idx = values.index(min(values))
    else:
        peak_idx = trough_idx = 0

    total_contacts = len(sessions)
    total_close = sum(1 for _s, cnt in scored if cnt >= 500)

    # earliest message ts: per-platform — WeChat scans message_*.db for MIN(create_time);
    # QQStore goes straight to nt_msg.db's c2c_msg_table + group_msg_table.
    if _is_qq_store(store):
        earliest_ts = store.earliest_ts()  # type: ignore[attr-defined]
    else:
        earliest_ts = 0
        for p in sorted(store.dir.glob("message_*.db")):
            if any(skip in p.name for skip in ("_fts", "_resource", "biz_")):
                continue
            c = store._conn(p.name)
            try:
                for t in _list_msg_tables(c):
                    try:
                        r = c.execute(f"SELECT MIN(create_time) FROM {t}").fetchone()
                        if r and r[0] and (earliest_ts == 0 or r[0] < earliest_ts):
                            earliest_ts = r[0]
                    except sqlite3.DatabaseError:
                        continue
            finally:
                c.close()
    days_since = ((datetime.now(CST).timestamp() - earliest_ts) // 86400) if earliest_ts else 0

    data = {
        "totalContacts": total_contacts,
        "closeFriends": total_close,
        "daysSinceFirst": int(days_since),
        "topFriends": top5,
        "heat": {
            "months": short_labels,
            "values": norm,
            "peakLabel": short_labels[peak_idx] if short_labels else "—",
            "peakCount": values[peak_idx] if values else 0,
            "troughLabel": short_labels[trough_idx] if short_labels else "—",
            "troughCount": values[trough_idx] if values else 0,
        },
    }
    _HOME_CACHE["data"] = data
    _HOME_CACHE["ts"] = _time.time()
    return data


def all_friends(store: EchoStore, kind: str = "all", q: str = "") -> list[dict]:
    build_msg_index(store)  # warm cache
    sessions = store.sessions()
    out = []
    q_low = q.lower()
    for s in sessions:
        if kind == "private" and s.is_group:
            continue
        if kind == "group" and not s.is_group:
            continue
        cnt = fast_message_count(store, s.username)
        if cnt == 0:
            continue
        c = store.contact(s.username)
        if q_low:
            hay = f"{c.display()} {c.alias} {s.username}".lower()
            if q_low not in hay:
                continue
        out.append(friend_card(store, s.username, cnt, s.last_timestamp))
    out.sort(key=lambda f: -f["count"])
    return out


def find_ai_report_for(wxid: str) -> dict | None:
    """Look in the agent reports friends dir for a report tagged with this wxid.

    Reports start with: > wxid: `wxid_xxx`  (frontmatter line). Returns metadata + first
    ~600 chars of body (after frontmatter) for use as a "summary card".
    """
    reports_root = _agent_reports_root() / "friends"
    if not reports_root.exists():
        return None
    for p in reports_root.iterdir():
        if p.suffix.lower() != ".md":
            continue
        try:
            head = p.read_text(encoding="utf-8")
        except OSError:
            continue
        if f"`{wxid}`" not in head and wxid not in head:
            continue
        # Strip the leading frontmatter ("# name 关系档案 \n > 由 ... \n > wxid: ... \n\n---\n\n")
        # Body starts after first '---' separator
        idx = head.find("\n---\n")
        body = head[idx + 5:].lstrip() if idx > 0 else head
        # Short summary = first 600 chars of body (preserved markdown)
        short = body[:600]
        return {
            "available": True,
            "path": str(p.relative_to(reports_root.parent)).replace("\\", "/"),  # "friends/01_kevin.md"
            "size": p.stat().st_size,
            "mtime": int(p.stat().st_mtime),
            "short": short,
        }
    return None


def _friend_detail_with_fresh_ai_report(wxid: str, payload: dict) -> dict:
    """Attach report metadata at response time so external batch jobs don't leave stale cache."""
    out = dict(payload)
    rep = find_ai_report_for(wxid)
    if rep:
        out["aiReport"] = rep
    else:
        out.pop("aiReport", None)
    return out


def friend_detail(store: EchoStore, wxid: str) -> dict:
    """Friend card + full local analysis (used by FriendPage)."""
    contact = store.contact(wxid)
    s = local_analysis(store, wxid)
    if s.get("totals", {}).get("messages", 0) == 0:
        return {**friend_card(store, wxid, 0, 0), "stats": None}
    tag, tag_kind = _primary_tag(s.get("labels", []))
    last_msg_iso = s["rhythm"]["last_message"]
    last_ts = int(datetime.fromisoformat(last_msg_iso).timestamp())
    bond = _bond_for(s)
    knew = _knew(s)
    name = contact.display() or wxid
    card = {
        "id": wxid,
        "name": name,
        "count": s["totals"]["messages"],
        "last": _humanise_last(last_ts),
        "tag": tag,
        "tagKind": tag_kind,
        "hue": _hue_for(name),
        "glyph": _glyph_for(name),
        "knew": knew,
        "bond": bond,
        "isGroup": contact.is_group,
    }
    rh = s["rhythm"]
    b = s["balance"]
    rs = s["responsiveness"]
    by_hour = rh.get("by_hour", {})
    busiest_hour = max(by_hour.items(), key=lambda kv: kv[1])[0] if by_hour else "13"
    h = int(busiest_hour)
    busiest_label = f"{h}—{(h+2) % 24} 时"
    # Top word as "代表语气词"
    self_words = s.get("vocabulary", {}).get("self_top_words", {})
    other_words = s.get("vocabulary", {}).get("other_top_words", {})
    combined = Counter(self_words) + Counter(other_words)
    top_word, top_count = (combined.most_common(1)[0] if combined else ("—", 0))
    stats = {
        "totalSelf": b["self_share_msgs"] and round(b["self_share_msgs"] * s["totals"]["messages"]) or 0,
        "totalOther": s["totals"]["messages"] - round(b["self_share_msgs"] * s["totals"]["messages"]),
        "selfPct": round(b["self_share_msgs"] * 100),
        "spanDays": rh["span_days"],
        "longestSilenceDays": rh.get("longest_silence_days", 0),
        "longestSilenceFrom": rh.get("longest_silence_from", "—"),
        "topPhrase": top_word,
        "topPhraseCount": top_count,
        "initSelf": b.get("conversations_initiated_by_self", 0),
        "initOther": b.get("conversations_initiated_by_other", 0),
        "fastReplies": rs.get("self_replies_within_1min", 0) + rs.get("other_replies_within_1min", 0),
        "busiestHourLabel": busiest_label,
        "busiestHourSub": "你最常聊天的时段",
        "lateNightPct": round(rh.get("late_night_ratio", 0) * 100),
        "medianReplyHuman": rs.get("self_median_reply_human") or "—",
    }
    # Expose key relationship_signals so OfflineSignalsTable + EdgePanel can render
    # specific evidence ("offline 14 / vuln 3 / 4-year span") instead of empty cells.
    sig_block = s.get("relationship_signals", {}) or {}
    sig = {
        "tier": sig_block.get("tier"),
        "tier_label": sig_block.get("tier_label"),
        "longevity_years": sig_block.get("longevity_years", 0),
        "resurrections_count": len(sig_block.get("resurrections") or []),
        "vulnerability": sig_block.get("vulnerability") or {},
        "offline_evidence": sig_block.get("offline_evidence") or {},
        "mutual_care": sig_block.get("mutual_care") or {},
        "conflict_recovery": sig_block.get("conflict_recovery") or {},
        "calls": sig_block.get("calls", 0),
        "lifecycle": sig_block.get("lifecycle") or {},
        "moments_back": sig_block.get("moments_back", 0),
        "moments_out": sig_block.get("moments_out", 0),
        "signature_notes": sig_block.get("signature_notes") or [],
    }
    out = {**card, "stats": stats, "relationship_signals": sig}
    rep = find_ai_report_for(wxid)
    if rep:
        out["aiReport"] = rep
    return out


def friend_yearbook(store: EchoStore, wxid: str) -> dict:
    """Spotify-Wrapped-style year-by-year breakdown of you ↔ friend X.

    Returns per-year stats + key quotes pulled directly from chat history.
    Assembles purely from local data (no LLM) — this is the "scannable companion"
    to the prose AI report.
    """
    contact = store.contact(wxid)
    name = contact.display() or wxid
    msgs = list(store.messages(wxid, text_only=True))
    if not msgs:
        return {"cache_version": YEARBOOK_CACHE_VERSION, "wxid": wxid, "name": name, "years": [], "total_msgs": 0}

    # Group by year
    by_year: dict[int, list[Message]] = {}
    for m in msgs:
        y = _ts_to_dt(m.create_time).year
        by_year.setdefault(y, []).append(m)

    # Pull SNS interactions per year
    try:
        sns_all = get_sns_signals_cached(store).get(wxid, {})
    except Exception:
        sns_all = {}

    me = store.me or "self"
    years_data = []
    for year in sorted(by_year.keys()):
        ymsgs = by_year[year]
        n = len(ymsgs)

        # Self / other balance
        n_self = sum(1 for x in ymsgs if x.sender_wxid == me or x.sender_wxid == "self")
        n_other = n - n_self

        # First / last in year
        first_ts = ymsgs[0].create_time
        last_ts = ymsgs[-1].create_time

        # Busiest month
        month_count: dict[int, int] = {}
        for x in ymsgs:
            mn = _ts_to_dt(x.create_time).month
            month_count[mn] = month_count.get(mn, 0) + 1
        busiest_month, busiest_n = max(month_count.items(), key=lambda kv: kv[1]) if month_count else (0, 0)

        # Longest silence within the year
        days_active = sorted({_ts_to_dt(x.create_time).date() for x in ymsgs})
        longest_silence = 0
        silence_from = None
        for i in range(1, len(days_active)):
            gap = (days_active[i] - days_active[i - 1]).days
            if gap > longest_silence:
                longest_silence = gap
                silence_from = days_active[i - 1].isoformat()

        # Hard-evidence excerpts: vulnerability, offline, lifecycle, apology
        def find_kw(kws: list[str], limit: int = 2) -> list[dict]:
            out = []
            for x in ymsgs:
                if any(k in (x.text or "") for k in kws):
                    out.append({
                        "date": _ts_to_dt(x.create_time).strftime("%Y-%m-%d"),
                        "from": x.sender_name,
                        "from_id": x.sender_wxid,
                        "text": (x.text or "")[:160],
                    })
                    if len(out) >= limit:
                        break
            return out

        vuln_quotes = find_kw(VULN_KEYWORDS, 3)
        offline_quotes = find_kw(OFFLINE_KEYWORDS, 3)
        lifecycle_quotes = find_kw(LIFECYCLE_KEYWORDS, 2)
        apology_quotes = find_kw(APOLOGY_KEYWORDS, 1)
        care_quotes = find_kw(CARE_KEYWORDS, 2)

        text_msgs = [m for m in ymsgs if m.msg_type == 1 and (m.text or "").strip()]
        year_words = _word_counts([m.text for m in text_msgs])
        top_words = [
            {"word": w, "count": c}
            for w, c in year_words.most_common(12)
            if c >= 2
        ]
        top_terms = {item["word"].lower() for item in top_words[:8]}

        # A signature quote: score readable snippets instead of blindly taking
        # the longest message, which tends to pick URLs, boilerplate, or noise.
        day_counts = Counter(_ts_to_dt(x.create_time).date().isoformat() for x in ymsgs)
        max_day_count = max(day_counts.values()) if day_counts else 1

        def _quoteable(text: str) -> bool:
            t = (text or "").strip()
            if not (6 <= len(t) <= 180):
                return False
            if URL_RE.search(t) or NON_TEXT.fullmatch(t):
                return False
            if re.fullmatch(r"[\d\s:：./,_-]+", t):
                return False
            signal_chars = re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", t)
            if len(signal_chars) < 4:
                return False
            if len(signal_chars) / max(1, len(t)) < 0.35:
                return False
            if t.lower() in {"ok", "okay", "okok", "哈哈", "哈哈哈", "hhh", "hhhh"}:
                return False
            return True

        def _signature_score(idx: int, m: Message) -> tuple[float, list[str], str]:
            t = (m.text or "").strip()
            lower = t.lower()
            hits = [w for w in top_terms if w and w in lower]
            score = 0.0
            score += min(len(t), 90) / 24
            if 12 <= len(t) <= 90:
                score += 3
            if len(t) > 120:
                score -= 2
            score += min(12, len(hits) * 4)

            kw_reason = ""
            for label, kws, weight in (
                ("线下/一起做事", OFFLINE_KEYWORDS, 5),
                ("互相关心", CARE_KEYWORDS, 4),
                ("人生节点", LIFECYCLE_KEYWORDS, 4),
                ("脆弱表达", VULN_KEYWORDS, 3),
                ("道歉/修复", APOLOGY_KEYWORDS, 3),
            ):
                if any(k in t for k in kws):
                    score += weight
                    if not kw_reason:
                        kw_reason = label

            for j in (idx - 1, idx + 1):
                if 0 <= j < len(ymsgs):
                    near = ymsgs[j]
                    if near.sender_wxid != m.sender_wxid and abs(near.create_time - m.create_time) <= 15 * 60:
                        score += 4
                        break

            day = _ts_to_dt(m.create_time).date().isoformat()
            score += min(3, day_counts.get(day, 0) / max(1, max_day_count) * 3)
            if "?" in t or "？" in t:
                score += 0.8
            if hits:
                reason = "含年度高频词：" + "、".join(hits[:3])
            elif kw_reason:
                reason = kw_reason
            else:
                reason = "来自高频互动日"
            return score, hits[:3], reason

        scored_msgs = []
        for idx, m in enumerate(ymsgs):
            if m.msg_type == 1 and _quoteable(m.text or ""):
                score, terms, reason = _signature_score(idx, m)
                scored_msgs.append((score, terms, reason, m))
        signature = None
        if scored_msgs:
            _score, terms, reason, sig_m = sorted(scored_msgs, key=lambda item: -item[0])[0]
            signature = {
                "date": _ts_to_dt(sig_m.create_time).strftime("%Y-%m-%d"),
                "from": sig_m.sender_name,
                "from_id": sig_m.sender_wxid,
                "text": sig_m.text[:240],
                "terms": terms,
                "reason": reason,
            }

        # Late-night ratio
        late_night = sum(1 for x in ymsgs
                        if 23 <= _ts_to_dt(x.create_time).hour or _ts_to_dt(x.create_time).hour < 4)

        # Calls in year
        calls = sum(1 for x in ymsgs if x.msg_type in (50, 62))

        years_data.append({
            "year": year,
            "msg_count": n,
            "self_count": n_self,
            "other_count": n_other,
            "self_pct": round(n_self / n * 100) if n else 0,
            "first_date": datetime.fromtimestamp(first_ts, CST).strftime("%Y-%m-%d"),
            "last_date": datetime.fromtimestamp(last_ts, CST).strftime("%Y-%m-%d"),
            "active_days": len(days_active),
            "busiest_month": busiest_month,
            "busiest_month_msgs": busiest_n,
            "longest_silence_days": longest_silence,
            "silence_from": silence_from,
            "late_night_msgs": late_night,
            "late_night_pct": round(late_night / n * 100) if n else 0,
            "calls": calls,
            "vulnerability_quotes": vuln_quotes,
            "offline_quotes": offline_quotes,
            "lifecycle_quotes": lifecycle_quotes,
            "apology_quotes": apology_quotes,
            "care_quotes": care_quotes,
            "top_words": top_words,
            "signature": signature,
        })

    return {
        "cache_version": YEARBOOK_CACHE_VERSION,
        "wxid": wxid,
        "name": name,
        "total_msgs": len(msgs),
        "first_date": datetime.fromtimestamp(msgs[0].create_time, CST).strftime("%Y-%m-%d"),
        "last_date": datetime.fromtimestamp(msgs[-1].create_time, CST).strftime("%Y-%m-%d"),
        "span_days": (msgs[-1].create_time - msgs[0].create_time) // 86400,
        "active_years": len(by_year),
        "moments_back_total": sns_all.get("they_liked_you", 0) + sns_all.get("they_commented_you", 0),
        "moments_out_total": sns_all.get("you_liked_them", 0) + sns_all.get("you_commented_them", 0),
        "years": years_data,
    }


def friend_moments(store: EchoStore, wxid: str, n: int = 4) -> list[dict]:
    """Pick a few representative quote-able messages."""
    msgs = list(store.messages(wxid, text_only=True))
    if not msgs:
        return []
    candidates = [m for m in msgs if 8 <= len(m.text) <= 60 and m.text not in {"OK", "好", "嗯", "哦"}]
    if not candidates:
        candidates = msgs
    step = max(1, len(candidates) // n)
    picks = candidates[::step][:n]
    return [
        {
            "date": datetime.fromtimestamp(m.create_time, CST).strftime("%Y·%m·%d"),
            "from": m.sender_name,            # 稳定显示名 (Message.sender_name 已经处理了 "你" / 群昵称)
            "from_id": m.sender_wxid,         # 稳定的唯一标识符
            "text": m.text,
        }
        for m in picks
    ]


# ---------- HTTP handler ----------

class _MurmurAPIHandler(BaseHTTPRequestHandler):
    store: Optional[EchoStore] = None  # set by _run_server
    export_dir: Path = _agent_workspace_root()
    _ALLOWED_DEV_ORIGINS = {
        ("http", "127.0.0.1", 5173),
        ("http", "localhost", 5173),
        ("http", "::1", 5173),
    }
    _ALLOWED_TAURI_HOSTS = {"tauri.localhost"}
    _ALLOWED_CORS_SCHEMES = {"tauri", "asset"}

    # quiet noisy default logging
    def log_message(self, format, *args):  # noqa: A002
        # Avoid reverse-DNS lookup (was adding 1-2s per request on Windows!).
        sys.stderr.write(f"[etcli serve] {self.client_address[0]} {format % args}\n")

    # Disable reverse-DNS hostname resolution globally — `address_string()` calls
    # socket.getfqdn() which on Windows can hang up to ~2s per request.
    def address_string(self):
        return self.client_address[0]

    def _allowed_cors_origin(self) -> str | None:
        origin = self.headers.get("Origin")
        if not origin:
            return None
        parsed = urllib.parse.urlparse(origin)
        if parsed.scheme in self._ALLOWED_CORS_SCHEMES:
            return origin
        if parsed.hostname in self._ALLOWED_TAURI_HOSTS:
            return origin
        if (parsed.scheme, parsed.hostname, parsed.port) in self._ALLOWED_DEV_ORIGINS:
            return origin
        return None

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        return not origin or self._allowed_cors_origin() is not None

    def _send_cors_headers(self) -> None:
        allowed_origin = self._allowed_cors_origin()
        if allowed_origin:
            self.send_header("Access-Control-Allow-Origin", allowed_origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        if not self._origin_allowed():
            return self._send_json({"error": "origin_not_allowed"}, 403)
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        try:
            if not self._origin_allowed():
                return self._send_json({"error": "origin_not_allowed"}, 403)
            self._dispatch_get()
        except Exception as e:
            self._send_json({"error": str(e), "type": type(e).__name__}, status=500)

    def do_POST(self):  # noqa: N802
        try:
            if not self._origin_allowed():
                return self._send_json({"error": "origin_not_allowed"}, 403)
            self._dispatch_post()
        except Exception as e:
            self._send_json({"error": str(e), "type": type(e).__name__}, status=500)

    def _dispatch_get(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path
        qs = urllib.parse.parse_qs(url.query)

        # If we started in bootstrap (TCC blocking discover_data_dir at boot)
        # but the user later granted FDA, retry discovery on every request
        # before deciding to send a 503. This auto-promotes the backend out
        # of bootstrap as soon as the data becomes readable, without needing
        # a full /api/refresh.
        if self.store is None:
            try:
                d = discover_data_dir()
                if d and d.exists():
                    _MurmurAPIHandler._set_wechat_store(EchoStore(d))
                    sys.stderr.write(f"[etcli serve] auto-promoted from bootstrap → store loaded from {d}\n")
            except Exception as e:
                sys.stderr.write(f"[etcli serve] bootstrap auto-promote failed: {e}\n")

        # Bootstrap mode: only a small allowlist works without decrypted data.
        _NO_STORE_GET = {"/api/info", "/api/agents", "/api/diagnose", "/api/reports", "/api/log-tail",
                          "/api/scan-disks/status", "/api/profiles"}
        # QQ endpoints have their own data lifecycle (separate stores keyed by
        # qq number) so they bypass the WeChat-store bootstrap gate entirely.
        if path.startswith("/api/qq/"):
            return self._dispatch_qq_get(path, qs)
        if self.store is None and path not in _NO_STORE_GET and not path.startswith("/api/report/"):
            return self._send_json({
                "error": "no_decrypted_data",
                "message": "Backend is in bootstrap mode — provide a key via /api/save-key + /api/refresh first.",
            }, status=503)

        if path.startswith("/api/media/"):
            # Serve media bytes by md5: /api/media/<md5>
            md5 = path[len("/api/media/"):]
            return self._serve_media(md5)

        if path == "/api/info":
            if self.store is None:
                diagnose_hint = "no decrypted data — run extract-key + refresh to bootstrap"
                try:
                    profiles = _paths.discover_wechat_profiles()
                    caps = _paths.detect_capabilities()
                    if not profiles:
                        diagnose_hint = "未找到微信数据目录；请确认微信已在本机登录，或在微信设置里查看文件管理路径。"
                    elif not (_paths.load_config().get("decrypt_key") or (Path.home() / ".murmur" / "decrypted_keys.json").exists()):
                        diagnose_hint = "已找到微信数据，但还没有解密密钥；请按引导抓取密钥。"
                    elif caps.can_decrypt_db:
                        diagnose_hint = "已找到微信数据和密钥，但尚未成功解密；请点击更新/解密。"
                except Exception:
                    pass
                return self._send_json({
                    "data_dir": None,
                    "self_wxid": None,
                    "version": APP_VERSION,
                    "bootstrap": True,
                    "needs_onboarding": True,
                    "reason": diagnose_hint,
                })
            return self._send_json({
                "data_dir": str(self.store.dir),
                "self_wxid": self.store.me,
                "account_id": self.store.me,
                "platform": self.__class__._active_platform,
                "active_id": self.__class__._active_id,
                "version": APP_VERSION,
            })

        if path == "/api/profiles":
            return self._send_json(self.__class__._build_profiles_payload())

        if path == "/api/log-tail":
            try:
                max_lines = max(20, min(200, int(qs.get("lines", [80])[0])))
            except ValueError:
                max_lines = 80
            return self._send_json(read_diagnostic_logs(max_lines=max_lines))

        if path == "/api/scan-disks/status":
            # Polling endpoint for the background disk scan started by POST /api/scan-disks.
            return self._send_json(_paths.get_scan_state())

        # Onboarding gate: data-needing endpoints return 503 until store is ready.
        # Endpoints that work without a store stay above this gate.
        # NOTE: keep this allowlist in sync with `_NO_STORE_GET` above. They
        # describe the same intent — endpoints reachable in bootstrap mode —
        # and historically diverged: /api/reports + /api/report/* were in
        # _NO_STORE_GET but missing here, so users hit 503 the moment they
        # opened the Reports page on a fresh install.
        _gate_pass = (path in {"/api/diagnose", "/api/agents", "/api/reports", "/api/log-tail",
                                "/api/scan-disks/status", "/api/profiles"}
                      or path.startswith("/api/report/"))
        if _gate_pass:
            pass  # these don't need store, fall through to their handlers
        elif self.store is None:
            return self._send_json({
                "error": "onboarding_required",
                "message": "解密数据未准备好。请先抓 key 再解密。",
                "needs_onboarding": True,
            }, status=503)
        if path == "/api/agents":
            return self._send_json(_detect_local_agents())
        if path == "/api/graph":
            scope = qs.get("scope", ["private"])[0]
            min_private = int(qs.get("min_private", [10])[0])
            recent_days = int(qs.get("recent_days", [365])[0])
            top_n = int(qs.get("top_n", [100])[0])
            show_clusters = qs.get("show_clusters", ["false"])[0] != "false"
            payload = get_relationship_graph_cached(
                self.store, scope=scope, min_private=min_private,
                recent_days=recent_days, top_n=top_n, show_clusters=show_clusters,
            )
            return self._send_json(payload)
        if path == "/api/friend-mentions":
            top_n = int(qs.get("top_n", [50])[0])
            min_n = int(qs.get("min", [3])[0])
            return self._send_json(get_friend_mentions_cached(self.store, top_n=top_n, min_mention_count=min_n))
        if path == "/api/friend-identity-pack":
            wxid = qs.get("wxid", [""])[0]
            sample = int(qs.get("sample", [80])[0])
            if not wxid:
                return self._send_json({"error": "wxid required"}, 400)
            pack = build_friend_identity_pack(self.store, wxid, sample_n=sample)
            return self._send_json({"pack": pack, "wxid": wxid, "size": len(pack)})
        if path == "/api/friend-pair-pack":
            a = qs.get("a", [""])[0]
            b = qs.get("b", [""])[0]
            if not a or not b:
                return self._send_json({"error": "a and b required"}, 400)
            evidence = pair_direct_evidence(self.store, a, b)
            if not evidence["ok"]:
                return self._send_json({
                    "error": "no_direct_pair_evidence",
                    "message": evidence["message"],
                    "evidence": evidence,
                }, 422)
            ck = "pairpack_v3_" + "__".join(sorted([a, b]))
            cached = _PAIR_PACK_CACHE.get(ck)
            if cached and (_time.time() - cached[0]) < _CACHE_TTL:
                return self._send_json(cached[1])
            disk = _disk_load(ck)
            if disk and (_time.time() - disk["_ts"]) < _CACHE_TTL:
                _PAIR_PACK_CACHE[ck] = (disk["_ts"], disk["_payload"])
                return self._send_json(disk["_payload"])
            with _PAIR_BUILD_LOCK:
                with _STORE_READ_LOCK:
                    pack = build_pair_inference_pack(self.store, a, b)
            payload = {"pack": pack, "a": a, "b": b, "size": len(pack)}
            _PAIR_PACK_CACHE[ck] = (_time.time(), payload)
            _disk_save(ck, payload)
            return self._send_json(payload)
        if path == "/api/pair-report":
            a = qs.get("a", [""])[0]
            b = qs.get("b", [""])[0]
            if not a or not b:
                return self._send_json({"available": False, "error": "a, b required"}, 400)
            ck = "pairreport_" + "__".join(sorted([a, b]))
            cached = _PAIR_REPORT_CACHE.get(ck)
            if cached and (_time.time() - cached[0]) < _CACHE_TTL:
                return self._send_json(cached[1])
            # Pair filenames are deterministic: "<XX>_<safe_name_a>__<safe_name_b>.md"
            # where _safe_filename = re.sub(r'[<>:"/\\|?*\s]+', '_', name)[:80]
            # (mirror of batch_analyze._safe_filename — keep them in sync).
            # We MUST match by filename, not body content: pair reports legitimately
            # reference other friends' names in the analysis, so body matching causes
            # bogus matches (e.g. asking for A↔B returns A↔C because B is mentioned).
            contacts = self.store.contacts() if self.store else {}
            ca = contacts.get(a)
            cb = contacts.get(b)
            name_a = (ca.display() if ca else a)
            name_b = (cb.display() if cb else b)

            def _safe(s: str) -> str:
                return re.sub(r'[<>:"/\\|?*\s]+', "_", s)[:80]

            target = {_safe(name_a), _safe(name_b)}
            pairs_root = _agent_reports_root() / "pairs"
            if pairs_root.exists():
                for p in pairs_root.iterdir():
                    if p.suffix.lower() != ".md":
                        continue
                    try:
                        content = p.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        continue
                    ids = set(re.findall(r"> wxid_[ab]: `([^`]+)`", content))
                    if ids and ids != {a, b}:
                        continue
                    if not ids:
                        # Legacy reports (pre wxid frontmatter) fall back to the deterministic
                        # filename. Body matching is deliberately forbidden to avoid A↔B returning
                        # A↔C just because B is mentioned in the prose.
                        stem = p.stem
                        after_idx = stem.split("_", 1)[1] if "_" in stem else stem
                        parts = after_idx.split("__")
                        if len(parts) != 2:
                            continue
                        if {parts[0], parts[1]} != target:
                            continue
                    idx = content.find("\n---\n")
                    body = content[idx + 5:].lstrip() if idx > 0 else content
                    payload = {
                        "available": True,
                        "path": f"pairs/{p.name}",
                        "size": p.stat().st_size,
                        "mtime": int(p.stat().st_mtime),
                        "short": body[:600],
                    }
                    _PAIR_REPORT_CACHE[ck] = (_time.time(), payload)
                    return self._send_json(payload)
            payload = {"available": False}
            _PAIR_REPORT_CACHE[ck] = (_time.time(), payload)
            return self._send_json(payload)
        if path == "/api/reports":
            # List all generated agent reports (friends + pairs).
            reports_root = _agent_reports_root()
            out = {"friends": [], "pairs": [], "root": str(reports_root)}
            if reports_root.exists():
                fr = reports_root / "friends"
                pr = reports_root / "pairs"
                if fr.exists():
                    for p in sorted(fr.iterdir()):
                        if p.suffix.lower() == ".md":
                            stat = p.stat()
                            out["friends"].append({
                                "path": str(p.relative_to(reports_root)).replace("\\", "/"),
                                "name": p.stem,
                                "size": stat.st_size,
                                "mtime": int(stat.st_mtime),
                            })
                if pr.exists():
                    for p in sorted(pr.iterdir()):
                        if p.suffix.lower() == ".md":
                            stat = p.stat()
                            out["pairs"].append({
                                "path": str(p.relative_to(reports_root)).replace("\\", "/"),
                                "name": p.stem,
                                "size": stat.st_size,
                                "mtime": int(stat.st_mtime),
                            })
            return self._send_json(out)

        if path.startswith("/api/report/"):
            # Serve a single report's markdown content
            rel = urllib.parse.unquote(path[len("/api/report/"):])
            reports_root = _agent_reports_root()
            target = (reports_root / rel).resolve()
            try:
                # Path traversal guard
                target.relative_to(reports_root.resolve())
            except ValueError:
                return self._send_json({"error": "invalid path"}, 400)
            if not target.exists() or not target.is_file():
                return self._send_json({"error": "not found"}, 404)
            try:
                content = target.read_text(encoding="utf-8")
            except Exception as e:
                return self._send_json({"error": str(e)}, 500)
            return self._send_json({"path": rel, "content": content, "size": target.stat().st_size})

        if path == "/api/diagnose":
            caps = _paths.detect_capabilities()
            profiles = _paths.discover_wechat_profiles()
            cfg = _paths.load_config()
            mac_keys_path = Path.home() / ".murmur" / "decrypted_keys.json"
            has_mac_keys = False
            if _paths.IS_MAC and mac_keys_path.exists():
                try:
                    mac_keys = json.loads(mac_keys_path.read_text(encoding="utf-8"))
                    has_mac_keys = bool(mac_keys.get("keys_by_db") or mac_keys.get("keys_by_salt"))
                except Exception:
                    has_mac_keys = False
            return self._send_json({
                "platform": "windows" if _paths.IS_WINDOWS else "macos" if _paths.IS_MAC else "linux",
                "python": sys.version.split()[0],
                "capabilities": {
                    "can_decrypt_db": caps.can_decrypt_db,
                    "can_extract_key": caps.can_extract_key,
                    "can_extract_image_key": caps.can_extract_image_key,
                    "has_wechat_installed": caps.has_wechat_installed,
                    "has_wechat_data": caps.has_wechat_data,
                    "sip_enabled": caps.sip_enabled,
                    "weixin_running": caps.weixin_running,
                    "wechat_hardened": caps.wechat_hardened,
                    "tcc_blocked": caps.tcc_blocked,
                },
                "profiles": [
                    {
                        "wxid": p.wxid,
                        "wxid_short": p.wxid_short,
                        "encrypted_root": str(p.encrypted_root),
                        "decrypted_root": str(_paths.decrypted_root_for(p)),
                        "has_decrypted_data": (_paths.decrypted_root_for(p, must_exist=True) is not None),
                    }
                    for p in profiles
                ],
                "saved_key": bool(cfg.get("decrypt_key")) or has_mac_keys,
                "agents_found": len(_detect_local_agents()),
                "notes": caps.notes,
                "wechat_exe": str(_paths.find_weixin_exe()) if _paths.find_weixin_exe() else None,
                "murmur_home": str(_paths.murmur_home()),
                "wechat_search_roots": [str(p) for p in _paths.wechat_search_paths()],
            })
        if path == "/api/home-summary":
            if _HOME_SUMMARY_CACHE["data"] is not None and (_time.time() - _HOME_SUMMARY_CACHE["ts"]) < _CACHE_TTL:
                return self._send_json(_HOME_SUMMARY_CACHE["data"])
            disk = _disk_load("home_summary")
            if disk and (_time.time() - disk["_ts"]) < _CACHE_TTL:
                _HOME_SUMMARY_CACHE["data"] = disk["_payload"]
                _HOME_SUMMARY_CACHE["ts"] = disk["_ts"]
                return self._send_json(disk["_payload"])
            payload = home_summary(self.store)
            _HOME_SUMMARY_CACHE["data"] = payload
            _HOME_SUMMARY_CACHE["ts"] = _time.time()
            _disk_save("home_summary", payload)
            return self._send_json(payload)
        if path == "/api/friends":
            kind = (qs.get("type", ["all"])[0]) or "all"
            q = (qs.get("q", [""])[0]) or ""
            ck = f"{kind}:{q}"
            cached = _FRIENDS_LIST_CACHE.get(ck)
            if cached and (_time.time() - cached[0]) < _CACHE_TTL:
                return self._send_json(cached[1])
            payload = all_friends(self.store, kind=kind, q=q)
            _FRIENDS_LIST_CACHE[ck] = (_time.time(), payload)
            return self._send_json(payload)
        if path.startswith("/api/friend/"):
            tail = path[len("/api/friend/"):]
            parts = tail.split("/", 1)
            wxid = urllib.parse.unquote(parts[0])
            sub = parts[1] if len(parts) > 1 else ""
            if not sub:
                cached = _FRIEND_DETAIL_CACHE.get(wxid)
                if cached and (_time.time() - cached[0]) < _CACHE_TTL:
                    payload = _friend_detail_with_fresh_ai_report(wxid, cached[1])
                    _FRIEND_DETAIL_CACHE[wxid] = (cached[0], payload)
                    return self._send_json(payload)
                disk = _disk_load(f"friend_{wxid}")
                if disk and (_time.time() - disk["_ts"]) < _CACHE_TTL:
                    payload = _friend_detail_with_fresh_ai_report(wxid, disk["_payload"])
                    _FRIEND_DETAIL_CACHE[wxid] = (disk["_ts"], payload)
                    return self._send_json(payload)
                payload = _friend_detail_with_fresh_ai_report(wxid, friend_detail(self.store, wxid))
                _FRIEND_DETAIL_CACHE[wxid] = (_time.time(), payload)
                _disk_save(f"friend_{wxid}", payload)
                return self._send_json(payload)
            if sub == "moments":
                return self._send_json(friend_moments(self.store, wxid, n=int(qs.get("n", [4])[0])))
            if sub == "yearbook":
                cached = _YEARBOOK_CACHE.get(wxid)
                if cached and (_time.time() - cached[0]) < _CACHE_TTL and _yearbook_has_quote_ids(cached[1]):
                    return self._send_json(cached[1])
                disk = _disk_load(f"yearbook_{wxid}")
                if disk and (_time.time() - disk["_ts"]) < _CACHE_TTL and _yearbook_has_quote_ids(disk["_payload"]):
                    _YEARBOOK_CACHE[wxid] = (disk["_ts"], disk["_payload"])
                    return self._send_json(disk["_payload"])
                payload = friend_yearbook(self.store, wxid)
                _YEARBOOK_CACHE[wxid] = (_time.time(), payload)
                _disk_save(f"yearbook_{wxid}", payload)
                return self._send_json(payload)
            if sub == "media":
                # Return media items associated with this friend's chat
                idx_path = _paths.media_index_path()
                if not idx_path.exists():
                    return self._send_json([])
                try:
                    idx = json.loads(idx_path.read_text(encoding="utf-8"))
                except Exception:
                    return self._send_json([])
                target_hash = hashlib.md5(wxid.encode()).hexdigest()
                host = self.headers.get("Host") or "127.0.0.1:9100"
                api_base = f"http://{host}"
                items = []
                for md5, rec in idx.items():
                    # Strict filter: only include items whose chat_hash matches md5(wxid).
                    # Items without chat_hash (videos in this schema) can't be tied to a friend.
                    if rec.get("chat_hash") != target_hash:
                        continue
                    if not rec.get("exists"):
                        continue
                    fname = rec.get("file_name", "")
                    ext = (fname.rsplit(".", 1)[-1] if "." in fname else "").lower()
                    if ext in ("mp4", "mov", "webm"):
                        kind = "vid"
                    elif ext in ("jpg", "jpeg", "png", "gif", "webp", "bmp", "dat"):
                        kind = "img"
                    else:
                        continue
                    items.append({
                        "md5": md5,
                        "kind": kind,
                        "filename": fname,
                        "month": rec.get("month") or "未知",
                        "ts": 0,  # we don't have per-file mtime yet
                        "from": None,
                        "url": f"{api_base}/api/media/{md5}",
                        "size": rec.get("size", 0),
                    })
                # Sort by month desc, then by filename
                items.sort(key=lambda x: (x.get("month", ""), x.get("filename", "")), reverse=True)
                return self._send_json(items[:500])  # cap to 500 for perf
            if sub == "messages":
                limit = int(qs.get("limit", [200])[0])
                msgs = list(self.store.messages(wxid, text_only=False, limit=limit))
                return self._send_json([
                    {
                        "ts": m.create_time,
                        "time": datetime.fromtimestamp(m.create_time, CST).isoformat(),
                        "from": m.sender_name,           # 稳定显示名 (你 / 备注 / 昵称)
                        "from_id": m.sender_wxid,        # 稳定 wxid (唯一识别)
                        "text": m.text,
                        "type": m.raw_type_label,
                    }
                    for m in msgs
                ])
            if sub == "connections":
                # Returns this friend's notable connections (friend↔friend edges where
                # this wxid is one endpoint). Sorted by relevance: mutual_reply > mention >
                # moments_cross > co_group. Used by FriendPage / GraphPage SidePanel to
                # show "important relationships" without needing user to click obscure edges.
                cached = _CONN_CACHE.get(wxid)
                if cached and (_time.time() - cached[0]) < _CACHE_TTL:
                    return self._send_json(cached[1])
                disk = _disk_load(f"conn_{wxid}")
                if disk and (_time.time() - disk["_ts"]) < _CACHE_TTL:
                    _CONN_CACHE[wxid] = (disk["_ts"], disk["_payload"])
                    return self._send_json(disk["_payload"])
                graph = get_relationship_graph_cached(self.store, scope="all", top_n=600)
                node_lookup = {n["id"]: n for n in graph["nodes"]}
                connections = []
                for e in graph["edges"]:
                    other = None
                    if e["source"] == wxid:
                        other = e["target"]
                    elif e["target"] == wxid:
                        other = e["source"]
                    else:
                        continue
                    if other == "self" or other == wxid:
                        continue
                    other_node = node_lookup.get(other)
                    other_name = other_node["name"] if other_node else other
                    connections.append({
                        "wxid": other,
                        "name": other_name,
                        "edge_type": e["type"],
                        "weight": e["weight"],
                        "mention_count": e.get("mention_count"),
                        "shared_group_count": e.get("shared_group_count"),
                        "moments_cross": e.get("moments_cross"),
                    })
                # Sort: prefer the strongest signals first
                priority = {"mutual_reply": 0, "mention": 1, "moments_cross": 2, "co_group": 3}
                connections.sort(key=lambda c: (priority.get(c["edge_type"], 9),
                                                 -(c.get("mention_count") or c.get("moments_cross") or c["weight"] or 0)))
                payload = {"wxid": wxid, "connections": connections[:30]}
                _CONN_CACHE[wxid] = (_time.time(), payload)
                _disk_save(f"conn_{wxid}", payload)
                return self._send_json(payload)
        return self._send_json({"error": "Not found", "path": path}, status=404)

    def _dispatch_post(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path

        # QQ endpoints have an independent data lifecycle from WeChat — they
        # bypass the WeChat-store bootstrap gate.
        if path.startswith("/api/qq/"):
            return self._dispatch_qq_post(path)

        # Bootstrap endpoints that work even when store is None (no decrypted data yet)
        # Mac onboarding adds a few extra (resign-wechat, open-fda, open-folder); keep them whitelisted.
        BOOTSTRAP_POSTS = {"/api/refresh", "/api/save-key", "/api/extract-key", "/api/wechat-root",
                           "/api/open-folder", "/api/resign-wechat", "/api/open-fda",
                           "/api/scan-disks", "/api/scan-disks/cancel", "/api/active-profile"}
        if path == "/api/active-profile":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            try:
                opts = json.loads(body.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                opts = {}
            return self._set_active_profile(opts)
        if self.store is None and path not in BOOTSTRAP_POSTS:
            return self._send_json({
                "error": "no_decrypted_data",
                "message": "解密数据未准备好。请先抓 key 再解密。",
                "needs_onboarding": True,
            }, status=503)

        if path == "/api/wechat-root":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            root = (opts.get("path") or "").strip()
            if not root:
                return self._send_json({"ok": False, "error": "请粘贴微信「文件管理」里打开的文件夹路径"}, 400)
            try:
                saved = _paths.save_wechat_root(root)
                profiles = _paths.discover_wechat_profiles()
                matched = [
                    {
                        "wxid": p.wxid,
                        "wxid_short": p.wxid_short,
                        "encrypted_root": str(p.encrypted_root),
                        "decrypted_root": str(_paths.decrypted_root_for(p)),
                        "has_decrypted_data": (_paths.decrypted_root_for(p, must_exist=True) is not None),
                    }
                    for p in profiles
                ]
                if not matched:
                    return self._send_json({
                        "ok": False,
                        "saved": str(saved),
                        "error": "已保存路径，但里面还没找到 wxid_*/db_storage。请确认粘贴的是包含 xwechat_files 的路径，或直接粘贴 wxid_... 账号文件夹。",
                        "wechat_search_roots": [str(p) for p in _paths.wechat_search_paths()],
                    })
                return self._send_json({
                    "ok": True,
                    "saved": str(saved),
                    "profiles": matched,
                    "wechat_search_roots": [str(p) for p in _paths.wechat_search_paths()],
                })
            except Exception as e:
                return self._send_json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)

        if path == "/api/scan-disks":
            # Start a background full-disk fast-walk for xwechat_files / wxid_*
            # candidates. Idempotent: if a scan is already running, returns the
            # current state instead of starting a second one. Frontend polls
            # /api/scan-disks/status every 0.5–1s for progress + final results.
            state = _paths.get_scan_state()
            if state.get("running"):
                return self._send_json({"ok": True, "already_running": True, **state})
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            max_depth = int(opts.get("max_depth", 8))
            max_depth = max(2, min(20, max_depth))
            import threading as _th
            t = _th.Thread(
                target=_paths.scan_for_wechat_data_async,
                kwargs={"max_depth": max_depth},
                daemon=True,
            )
            t.start()
            # Tiny sleep so the worker can flip running=True before we return —
            # otherwise the frontend's first poll may see "not running" and
            # think the scan finished instantly.
            _time.sleep(0.15)
            return self._send_json({"ok": True, "started": True, **_paths.get_scan_state()})

        if path == "/api/scan-disks/cancel":
            _paths.cancel_scan()
            return self._send_json({"ok": True, **_paths.get_scan_state()})

        if path == "/api/refresh":
            # Run the decrypt pipeline; dispatches via etcli sub-task helper (frozen vs dev aware)
            t0 = _time.time()
            r = subprocess.run(_spawn_etcli_args("refresh"),
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
            dt = round((_time.time() - t0) * 1000)
            ok = r.returncode == 0
            # Reload store + flush every cache so the new data shows immediately.
            # /api/refresh is WeChat-specific (it spawns refresh.py which decrypts
            # WeChat DBs), so we operate on _wechat_store NOT self.store — the
            # latter may be a QQStore if QQ is currently the active platform, in
            # which case `_msg_db_for_session.clear()` 500s with AttributeError.
            if ok:
                wechat_store = _MurmurAPIHandler._wechat_store
                if wechat_store is None:
                    # First-time decrypt — instantiate WeChat store now. Don't
                    # auto-promote it to active if a different platform is in use.
                    try:
                        new_dir = discover_data_dir()
                        if new_dir and new_dir.exists():
                            set_active = (_MurmurAPIHandler._active_platform == "wechat"
                                           or _MurmurAPIHandler.store is None)
                            _MurmurAPIHandler._set_wechat_store(EchoStore(new_dir),
                                                                  set_active=set_active)
                    except Exception as e:
                        sys.stderr.write(f"[refresh] post-decrypt store init failed: {e}\n")
                else:
                    wechat_store._contacts = None
                    wechat_store._sessions = None
                    wechat_store._msg_db_for_session.clear()
                # Drop every memoized layer — same flush path the profile-swap
                # endpoint uses. Without this the /api/friends list stays empty
                # after refresh because _MSG_INDEX_CACHE was populated earlier
                # when the decrypted dir was still empty stubs.
                _MurmurAPIHandler._flush_analysis_caches()
                _disk_clear()  # nuke persisted caches too — data is fresh
            return self._send_json({
                "ok": ok,
                "ms": dt,
                "details": (r.stdout + (r.stderr if not ok else "")).strip()[-2000:],
            })

        if path == "/api/media/index":
            # Productized replacement for "open Terminal and run python cli/media.py index".
            # Keep this in-process so packaged users do not need Python or the repo checkout.
            t0 = _time.time()
            try:
                import media as _media

                selected_profile = None
                try:
                    store_dir = self.store.dir.resolve() if self.store else None
                    for prof in _paths.discover_wechat_profiles():
                        dec = _paths.decrypted_root_for(prof, must_exist=False).resolve()
                        if (store_dir and dec == store_dir) or (self.store and prof.wxid_short in str(store_dir or "")):
                            selected_profile = prof
                            break
                    if selected_profile is None:
                        profiles = _paths.discover_wechat_profiles()
                        selected_profile = profiles[0] if profiles else None
                except Exception:
                    selected_profile = None
                if selected_profile is not None:
                    _media._PROFILE = selected_profile

                idx = _media.index_hardlinks()
                out_path = _paths.media_index_path()
                out_path.parent.mkdir(parents=True, exist_ok=True)
                existing = {}
                if out_path.exists():
                    try:
                        existing = json.loads(out_path.read_text(encoding="utf-8"))
                    except Exception:
                        existing = {}
                merged = {**existing, **idx}
                out_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
                existing_count = sum(1 for r in merged.values() if isinstance(r, dict) and r.get("exists"))
                return self._send_json({
                    "ok": True,
                    "total": len(merged),
                    "indexed": len(idx),
                    "existing": existing_count,
                    "ms": round((_time.time() - t0) * 1000),
                    "path": str(out_path),
                })
            except Exception as e:
                return self._send_json({
                    "ok": False,
                    "error": f"{type(e).__name__}: {e}",
                    "ms": round((_time.time() - t0) * 1000),
                }, 500)

        if path.startswith("/api/friend/") and path.endswith("/analyze-pack"):
            wxid_raw = path[len("/api/friend/"):-len("/analyze-pack")]
            wxid = urllib.parse.unquote(wxid_raw)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            sample = int(opts.get("sample", 80))
            with _PACK_BUILD_LOCK:
                with _STORE_READ_LOCK:
                    pack = build_analysis_pack(self.store, wxid, sample_n=sample)
                    name = self.store.contact(wxid).display() or wxid
                self.export_dir.mkdir(parents=True, exist_ok=True)
                safe = re.sub(r'[<>:"/\\|?*]', "_", name)
                out = self.export_dir / f"{safe}_AI分析包.md"
                out.write_text(pack, encoding="utf-8")
            return self._send_json({
                "ok": True,
                "path": str(out),
                "size": out.stat().st_size,
                "name": out.name,
                "content": pack,  # also return content so frontend can offer "copy all"
            })

        if path == "/api/agents/batch":
            # Launch batch_analyze.py as a subprocess. Returns immediately with the PID.
            # Body: {cli, mode, top, top_pairs, sample, parallel, force}
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            cli_name = opts.get("cli", "claude")
            mode = opts.get("mode", "top")
            pair_mode = opts.get("pair_mode", "graph")
            if pair_mode not in ("graph", "mention"):
                pair_mode = "graph"
            top = int(opts.get("top", 20))
            top_pairs = int(opts.get("top_pairs", 20))
            sample = max(1, min(int(opts.get("sample", 80)), 500))
            parallel = max(1, min(int(opts.get("parallel", 5)), 10))
            force = bool(opts.get("force", False))
            log_dir = _agent_workspace_root()
            log_dir.mkdir(parents=True, exist_ok=True)
            if cli_name in ("both", "all", "claude+codex"):
                installed = {a["cli"] for a in _detect_local_agents()}
                cli_names = [c for c in ("claude", "codex") if c in installed]
                if len(cli_names) < 2:
                    return self._send_json({"ok": False, "error": "需要同时安装 Claude 和 Codex 才能跑双引擎"}, 400)
            elif cli_name in ("claude", "codex"):
                cli_names = [cli_name]
            else:
                return self._send_json({"ok": False, "error": "cli must be claude, codex, or both"}, 400)
            extra: list = ["--parallel", str(parallel), "--sample", str(sample)]
            if mode == "all":
                pair_arg = top_pairs if top_pairs >= 0 else 0
                extra += ["--top", "0", "--top-pairs", str(pair_arg), "--min-mentions", "2", "--pair-mode", "graph"]
            elif mode == "pairs-graph":
                extra += ["--pairs-only", "--pair-mode", "graph", "--top-pairs", str(top_pairs)]
            elif mode == "single-friend":
                wxid = opts.get("wxid")
                if not wxid:
                    return self._send_json({"ok": False, "error": "wxid required for single-friend"}, 400)
                return self._send_json({"ok": False, "error": "use /api/agents/invoke for single-friend"}, 400)
            else:  # top mode (default)
                extra += ["--top", str(top), "--top-pairs", str(top_pairs), "--min-mentions", "2", "--pair-mode", pair_mode]
            if force:
                extra.append("--force")
            if len(cli_names) > 1:
                extra.append("--tag-cli")
            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"
            env["PYTHONUNBUFFERED"] = "1"
            try:
                port = int(getattr(self.server, "server_address", ("127.0.0.1", 9100))[1])
                env["ETCLI_URL"] = f"http://127.0.0.1:{port}"
            except Exception:
                env["ETCLI_URL"] = os.environ.get("ETCLI_URL", "http://127.0.0.1:9100")
            # Run from a writable user dir, NOT the bundle's read-only Resources
            # dir (cli_dir resolves into _internal/ when frozen). codex/claude
            # spawn child sessions in cwd → fail if cwd isn't writable.
            batch_cwd = _agent_workspace_root()
            try: batch_cwd.mkdir(parents=True, exist_ok=True)
            except OSError: batch_cwd = Path.home()
            try:
                procs: list[subprocess.Popen] = []
                cmds: list[list[str]] = []
                log_paths: list[str] = []
                stamp = int(_time.time())
                for one_cli in cli_names:
                    log_path = log_dir / (f"batch_{stamp}_{one_cli}.log" if len(cli_names) > 1 else f"batch_{stamp}.log")
                    cmd = _spawn_etcli_args("batch", "--cli", one_cli, *extra)
                    with open(log_path, "wb") as f:
                        proc = subprocess.Popen(
                            cmd, stdout=f, stderr=subprocess.STDOUT, env=env,
                            cwd=str(batch_cwd),
                            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform.startswith("win") else 0,
                        )
                    _BATCH_PROCS[proc.pid] = proc
                    procs.append(proc)
                    cmds.append(cmd)
                    log_paths.append(str(log_path))
                return self._send_json({
                    "ok": True,
                    "pid": procs[0].pid,
                    "pids": [p.pid for p in procs],
                    "log_path": log_paths[0],
                    "log_paths": log_paths,
                    "cmd": cmds[0],
                    "cmds": cmds,
                    "started_at": int(_time.time()),
                    "parallel": parallel,
                    "cli": cli_name,
                })
            except Exception as e:
                return self._send_json({"ok": False, "error": f"{type(e).__name__}: {e}"})

        if path == "/api/agents/batch/status":
            # Body: {pid: 1234, log_path: "...", pids?: [...], log_paths?: [...]}
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            pid = int(opts.get("pid", 0))
            pids = [int(x) for x in (opts.get("pids") or ([] if not pid else [pid])) if int(x)]
            log_path = opts.get("log_path")
            log_paths = opts.get("log_paths") or ([] if not log_path else [log_path])

            def _pid_running(one_pid: int) -> bool:
                proc = _BATCH_PROCS.get(one_pid)
                if proc:
                    alive = proc.poll() is None
                    if not alive:
                        _BATCH_PROCS.pop(one_pid, None)
                    return alive
                try:
                    if sys.platform.startswith("win"):
                        # tasklist returns "<exe>","<pid>",... Check that ANY exe with this PID exists
                        # (could be python.exe in dev mode, or etcli.exe in PyInstaller bundle).
                        r = subprocess.run(["tasklist", "/FI", f"PID eq {one_pid}", "/NH", "/FO", "CSV"],
                                            capture_output=True, text=True, encoding="utf-8", errors="replace")
                        out = (r.stdout or "").lower()
                        return ("python" in out) or ("etcli" in out)
                    os.kill(one_pid, 0)
                    return True
                except (ProcessLookupError, PermissionError, OSError):
                    return False

            running = any(_pid_running(one_pid) for one_pid in pids)
            log_tail = ""
            log_text = ""
            per_log_progress: list[dict] = []
            for lp in log_paths:
                p = Path(lp)
                if p.exists():
                    try:
                        text = p.read_text(encoding="utf-8", errors="replace")
                        per_log_progress.append(_batch_progress_from_log(text))
                        log_text += text + "\n"
                        if len(log_paths) > 1:
                            label = p.stem.replace("batch_", "")
                            log_tail += (("\n\n" if log_tail else "") + f"===== {label} =====\n" + text[-1800:])
                        else:
                            log_tail = text[-3000:]
                    except OSError:
                        pass
            if len(per_log_progress) > 1:
                progress = {
                    "friends_done": 0,
                    "friends_total": 0,
                    "pairs_done": 0,
                    "pairs_total": 0,
                    "failures": 0,
                    "skipped": 0,
                    "last_stage": "",
                    "crashed": False,
                }
                for item in per_log_progress:
                    for key in ("friends_done", "friends_total", "pairs_done", "pairs_total", "failures", "skipped"):
                        progress[key] += item.get(key, 0) or 0
                    progress["crashed"] = progress["crashed"] or bool(item.get("crashed"))
                    if item.get("last_stage"):
                        progress["last_stage"] = item["last_stage"]
            else:
                progress = _batch_progress_from_log(log_text)
            # Snapshot current report counts. These are all reports in the active
            # reports directory; progress fields above describe only this run.
            reports_root = _agent_reports_root()
            n_friends = 0
            n_pairs = 0
            if reports_root.exists():
                fr = reports_root / "friends"
                pr = reports_root / "pairs"
                if fr.exists():
                    n_friends = sum(1 for x in fr.iterdir() if x.suffix.lower() == ".md")
                if pr.exists():
                    n_pairs = sum(1 for x in pr.iterdir() if x.suffix.lower() == ".md")
            return self._send_json({
                "running": running, "n_friends": n_friends, "n_pairs": n_pairs,
                "log_tail": log_tail, "reports_root": str(reports_root), **progress,
            })

        if path == "/api/agents/invoke-pair":
            # Body: {"cli": "claude", "a": wxid_a, "b": wxid_b}
            # ASYNC: spawn the agent in a background thread and return immediately with
            # a job id. Frontend polls /api/agents/pair-status?a=X&b=Y to see when the
            # report file appears.
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            cli_name = opts.get("cli", "claude")
            a = opts.get("a")
            b = opts.get("b")
            if not a or not b:
                return self._send_json({"ok": False, "error": "a, b required"}, 400)
            evidence = pair_direct_evidence(self.store, a, b)
            if not evidence["ok"]:
                return self._send_json({
                    "ok": False,
                    "error": evidence["message"],
                    "code": "no_direct_pair_evidence",
                    "evidence": evidence,
                }, 422)
            agent = next((x for x in _detect_local_agents() if x["cli"] == cli_name), None)
            if not agent:
                return self._send_json({"ok": False, "error": f"{cli_name} not installed"}, 404)

            ca = self.store.contact(a)
            cb = self.store.contact(b)
            name_a = ca.display() or a
            name_b = cb.display() or b
            agent_path = agent["path"]
            store_ref = self.store
            pair_key = "__".join(sorted([a, b]))

            # Initialize / overwrite stream state
            _PAIR_STREAM[pair_key] = {
                "running": True, "output": "", "error": None,
                "started_at": _time.time(), "finished_at": None,
                "name_a": name_a, "name_b": name_b, "cli": cli_name,
                "stage": "building pack",
            }

            def _run_pair_in_background():
                state = _PAIR_STREAM[pair_key]
                try:
                    with _STORE_READ_LOCK:
                        pack = build_pair_inference_pack(store_ref, a, b)
                    state["stage"] = f"running {cli_name}"
                    use_shell = sys.platform.startswith("win") and agent_path.lower().endswith((".cmd", ".bat", ".ps1"))
                    cmd_args = ([agent_path, "--print"] if cli_name == "claude" else
                                 [agent_path, "exec", "--skip-git-repo-check", "--ephemeral", *_codex_model_args(), "-"] if cli_name == "codex" else
                                 [agent_path])
                    t_start = _time.time()

                    # Popen + stream stdout line by line so frontend can show live output
                    if use_shell:
                        cmd = " ".join(f'"{x}"' if " " in x or x.startswith("-") is False else x for x in cmd_args)
                    else:
                        cmd = cmd_args

                    # Run agent from a writable user dir, NOT the bundled .app's
                    # read-only Resources dir (where etcli's own cwd may live).
                    # codex creates session dirs in cwd → fails if cwd isn't writable.
                    _agent_cwd = _agent_workspace_root()
                    try: _agent_cwd.mkdir(parents=True, exist_ok=True)
                    except OSError: _agent_cwd = Path.home()
                    proc = subprocess.Popen(
                        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        bufsize=1, text=True, encoding="utf-8", errors="replace",
                        shell=use_shell, cwd=str(_agent_cwd),
                    )
                    if proc.stdin:
                        proc.stdin.write(pack)
                        proc.stdin.close()
                    if proc.stdout:
                        for line in proc.stdout:
                            state["output"] += line
                    rc = proc.wait(timeout=900)
                    elapsed = int(_time.time() - t_start)
                    output = state["output"]
                    sys.stderr.write(f"[invoke-pair] {name_a}↔{name_b} done rc={rc} chars={len(output)} {elapsed}s\n")

                    if rc == 0 and len(output) > 100:
                        clean_output = output
                        if cli_name == "codex":
                            cidx = output.rfind("\ncodex\n")
                            if cidx > 0:
                                clean_output = output[cidx + len("\ncodex\n"):]
                                tidx = clean_output.find("\ntokens used\n")
                                if tidx > 0:
                                    clean_output = clean_output[:tidx]
                        clean_output = clean_output.strip()
                        pairs_root = _agent_reports_root() / "pairs"
                        pairs_root.mkdir(parents=True, exist_ok=True)
                        safe_a = re.sub(r'[<>:"/\\|?*]', "_", name_a) or a
                        safe_b = re.sub(r'[<>:"/\\|?*]', "_", name_b) or b
                        idx = max([int(p.stem.split("_")[0]) for p in pairs_root.glob("*.md")
                                    if p.stem.split("_")[0].isdigit()] + [0]) + 1
                        fname = f"{idx:02d}_{safe_a}__{safe_b}.md"
                        md = (
                            f"# {name_a} ↔ {name_b} 关系推断\n\n"
                            f"> 由 {cli_name} 生成 · 用时 {elapsed}s · 触发：app 内点击\n\n"
                            f"> wxid_a: `{a}`\n"
                            f"> wxid_b: `{b}`\n\n"
                            f"---\n\n{clean_output}\n"
                        )
                        (pairs_root / fname).write_text(md, encoding="utf-8")
                        sys.stderr.write(f"[invoke-pair] saved → {fname}\n")
                        state["stage"] = "saved"
                    else:
                        state["error"] = f"agent rc={rc}, output {len(output)} chars (need ≥100)"
                        state["stage"] = "failed"
                    pck = "pairreport_" + "__".join(sorted([a, b]))
                    _PAIR_REPORT_CACHE.pop(pck, None)
                    try:
                        (_disk_cache_dir() / f"{_safe_filename(pck)}.json").unlink(missing_ok=True)
                    except Exception:
                        pass
                except Exception as e:
                    state["error"] = f"{type(e).__name__}: {e}"
                    state["stage"] = "crashed"
                    sys.stderr.write(f"[invoke-pair bg] {e}\n")
                finally:
                    state["running"] = False
                    state["finished_at"] = _time.time()

            import threading
            threading.Thread(target=_run_pair_in_background, daemon=True).start()
            return self._send_json({
                "ok": True,
                "queued": True,
                "a": a, "b": b, "pair_key": pair_key,
                "message": f"已开始让 {cli_name} 分析「{name_a}」↔「{name_b}」",
            })

        if path == "/api/agents/pair-stream":
            # Poll endpoint for live agent output. Returns latest stage + accumulated output.
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            a = opts.get("a")
            b = opts.get("b")
            if not a or not b:
                return self._send_json({"running": False, "output": "", "error": "a, b required"}, 400)
            pair_key = "__".join(sorted([a, b]))
            state = _PAIR_STREAM.get(pair_key)
            if not state:
                return self._send_json({"running": False, "output": "", "stage": "no job"})
            return self._send_json({
                "running": state["running"],
                "output": state["output"],
                "error": state["error"],
                "stage": state["stage"],
                "started_at": state["started_at"],
                "finished_at": state["finished_at"],
                "elapsed": int((state["finished_at"] or _time.time()) - state["started_at"]),
            })

        if path == "/api/agents/invoke":
            # Body: {"cli": "claude", "wxid": "...", "sample": 80}
            # ASYNC: spawn agent in background thread, return immediately. Frontend polls
            # /api/agents/invoke-stream for live output.
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            cli_name = opts.get("cli", "claude")
            wxid = opts.get("wxid")
            sample = int(opts.get("sample", 80))
            if not wxid or wxid in ("undefined", "null"):
                return self._send_json({"ok": False, "error": "wxid required"}, 400)
            # Defensive: reject wxids that aren't actually in the contacts table —
            # protects against frontend bugs that pass garbage like "undefined" or typos.
            if wxid not in self.store.contacts():
                return self._send_json({
                    "ok": False, "error": f"未知的 wxid: {wxid!r}（请从联系人列表点开朋友再触发）",
                }, 404)
            contact = self.store.contact(wxid)
            agent = next((a for a in _detect_local_agents() if a["cli"] == cli_name), None)
            if not agent:
                return self._send_json({"ok": False, "error": f"{cli_name} not installed"}, 404)
            existing_state = _FRIEND_STREAM.get(wxid)
            if existing_state and existing_state.get("running"):
                return self._send_json({
                    "ok": True,
                    "queued": False,
                    "already_running": True,
                    "wxid": wxid,
                    "message": f"{cli_name} 已经在分析「{existing_state.get('name') or wxid}」，请稍等或查看当前进度",
                })

            name = contact.display() or wxid
            agent_path = agent["path"]
            store_ref = self.store
            export_dir = self.export_dir

            _FRIEND_STREAM[wxid] = {
                "running": True, "output": "", "error": None,
                "started_at": _time.time(), "finished_at": None,
                "name": name, "cli": cli_name, "stage": "building pack",
            }

            def _run_friend_in_background():
                state = _FRIEND_STREAM[wxid]
                try:
                    with _STORE_READ_LOCK:
                        pack = build_analysis_pack(store_ref, wxid, sample_n=sample)
                    export_dir.mkdir(parents=True, exist_ok=True)
                    safe = re.sub(r'[<>:"/\\|?*]', "_", name)
                    pack_path = export_dir / f"{safe}_AI分析包.md"
                    pack_path.write_text(pack, encoding="utf-8")
                    state["stage"] = f"running {cli_name}"

                    use_shell = sys.platform.startswith("win") and agent_path.lower().endswith((".cmd", ".bat", ".ps1"))
                    if cli_name == "claude":
                        cmd_args = [agent_path, "--print"]
                    elif cli_name == "codex":
                        cmd_args = [agent_path, "exec", "--skip-git-repo-check", "--ephemeral", *_codex_model_args(), "-"]
                    else:
                        cmd_args = [agent_path]

                    if use_shell:
                        cmd = " ".join(f'"{x}"' if " " in x or x.startswith("-") is False else x for x in cmd_args)
                    else:
                        cmd = cmd_args

                    t_start = _time.time()
                    # Run agent from a writable user dir, NOT the bundled .app's
                    # read-only Resources dir (where etcli's own cwd may live).
                    # codex creates session dirs in cwd → fails if cwd isn't writable.
                    _agent_cwd = _agent_workspace_root()
                    try: _agent_cwd.mkdir(parents=True, exist_ok=True)
                    except OSError: _agent_cwd = Path.home()
                    proc = subprocess.Popen(
                        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        bufsize=1, text=True, encoding="utf-8", errors="replace",
                        shell=use_shell, cwd=str(_agent_cwd),
                    )
                    if proc.stdin:
                        proc.stdin.write(pack)
                        proc.stdin.close()
                    if proc.stdout:
                        for line in proc.stdout:
                            state["output"] += line
                    rc = proc.wait(timeout=900)
                    elapsed = int(_time.time() - t_start)
                    output = state["output"]
                    sys.stderr.write(f"[invoke] {name} rc={rc} chars={len(output)} {elapsed}s\n")

                    if rc == 0 and len(output) > 100:
                        # Strip codex banner: keep only between "\ncodex\n" and "\ntokens used\n"
                        clean_output = output
                        if cli_name == "codex":
                            cidx = output.rfind("\ncodex\n")
                            if cidx > 0:
                                clean_output = output[cidx + len("\ncodex\n"):]
                                tidx = clean_output.find("\ntokens used\n")
                                if tidx > 0:
                                    clean_output = clean_output[:tidx]
                        clean_output = clean_output.strip()
                        reports_root = _agent_reports_root() / "friends"
                        reports_root.mkdir(parents=True, exist_ok=True)
                        safe_full = re.sub(r'[<>:"/\\|?*]', "_", name) or wxid
                        report_file = reports_root / f"{safe_full}.md"
                        ts = datetime.now(CST).isoformat(timespec="seconds")
                        md = (
                            f"# {name} 关系档案\n\n"
                            f"> 由 {cli_name} 生成 · {ts} · 用时 {elapsed}s\n"
                            f"> wxid: `{wxid}`\n\n---\n\n{clean_output}\n"
                        )
                        report_file.write_text(md, encoding="utf-8")
                        sys.stderr.write(f"[invoke] saved → {safe_full}.md\n")
                        state["stage"] = "saved"
                        # Invalidate friend_detail cache so aiReport surfaces immediately
                        _FRIEND_DETAIL_CACHE.pop(wxid, None)
                        try:
                            (_disk_cache_dir() / f"{_safe_filename('friend_' + wxid)}.json").unlink(missing_ok=True)
                        except Exception:
                            pass
                    else:
                        state["error"] = f"agent rc={rc}, output {len(output)} chars"
                        state["stage"] = "failed"
                except Exception as e:
                    state["error"] = f"{type(e).__name__}: {e}"
                    state["stage"] = "crashed"
                    sys.stderr.write(f"[invoke bg] {e}\n")
                finally:
                    state["running"] = False
                    state["finished_at"] = _time.time()

            import threading
            threading.Thread(target=_run_friend_in_background, daemon=True).start()
            return self._send_json({
                "ok": True, "queued": True, "wxid": wxid,
                "message": f"已开始让 {cli_name} 分析「{name}」",
            })

        if path == "/api/agents/invoke-stream":
            # Body: {"wxid": "..."}
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            wxid = opts.get("wxid")
            if not wxid:
                return self._send_json({"running": False, "output": "", "error": "wxid required"}, 400)
            state = _FRIEND_STREAM.get(wxid)
            if not state:
                return self._send_json({"running": False, "output": "", "stage": "no job"})
            return self._send_json({
                "running": state["running"],
                "output": state["output"],
                "error": state["error"],
                "stage": state["stage"],
                "elapsed": int((state["finished_at"] or _time.time()) - state["started_at"]),
            })

        if path == "/api/extract-key":
            # Multi-step key extraction with status streaming via subprocess.
            # Body: {"auto_restart": true|false}
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            auto_restart = bool(opts.get("auto_restart", True))
            timeout = int(opts.get("timeout", 90))
            t0 = _time.time()
            if _paths.IS_MAC:
                # macOS dance:
                #   1. The script needs ROOT (for task_for_pid on WeChat).
                #   2. But ROOT is BLOCKED by TCC from listdir-ing
                #      ~/Library/Containers (where the encrypted DBs live).
                #   3. The CURRENT user *is* allowed to read its own containers.
                # So: collect the salts as user → drop to /tmp → invoke as root
                # with --salts ... --out-keys ... so the root pass only does
                # mach_vm work, never touching TCC-protected paths.
                import shlex, tempfile, shutil
                # Pre-collect salts as the user (works because we're not root)
                cli_dir = Path(__file__).resolve().parent
                sys.path.insert(0, str(cli_dir))
                from extract_key_mac import collect_db_salts as _collect  # noqa: E402
                profiles = _paths.discover_wechat_profiles()
                if not profiles:
                    return self._send_json({
                        "ok": False,
                        "error": "未找到 WeChat profile（请先在微信里登录一次）",
                    })
                prof = profiles[0]
                salt_map = _collect(prof)  # {salt_hex: {name, path, page1}}
                if not salt_map:
                    return self._send_json({
                        "ok": False,
                        "error": "没找到加密 DB — 让微信完成首次同步后再试",
                    })
                # Persist salts file in /tmp (TCC-free)
                fd_s, salts_path = tempfile.mkstemp(prefix="murmur_salts_", suffix=".json")
                os.close(fd_s)
                fd_k, keys_path = tempfile.mkstemp(prefix="murmur_keys_", suffix=".json")
                os.close(fd_k)
                # Make tmp files writable by root subprocess; flat dict {salt: name}
                # plus a sentinel __wxid__ key so the script can record provenance.
                salts_payload = {salt: meta["name"] for salt, meta in salt_map.items()}
                salts_payload["__wxid__"] = prof.wxid
                Path(salts_path).write_text(
                    json.dumps(salts_payload, ensure_ascii=False),
                    encoding="utf-8",
                )

                # Build the elevated command. _spawn_etcli_args handles both
                # frozen mode (etcli extract-key-mac ...) and dev mode (python
                # extract_key_mac.py ...). Quote each arg for shell + AppleScript.
                inner_argv = _spawn_etcli_args(
                    "extract-key-mac",
                    "--timeout", str(timeout),
                    "--salts", salts_path,
                    "--out-keys", keys_path,
                )
                inner = " ".join(shlex.quote(a) for a in inner_argv)
                inner_as = inner.replace("\\", "\\\\").replace('"', '\\"')
                applescript = f'do shell script "{inner_as}" with administrator privileges'
                r = subprocess.run(["osascript", "-e", applescript],
                                   capture_output=True, text=True, encoding="utf-8",
                                   timeout=max(timeout + 30, 90))
                stdout = (r.stdout or "") + (r.stderr or "")

                # Copy keys file from /tmp to user's ~/.murmur (so refresh.py finds it)
                dst = Path.home() / ".murmur" / "decrypted_keys.json"
                try:
                    if Path(keys_path).exists() and Path(keys_path).stat().st_size > 0:
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy(keys_path, dst)
                        # Fix ownership (root → user) so the user can read it
                        try:
                            uid = int(os.environ.get("SUDO_UID", os.getuid()))
                            gid = int(os.environ.get("SUDO_GID", os.getgid()))
                            os.chown(dst, uid, gid)
                        except Exception:
                            pass
                except Exception as e:
                    stdout += f"\n[orchestrator] copy {keys_path} → {dst} failed: {e}"
                # Clean up tmp salts (always) and tmp keys (only if we copied)
                try: os.unlink(salts_path)
                except OSError: pass
                try: os.unlink(keys_path)
                except OSError: pass
            else:
                # Windows path: spawn extract_key_dll via _spawn_etcli_args
                # (handles dev vs PyInstaller frozen).
                extra = ["--timeout", str(timeout)]
                if auto_restart:
                    extra.append("--auto-restart")
                cmd = _spawn_etcli_args("extract-key", *extra)
                # errors="replace" so CP936/GBK output (taskkill, registry strings, Chinese paths)
                # doesn't crash the reader thread with UnicodeDecodeError on bytes like 0xb4.
                r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
                stdout = (r.stdout or "") + (r.stderr or "")
            ms = round((_time.time() - t0) * 1000)
            # Parse output. Two flavours:
            #   Windows (extract_key_dll.py): single line "[KEY] <64hex>"
            #   macOS   (extract_key_mac.py):   "[KEY] <db>: <64hex>" per DB,
            #     plus per-DB JSON file at ~/.murmur/decrypted_keys.json.
            key = None
            mac_keys_count = 0
            for line in stdout.splitlines():
                if not line.startswith("[KEY]"):
                    continue
                tail = line[5:].strip()
                if _paths.IS_MAC:
                    mac_keys_count += 1
                else:
                    # Win: take the first 64-hex token we see
                    parts = tail.split()
                    for p in parts:
                        if len(p) == 64 and all(c in "0123456789abcdefABCDEF" for c in p):
                            key = p.lower()
                            break
                    if key:
                        break
            if _paths.IS_MAC:
                # On Mac, success = the per-DB JSON was copied into ~/.murmur
                ok = (Path.home() / ".murmur" / "decrypted_keys.json").exists() and mac_keys_count > 0
                return self._send_json({
                    "ok": ok,
                    "mac_keys_count": mac_keys_count,
                    "ms": ms,
                    "log": stdout[-3000:] or "(no output)",
                })
            return self._send_json({
                "ok": bool(key),
                "key": key,
                "ms": ms,
                "log": stdout[-3000:],
            })

        if path == "/api/save-key":
            # Persist a key for future use (so user doesn't need to re-extract)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            key = (opts.get("key") or "").strip()
            if len(key) != 64 or not all(c in "0123456789abcdefABCDEF" for c in key):
                return self._send_json({"ok": False, "error": "key must be 64 hex chars"})
            cfg = Path.home() / ".murmur" / "config.json"
            cfg.parent.mkdir(parents=True, exist_ok=True)
            existing = {}
            if cfg.exists():
                try:
                    existing = json.loads(cfg.read_text(encoding="utf-8"))
                except Exception:
                    pass
            existing["decrypt_key"] = key
            existing["saved_at"] = datetime.now(CST).isoformat()
            cfg.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
            return self._send_json({"ok": True, "path": str(cfg)})

        if path == "/api/resign-wechat":
            # Mac-only: re-sign WeChat.app ad-hoc to clear hardened-runtime flag.
            # Triggers macOS native auth prompt via osascript "with administrator privileges".
            # Body: {"relaunch": true|false}  — whether to re-launch WeChat afterwards
            if not _paths.IS_MAC:
                return self._send_json({"ok": False, "error": "macOS only"}, 400)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            relaunch = bool(opts.get("relaunch", True))

            steps_log = []
            try:
                import shlex
                wechat_app = _paths.find_weixin_exe()
                main_exec = _paths.wechat_main_exec(wechat_app)
                if not wechat_app or not main_exec:
                    return self._send_json({
                        "ok": False,
                        "error": "没找到 WeChat.app / Weixin.app；请先安装并打开微信，或设置 MURMUR_WECHAT_APP",
                        "log": steps_log,
                    })

                # 1. Quit WeChat (graceful, then force)
                steps_log.append("[1/4] 退出微信…")
                for app_name in ("WeChat", "Weixin", "微信"):
                    subprocess.run(["osascript", "-e", f'try\n  tell application "{app_name}" to quit\nend try'],
                                   capture_output=True, text=True, timeout=10)
                _time.sleep(1.5)
                subprocess.run(["pkill", "-x", "WeChat"], capture_output=True)
                subprocess.run(["pkill", "-x", "Weixin"], capture_output=True)
                _time.sleep(0.8)

                # 2. Run codesign with admin privileges via osascript
                steps_log.append("[2/4] 重签名 (会弹 macOS 系统认证窗口，请输入开机密码)…")
                # Modern macOS: plain `codesign --force --sign -` PRESERVES the existing
                # flags (including hardened-runtime), which defeats the whole point.
                # Fix: first wipe the signature, then ad-hoc re-sign without preserving
                # flags. Use a chained shell command — osascript runs them as one
                # admin-elevated subshell so the password prompt only appears once.
                main_exec_q = shlex.quote(str(main_exec))
                shell_cmd = (
                    f"codesign --remove-signature {main_exec_q} && "
                    "codesign --force --sign - "
                    "--preserve-metadata=identifier,entitlements,requirements "
                    f"{main_exec_q}"
                )
                cmd = (f'do shell script "{shell_cmd}" with administrator privileges')
                t0 = _time.time()
                r = subprocess.run(["osascript", "-e", cmd],
                                   capture_output=True, text=True, timeout=120)
                dt = round((_time.time() - t0) * 1000)
                if r.returncode != 0:
                    err_blob = ((r.stdout or "") + "\n" + (r.stderr or "")).strip()
                    err_l = err_blob.lower()
                    if r.returncode == -128 or "user canceled" in err_l or "用户已取消" in err_l:
                        msg = "重签名被 macOS 系统授权窗口取消了。请重新点击重签名，在弹出的系统窗口里输入这台 Mac 的开机密码（不是 Apple ID）。"
                    elif "operation not permitted" in err_l or "permission" in err_l:
                        msg = "重签名被系统权限拦截。请先把 Murmur 拖到 Applications，给 Murmur 完全磁盘访问权限，完全退出后重开再试。"
                    else:
                        msg = "codesign 重签名失败。请确认 WeChat 已退出、Murmur 在 Applications 里运行，并在系统授权窗口输入开机密码。"
                    return self._send_json({
                        "ok": False,
                        "error": msg,
                        "stderr": err_blob[-800:],
                        "log": steps_log,
                        "ms": dt,
                    })

                # 3. Verify the runtime flag is now gone (check the main exec, not the bundle)
                steps_log.append("[3/4] 验证签名…")
                v = subprocess.run(
                    ["codesign", "-d", "-v", str(main_exec)],
                    capture_output=True, text=True,
                )
                v_blob = (v.stdout + "\n" + v.stderr)
                still_hardened = _paths.codesign_has_runtime_flag(v_blob)
                if still_hardened:
                    return self._send_json({
                        "ok": False,
                        "error": "重签名后主可执行文件仍带 hardened runtime — 这是 macOS / codesign 行为变化导致的，请反馈 issue",
                        "stderr": v_blob[-800:],
                        "log": steps_log,
                    })

                # 4. Re-launch
                if relaunch:
                    steps_log.append("[4/4] 启动微信…")
                    subprocess.Popen(["open", str(wechat_app)])

                return self._send_json({
                    "ok": True,
                    "ms": dt,
                    "log": steps_log,
                    "next_steps": "在新打开的微信里登录、点开几个对话，然后回到这里点「开始抓密钥」",
                })
            except subprocess.TimeoutExpired:
                return self._send_json({"ok": False, "error": "超时", "log": steps_log})
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e), "log": steps_log})

        if path == "/api/open-fda":
            # macOS only: open System Settings to "Full Disk Access" so the user can
            # tick Murmur. Works on macOS 13+. After granting, user has to relaunch
            # Murmur (TCC re-evaluates on next process launch).
            if not _paths.IS_MAC:
                return self._send_json({"ok": False, "error": "macOS only"}, 400)
            try:
                # macOS 13+ deep link
                subprocess.Popen(["open", "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"])
                return self._send_json({"ok": True})
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)})

        if path == "/api/open-folder":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            opts = json.loads(body.decode("utf-8") or "{}")
            target = Path(opts.get("path", str(self.export_dir)))
            try:
                if sys.platform.startswith("win"):
                    os.startfile(str(target if target.is_dir() else target.parent))  # type: ignore[attr-defined]
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", str(target if target.is_dir() else target.parent)])
                else:
                    subprocess.Popen(["xdg-open", str(target if target.is_dir() else target.parent)])
                return self._send_json({"ok": True, "opened": str(target)})
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)})

        return self._send_json({"error": "Not found", "path": path}, status=404)


    # ============================================================
    # Multi-platform store registry. `self.store` is the *active* store —
    # an EchoStore (WeChat) or QQStore (QQ). Both expose the same surface
    # (contacts/sessions/messages/message_count/contact) so every analysis
    # function stays platform-agnostic. See cli/qq_paths.py, cli/qq_decrypt.py,
    # cli/qq_store.py.
    # ============================================================
    _wechat_store: Optional[EchoStore] = None
    _qq_stores: dict = {}
    _qq_keys_cfg_path = Path.home() / ".murmur" / "qq_keys.json"
    _active_platform: str = "wechat"
    _active_id: Optional[str] = None  # wxid for wechat, qq_number for qq

    @classmethod
    def _qq_load_keys_config(cls) -> dict:
        if not cls._qq_keys_cfg_path.exists():
            return {}
        try:
            return json.loads(cls._qq_keys_cfg_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    @classmethod
    def _qq_save_keys_config(cls, cfg: dict) -> None:
        cls._qq_keys_cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cls._qq_keys_cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    @classmethod
    def _qq_get_store(cls, qq_number: str):
        if qq_number in cls._qq_stores:
            return cls._qq_stores[qq_number]
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import qq_store as _qstore  # noqa: E402
        decrypted_dir = Path.home() / "Documents" / "Murmur" / "decrypted_qq" / qq_number
        if not (decrypted_dir / "nt_msg.db").exists():
            return None
        s = _qstore.QQStore(decrypted_dir, qq_number=qq_number)
        cls._qq_stores[qq_number] = s
        return s

    # ---------- shared helpers used by /api/profiles + /api/active-profile ----------

    @classmethod
    def _set_wechat_store(cls, store: EchoStore, *, set_active: bool = True) -> None:
        cls._wechat_store = store
        if set_active:
            cls.store = store
            cls._active_platform = "wechat"
            cls._active_id = cls._wechat_id_for_store(store) or store.me

    @classmethod
    def _wechat_profile_for_id(cls, ident: str):
        """Return the WeChat profile matching a full wxid or short decrypted dir id."""
        try:
            for prof in _paths.discover_wechat_profiles():
                if ident in {prof.wxid, prof.wxid_short}:
                    return prof
        except Exception:
            return None
        return None

    @classmethod
    def _wechat_id_for_store(cls, store: EchoStore) -> Optional[str]:
        """Map an EchoStore back to its full wxid for ProfileSwitcher state."""
        try:
            store_dir = Path(store.dir).resolve()
            for prof in _paths.discover_wechat_profiles():
                dec = _paths.decrypted_root_for(prof, must_exist=True)
                if dec and Path(dec).resolve() == store_dir:
                    return prof.wxid
        except Exception:
            pass
        return store.me

    @classmethod
    def _flush_analysis_caches(cls) -> None:
        """Drop every memoized analysis layer so the next request reflects the new store.

        Most caches are global (module-level dicts) — they're keyed by wxid only
        and would otherwise serve stale WeChat data when the user switched to QQ.
        """
        for cache in (_GRAPH_CACHE, _CONN_CACHE, _FRIEND_DETAIL_CACHE,
                       _FRIENDS_LIST_CACHE, _YEARBOOK_CACHE):
            try:
                cache.clear()
            except Exception:
                pass
        for d in (_SNS_SIGNALS_CACHE, _FF_MOMENTS_CACHE, _HOME_SUMMARY_CACHE,
                   _HOME_CACHE):
            d["data"] = None  # type: ignore[index]
        # Drop the WeChat msg-index cache so a swap back to WeChat re-scans.
        # QQStore caches its own per-instance, so QQ→QQ swaps stay fast.
        _MSG_INDEX_CACHE["counts"] = None
        _MSG_INDEX_CACHE["locations"] = None
        _MSG_INDEX_CACHE["last_ts"] = None

    @staticmethod
    def _mask_id(s: str) -> str:
        if not s:
            return ""
        if s.startswith("qq:"):
            n = s[3:]
            if len(n) <= 6:
                return "QQ " + n
            return "QQ " + n[:3] + "…" + n[-3:]
        if s.startswith("wxid_"):
            head = s[:6]  # "wxid_x"
            return head + "…" + s[-4:]
        if len(s) <= 8:
            return s
        return s[:4] + "…" + s[-4:]

    @classmethod
    def _build_profiles_payload(cls) -> dict:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import qq_paths as _qpaths  # noqa: E402
        out: list[dict] = []
        # WeChat
        try:
            wprofs = _paths.discover_wechat_profiles()
        except Exception:
            wprofs = []
        cfg = _paths.load_config()
        saved_wkey = bool(cfg.get("decrypt_key")) or (Path.home() / ".murmur" / "decrypted_keys.json").exists()
        for p in wprofs:
            dec_dir = _paths.decrypted_root_for(p, must_exist=True)
            ready = bool(dec_dir)
            n_sessions = 0
            last_ts = 0
            if ready and cls._wechat_store and Path(cls._wechat_store.dir) == dec_dir:
                try:
                    sess = cls._wechat_store.sessions()
                    n_sessions = len(sess)
                    last_ts = max((s.last_timestamp for s in sess), default=0)
                except Exception:
                    pass
            state = "ready" if ready else ("needs_decrypt" if saved_wkey else "needs_key")
            pid = p.wxid
            out.append({
                "id": pid,
                "platform": "wechat",
                "display_id": cls._mask_id(pid),
                "qq_number": None,
                "n_sessions": n_sessions,
                "last_active_ts": last_ts or None,
                "state": state,
                "is_active": (cls._active_platform == "wechat" and cls._active_id == pid),
            })
        # QQ
        try:
            qprofs = _qpaths.discover_qq_profiles()
        except Exception:
            qprofs = []
        saved_qkeys = cls._qq_load_keys_config()
        for q in qprofs:
            dec_dir = _qpaths.qq_decrypted_root_for(q, must_exist=False)
            ready = (dec_dir is not None) and (dec_dir / "nt_msg.db").exists()
            n_sessions = 0
            last_ts = 0
            if ready:
                qs = cls._qq_stores.get(q.qq_number)
                if qs is not None:
                    try:
                        sess = qs.sessions()
                        n_sessions = len(sess)
                        last_ts = max((s.last_timestamp for s in sess), default=0)
                    except Exception:
                        pass
            state = "ready" if ready else ("needs_decrypt" if q.qq_number in saved_qkeys else "needs_key")
            pid = f"qq:{q.qq_number}"
            out.append({
                "id": pid,
                "platform": "qq",
                "display_id": cls._mask_id(pid),
                "qq_number": q.qq_number,
                "n_sessions": n_sessions,
                "last_active_ts": last_ts or None,
                "state": state,
                "is_active": (cls._active_platform == "qq" and cls._active_id == q.qq_number),
            })
        return {
            "active_platform": cls._active_platform,
            "active_id": cls._active_id,
            "profiles": out,
        }

    def _set_active_profile(self, opts: dict):
        cls = self.__class__
        platform = (opts.get("platform") or "").strip()
        ident = (opts.get("id") or "").strip()
        if platform not in ("wechat", "qq"):
            return self._send_json({"ok": False, "error": "platform must be 'wechat' or 'qq'"}, 400)
        if not ident:
            return self._send_json({"ok": False, "error": "id required"}, 400)
        if platform == "wechat":
            prof = cls._wechat_profile_for_id(ident)
            if prof is None:
                return self._send_json({"ok": False, "error": f"wechat profile {ident} not found"}, 404)
            dec_dir = _paths.decrypted_root_for(prof, must_exist=True)
            if not dec_dir:
                return self._send_json({"ok": False, "error": f"wechat profile {ident} not decrypted"}, 404)
            # Reuse cached store if it matches; otherwise (re)load the specific
            # profile the user clicked. discover_data_dir() returns the first
            # ready account and is wrong for multi-WeChat switching.
            if cls._wechat_store is not None and Path(cls._wechat_store.dir).resolve() == Path(dec_dir).resolve():
                store = cls._wechat_store
            else:
                store = EchoStore(dec_dir)
            cls._set_wechat_store(store, set_active=True)
            cls._active_id = prof.wxid
        else:  # qq
            qs = cls._qq_get_store(ident)
            if qs is None:
                return self._send_json({"ok": False, "error": f"qq {ident} not decrypted"}, 404)
            cls.store = qs
            cls._active_platform = "qq"
            cls._active_id = ident
        cls._flush_analysis_caches()
        return self._send_json({
            "ok": True,
            "active_platform": cls._active_platform,
            "active_id": cls._active_id,
        })

    def _dispatch_qq_get(self, path: str, qs: dict):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import qq_paths as _qpaths  # noqa: E402

        if path == "/api/qq/profiles":
            # Onboarding-only listing (keys + has_decrypted flags). For the
            # cross-platform switcher use /api/profiles instead.
            if not _qpaths.IS_WINDOWS:
                return self._send_json({
                    "platform": "qq",
                    "supported": False,
                    "profiles": [],
                    "qq_running": False,
                    "qq_install": None,
                    "error": "QQ 导入目前只支持 Windows。Mac 版暂时可以继续使用微信数据，QQ for Mac 适配还在开发中。",
                })
            profiles = _qpaths.discover_qq_profiles()
            keys = self._qq_load_keys_config()
            out = []
            for p in profiles:
                dec_dir = _qpaths.qq_decrypted_root_for(p, must_exist=False)
                has_decrypted = (dec_dir is not None) and (dec_dir / "nt_msg.db").exists()
                out.append({
                    "qq_number": p.qq_number,
                    "encrypted_root": str(p.nt_db_dir),
                    "decrypted_root": str(dec_dir) if dec_dir else None,
                    "has_decrypted_data": has_decrypted,
                    "has_saved_key": p.qq_number in keys,
                })
            return self._send_json({
                "platform": "qq",
                "profiles": out,
                "qq_running": bool(_qpaths.qq_running_pids()),
                "qq_install": str(_qpaths.find_qq_install_dir()) if _qpaths.find_qq_install_dir() else None,
            })

        return self._send_json({"error": "unknown qq endpoint", "path": path}, 404)

    def _dispatch_qq_post(self, path: str):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import qq_paths as _qpaths  # noqa: E402
        import qq_decrypt as _qdec  # noqa: E402

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b"{}"
        try:
            opts = json.loads(body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            opts = {}

        if path == "/api/qq/extract-key":
            timeout = int(opts.get("timeout", 240))
            r = _qdec.extract_key_via_powershell(timeout=timeout)
            return self._send_json(r)

        if path == "/api/qq/save-key":
            qq = str(opts.get("qq", "")).strip()
            key = str(opts.get("key", "")).strip()
            if not qq or not key:
                return self._send_json({"ok": False, "error": "qq + key required"}, 400)
            cfg = self._qq_load_keys_config()
            cfg[qq] = key
            self._qq_save_keys_config(cfg)
            return self._send_json({"ok": True, "qq": qq})

        if path == "/api/qq/decrypt":
            qq = str(opts.get("qq", "")).strip()
            key = str(opts.get("key", "")).strip()
            if not qq:
                return self._send_json({"ok": False, "error": "qq required"}, 400)
            if not key:
                key = self._qq_load_keys_config().get(qq, "")
            if not key:
                return self._send_json({"ok": False, "error": "no saved key — extract-key first"}, 400)
            profiles = _qpaths.discover_qq_profiles()
            prof = next((p for p in profiles if p.qq_number == qq), None)
            if not prof:
                return self._send_json({"ok": False, "error": f"qq {qq} not found in Tencent Files"}, 404)
            dst = _qpaths.qq_decrypted_root_for(prof)
            try:
                results = _qdec.decrypt_profile(prof.nt_db_dir, dst, key)
            except _qdec.WrongKeyError as e:
                return self._send_json({"ok": False, "error": f"wrong key: {e}"}, 400)
            self.__class__._qq_stores.pop(qq, None)
            ok = any(v.startswith("ok") for v in results.values())
            return self._send_json({
                "ok": ok, "qq": qq, "decrypted_root": str(dst),
                "results": results,
            })

        return self._send_json({"error": "unknown qq endpoint", "path": path}, 404)

    def _serve_media(self, md5: str):
        """Serve a media file by its content md5. Auto-decrypts .dat files."""
        idx_path = _paths.media_index_path()
        if not idx_path.exists():
            return self._send_json({"error": "media-index.json not built; run media.py index"}, 404)
        try:
            idx = json.loads(idx_path.read_text(encoding="utf-8"))
        except Exception as e:
            return self._send_json({"error": f"index parse error: {e}"}, 500)
        rec = idx.get(md5)
        if not rec or not rec.get("source_path"):
            return self._send_json({"error": "md5 not found in index"}, 404)
        src = Path(rec["source_path"])
        if not src.exists():
            return self._send_json({"error": f"file missing on disk: {src}"}, 404)

        ext = src.suffix.lower()
        try:
            data = src.read_bytes()
        except OSError as e:
            return self._send_json({"error": str(e)}, 500)

        # On-the-fly decrypt for .dat files
        if ext == ".dat" and data:
            try:
                # Read image AES key from config if available
                cfg = _paths.load_config()
                img_key_str = cfg.get("image_aes_key")
                img_key = img_key_str.encode("utf-8") if img_key_str else None
                # Lazy import (avoid circular)
                import media as _media
                plain, fmt, ver = _media.decrypt_dat(data, image_aes_key=img_key)
                if fmt and plain:
                    data = plain
                    ext = "." + fmt
                else:
                    # V4-V2 without key — return a small SVG placeholder
                    placeholder = (
                        f'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" '
                        f'viewBox="0 0 120 120">'
                        f'<rect width="120" height="120" fill="#F1E8D7"/>'
                        f'<text x="60" y="55" text-anchor="middle" font-family="serif" font-size="14" '
                        f'fill="#6F6A5C">图片加密</text>'
                        f'<text x="60" y="75" text-anchor="middle" font-family="sans-serif" font-size="10" '
                        f'fill="#B6AC97">需要 image key ({ver})</text>'
                        f'</svg>'
                    ).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "image/svg+xml")
                    self.send_header("Content-Length", str(len(placeholder)))
                    self._send_cors_headers()
                    self.end_headers()
                    self.wfile.write(placeholder)
                    return
            except Exception as e:
                sys.stderr.write(f"[serve_media] decrypt error for {md5}: {e}\n")

        mime = {
            ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
        }.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(data)


def _which(cli: str) -> str | None:
    """Cross-platform `which`. On Windows, also searches for .cmd / .bat / .exe.

    On macOS / Linux, when running inside a launchd-spawned GUI .app, the
    inherited PATH is the bare `/usr/bin:/bin:/usr/sbin:/sbin` — it does NOT
    include common npm/yarn/pnpm install dirs like ~/.nvm/.../bin or
    /opt/homebrew/bin. So shutil.which() misses claude/codex even
    when they're installed. We augment the search with the common dirs.
    """
    import shutil as _shutil
    p = _shutil.which(cli)
    if p:
        return p
    if sys.platform.startswith("win"):
        # npm global on Windows: %APPDATA%\npm\<cli>.cmd
        npm_dir = Path(os.environ.get("APPDATA") or "") / "npm"
        for ext in (".cmd", ".bat", ".exe", ".ps1"):
            cand = npm_dir / f"{cli}{ext}"
            if cand.exists():
                return str(cand)
        return None
    # macOS / Linux: search common install dirs that .app's PATH usually misses
    home = Path.home()
    extra_dirs: list[Path] = [
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
        home / ".local" / "bin",
        home / ".cargo" / "bin",
        home / "Library" / "pnpm",
    ]
    # All nvm-managed Node versions: ~/.nvm/versions/node/v*/bin
    nvm_root = home / ".nvm" / "versions" / "node"
    if nvm_root.is_dir():
        try:
            for ver in sorted(nvm_root.iterdir(), reverse=True):  # newest first
                if ver.is_dir():
                    extra_dirs.append(ver / "bin")
        except OSError:
            pass
    # Volta / asdf / fnm node managers
    extra_dirs += [
        home / ".volta" / "bin",
        home / ".asdf" / "shims",
        home / ".local" / "share" / "fnm" / "node-versions",
    ]
    for d in extra_dirs:
        cand = d / cli
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return None


def build_friend_identity_pack(store: EchoStore, wxid: str, sample_n: int = 80) -> str:
    """Build a dense markdown pack focused on extracting WHO this person is.

    Used as input to claude/codex for identity inference.
    Output structure: contact basics + 80 sampled text messages + a focused identity prompt.
    """
    contact = store.contact(wxid)
    msgs = list(store.messages(wxid, text_only=True))
    if not msgs:
        return f"# {contact.display() or wxid}\n\n暂无消息。\n"

    # Sample messages: distributed across time
    n_head = max(1, sample_n // 4)
    n_tail = max(1, sample_n // 4)
    n_mid = max(0, sample_n - n_head - n_tail)
    head = msgs[:n_head]
    tail = msgs[-n_tail:] if n_tail else []
    middle = msgs[n_head:len(msgs) - n_tail] if n_tail else msgs[n_head:]
    if n_mid > 0 and middle:
        step = max(1, len(middle) // n_mid)
        mid = middle[::step][:n_mid]
    else:
        mid = []

    name = contact.display() or wxid
    parts = [
        f"# 关于「{name}」是谁\n",
        f"> wxid: `{wxid}` · 备注: `{contact.remark or '-'}` · 昵称: `{contact.nick_name or '-'}` · 微信号: `{contact.alias or '-'}`\n",
        f"> 共 {len(msgs)} 条文字消息，时间跨度 {(msgs[-1].create_time - msgs[0].create_time) // 86400} 天",
        "",
        "## 抽样对话（双向）\n",
    ]
    for m in head + mid + tail:
        who = "你" if m.sender_wxid == "self" else m.sender_name
        date = datetime.fromtimestamp(m.create_time, CST).strftime("%Y-%m-%d")
        parts.append(f"- `[{date}]` **{who}**: {m.text[:160]}")
    parts.append("\n---\n")
    parts.append("## 任务：从上面的对话推断这个人的基本身份\n")
    parts.append("```")
    parts.append("你是一个观察细致的社交分析师。请仅基于上方对话的内容，推断这个人的：\n")
    parts.append("1. **可能的真实姓名 / 称呼**（备注/昵称暗示了什么？）")
    parts.append("2. **大致年龄 / 人生阶段**（学生 / 工作几年 / 已婚 / 退休 等）")
    parts.append("3. **职业 / 学校 / 行业**")
    parts.append("4. **居住地 / 常去的城市**")
    parts.append("5. **与你的关系**（同学 / 同事 / 朋友 / 亲属 / 网友 / 暧昧 等）")
    parts.append("6. **个性侧写**（外向/内向、表达型/沉默型、情绪稳定 等）")
    parts.append("7. **重要的生活线索**（恋爱状况、家人提及、健康问题、近期变化 等）\n")
    parts.append("**重要规则**：")
    parts.append("- 每个判断都要引用至少 1 条带日期的具体对话作为依据；")
    parts.append("- 拿不准的项就明确写「证据不足，无法判断」，不要编造；")
    parts.append("- 输出严格的 markdown 结构化报告，800-1500 字，中文。")
    parts.append("```\n")
    return "\n".join(parts)


def build_pair_inference_pack(store: EchoStore, wxid_a: str, wxid_b: str,
                               mentions: dict | None = None) -> str:
    """Build a pack for inferring how friend A and friend B know each other.

    Combines:
    - Identity samples for each
    - Mentions of B in chat with A (and vice versa)
    - Their group co-presence + mutual replies (if any)
    """
    contact_a = store.contact(wxid_a)
    contact_b = store.contact(wxid_b)
    name_a = contact_a.display() or wxid_a
    name_b = contact_b.display() or wxid_b

    parts = [
        f"# 朋友间关系推断：「{name_a}」 与 「{name_b}」\n",
        f"> 你是观察者。下方是关于这两个人的所有可证据，请推断**他们之间是什么关系**。\n",
    ]

    evidence = pair_direct_evidence(store, wxid_a, wxid_b)
    parts.append("## 直接证据门槛\n")
    if evidence["ok"]:
        parts.append("> 已找到至少一种直接证据，因此允许生成关系推断。直接证据包括：群内互相回复、你和一方聊到另一方、朋友圈互赞/互评。\n")
        for e in evidence["direct_edges"][:6]:
            bits = [f"类型={e.get('type')}", f"权重={e.get('weight')}"]
            if e.get("mention_count"):
                bits.append(f"提及={e.get('mention_count')}")
            if e.get("shared_group_count"):
                bits.append(f"共同群={e.get('shared_group_count')}")
            if e.get("moments_cross"):
                bits.append(f"朋友圈互动={e.get('moments_cross')}")
            parts.append("- " + "；".join(bits))
    else:
        parts.append("> **没有直接证据。不要推断他们认识。** 如果你仍看到这个包，结论必须是「证据不足」。\n")

    # Mentions data. Always rescan this exact pair so long-tail friends are not missed
    # by the global top-N mention cache used for graph ranking.
    try:
        rec = extract_pair_mentions_direct(store, wxid_a, wxid_b)
    except Exception:
        rec = {}
    if mentions:
        ab_key = f"{min(wxid_a, wxid_b)}__{max(wxid_a, wxid_b)}"
        cached_rec = mentions.get(ab_key) or {}
        if cached_rec.get("total_mentions", 0) > rec.get("total_mentions", 0):
            rec = cached_rec
    parts.append("## 提及证据：你和其中一人的私聊里，是否提到另一人\n")
    a_chat_mentions = rec.get(f"mentions_in_chat_with_{wxid_a}", 0)
    b_chat_mentions = rec.get(f"mentions_in_chat_with_{wxid_b}", 0)
    parts.append(f"- 你和 {name_a} 的私聊里提到「{name_b}」: **{a_chat_mentions}** 次")
    parts.append(f"- 你和 {name_b} 的私聊里提到「{name_a}」: **{b_chat_mentions}** 次")
    if rec.get("examples"):
        parts.append("- 样例：")
        for ex in rec["examples"][:8]:
            parts.append(f"  - `[{ex['date']}]` {ex['from']}: {ex['text'][:160]}")
    else:
        parts.append("- 未检测到明确名字提及；后续结论需要更多依赖群聊、朋友圈或各自私聊语境。")
    parts.append("")

    # Each side's basic profile (time-spread samples for context)
    for wxid, name in [(wxid_a, name_a), (wxid_b, name_b)]:
        msgs = list(store.messages(wxid, text_only=True))
        if not msgs:
            continue
        parts.append(f"## 你 ↔ {name} 对话样本（按时间分布）\n")
        parts.append("> 头部 + 中段 + 尾部抽样，避免只看早期或近期片段。\n")
        for m in _pick_spread(msgs, 28):
            who = "你" if m.sender_wxid == "self" else m.sender_name
            date = datetime.fromtimestamp(m.create_time, CST).strftime("%Y-%m-%d")
            parts.append(f"- `[{date}]` **{who}**: {m.text[:120]}")
        non_text_events = sample_non_text_events(store, wxid, limit=8)
        if non_text_events:
            parts.append("\n**非文本互动样本**：")
            for ev in non_text_events:
                parts.append(f"- `[{ev['date']}]` **{ev['from']}**: {ev['text'] or '[' + ev['type'] + ']'}")
        parts.append("")

    # === Group co-presence: actual A↔B interactions in shared groups ===
    # This is the heart of pair-relationship inference: how do they actually talk
    # to EACH OTHER (not to you) when they're in the same group?
    contacts_map = store.contacts()
    group_dialogues: list[dict] = []
    for s in store.sessions():
        if not s.is_group:
            continue
        try:
            ms = list(store.messages(s.username, text_only=True))
        except Exception:
            continue
        # Find indices where A or B spoke
        idxs = [i for i, m in enumerate(ms)
                 if m.sender_wxid in (wxid_a, wxid_b)]
        if len(idxs) < 2:
            continue  # they didn't both speak in this group
        # Need both A AND B to have spoken
        speakers_in_idxs = {ms[i].sender_wxid for i in idxs}
        if len(speakers_in_idxs) < 2:
            continue
        direct_turn_idxs: set[int] = set()
        direct_turn_count = 0
        recent_ab: list[tuple[int, Message]] = []
        for i, m in enumerate(ms):
            if m.sender_wxid not in (wxid_a, wxid_b):
                continue
            cutoff = m.create_time - 600
            recent_ab = [(j, pm) for j, pm in recent_ab if pm.create_time >= cutoff]
            prev = next((j for j, pm in reversed(recent_ab) if pm.sender_wxid != m.sender_wxid), None)
            if prev is not None:
                direct_turn_count += 1
                direct_turn_idxs.update([prev, i])
            recent_ab.append((i, m))

        # Pull rolling windows around direct A↔B turns first; if none, use spread samples
        # from all A-or-B utterances so the pack still explains co-presence.
        sample_idxs = _pick_spread_indices(sorted(direct_turn_idxs), 12) if direct_turn_idxs else _pick_spread_indices(idxs, 12)
        used = set()
        windows: list[list[int]] = []
        for k in sample_idxs:
            lo = max(0, k - 2)
            hi = min(len(ms), k + 3)
            window_idxs = [j for j in range(lo, hi) if j not in used]
            for j in window_idxs:
                used.add(j)
            if window_idxs:
                windows.append(window_idxs)
        if not windows:
            continue
        c = contacts_map.get(s.username)
        group_name = c.display() if c else s.username
        # Count A-vs-B turns in this group
        a_count = sum(1 for i in idxs if ms[i].sender_wxid == wxid_a)
        b_count = sum(1 for i in idxs if ms[i].sender_wxid == wxid_b)
        group_dialogues.append({
            "group": group_name,
            "a_count": a_count,
            "b_count": b_count,
            "direct_turn_count": direct_turn_count,
            "first_date": datetime.fromtimestamp(ms[idxs[0]].create_time, CST).strftime("%Y-%m-%d"),
            "last_date": datetime.fromtimestamp(ms[idxs[-1]].create_time, CST).strftime("%Y-%m-%d"),
            "windows": windows[:6],  # up to 6 dialogue windows per group
            "msgs": ms,
        })
    # Sort by interaction density (a_count + b_count, prefer balanced)
    group_dialogues.sort(key=lambda gd: -(gd["a_count"] + gd["b_count"]))
    if group_dialogues:
        parts.append("## 共同群聊概览\n")
        parts.append("> 这里使用完整群聊历史扫描，不再只截前 2000 条；直接接话指 10 分钟内 A/B 互相承接。\n")
        for gd in group_dialogues[:10]:
            parts.append(
                f"- 群「{gd['group']}」：{name_a} {gd['a_count']} 条，{name_b} {gd['b_count']} 条；"
                f"直接接话 {gd['direct_turn_count']} 次；跨度 {gd['first_date']} → {gd['last_date']}"
            )
        parts.append("")
        parts.append(f"## 群里 A↔B 真实对话（不经过你）\n")
        parts.append(
            "> **关键证据**：A 和 B 在你都在的群聊里**互相说话**的样本。"
            "每条消息都按通讯录里的备注/昵称显示（即使他们改了群昵称）。"
            "看他们之间的语气 / 是否互相 @ / 是否搭话能直接推断关系深度。\n"
        )
        for gd in group_dialogues[:5]:
            parts.append(
                f"\n### 群「{gd['group']}」（{name_a} 发言 {gd['a_count']} 条 · "
                f"{name_b} 发言 {gd['b_count']} 条 · 直接接话 {gd['direct_turn_count']} 次）"
            )
            ms = gd["msgs"]
            for window in gd["windows"]:
                first_ts = ms[window[0]].create_time
                date_s = datetime.fromtimestamp(first_ts, CST).strftime("%Y-%m-%d")
                parts.append(f"\n`[{date_s}]`")
                for k in window:
                    m = ms[k]
                    if m.sender_wxid == "self" or m.sender_wxid == store.me:
                        who = "你"
                    else:
                        c = contacts_map.get(m.sender_wxid)
                        who = (c.display() if c else m.sender_name)
                    marker = "→" if m.sender_wxid in (wxid_a, wxid_b) else " "
                    parts.append(f"{marker} **{who}**: {m.text[:160]}")
        parts.append("")
    else:
        parts.append("## 共同群聊证据\n")
        parts.append("- 未发现两人在同一个群里都发过言；朋友间关系推断需要主要依赖提及、朋友圈或各自私聊语境。\n")

    # === Friend-to-friend Moments interactions (independent evidence) ===
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import sns as _sns_mod
        ff = _sns_mod.friend_to_friend_signals(store.dir, store.me or "")
        key = tuple(sorted([wxid_a, wxid_b]))
        if key in ff:
            s = ff[key]
            tot = s["a_liked_b"] + s["a_commented_b"] + s["b_liked_a"] + s["b_commented_a"]
            if tot >= 1:
                parts.append(f"## 朋友圈互动（独立信号 · 不经过你）\n")
                parts.append(
                    f"- {name_a} 给 {name_b} 互动 {s['a_liked_b'] + s['a_commented_b'] if key[0] == wxid_a else s['b_liked_a'] + s['b_commented_a']} 次"
                )
                parts.append(
                    f"- {name_b} 给 {name_a} 互动 {s['b_liked_a'] + s['b_commented_a'] if key[0] == wxid_a else s['a_liked_b'] + s['a_commented_b']} 次"
                )
                if s.get("examples"):
                    parts.append("- 评论原文样本：")
                    for ex in s["examples"][:4]:
                        ex_date = datetime.fromtimestamp(ex.get("ts", 0), CST).strftime("%Y-%m-%d") if ex.get("ts") else "?"
                        from_name = name_a if ex.get("from_wxid") == wxid_a else name_b if ex.get("from_wxid") == wxid_b else ex.get("from_name", "对方")
                        to_name = name_a if ex.get("to_wxid") == wxid_a else name_b if ex.get("to_wxid") == wxid_b else "对方"
                        kind = "评论" if ex.get("type") == "comment" else "点赞"
                        text = ex.get("text") or "（无文字）"
                        parts.append(f"  - `[{ex_date}]` {from_name} → {to_name} {kind}: {text}")
                parts.append("")
    except Exception:
        pass

    parts.append("---\n")
    parts.append("## 任务\n")
    parts.append("```")
    parts.append(f"基于上方所有数据，推断「{name_a}」和「{name_b}」之间的关系。")
    parts.append("请输出 1800-2600 字的中文分析报告，必须结论先行、证据分层、不要偷懒。")
    parts.append("")
    parts.append("报告结构必须包含：")
    parts.append("")
    parts.append("1. **一句话结论** — 关系类型 + 关系强度 + 置信度。")
    parts.append("2. **证据矩阵** — 分别评价：名字提及、共同群聊、10 分钟内直接接话、朋友圈互动、各自与你的私聊背景、非文本互动。")
    parts.append("3. **他们怎么认识 / 主要交集场景** — 从群名、时间跨度、话题和语气推断，不确定就写不确定。")
    parts.append("4. **关系深度估计** — 不认识 / 认识但不熟 / 点头之交 / 同好或同学同事 / 会私下联系 / 真朋友。")
    parts.append("5. **关系图可视化摘要** — 给 UI 用的 4 行：`边类型`、`边强度 0-100`、`主要证据`、`风险提示`。")
    parts.append("6. **不能下结论的地方** — 明确列出缺失证据，避免过度推断。")
    parts.append("")
    parts.append("**严格规则**：")
    parts.append("- 每条结论必须引用至少 1 条带日期的样本或一个明确计数；")
    parts.append("- 如果名字提及次数是 0，不要因此草草结束，必须继续分析共同群聊、直接接话、朋友圈和各自私聊背景；")
    parts.append("- 不要把「你 ↔ A」或「你 ↔ B」的亲密度误写成「A ↔ B」的亲密度；只能作为弱背景证据；")
    parts.append("- 如果共同群里只是同场出现但没有互相接话，要把它标为弱证据；")
    parts.append("- 拿不准就直说「证据不足」，不要为了成稿编造；")
    parts.append("- 关注隐含线索：对方提到时的语气（亲昵/冷淡）、上下文（一起做事/吐槽/约见面）；")
    parts.append("- 最终结论要能直接服务关系网：这条边为什么存在、强不强、哪里可能误判。")
    parts.append("```\n")
    return "\n".join(parts)


def extract_friend_mentions(store: EchoStore, top_n: int = 50,
                             min_mention_count: int = 3) -> dict:
    """
    For each pair (A, B) of TOP friends, count how often B is mentioned in self↔A chat.
    This is the strongest possible signal of A-B relationship that LLM-chat alone can't infer:
    if you talk about B 12 times with A, A and B almost certainly know each other.

    Returns:
        {
            "(wxid_a, wxid_b)": {
                "count_in_a_chat": N,    # B mentioned in your chat with A
                "count_in_b_chat": M,    # A mentioned in your chat with B
                "examples_in_a": [...],  # up to 3 real msgs where B was mentioned in A's chat
                "examples_in_b": [...],
            }
        }

    Top friends only by default. Pass top_n <= 0 for all eligible private friends.
    """
    contacts = store.contacts()

    # Step 1: Identify top-N friends (private chat + decent activity)
    candidates = []
    for s in store.sessions():
        if s.is_group:
            continue
        cnt = fast_message_count(store, s.username)
        if cnt < 30:  # skip super-light contacts
            continue
        c = contacts.get(s.username)
        if not c:
            continue
        # Use a simple score (msgs) as proxy for "important enough to consider"
        candidates.append((s.username, c.display() or s.username, cnt))
    candidates.sort(key=lambda x: -x[2])
    top = candidates if top_n <= 0 else candidates[:top_n]
    top_wxids = {x[0] for x in top}

    name_to_wxids: dict[str, set[str]] = {}
    for wxid, _name, _ in top:
        c = contacts.get(wxid)
        if not c:
            continue
        for name in _mention_names_for_contact(c):
            name_to_wxids.setdefault(name, set()).add(wxid)

    # Step 3: For each top friend, scan their chat with self for mentions of other top friends
    mentions: dict[tuple[str, str], dict] = {}  # (a_wxid, b_wxid) → {count_in_a_chat, examples_in_a}
    for (a_wxid, a_name, _) in top:
        # Build a regex to match any "other friend's name" in this chat's text
        # Each name → wxid set; we record matches per name
        for m in store.messages(a_wxid, text_only=True):
            if not m.text:
                continue
            for name, target_wxids in name_to_wxids.items():
                if not _text_mentions_name(m.text, name):
                    continue
                for b_wxid in target_wxids:
                    if b_wxid == a_wxid:
                        continue
                    key = (a_wxid, b_wxid)
                    rec = mentions.setdefault(key, {"count_in_a_chat": 0, "examples_in_a": []})
                    rec["count_in_a_chat"] += 1
                    if len(rec["examples_in_a"]) < 3:
                        rec["examples_in_a"].append({
                            "ts": m.create_time,
                            "date": _ts_to_dt(m.create_time).strftime("%Y-%m-%d"),
                            "from": m.sender_name,
                            "text": m.text[:140],
                        })

    # Step 4: Symmetric merge — pair (A,B) gets data from both sides, then filter
    # by total mentions so 2+2 evidence is not thrown away by a one-direction threshold.
    result: dict[str, dict] = {}
    seen_pairs = set()
    for (a, b), rec_a in mentions.items():
        canonical = tuple(sorted([a, b]))
        if canonical in seen_pairs:
            continue
        seen_pairs.add(canonical)
        rec_b = mentions.get((b, a), {"count_in_a_chat": 0, "examples_in_a": []})
        total = rec_a["count_in_a_chat"] + rec_b["count_in_a_chat"]
        if total < min_mention_count:
            continue
        result[f"{canonical[0]}__{canonical[1]}"] = {
            "wxid_a": canonical[0],
            "wxid_b": canonical[1],
            "name_a": (contacts.get(canonical[0]).display() if contacts.get(canonical[0]) else canonical[0]),
            "name_b": (contacts.get(canonical[1]).display() if contacts.get(canonical[1]) else canonical[1]),
            f"mentions_in_chat_with_{canonical[0]}": rec_a["count_in_a_chat"] if a == canonical[0] else rec_b["count_in_a_chat"],
            f"mentions_in_chat_with_{canonical[1]}": rec_a["count_in_a_chat"] if a == canonical[1] else rec_b["count_in_a_chat"],
            "total_mentions": total,
            "examples": (rec_a.get("examples_in_a", []) + rec_b.get("examples_in_a", []))[:6],
        }
    return result


def build_relationship_graph(store: EchoStore, *,
                               scope: str = "private",
                               min_private: int = 10,
                               recent_days: int = 365,
                               top_n: int = 100,
                               show_clusters: bool = False) -> dict:
    """Build the relationship graph: nodes = people, edges with real interaction signals.

    scope filters:
      "private" (default) — Only people you have a 1-on-1 with msg_count >= min_private,
                            OR who you've been recently active with (last `recent_days`).
                            Strangers from groups are dropped. <= ~115 nodes for typical user.
      "recent"            — Same as private but with stricter recent_days threshold.
      "all"               — Everyone who appeared anywhere (the old behavior, ~575+ nodes).

    Edge types:
    - private: self ↔ each friend you have a 1-on-1 with (weight = msg count)
    - co_group: friend ↔ friend who appear in same group (lightest signal)
    - mutual_reply: friend A replied to friend B's group msg within 5 min (real interaction)

    Also nodes carry: msgs_in_groups (their public activity), sns_interaction (Moments back/out)
    """
    contacts = store.contacts()
    sessions = store.sessions()

    # Step 1: For each group, scan messages to find:
    #   (a) which wxids spoke (active members)
    #   (b) mutual replies — who replied to whom within 5 min
    group_members: dict[str, set[str]] = {}
    group_msg_count: dict[str, dict[str, int]] = {}  # group → {wxid: msg count}
    mutual_reply: dict[tuple[str, str], int] = {}  # (a,b) sorted → reply count

    # Track per-pair, per-group counts so we can dampen large-group noise after collection.
    mutual_reply_per_group: dict[str, dict[tuple[str, str], int]] = {}

    for s in sessions:
        if not s.is_group:
            continue
        senders: set[str] = set()
        per_user: dict[str, int] = {}
        prev_msgs: list[tuple[int, str]] = []
        per_group_pairs: dict[tuple[str, str], int] = {}

        for m in store.messages(s.username, text_only=False):
            if m.sender_wxid == "self" or not m.sender_wxid:
                continue
            senders.add(m.sender_wxid)
            per_user[m.sender_wxid] = per_user.get(m.sender_wxid, 0) + 1

            cutoff = m.create_time - 300  # 5 min
            prev_msgs = [(t, w) for t, w in prev_msgs if t >= cutoff]
            for t, prev_wxid in prev_msgs:
                if prev_wxid != m.sender_wxid:
                    a, b = sorted([m.sender_wxid, prev_wxid])
                    per_group_pairs[(a, b)] = per_group_pairs.get((a, b), 0) + 1
            prev_msgs.append((m.create_time, m.sender_wxid))

        if senders:
            group_members[s.username] = senders
            group_msg_count[s.username] = per_user
            mutual_reply_per_group[s.username] = per_group_pairs

    # Aggregate mutual_reply with size-aware dampening.
    # Big groups (50+ members) inflate co-presence noise: 2 random people in a 200-person
    # group will cross paths often. Cap each group's contribution by a logarithmic factor.
    import math
    for gname, pair_counts in mutual_reply_per_group.items():
        size = len(group_members.get(gname, ()))
        # Damp factor: 1.0 for ≤10 members, fades to ~0.3 for 200+ members.
        damp = 1.0 if size <= 10 else max(0.3, 10 / size)
        # Also cap each individual pair's contribution to keep the strongest groups from dominating
        per_pair_cap = max(20, 200 // max(1, size // 10))
        for pair, n in pair_counts.items():
            contribution = min(n, per_pair_cap) * damp
            mutual_reply[pair] = mutual_reply.get(pair, 0) + contribution
    # Round (was floats now)
    mutual_reply = {p: int(round(v)) for p, v in mutual_reply.items() if v >= 1}

    # Step 2: Private chat strengths
    private_strength: dict[str, int] = {}
    for s in sessions:
        if s.is_group:
            continue
        cnt = fast_message_count(store, s.username)
        if cnt > 0:
            private_strength[s.username] = cnt

    # Step 4: Aggregate per-person group activity
    msgs_in_groups: dict[str, int] = {}
    groups_per_friend: dict[str, int] = {}
    for g, per_user in group_msg_count.items():
        for w, n in per_user.items():
            msgs_in_groups[w] = msgs_in_groups.get(w, 0) + n
            groups_per_friend[w] = groups_per_friend.get(w, 0) + 1

    # Step 5: Pull SNS (Moments) signals
    sns_per_friend = get_sns_signals_cached(store)

    # Step 5b: Friend-to-friend mention extraction (deep relationship inference)
    # When you and A talk about B, that's the strongest evidence A↔B know each other.
    try:
        # If the graph asks for all nodes (top_n <= 0), also scan all eligible private
        # friends for mention edges. Otherwise match the graph's visible candidate scale
        # while keeping a floor of 50 so small graphs still get useful cross-links.
        mention_top_n = 0 if top_n <= 0 else max(50, top_n)
        mention_pairs = get_friend_mentions_cached(store, top_n=mention_top_n, min_mention_count=3)
    except Exception as e:
        sys.stderr.write(f"[mentions] failed: {e}\n")
        mention_pairs = {}

    # Step 5c: Friend-to-friend Moments interactions (A liked/commented B's post — without you).
    # Strong independent evidence of A↔B relationship. Cached: scanning SnsTimeLine
    # is the slowest part of build_relationship_graph (~5s on a typical user).
    if _FF_MOMENTS_CACHE["data"] is not None and (_time.time() - _FF_MOMENTS_CACHE["ts"]) < _CACHE_TTL:
        ff_moments = _FF_MOMENTS_CACHE["data"]
    else:
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import sns as _sns_mod
            ff_moments = _sns_mod.friend_to_friend_signals(store.dir, store.me or "")
            _FF_MOMENTS_CACHE["data"] = ff_moments
            _FF_MOMENTS_CACHE["ts"] = _time.time()
        except Exception as e:
            sys.stderr.write(f"[ff_moments] failed: {e}\n")
            ff_moments = {}

    # Step 6: Build nodes — apply scope filter to keep graph focused
    now_ts = datetime.now(CST).timestamp()
    sessions_by_wxid = {s.username: s for s in store.sessions()}
    cutoff = now_ts - recent_days * 86400

    def keep_wxid(w: str) -> bool:
        if w == store.me:
            return False
        if w not in contacts:
            return False
        c = contacts[w]
        # **Filter out chatroom strangers** (people you've never added) — addresses
        # 用户的「不要把我没有的好友列进去」complaint.
        if not c.is_real_friend:
            return False
        priv = private_strength.get(w, 0)
        if scope == "all":
            return True
        if priv >= min_private:
            return True
        if priv > 0:
            s = sessions_by_wxid.get(w)
            if s and s.last_timestamp >= cutoff:
                return True
        if scope == "recent":
            return False
        # Also keep real friends with strong group activity (after dampening)
        if scope == "private":
            for (a, b), n in mutual_reply.items():
                if (a == w or b == w) and n >= 100:
                    return True
        return False

    candidate_wxids: set[str] = set(private_strength.keys())
    if scope == "all":
        for members in group_members.values():
            candidate_wxids.update(members)
    all_wxids = {w for w in candidate_wxids if keep_wxid(w)}

    # Compute combined "weight" per friend = private + group_activity + moments_interaction
    nodes = []
    nodes.append({
        "id": "self", "wxid": store.me or "self", "name": "你",
        "is_self": True, "tier": "self", "size": 100,
        "private_msgs": 0, "group_msgs": 0, "groups": len(group_members),
        "moments_back": 0, "moments_out": 0,
    })
    for w in sorted(all_wxids):
        if w == store.me:
            continue
        c = contacts.get(w)
        priv = private_strength.get(w, 0)
        gmsgs = msgs_in_groups.get(w, 0)
        ngroups = groups_per_friend.get(w, 0)
        sns = sns_per_friend.get(w, {}) if sns_per_friend else {}
        moments_back = (sns.get("they_liked_you", 0) + sns.get("they_commented_you", 0))
        moments_out = (sns.get("you_liked_them", 0) + sns.get("you_commented_them", 0))

        # Combined cross-context weight — this is the new "true closeness" score
        combined = (
            priv +                     # private chat (strong signal)
            gmsgs * 0.3 +              # group activity (weaker per-msg signal)
            ngroups * 50 +             # being in many shared groups
            moments_back * 30 +        # they engage with your Moments
            moments_out * 30           # you engage with theirs
        )

        # Tier from combined score (more nuanced than before)
        if combined >= 4000 or (priv >= 1500 and (moments_back + moments_out) >= 5):
            tier = "A"   # 老朋友 / 真朋友
        elif combined >= 1500 or priv >= 800 or ngroups >= 5:
            tier = "B"   # 常聊
        elif combined >= 400 or priv >= 100 or ngroups >= 2:
            tier = "C"
        elif combined >= 50 or priv > 0 or ngroups >= 1:
            tier = "D"
        else:
            tier = "E"
        size = max(8, min(60, int(combined ** 0.4)))
        nodes.append({
            "id": w, "wxid": w,
            "name": (c.display() if c else w),
            "is_self": False, "tier": tier, "size": size,
            "private_msgs": priv, "group_msgs": gmsgs, "groups": ngroups,
            "moments_back": moments_back, "moments_out": moments_out,
            "combined_score": round(combined),
        })

    # Cap nodes before constructing edges. Edges never influence node scoring, so this
    # keeps large groups from generating thousands of pairs that the final top-N filter
    # would throw away anyway.
    self_node = next((n for n in nodes if n.get("is_self")), None)
    other_nodes = [n for n in nodes if not n.get("is_self")]
    other_nodes.sort(key=lambda n: -n.get("combined_score", 0))
    if top_n > 0:
        other_nodes = other_nodes[:top_n]
    nodes = ([self_node] if self_node else []) + other_nodes
    node_id_set = {n["id"] for n in nodes}

    # Step 7: Edges
    edges = []
    edge_index: dict[tuple[str, str], dict] = {}

    def _pair_key(a: str, b: str) -> tuple[str, str]:
        return tuple(sorted([a, b]))

    def _add_edge(edge: dict) -> dict:
        edges.append(edge)
        if edge["source"] != "self" and edge["target"] != "self":
            edge_index[_pair_key(edge["source"], edge["target"])] = edge
        return edge

    # private (self ↔ friend)
    for w, cnt in private_strength.items():
        if w == store.me:
            continue
        if w not in node_id_set:
            continue
        _add_edge({"source": "self", "target": w, "type": "private", "weight": cnt})

    # mutual_reply (HIGH-VALUE: real friend-to-friend interaction in groups)
    for (a, b), n in mutual_reply.items():
        if a == store.me or b == store.me or a not in contacts or b not in contacts:
            continue
        if a not in node_id_set or b not in node_id_set:
            continue
        if n < 3:
            continue  # filter out trivial co-presence
        _add_edge({
            "source": a, "target": b, "type": "mutual_reply", "weight": n,
        })

    # mention edges (when YOU and A talked ABOUT B — strongest LLM-inferable signal of A↔B)
    for pair_key, rec in mention_pairs.items():
        a, b = rec["wxid_a"], rec["wxid_b"]
        cnt = rec["total_mentions"]
        if a not in node_id_set or b not in node_id_set:
            continue
        # If pair already has mutual_reply edge: ATTACH mention_count instead of dropping
        existing = edge_index.get(_pair_key(a, b))
        if existing is not None:
            existing["mention_count"] = cnt
            continue
        # Else add mention edge
        weight = min(1.0, cnt / 30.0)
        _add_edge({
            "source": a, "target": b, "type": "mention", "weight": weight,
            "mention_count": cnt,
        })

    # Co-group edges (light signal — same group). Build this after top-N selection
    # so large groups only produce pairs that can actually be rendered.
    co_group: dict[tuple[str, str], list[str]] = {}
    for group_username, members in group_members.items():
        members_list = sorted(w for w in members if w in node_id_set and w != "self")
        for i in range(len(members_list)):
            for j in range(i + 1, len(members_list)):
                co_group.setdefault((members_list[i], members_list[j]), []).append(group_username)

    # co_group (light: just same group, no actual interaction)
    for (a, b), groups in co_group.items():
        if a == store.me or b == store.me:
            continue
        if len(groups) < 2:
            continue
        # Attach to existing edge if any (so mutual_reply also shows shared_group_count)
        existing = edge_index.get(_pair_key(a, b))
        if existing is not None:
            existing["shared_group_count"] = len(groups)
            continue
        _add_edge({
            "source": a, "target": b, "type": "co_group",
            "shared_group_count": len(groups), "weight": len(groups),
        })

    # moments_cross — A and B interacted on each other's Moments (strong evidence,
    # entirely independent of your private/group chats).
    for (a, b), s in ff_moments.items():
        if a == store.me or b == store.me or a not in contacts or b not in contacts:
            continue
        if a not in node_id_set or b not in node_id_set:
            continue
        total = s["a_liked_b"] + s["a_commented_b"] + s["b_liked_a"] + s["b_commented_a"]
        if total < 2:
            continue
        # If pair already has another edge, augment its meta (and keep the edge)
        existing = edge_index.get(_pair_key(a, b))
        if existing is not None:
            existing["moments_cross"] = total
            continue
        # Otherwise add a new edge of type moments_cross
        _add_edge({
            "source": a, "target": b, "type": "moments_cross",
            "weight": min(1.0, total / 30.0),
            "moments_cross": total,
            "moments_a_to_b": s["a_liked_b"] + s["a_commented_b"],
            "moments_b_to_a": s["b_liked_a"] + s["b_commented_a"],
        })

    # Drop edges to filtered-out nodes as a final defensive pass.
    edges = [e for e in edges
             if e["source"] in node_id_set and e["target"] in node_id_set]

    # Clusters — only render if explicitly requested. Default off to reduce visual noise.
    clusters = []
    if show_clusters:
        for gname, members in group_members.items():
            kept = [m for m in members if m in node_id_set]
            if len(kept) < 2:
                continue
            c = contacts.get(gname)
            clusters.append({
                "id": gname,
                "label": (c.display() if c else gname),
                "members": kept + ["self"],
            })
        clusters.sort(key=lambda c: -len(c["members"]))
        clusters = clusters[:8]

    return {
        "nodes": nodes,
        "edges": edges,
        "clusters": clusters,
        "stats": {
            "total_people": len(nodes) - 1,
            "total_edges": len(edges),
            "private_count": len(private_strength),
            "groups": len(group_members),
            "scope": scope,
            "filters": {"min_private": min_private, "recent_days": recent_days},
        },
    }


def _detect_local_agents() -> list[dict]:
    """Detect installed AI CLIs that Murmur can actually invoke safely."""
    candidates = [
        ("claude", "Claude Code", "anthropic"),
        ("codex", "Codex CLI", "openai"),
    ]
    found = []
    for cli, name, vendor in candidates:
        path = _which(cli)
        if not path:
            continue
        try:
            # On Windows .cmd needs shell=True; on POSIX direct invocation works
            use_shell = sys.platform.startswith("win") and path.lower().endswith((".cmd", ".bat", ".ps1"))
            cmd = f'"{path}" --version' if use_shell else [path, "--version"]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=5,
                               encoding="utf-8", errors="replace", shell=use_shell)
            version = (r.stdout or r.stderr or "").strip().split("\n")[0][:80]
            if r.returncode == 0 or version:
                found.append({"cli": cli, "name": name, "vendor": vendor,
                              "version": version, "path": path})
        except (subprocess.TimeoutExpired, OSError):
            pass
    return found


def _run_server(args) -> int:
    # Bootstrap-mode-aware: if no decrypted data, start server anyway with store=None
    # so the onboarding endpoints (/api/info, /api/diagnose, /api/save-key,
    # /api/extract-key, /api/refresh, /api/agents) can guide the user to decrypt.
    # Other endpoints return 503 until store loads.
    data_dir = Path(args.data_dir) if args.data_dir else discover_data_dir()
    store: Optional[EchoStore] = None
    if data_dir and data_dir.exists():
        try:
            store = EchoStore(data_dir)
        except Exception as e:
            sys.stderr.write(f"[etcli serve] EchoStore init failed: {e} — starting in bootstrap mode\n")
    else:
        sys.stderr.write(
            "[etcli serve] no decrypted data found — running in bootstrap mode "
            "(onboarding endpoints only). Frontend will guide you to provide a key.\n"
        )
    if store is not None:
        _MurmurAPIHandler._set_wechat_store(store)
    else:
        _MurmurAPIHandler.store = None
    if args.export_dir:
        _MurmurAPIHandler.export_dir = Path(args.export_dir)

    addr = (args.host, args.port)
    # ThreadingHTTPServer: each request in its own thread → batch_analyze.py and the
    # frontend don't block each other. Without this, hammering the serve while a
    # heavy /api/friend-pair-pack runs makes /api/info take seconds.
    httpd = ThreadingHTTPServer(addr, _MurmurAPIHandler)
    sys.stderr.write(f"[etcli serve] Murmur API listening on http://{args.host}:{args.port}/\n")
    if store is not None:
        sys.stderr.write(f"  data_dir   : {store.dir}\n")
        sys.stderr.write(f"  self wxid  : {store.me}\n")
    else:
        sys.stderr.write(f"  data_dir   : (none yet — bootstrap mode)\n")
    sys.stderr.write(f"  export dir : {_MurmurAPIHandler.export_dir}\n")

    # Pre-warm caches in a background thread. Tries disk first (instant if previously
    # computed), falls back to recompute (~10s) which then gets saved to disk too.
    def _prewarm():
        if store is None:
            return  # bootstrap mode — nothing to pre-warm
        try:
            t0 = _time.time()
            for scope, top_n in [("private", 100), ("all", 600)]:
                ck = _graph_cache_key(scope, 10, 365, top_n, False)
                disk = _disk_load(ck)
                if disk:
                    _GRAPH_CACHE[ck] = (disk["_ts"], disk["_payload"])
                    sys.stderr.write(f"[etcli serve] [{ck}] hot from disk\n")
                else:
                    sys.stderr.write(f"[etcli serve] [{ck}] computing…\n")
                    with _STORE_READ_LOCK:
                        g = build_relationship_graph(store, scope=scope, top_n=top_n)
                    _GRAPH_CACHE[ck] = (_time.time(), g)
                    _disk_save(ck, g)
            # home_summary
            disk_h = _disk_load("home_summary")
            if disk_h:
                _HOME_SUMMARY_CACHE["data"] = disk_h["_payload"]
                _HOME_SUMMARY_CACHE["ts"] = disk_h["_ts"]
            else:
                hs = home_summary(store)
                _HOME_SUMMARY_CACHE["data"] = hs
                _HOME_SUMMARY_CACHE["ts"] = _time.time()
                _disk_save("home_summary", hs)
            sys.stderr.write(f"[etcli serve] pre-warm done in {_time.time()-t0:.1f}s\n")
        except Exception as e:
            sys.stderr.write(f"[etcli serve] pre-warm failed: {e}\n")

    import threading
    threading.Thread(target=_prewarm, daemon=True).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\n[etcli serve] stopped.\n")
    return 0


if __name__ == "__main__":
    main()
