"""Tests for cli/chat_view.py (paged chat history behind GET /api/chat/messages).

Synthetic, unencrypted WeChat 4.x DBs; no third-party deps.
"""
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import chat_view as cv  # noqa: E402
from etcli import EchoStore  # noqa: E402

CST = timezone(timedelta(hours=8))
ME = "wxid_me"
ALICE = "wxid_alice"
BOB = "wxid_bob"
GROUP = "777@chatroom"
IMG_OK = "a" * 32
IMG_MISSING = "b" * 32
VID_OK = "c" * 32


def ts(day: str, hour: int = 12, minute: int = 0) -> int:
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=CST).timestamp()) + hour * 3600 + minute * 60


def table_for(username: str) -> str:
    return f"Msg_{hashlib.md5(username.encode()).hexdigest()}"


def make_msg_db(path: Path, names: list) -> sqlite3.Connection:
    c = sqlite3.connect(str(path))
    c.execute("CREATE TABLE IF NOT EXISTS Name2Id (user_name TEXT)")
    for n in names:
        c.execute("INSERT INTO Name2Id(user_name) VALUES (?)", (n,))
    return c


def add_msg(c, username, sender, when, text, mtype=1):
    t = table_for(username)
    c.execute(f"CREATE TABLE IF NOT EXISTS {t} (local_id INTEGER PRIMARY KEY AUTOINCREMENT, "
              "server_id INTEGER, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, "
              "message_content TEXT, compress_content BLOB)")
    sid = c.execute("SELECT rowid FROM Name2Id WHERE user_name = ?", (sender,)).fetchone()[0]
    c.execute(f"INSERT INTO {t} (server_id, local_type, real_sender_id, create_time, message_content) "
              "VALUES (?,?,?,?,?)", (None, mtype, sid, when, text))


def build_fixture(root: Path) -> Path:
    d = root / ME
    d.mkdir()
    c = sqlite3.connect(str(d / "session.db"))
    c.execute("CREATE TABLE SessionTable (username TEXT, last_timestamp INTEGER, summary TEXT)")
    for u in (ALICE, BOB, GROUP):
        c.execute("INSERT INTO SessionTable VALUES (?, ?, '')", (u, ts("2024-06-01")))
    c.commit()
    c.close()
    c = sqlite3.connect(str(d / "contact.db"))
    c.execute("CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, alias TEXT, local_type INTEGER)")
    c.execute("CREATE TABLE chat_room (username TEXT)")
    c.executemany("INSERT INTO contact VALUES (?,?,?,?,?)", [
        (ALICE, "爱丽丝", "alice", "", 1),
        (BOB, "", "Bob", "", 1),
        (GROUP, "", "周末饭局", "", 2),
    ])
    c.execute("INSERT INTO chat_room VALUES (?)", (GROUP,))
    c.commit()
    c.close()

    # message_0.db: Alice, 2024-01 .. 2024-03 (10 messages, two share a second
    # with a row in message_1.db to exercise the cross-DB tie-break).
    c = make_msg_db(d / "message_0.db", [ME, ALICE, BOB])
    for i in range(6):
        add_msg(c, ALICE, ALICE if i % 2 == 0 else ME, ts("2024-01-05", 9, i), f"一月消息 {i}")
    add_msg(c, ALICE, ALICE, ts("2024-02-10"), f'<msg><img md5="{IMG_OK}" length="1"/></msg>', mtype=3)
    add_msg(c, ALICE, ME, ts("2024-02-10", 12, 1), f'<msg><img md5="{IMG_MISSING}"/></msg>', mtype=3)
    add_msg(c, ALICE, ALICE, ts("2024-02-11"), f'<msg><videomsg md5="{VID_OK}" length="9"/></msg>', mtype=43)
    add_msg(c, ALICE, ME, ts("2024-03-01"), "同一秒 A")
    # Group chat lives in message_0.db too.
    add_msg(c, GROUP, BOB, ts("2024-04-01"), f"{BOB}:\n周末去哪吃")
    add_msg(c, GROUP, ME, ts("2024-04-01", 12, 5), f"{ME}:\n我订了位置")
    add_msg(c, GROUP, BOB, ts("2024-04-01", 12, 6), "你邀请Bob加入了群聊", mtype=10000)
    add_msg(c, GROUP, ME, ts("2024-04-01", 12, 7), "<sysmsg><revokemsg>你撤回了一条消息</revokemsg></sysmsg>",
            mtype=10002)
    link = ("<msg><appmsg><title>火锅店推荐</title><des>超好吃</des><type>5</type></appmsg></msg>")
    add_msg(c, GROUP, BOB, ts("2024-04-02"), f"{BOB}:\n{link}", mtype=(5 << 32) | 49)
    c.commit()
    c.close()

    # message_1.db: rolled-over DB, same Alice table.
    c = make_msg_db(d / "message_1.db", [ME, ALICE])
    add_msg(c, ALICE, ALICE, ts("2024-03-01"), "同一秒 B")   # same second as "同一秒 A"
    add_msg(c, ALICE, ALICE, ts("2024-05-20"), "五月 1")
    c.commit()
    c.close()
    return d


ALICE_TEXTS = [f"一月消息 {i}" for i in range(6)] + ["[image]", "[image]", "[video]",
                                                     "同一秒 A", "同一秒 B", "五月 1"]


class ChatViewBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="murmur-chat-view-"))
        self.store = EchoStore(build_fixture(self.tmp))
        src = self.tmp / "img.jpg"
        src.write_bytes(b"\xff\xd8\xff")
        self.media_index = self.tmp / "media-index.json"
        self.media_index.write_text(json.dumps({
            IMG_OK: {"kind": "image", "source_path": str(src), "exists": True},
            VID_OK: {"kind": "video", "source_path": str(src), "exists": True},
        }), encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def page(self, chat=ALICE, **kw):
        kw.setdefault("media_index_path", self.media_index)
        return cv.chat_page(self.store, chat, **kw)


class CursorTest(unittest.TestCase):
    def test_round_trip_and_errors(self) -> None:
        key = (1700000000, "message_0.db", 42)
        self.assertEqual(cv.parse_cursor(cv.format_cursor(key)), key)
        self.assertEqual(cv.parse_cursor("5:6:odd:name.db"), (5, "odd:name.db", 6))
        for bad in ("", "1:2", "x:1:message_0.db", "1:y:message_0.db", "1:2:../x.db", "1:2:a\\b"):
            with self.assertRaises(ValueError):
                cv.parse_cursor(bad)


class EchoPagingTest(ChatViewBase):
    def test_latest_page_and_meta(self) -> None:
        r = self.page(limit=4)
        self.assertEqual([m["text"] for m in r["messages"]], ALICE_TEXTS[-4:])
        self.assertTrue(r["has_more_before"])
        self.assertFalse(r["has_more_after"])
        self.assertIsNone(r["anchor"])
        chat = r["chat"]
        self.assertEqual(chat["name"], "爱丽丝")
        self.assertFalse(chat["is_group"])
        self.assertEqual(chat["count"], len(ALICE_TEXTS))
        self.assertEqual(chat["first_ts"], ts("2024-01-05", 9, 0))
        self.assertEqual(chat["last_ts"], ts("2024-05-20"))
        last = r["messages"][-1]
        self.assertEqual(last["from_id"], ALICE)
        self.assertEqual(last["from"], "爱丽丝")
        self.assertTrue(last["id"].endswith(":message_1.db"))
        self.assertEqual(last["time"], "2024-05-20T12:00:00+08:00")

    def test_walk_back_covers_everything_once(self) -> None:
        r = self.page(limit=3)
        seen = list(r["messages"])
        while r["has_more_before"]:
            r = self.page(before=seen[0]["id"], limit=3)
            self.assertNotIn("chat", r)  # only initial loads describe the chat
            seen = r["messages"] + seen
        self.assertEqual([m["text"] for m in seen], ALICE_TEXTS)
        self.assertEqual(len({m["id"] for m in seen}), len(seen))
        # Same-second rows across DBs: message_0.db sorts before message_1.db.
        a, b = seen[9], seen[10]
        self.assertEqual((a["text"], b["text"]), ("同一秒 A", "同一秒 B"))
        self.assertEqual(a["ts"], b["ts"])

    def test_walk_forward(self) -> None:
        first = self.page(at="0", limit=2)
        seen = list(first["messages"])
        self.assertEqual(first["anchor"], seen[0]["id"])
        more = first["has_more_after"]
        while more:
            r = self.page(after=seen[-1]["id"], limit=4)
            seen += r["messages"]
            more = r["has_more_after"]
        self.assertEqual([m["text"] for m in seen], ALICE_TEXTS)

    def test_around_existing_message(self) -> None:
        latest = self.page(limit=20)["messages"]
        target = latest[9]  # "同一秒 A" in message_0.db
        r = self.page(around=target["id"], limit=5)
        self.assertEqual(r["anchor"], target["id"])
        texts = [m["text"] for m in r["messages"]]
        self.assertIn("同一秒 A", texts)
        self.assertEqual(len(texts), 5)
        self.assertEqual(texts, ALICE_TEXTS[7:12])
        self.assertTrue(r["has_more_before"])
        self.assertFalse(r["has_more_after"])
        self.assertEqual(r["chat"]["count"], len(ALICE_TEXTS))

    def test_around_missing_cursor_anchors_next_message(self) -> None:
        r = self.page(around=f"{ts('2024-02-01')}:999:message_0.db", limit=4)
        self.assertEqual([m["text"] for m in r["messages"]],
                         ["一月消息 4", "一月消息 5", "[image]", "[image]"])
        anchor = next(m for m in r["messages"] if m["id"] == r["anchor"])
        self.assertEqual(anchor["ts"], ts("2024-02-10"))

    def test_at_date_and_past_the_end(self) -> None:
        r = self.page(at=ts("2024-03-01", 0), limit=6)
        anchor = next(m for m in r["messages"] if m["id"] == r["anchor"])
        self.assertEqual(anchor["text"], "同一秒 A")
        r = self.page(at=ts("2030-01-01"), limit=3)
        self.assertEqual([m["text"] for m in r["messages"]], ALICE_TEXTS[-3:])
        self.assertEqual(r["anchor"], r["messages"][-1]["id"])
        self.assertFalse(r["has_more_after"])

    def test_only_one_position_param(self) -> None:
        with self.assertRaises(ValueError):
            self.page(before="1:1:message_0.db", after="1:1:message_0.db")
        with self.assertRaises(ValueError):
            self.page(around="1:1:message_0.db", at=5)

    def test_limit_is_clamped(self) -> None:
        r = self.page(limit=0)
        self.assertEqual(len(r["messages"]), 1)
        r = self.page(limit=10_000)
        self.assertEqual(len(r["messages"]), len(ALICE_TEXTS))

    def test_media(self) -> None:
        msgs = self.page(limit=50)["messages"]
        by_text = [(m["type"], m["media"]) for m in msgs if m["media"]]
        self.assertEqual(by_text, [
            ("image", {"kind": "image", "url": f"/api/media/{IMG_OK}"}),
            ("image", {"kind": "image", "url": None}),
            ("video", {"kind": "video", "url": f"/api/media/{VID_OK}"}),
        ])
        self.assertIsNone(msgs[0]["media"])

    def test_media_index_missing_or_broken(self) -> None:
        r = self.page(limit=50, media_index_path=self.tmp / "nope.json")
        self.assertTrue(all(m["media"] is None or m["media"]["url"] is None for m in r["messages"]))
        self.media_index.write_text("{broken", encoding="utf-8")
        os.utime(self.media_index, ns=(1, 2))  # new mtime → cache refresh
        r = self.page(limit=50)
        self.assertTrue(all(m["media"] is None or m["media"]["url"] is None for m in r["messages"]))

    def test_group_senders_system_and_links(self) -> None:
        r = self.page(GROUP, limit=50)
        self.assertTrue(r["chat"]["is_group"])
        self.assertEqual(r["chat"]["name"], "周末饭局")
        rows = [(m["from_id"], m["from"], m["type"], m["text"]) for m in r["messages"]]
        self.assertEqual(rows[0], (BOB, "Bob", "text", "周末去哪吃"))
        self.assertEqual(rows[1], ("self", "你", "text", "我订了位置"))
        self.assertEqual(rows[2][2:], ("system", "你邀请Bob加入了群聊"))
        self.assertEqual(rows[3][2:], ("revoke", "你撤回了一条消息"))
        self.assertEqual(rows[4][2], "share")
        self.assertTrue(rows[4][3].startswith("[链接] 火锅店推荐"))

    def test_unknown_chat_is_empty(self) -> None:
        r = self.page("wxid_nobody", limit=10)
        self.assertEqual(r["messages"], [])
        self.assertFalse(r["has_more_before"])
        self.assertEqual(r["chat"]["count"], 0)
        self.assertIsNone(r["chat"]["first_ts"])

    def test_search_locator_opens_the_hit(self) -> None:
        import search_index as si
        old = os.environ.get("MURMUR_SEARCH_INDEX_DIR")
        os.environ["MURMUR_SEARCH_INDEX_DIR"] = str(self.tmp / "idx")
        try:
            idx = si.get_index(self.store, "wechat")
            idx.update()
            hit = idx.search("同一秒")["results"]
            hit = next(h for h in hit if "B" in h["snippet"])
            loc = hit["locator"]
            cursor = f"{hit['ts']}:{loc['local_id']}:{loc['db']}"
            r = self.page(around=cursor, limit=6)
            self.assertEqual(r["anchor"], cursor)
            anchor = next(m for m in r["messages"] if m["id"] == cursor)
            self.assertEqual(anchor["text"], "同一秒 B")
        finally:
            idx = si.get_index(self.store, "wechat")
            idx.wait(30)
            with si._REGISTRY_LOCK:
                si._REGISTRY.pop(str(idx.path), None)
            if old is None:
                os.environ.pop("MURMUR_SEARCH_INDEX_DIR", None)
            else:
                os.environ["MURMUR_SEARCH_INDEX_DIR"] = old


# ---------------------------------------------------------------- fallback

@dataclass
class _Msg:
    create_time: int
    sender_wxid: str
    sender_name: str
    msg_type: int
    text: str
    raw_type_label: str


class _Contact:
    def __init__(self, name):
        self.name = name

    def display(self):
        return self.name


class _ListStore:
    """Minimal QQStore-like store: messages() + contact() only."""

    def __init__(self, n):
        self.msgs = [_Msg(1000 + i // 2, "self" if i % 3 == 0 else "u1", "x", 1, f"m{i}", "text")
                     for i in range(n)]

    def messages(self, chat, text_only=False):
        return iter(self.msgs)

    def contact(self, chat):
        return _Contact("QQ 好友")


class FallbackStoreTest(unittest.TestCase):
    def test_paging_and_around(self) -> None:
        store = _ListStore(11)
        r = cv.chat_page(store, "u1", limit=4)
        self.assertEqual([m["text"] for m in r["messages"]], ["m7", "m8", "m9", "m10"])
        self.assertTrue(r["has_more_before"])
        self.assertEqual(r["chat"]["platform"], "qq")
        self.assertEqual(r["chat"]["count"], 11)
        seen = r["messages"]
        while r["has_more_before"]:
            r = cv.chat_page(store, "u1", before=seen[0]["id"], limit=4)
            seen = r["messages"] + seen
        self.assertEqual([m["text"] for m in seen], [f"m{i}" for i in range(11)])
        target = seen[5]["id"]
        r = cv.chat_page(store, "u1", around=target, limit=3)
        self.assertEqual(r["anchor"], target)
        self.assertEqual([m["text"] for m in r["messages"]], ["m4", "m5", "m6"])
        r = cv.chat_page(store, "u1", after=seen[8]["id"], limit=5)
        self.assertEqual([m["text"] for m in r["messages"]], ["m9", "m10"])
        self.assertFalse(r["has_more_after"])


# ---------------------------------------------------------------- HTTP

class HttpTest(ChatViewBase):
    def setUp(self) -> None:
        super().setUp()
        import etcli
        self.etcli = etcli
        H = etcli._MurmurAPIHandler
        self._saved = (H.store, H._wechat_store, H._active_platform, H._active_id)
        H.store = self.store
        H._wechat_store = self.store
        H._active_platform = "wechat"
        H._active_id = ME
        p = mock.patch.object(etcli._paths, "media_index_path", lambda *a, **k: self.media_index)
        p.start()
        self.addCleanup(p.stop)
        from http.server import ThreadingHTTPServer
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        H = self.etcli._MurmurAPIHandler
        H.store, H._wechat_store, H._active_platform, H._active_id = self._saved
        super().tearDown()

    def _get(self, path: str):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=30) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_endpoint(self) -> None:
        q = urllib.parse.quote
        code, r = self._get(f"/api/chat/messages?chat={q(ALICE)}&limit=2")
        self.assertEqual(code, 200)
        self.assertEqual([m["text"] for m in r["messages"]], ALICE_TEXTS[-2:])
        code, r2 = self._get(f"/api/chat/messages?chat={q(ALICE)}&before={q(r['messages'][0]['id'])}&limit=2")
        self.assertEqual([m["text"] for m in r2["messages"]], ALICE_TEXTS[-4:-2])
        code, r = self._get(f"/api/chat/messages?chat={q(ALICE)}&at=2024-02-10&limit=3")
        self.assertEqual(code, 200)
        anchor = next(m for m in r["messages"] if m["id"] == r["anchor"])
        self.assertEqual(anchor["media"], {"kind": "image", "url": f"/api/media/{IMG_OK}"})
        code, r = self._get(f"/api/chat/messages?chat={q(GROUP)}")
        self.assertEqual(code, 200)
        self.assertTrue(r["chat"]["is_group"])

    def test_bad_params(self) -> None:
        q = urllib.parse.quote
        self.assertEqual(self._get("/api/chat/messages")[0], 400)
        self.assertEqual(self._get(f"/api/chat/messages?chat={q(ALICE)}&before=nope")[0], 400)
        self.assertEqual(self._get(f"/api/chat/messages?chat={q(ALICE)}&at=someday")[0], 400)
        self.assertEqual(self._get(f"/api/chat/messages?chat={q(ALICE)}&limit=abc")[0], 400)
        code, body = self._get(f"/api/chat/messages?chat={q(ALICE)}&before=1:1:a.db&after=1:1:a.db")
        self.assertEqual(code, 400)
        self.assertEqual(body["error"], "bad_param")

    def test_gated_without_store(self) -> None:
        H = self.etcli._MurmurAPIHandler
        H.store = None
        orig = self.etcli.discover_data_dir
        self.etcli.discover_data_dir = lambda: None
        try:
            self.assertEqual(self._get(f"/api/chat/messages?chat={ALICE}")[0], 503)
        finally:
            self.etcli.discover_data_dir = orig
            H.store = self.store


if __name__ == "__main__":
    unittest.main()
