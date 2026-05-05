"""qq_store.py — QQNT decrypted-DB reader, EchoStore-compatible.

QQ data is shoehorned into the WeChat `EchoStore` shape so the rest of Murmur
(Home, Friend, Graph, Reports, Yearbook, AI agent) consumes it through the
exact same interface — no platform branches in the page code.

Shape translation:
    WeChat                        QQ
    --------------------------    --------------------------------
    wxid_xxx (private peer)   →   u_xxx                  (QQNT uid, stable)
    xxx@chatroom (group)      →   <group_number>@chatroom
    Contact.alias (微信号)    →   QQ number (numeric, e.g. "939919010")
    Contact.nick_name         →   QQNT nickname
    Contact.is_real_friend    →   uid present in buddy_list
    Message.sender_wxid       →   "self" if from me, else u_xxx
    Message.msg_type          →   WeChat code (1/3/34/43/47/49/10000/...)
    Message.text              →   rendered (parsed from Tencent Element protobuf)

Numeric column names used here are Tencent's internal protobuf field numbers,
reverse-engineered from real DBs — see schema notes inline.
"""
from __future__ import annotations

import hashlib
import sqlite3
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Iterator, Optional

CST = timezone(timedelta(hours=8))


# ---- EchoStore-shape dataclasses (mirror cli/etcli.py:Contact/Session/Message) ----

@dataclass
class Contact:
    username: str
    remark: str
    nick_name: str
    alias: str
    is_group: bool
    is_real_friend: bool = False

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
    create_time: int
    sender_wxid: str
    sender_name: str
    msg_type: int
    text: str
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


# ---- protobuf parser (just enough for QQNT message Elements) ----

# Tencent Element protobuf fields:
#   45001 id, 45002 type, 45101 text, 45402 fileName, 45906 voiceLen,
#   45410 videoLen, 47602 emojiText, 47901 applicationMessage, 48214 noticeInfo
# Element type values (45002):
#   1=text 2=image 3=file 4=voice 5=video 6=emoji 7=quote 8=notice
#   9=redpacket 10=app 21=call 26=feed

_QQ_TO_WX_TYPE = {
    1: 1, 2: 3, 3: 49, 4: 34, 5: 43, 6: 47, 7: 49,
    8: 10000, 9: 49, 10: 49, 21: 50, 26: 49,
}
_QQ_TYPE_LABEL = {
    1: "text", 3: "image", 34: "voice", 43: "video", 47: "emoji",
    49: "share", 50: "voip", 10000: "system",
}
_QQ_TYPE_STUB = {
    2: "[图片]", 3: "[文件]", 4: "[语音]", 5: "[视频]",
    7: "[引用]", 8: "[系统消息]", 9: "[红包]",
    10: "[应用消息]", 21: "[通话]", 26: "[动态]",
}


def _read_varint(buf: bytes, off: int) -> tuple[int, int]:
    v = 0
    shift = 0
    while True:
        b = buf[off]
        off += 1
        v |= (b & 0x7f) << shift
        if not (b & 0x80):
            return v, off
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def _iter_proto_fields(buf: bytes):
    off = 0
    L = len(buf)
    while off < L:
        try:
            tag, off = _read_varint(buf, off)
        except (IndexError, ValueError):
            return
        field_num = tag >> 3
        wire = tag & 7
        if wire == 0:
            try:
                v, off = _read_varint(buf, off)
            except (IndexError, ValueError):
                return
            yield field_num, wire, v
        elif wire == 1:
            if off + 8 > L: return
            yield field_num, wire, buf[off:off + 8]
            off += 8
        elif wire == 2:
            try:
                ln, off = _read_varint(buf, off)
            except (IndexError, ValueError):
                return
            if off + ln > L: return
            yield field_num, wire, buf[off:off + ln]
            off += ln
        elif wire == 5:
            if off + 4 > L: return
            yield field_num, wire, buf[off:off + 4]
            off += 4
        else:
            return


def _parse_element(elem_bytes: bytes) -> dict:
    out: dict[int, object] = {}
    for fn, wire, payload in _iter_proto_fields(elem_bytes):
        if wire == 2:
            try:
                out[fn] = payload.decode("utf-8")
            except UnicodeDecodeError:
                out[fn] = payload
        else:
            out[fn] = payload
    return out


def _render_content(type_tag: int, blob: Optional[bytes]) -> tuple[str, int, str]:
    """Return (text, wechat_msg_type, raw_label) by parsing the message_body protobuf."""
    if not blob:
        return "", 1, "text"
    parts: list[str] = []
    primary_qq_type = 1
    for fn, wire, payload in _iter_proto_fields(blob):
        if fn != 40800 or wire != 2:
            continue
        elem = _parse_element(payload)
        et_raw = elem.get(45002, 0)
        et = int(et_raw) if isinstance(et_raw, int) else 0
        if et == 1:
            txt = elem.get(45101, "")
            if isinstance(txt, str) and txt:
                parts.append(txt)
            primary_qq_type = 1
        elif et == 6:
            etxt = elem.get(47602, "")
            if isinstance(etxt, str) and etxt:
                parts.append(etxt)
            primary_qq_type = 6 if primary_qq_type == 1 else primary_qq_type
        elif et == 8:
            ntxt = elem.get(48214, "") or elem.get(48271, "")
            parts.append(ntxt if isinstance(ntxt, str) and ntxt else "[系统消息]")
            primary_qq_type = 8
        elif et == 10:
            atxt = elem.get(47901, "")
            parts.append(atxt[:200] if isinstance(atxt, str) and atxt else "[应用消息]")
            primary_qq_type = 10
        elif et in _QQ_TYPE_STUB:
            parts.append(_QQ_TYPE_STUB[et])
            primary_qq_type = et
        elif et != 0:
            parts.append(f"[type_{et}]")
            primary_qq_type = et
    wx_type = _QQ_TO_WX_TYPE.get(primary_qq_type, 1)
    label = _QQ_TYPE_LABEL.get(wx_type, f"type_{wx_type}")
    return "".join(parts), wx_type, label


# ---- store ----

GROUP_SUFFIX = "@chatroom"


def _is_group_username(u: str) -> bool:
    return u.endswith(GROUP_SUFFIX)


class QQStore:
    """EchoStore-compatible read-only access to a decrypted QQNT account.

    Layout: <decrypted_dir>/{nt_msg.db, profile_info.db, group_info.db, ...}

    The directory name is the QQ number ("939919010"). `me` here is the QQNT
    uid ("u_..."), looked up lazily from profile_info_v6.
    """

    def __init__(self, data_dir: Path, me: Optional[str] = None,
                 qq_number: Optional[str] = None):
        self.dir = Path(data_dir)
        if not (self.dir / "nt_msg.db").exists():
            raise FileNotFoundError(f"nt_msg.db not found in {self.dir}")
        self.qq = qq_number or self.dir.name
        self._contacts: Optional[dict[str, Contact]] = None
        self._sessions: Optional[list[Session]] = None
        self._self_uid_cached: Optional[str] = None
        self._index_cache: Optional[tuple[dict[str, int], dict[str, int]]] = None
        self._heat_cache: Optional[Counter] = None
        self._earliest_ts_cached: Optional[int] = None
        # Eagerly resolve self_uid so callers reading `.me` (e.g. /api/info)
        # see a value without having to first hydrate the contacts cache.
        # Pre-set me=None before calling _resolve_self_uid (it reads self.me).
        self.me = me
        if self.me is None:
            self.me = self._resolve_self_uid()

    # --- connection ---

    def _conn(self, fname: str) -> sqlite3.Connection:
        return sqlite3.connect(f"file:{(self.dir / fname).as_posix()}?mode=ro", uri=True)

    # --- self uid ---

    def _resolve_self_uid(self) -> str:
        if self._self_uid_cached is not None:
            return self._self_uid_cached
        c = self._conn("profile_info.db")
        try:
            try:
                qq_int = int(self.qq)
            except (TypeError, ValueError):
                qq_int = -1
            row = c.execute(
                'SELECT "1000" FROM profile_info_v6 WHERE "1002" = ? AND "1000" IS NOT NULL LIMIT 1',
                (qq_int,)
            ).fetchone()
            self._self_uid_cached = (row[0] if row and row[0] else self.qq)
        except sqlite3.Error:
            self._self_uid_cached = self.qq
        finally:
            c.close()
        if self.me is None:
            self.me = self._self_uid_cached
        return self._self_uid_cached or self.qq

    # --- contacts ---

    def contacts(self) -> dict[str, Contact]:
        if self._contacts is not None:
            return self._contacts
        out: dict[str, Contact] = {}
        c = self._conn("profile_info.db")
        try:
            buddy_uids = {r[0] for r in c.execute('SELECT "1000" FROM buddy_list').fetchall()
                          if r[0]}
            for row in c.execute(
                'SELECT "1000", "1002", "20002", "20009" FROM profile_info_v6'
            ).fetchall():
                uid, qq_num, nickname, _signature = row
                if not uid:
                    continue
                qq_str = str(qq_num) if qq_num else ""
                out[uid] = Contact(
                    username=uid,
                    remark="",
                    nick_name=(nickname or "").strip(),
                    alias=qq_str,
                    is_group=False,
                    is_real_friend=(uid in buddy_uids),
                )
            for uid in buddy_uids:
                if uid not in out:
                    out[uid] = Contact(
                        username=uid, remark="", nick_name="", alias="",
                        is_group=False, is_real_friend=True,
                    )
        finally:
            c.close()

        # Groups become contacts with `<num>@chatroom` username.
        try:
            c = self._conn("group_info.db")
            try:
                for row in c.execute(
                    'SELECT "60001", "60007", "60002", "60006" FROM group_detail_info_ver1'
                ).fetchall():
                    gnum, name, _owner_uid, _members = row
                    if gnum is None:
                        continue
                    gnum_s = str(gnum)
                    uname = f"{gnum_s}{GROUP_SUFFIX}"
                    out[uname] = Contact(
                        username=uname,
                        remark="",
                        nick_name=(name or "").strip() or f"群{gnum_s}",
                        alias=gnum_s,
                        is_group=True,
                        is_real_friend=False,
                    )
            finally:
                c.close()
        except sqlite3.Error:
            pass

        self._contacts = out
        # Make sure self.me is populated for downstream use
        self._resolve_self_uid()
        return out

    def contact(self, username: str) -> Contact:
        c = self.contacts().get(username)
        if c:
            return c
        return Contact(
            username=username, remark="", nick_name="", alias="",
            is_group=_is_group_username(username), is_real_friend=False,
        )

    # --- sessions ---

    def sessions(self) -> list[Session]:
        if self._sessions is not None:
            return self._sessions
        out: list[Session] = []
        contacts = self.contacts()
        c = self._conn("nt_msg.db")
        try:
            # c2c sessions: peer uid is in column 40021 (TEXT)
            for peer_uid, last_ts in c.execute(
                'SELECT "40021", MAX("40050") FROM c2c_msg_table '
                'WHERE "40021" IS NOT NULL GROUP BY "40021"'
            ).fetchall():
                if not peer_uid:
                    continue
                ct = contacts.get(peer_uid)
                summary = ct.display() if ct else peer_uid
                out.append(Session(
                    username=peer_uid,
                    last_timestamp=int(last_ts or 0),
                    summary=summary,
                    is_group=False,
                ))
            # group sessions: 40021 is the group number (TEXT)
            for gnum, last_ts in c.execute(
                'SELECT "40021", MAX("40050") FROM group_msg_table '
                'WHERE "40021" IS NOT NULL GROUP BY "40021"'
            ).fetchall():
                if not gnum:
                    continue
                uname = f"{gnum}{GROUP_SUFFIX}"
                ct = contacts.get(uname)
                summary = ct.display() if ct else f"群{gnum}"
                out.append(Session(
                    username=uname,
                    last_timestamp=int(last_ts or 0),
                    summary=summary,
                    is_group=True,
                ))
        finally:
            c.close()
        out.sort(key=lambda s: -s.last_timestamp)
        self._sessions = out
        return out

    # --- messages ---

    def message_count(self, username: str) -> int:
        is_group = _is_group_username(username)
        if is_group:
            table = "group_msg_table"
            peer_id = username[: -len(GROUP_SUFFIX)]
        else:
            table = "c2c_msg_table"
            peer_id = username
        c = self._conn("nt_msg.db")
        try:
            row = c.execute(
                f'SELECT COUNT(*) FROM {table} WHERE "40021" = ?', (peer_id,)
            ).fetchone()
            return int(row[0]) if row else 0
        finally:
            c.close()

    def messages(
        self,
        username: str,
        since: Optional[int] = None,
        until: Optional[int] = None,
        limit: Optional[int] = None,
        text_only: bool = False,
    ) -> Iterator[Message]:
        is_group = _is_group_username(username)
        peer_id = username[: -len(GROUP_SUFFIX)] if is_group else username
        table = "group_msg_table" if is_group else "c2c_msg_table"
        contacts = self.contacts()
        self_uid = self._resolve_self_uid()

        def resolve_name(uid: str, group_disp: Optional[str]) -> str:
            if uid == "self":
                return "你"
            if is_group and group_disp:
                return group_disp
            ct = contacts.get(uid)
            if ct:
                return ct.display()
            return f"~{uid[-6:]}" if uid and uid.startswith("u_") else (uid or "")

        wheres = ['"40021" = ?']
        params: list = [peer_id]
        if since is not None:
            wheres.append('"40050" >= ?')
            params.append(int(since))
        if until is not None:
            wheres.append('"40050" <= ?')
            params.append(int(until))
        sql = (f'SELECT "40001", "40020", "40050", "40005", "40800", "40090" '
               f'FROM {table} WHERE ' + " AND ".join(wheres) +
               ' ORDER BY "40050" ASC')

        c = self._conn("nt_msg.db")
        try:
            rows = c.execute(sql, params).fetchall()
        finally:
            c.close()

        out: list[Message] = []
        for msg_id, sender_uid, ts, type_tag, content_blob, group_disp in rows:
            if msg_id is None or ts is None:
                continue
            text, wx_type, label = _render_content(type_tag or 0, content_blob)
            if text_only and wx_type != 1:
                continue
            canonical = "self" if (sender_uid and sender_uid == self_uid) else (sender_uid or "")
            sender_name = resolve_name(canonical, group_disp)
            out.append(Message(
                create_time=int(ts),
                sender_wxid=canonical,
                sender_name=sender_name,
                msg_type=wx_type,
                text=text,
                raw_type_label=label,
            ))

        if limit:
            n = max(0, int(limit))
            out = out[-n:] if n else []
        for m in out:
            yield m


    # --- aggregations (mirror cli/etcli.py:build_msg_index/heat_monthly_via_sql/earliest_ts) ---

    def build_index(self) -> tuple[dict[str, int], dict[str, int]]:
        """Return (counts, last_ts) keyed by EchoStore-shape username.

        Mirrors etcli.build_msg_index's role for QQ. One pass over c2c_msg_table
        + group_msg_table is ~50ms even on busy accounts.
        """
        if self._index_cache is not None:
            return self._index_cache
        out_counts: dict[str, int] = {}
        out_last: dict[str, int] = {}
        c = self._conn("nt_msg.db")
        try:
            for peer, n, last in c.execute(
                'SELECT "40021", COUNT(*), MAX("40050") FROM c2c_msg_table '
                'WHERE "40021" IS NOT NULL GROUP BY "40021"'
            ).fetchall():
                if peer:
                    out_counts[peer] = int(n or 0)
                    out_last[peer] = int(last or 0)
            for gnum, n, last in c.execute(
                'SELECT "40021", COUNT(*), MAX("40050") FROM group_msg_table '
                'WHERE "40021" IS NOT NULL GROUP BY "40021"'
            ).fetchall():
                if gnum:
                    uname = f"{gnum}{GROUP_SUFFIX}"
                    out_counts[uname] = int(n or 0)
                    out_last[uname] = int(last or 0)
        finally:
            c.close()
        self._index_cache = (out_counts, out_last)
        return self._index_cache

    def heat_monthly(self) -> Counter:
        if self._heat_cache is not None:
            return self._heat_cache
        monthly: Counter = Counter()
        c = self._conn("nt_msg.db")
        try:
            for tbl in ("c2c_msg_table", "group_msg_table"):
                try:
                    rows = c.execute(
                        f"SELECT strftime('%Y-%m', datetime(\"40050\", 'unixepoch', '+8 hours')) AS m, "
                        f"COUNT(*) FROM {tbl} WHERE \"40050\" > 0 GROUP BY m"
                    ).fetchall()
                    for ym, cnt in rows:
                        if ym:
                            monthly[ym] += int(cnt or 0)
                except sqlite3.OperationalError:
                    continue
        finally:
            c.close()
        self._heat_cache = monthly
        return monthly

    def earliest_ts(self) -> int:
        if self._earliest_ts_cached is not None:
            return self._earliest_ts_cached
        earliest = 0
        c = self._conn("nt_msg.db")
        try:
            for tbl in ("c2c_msg_table", "group_msg_table"):
                try:
                    r = c.execute(
                        f'SELECT MIN("40050") FROM {tbl} WHERE "40050" > 0'
                    ).fetchone()
                    if r and r[0] and (earliest == 0 or r[0] < earliest):
                        earliest = int(r[0])
                except sqlite3.OperationalError:
                    continue
        finally:
            c.close()
        self._earliest_ts_cached = earliest
        return earliest


if __name__ == "__main__":
    decrypted_root = Path.home() / "Documents" / "Murmur" / "decrypted_qq" / "939919010"
    s = QQStore(decrypted_root)
    print(f"self uid: {s._resolve_self_uid()}")
    print(f"contacts: {len(s.contacts())}")
    print(f"sessions: {len(s.sessions())}")
    if s.sessions():
        sess = s.sessions()[0]
        print(f"top session: {sess.username} ({sess.summary}) ts={sess.last_timestamp}")
        print(f"  count: {s.message_count(sess.username)}")
        for m in list(s.messages(sess.username, limit=3)):
            print(f"  [{m.raw_type_label:8s}] {m.sender_name[:15]:15s}  {m.text[:60]}")
