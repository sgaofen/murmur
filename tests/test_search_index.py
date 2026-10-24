"""Tests for cli/search_index.py on synthetic (unencrypted) WeChat 4.x / QQ NT DBs.

No third-party deps: the zstd branch is exercised with a fake `zstandard`
module injected into sys.modules.
"""
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import types
import unittest
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import search_index as si  # noqa: E402
from etcli import EchoStore  # noqa: E402

CST = timezone(timedelta(hours=8))
ME = "wxid_me"
ALICE = "wxid_alice"
BOB = "wxid_bob"
GROUP = "123456@chatroom"


def ts(day: str, hour: int = 12) -> int:
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=CST).timestamp()) + hour * 3600


def table_for(username: str) -> str:
    return f"Msg_{hashlib.md5(username.encode()).hexdigest()}"


def bump_mtime(path: Path, step_ns: int = 5_000_000_000) -> None:
    st = os.stat(path)
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + step_ns))


def make_msg_db(path: Path, names: list[str]) -> sqlite3.Connection:
    c = sqlite3.connect(str(path))
    c.execute("CREATE TABLE IF NOT EXISTS Name2Id (user_name TEXT)")
    for n in names:
        c.execute("INSERT INTO Name2Id(user_name) VALUES (?)", (n,))
    c.commit()
    return c


def ensure_msg_table(c: sqlite3.Connection, username: str) -> str:
    t = table_for(username)
    c.execute(f"CREATE TABLE IF NOT EXISTS {t} (local_id INTEGER PRIMARY KEY AUTOINCREMENT, "
              "server_id INTEGER, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, "
              "message_content TEXT, compress_content BLOB)")
    return t


def name_id(c: sqlite3.Connection, name: str) -> int:
    return c.execute("SELECT rowid FROM Name2Id WHERE user_name = ?", (name,)).fetchone()[0]


def add_msg(c, username, sender, when, text, mtype=1, server_id=None, compress=None, local_id=None):
    t = ensure_msg_table(c, username)
    cols = "local_id, server_id, local_type, real_sender_id, create_time, message_content, compress_content"
    c.execute(f"INSERT INTO {t} ({cols}) VALUES (?,?,?,?,?,?,?)",
              (local_id, server_id, mtype, name_id(c, sender), when, text, compress))


def build_wechat_fixture(root: Path) -> Path:
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

    c = make_msg_db(d / "message_0.db", [ME, ALICE, BOB])
    add_msg(c, ALICE, ALICE, ts("2024-01-05"), "今晚一起吃晚饭吗", server_id=9007199254740993)
    add_msg(c, ALICE, ME, ts("2024-01-05", 13), "好啊，去吃火锅")
    add_msg(c, ALICE, ALICE, ts("2024-02-10"), "", mtype=3)  # image stub → not indexed
    appmsg = ("<msg><appmsg><title>火锅店推荐</title><des>超好吃</des>"
              "<type>5</type></appmsg></msg>")
    add_msg(c, ALICE, ALICE, ts("2024-03-01"), appmsg, mtype=49)
    add_msg(c, BOB, BOB, ts("2024-03-02"), "Hello World 明天开会")
    add_msg(c, GROUP, BOB, ts("2024-04-01"), f"{BOB}:\n周末吃晚饭在哪里")
    add_msg(c, GROUP, ME, ts("2024-04-02"), f"{ME}:\n我订了晚饭的位置")
    c.commit()
    c.close()

    # A rolled-over second DB for the same chat.
    c = make_msg_db(d / "message_1.db", [ME, ALICE])
    add_msg(c, ALICE, ALICE, ts("2024-05-20"), "生日快乐🎂一起吃晚饭")
    c.commit()
    c.close()

    # WeChat's own FTS DB must be ignored.
    c = sqlite3.connect(str(d / "message_fts.db"))
    c.execute(f"CREATE TABLE {table_for(ALICE)} (local_id INTEGER, message_content TEXT)")
    c.execute(f"INSERT INTO {table_for(ALICE)} VALUES (1, '吃晚饭吃晚饭')")
    c.commit()
    c.close()
    return d


class _Base(unittest.TestCase):
    mode = None  # default: whatever the runtime supports

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="murmur-search-"))
        self.data = build_wechat_fixture(self.tmp)
        self.store = EchoStore(self.data)
        self.idx_path = self.tmp / "index" / "wechat-test.sqlite"
        self.idx = si.SearchIndex(self.store, "wechat", self.idx_path, mode=self.mode)

    def tearDown(self) -> None:
        self.idx.wait(10)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def search(self, q, **kw):
        return self.idx.search(q, **kw)


class WeChatIndexTest(_Base):
    def test_full_build_skips_stubs_and_wechat_fts_db(self) -> None:
        summary = self.idx.update()
        # 8 rows total in message_0/1, one image stub is skipped.
        self.assertEqual(summary["added"], 7)
        st = self.idx.status()
        self.assertEqual(st["indexed_messages"], 7)
        self.assertEqual(st["state"], "ready")
        self.assertEqual(st["sources"], 2)
        self.assertFalse(self.idx.needs_update())
        self.assertFalse(self.idx_path.parent == self.data)

    def test_does_not_write_into_decrypted_dir(self) -> None:
        before = sorted(p.name for p in self.data.iterdir())
        self.idx.update()
        self.assertEqual(sorted(p.name for p in self.data.iterdir()), before)

    def test_chinese_substring_two_and_three_chars(self) -> None:
        self.idx.update()
        r2 = self.search("晚饭")
        self.assertEqual(r2["total"], 4)
        self.assertEqual(r2["match"], "like")
        r3 = self.search("吃晚饭")
        self.assertEqual(r3["total"], 3)
        if self.idx.mode == si.MODE_FTS:
            self.assertEqual(r3["match"], "fts")
        # Newest first.
        times = [x["ts"] for x in r3["results"]]
        self.assertEqual(times, sorted(times, reverse=True))

    def test_result_shape_and_locator(self) -> None:
        self.idx.update()
        r = self.search("一起吃晚饭吗")
        self.assertEqual(r["total"], 1)
        hit = r["results"][0]
        self.assertEqual(hit["chat"], ALICE)
        self.assertEqual(hit["chat_name"], "爱丽丝")
        self.assertEqual(hit["sender"], ALICE)
        self.assertEqual(hit["sender_name"], "爱丽丝")
        self.assertFalse(hit["is_group"])
        self.assertEqual(hit["type"], "text")
        self.assertEqual(hit["locator"]["db"], "message_0.db")
        self.assertEqual(hit["locator"]["table"], table_for(ALICE))
        self.assertEqual(hit["locator"]["local_id"], 1)
        # server_id is a string so JS doesn't lose int64 precision.
        self.assertEqual(hit["locator"]["server_id"], "9007199254740993")
        self.assertTrue(any(s["hit"] for s in hit["segments"]))

    def test_group_sender_prefix_stripped_and_self(self) -> None:
        self.idx.update()
        r = self.search("位置")
        self.assertEqual(r["total"], 1)
        hit = r["results"][0]
        self.assertEqual(hit["chat"], GROUP)
        self.assertTrue(hit["is_group"])
        self.assertEqual(hit["sender"], "self")
        self.assertEqual(hit["sender_name"], "你")
        self.assertNotIn(ME, hit["snippet"])
        r = self.search("哪里")
        self.assertEqual(r["results"][0]["sender"], BOB)
        self.assertEqual(r["results"][0]["sender_name"], "Bob")

    def test_filters(self) -> None:
        self.idx.update()
        self.assertEqual(self.search("晚饭", chat=GROUP)["total"], 2)
        self.assertEqual(self.search("晚饭", chat=[f"{GROUP},{ALICE}"])["total"], 4)
        self.assertEqual(self.search("晚饭", sender="self")["total"], 1)
        self.assertEqual(self.search("晚饭", sender=BOB)["total"], 1)
        self.assertEqual(self.search("晚饭", ts_from=ts("2024-04-01", 0))["total"], 3)
        self.assertEqual(self.search("晚饭", ts_to=si.parse_time_param("2024-04-01", end=True))["total"], 2)
        self.assertEqual(self.search("火锅", types="share")["total"], 1)
        self.assertEqual(self.search("火锅", types="1")["total"], 1)
        self.assertEqual(self.search("火锅", types="text,share")["total"], 2)
        # Multiple terms are ANDed; ASCII is case-insensitive.
        self.assertEqual(self.search("hello 开会")["total"], 1)
        self.assertEqual(self.search("WORLD")["total"], 1)
        # LIKE wildcards in the query are literal.
        self.assertEqual(self.search("%")["total"], 0)
        self.assertEqual(self.search("_")["total"], 0)

    def test_pagination(self) -> None:
        self.idx.update()
        p1 = self.search("晚饭", limit=3, offset=0)
        p2 = self.search("晚饭", limit=3, offset=3)
        self.assertEqual(p1["total"], 4)
        self.assertEqual(len(p1["results"]), 3)
        self.assertEqual(len(p2["results"]), 1)
        ids = {(x["locator"]["db"], x["locator"]["table"], x["locator"]["local_id"])
               for x in p1["results"] + p2["results"]}
        self.assertEqual(len(ids), 4)

    def test_appmsg_rendered_text_is_indexed(self) -> None:
        self.idx.update()
        r = self.search("火锅店推荐")
        self.assertEqual(r["total"], 1)
        self.assertEqual(r["results"][0]["type"], "share")
        self.assertIn("火锅店推荐", r["results"][0]["snippet"])

    def test_incremental_only_indexes_new_rows(self) -> None:
        self.idx.update()
        db0 = self.data / "message_0.db"
        c = sqlite3.connect(str(db0))
        add_msg(c, ALICE, ALICE, ts("2024-06-01"), "新消息：晚饭改到明天")
        add_msg(c, BOB, ME, ts("2024-06-02"), "收到")
        c.commit()
        c.close()
        bump_mtime(db0)
        self.assertTrue(self.idx.needs_update())
        summary = self.idx.update()
        self.assertEqual(summary["added"], 2)
        self.assertEqual(summary["total"], 2)  # only new rows were read
        self.assertEqual(self.idx.status()["indexed_messages"], 9)
        self.assertEqual(self.search("晚饭")["total"], 5)
        # Nothing changed → nothing read.
        self.assertFalse(self.idx.needs_update())
        self.assertEqual(self.idx.update()["total"], 0)

    def test_new_file_and_removed_file(self) -> None:
        self.idx.update()
        c = make_msg_db(self.data / "message_2.db", [ME, BOB])
        add_msg(c, BOB, BOB, ts("2024-07-01"), "第三个库里的晚饭")
        c.commit()
        c.close()
        self.assertTrue(self.idx.needs_update())
        self.assertEqual(self.idx.update()["added"], 1)
        self.assertEqual(self.search("晚饭")["total"], 5)
        (self.data / "message_1.db").unlink()
        self.assertTrue(self.idx.needs_update())
        self.idx.update()
        self.assertEqual(self.search("晚饭")["total"], 4)
        self.assertEqual(self.search("生日快乐")["total"], 0)

    def test_replaced_table_with_lower_max_key_is_reindexed(self) -> None:
        self.idx.update()
        db1 = self.data / "message_1.db"
        db1.unlink()
        c = make_msg_db(db1, [ME, ALICE])
        add_msg(c, ALICE, ALICE, ts("2024-08-01"), "完全不同的内容", local_id=1)
        c.commit()
        c.close()
        bump_mtime(db1)
        self.idx.update()
        self.assertEqual(self.search("生日快乐")["total"], 0)
        self.assertEqual(self.search("完全不同")["total"], 1)

    def test_rebuild_and_background_worker(self) -> None:
        kicked = self.idx.start_update(full=False)
        self.assertTrue(kicked["started"])
        self.idx.wait(30)
        self.assertEqual(self.idx.status()["state"], "ready")
        self.assertEqual(self.idx.status()["indexed_messages"], 7)
        kicked = self.idx.start_update(full=True)
        self.assertTrue(kicked["started"])
        self.idx.wait(30)
        st = self.idx.status()
        self.assertEqual(st["state"], "ready")
        self.assertEqual(st["indexed_messages"], 7)
        self.assertIsNone(st["last_error"])

    def test_search_before_build_is_empty_not_error(self) -> None:
        r = self.search("晚饭")
        self.assertEqual(r["total"], 0)
        self.assertEqual(self.idx.status()["state"], "empty")

    def test_empty_query_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.search("   ")

    def test_compress_content_with_fake_zstd(self) -> None:
        magic = b"\x28\xb5\x2f\xfd"

        class _FakeDecompressor:
            def decompress(self, data):
                assert data.startswith(magic)
                return data[len(magic):]

        fake = types.ModuleType("zstandard")
        fake.ZstdDecompressor = _FakeDecompressor  # type: ignore[attr-defined]
        saved = sys.modules.get("zstandard")
        sys.modules["zstandard"] = fake
        try:
            db0 = self.data / "message_0.db"
            c = sqlite3.connect(str(db0))
            add_msg(c, BOB, BOB, ts("2024-09-01"), "",
                    compress=magic + "压缩过的正文内容".encode("utf-8"))
            c.commit()
            c.close()
            self.idx.update()
            r = self.search("压缩过的正文")
            self.assertEqual(r["total"], 1)
            self.assertEqual(r["results"][0]["chat"], BOB)
        finally:
            if saved is None:
                sys.modules.pop("zstandard", None)
            else:
                sys.modules["zstandard"] = saved

    def test_compress_content_without_zstd_is_skipped_not_crash(self) -> None:
        saved = sys.modules.get("zstandard")
        sys.modules["zstandard"] = None  # type: ignore[assignment]  # import → ImportError
        try:
            db0 = self.data / "message_0.db"
            c = sqlite3.connect(str(db0))
            add_msg(c, BOB, BOB, ts("2024-09-01"), "",
                    compress=b"\x28\xb5\x2f\xfd" + bytes(range(200, 256)) * 4)
            c.commit()
            c.close()
            summary = self.idx.update()
            self.assertEqual(summary["added"], 7)  # garbage row filtered out
        finally:
            if saved is None:
                sys.modules.pop("zstandard", None)
            else:
                sys.modules["zstandard"] = saved


class WeChatLikeFallbackTest(WeChatIndexTest):
    """Same suite with FTS5 trigram forced off (old SQLite)."""
    mode = si.MODE_LIKE

    def test_mode_reported(self) -> None:
        self.idx.update()
        self.assertEqual(self.idx.status()["mode"], si.MODE_LIKE)
        r = self.search("吃晚饭")
        self.assertEqual(r["mode"], si.MODE_LIKE)
        self.assertEqual(r["match"], "like")
        con = sqlite3.connect(str(self.idx_path))
        try:
            names = {x[0] for x in con.execute("SELECT name FROM sqlite_master").fetchall()}
        finally:
            con.close()
        self.assertNotIn("msg_fts", names)


class TrigramDetectionTest(unittest.TestCase):
    def test_auto_mode_falls_back_when_trigram_missing(self) -> None:
        saved = si._TRIGRAM_OK
        si._TRIGRAM_OK = False
        tmp = Path(tempfile.mkdtemp(prefix="murmur-search-"))
        try:
            store = EchoStore(build_wechat_fixture(tmp))
            idx = si.SearchIndex(store, "wechat", tmp / "i.sqlite")
            self.assertEqual(idx.mode, si.MODE_LIKE)
            # Asking for FTS explicitly still degrades.
            idx2 = si.SearchIndex(store, "wechat", tmp / "j.sqlite", mode=si.MODE_FTS)
            self.assertEqual(idx2.mode, si.MODE_LIKE)
            idx.update()
            self.assertEqual(idx.search("晚饭")["total"], 4)
        finally:
            si._TRIGRAM_OK = saved
            shutil.rmtree(tmp, ignore_errors=True)

    @unittest.skipUnless(si.fts5_trigram_available(), "SQLite without FTS5 trigram")
    def test_mode_switch_rebuilds_index(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="murmur-search-"))
        try:
            store = EchoStore(build_wechat_fixture(tmp))
            path = tmp / "i.sqlite"
            si.SearchIndex(store, "wechat", path, mode=si.MODE_FTS).update()
            like = si.SearchIndex(store, "wechat", path, mode=si.MODE_LIKE)
            self.assertTrue(like.needs_update())
            like.update()
            self.assertEqual(like.search("吃晚饭")["total"], 3)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class HelpersTest(unittest.TestCase):
    def test_parse_time_param(self) -> None:
        self.assertEqual(si.parse_time_param("1700000000"), 1700000000)
        self.assertEqual(si.parse_time_param("2024-01-01"), ts("2024-01-01", 0))
        self.assertEqual(si.parse_time_param("2024-01-01", end=True), ts("2024-01-01", 0) + 86399)
        self.assertIsNone(si.parse_time_param(""))
        with self.assertRaises(ValueError):
            si.parse_time_param("yesterday")

    def test_snippet_highlights_are_utf16_offsets(self) -> None:
        text = "🎂生日快乐，一起吃晚饭"
        out = si.build_snippet(text, ["晚饭"])
        self.assertEqual(out["snippet"], text)
        [[s, e]] = out["highlights"]
        # 🎂 is 2 UTF-16 code units, so the hit starts at 10 not 9.
        self.assertEqual((s, e), (10, 12))
        self.assertEqual("".join(x["text"] for x in out["segments"]), text)
        self.assertEqual([x["text"] for x in out["segments"] if x["hit"]], ["晚饭"])

    def test_snippet_windows_long_text(self) -> None:
        text = "啊" * 300 + "关键字" + "哦" * 300
        out = si.build_snippet(text, ["关键字"])
        self.assertTrue(out["snippet"].startswith("…"))
        self.assertTrue(out["snippet"].endswith("…"))
        self.assertLess(len(out["snippet"]), 200)
        self.assertIn("关键字", out["snippet"])

    def test_index_path_is_outside_decrypted_dir(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="murmur-search-"))
        try:
            store = EchoStore(build_wechat_fixture(tmp))
            p = si.index_path_for(store, "wechat", tmp / "idx")
            self.assertEqual(p.parent, tmp / "idx")
            self.assertEqual(p.name, f"wechat-{ME}.sqlite")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- QQ NT

def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _field_bytes(num: int, payload: bytes) -> bytes:
    return _varint((num << 3) | 2) + _varint(len(payload)) + payload


def _field_varint(num: int, v: int) -> bytes:
    return _varint(num << 3) + _varint(v)


def qq_text_body(text: str) -> bytes:
    elem = _field_varint(45002, 1) + _field_bytes(45101, text.encode("utf-8"))
    return _field_bytes(40800, elem)


def qq_image_body() -> bytes:
    return _field_bytes(40800, _field_varint(45002, 2))


class QQIndexTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="murmur-search-qq-"))
        d = self.tmp / "10001"
        d.mkdir()
        c = sqlite3.connect(str(d / "profile_info.db"))
        c.execute('CREATE TABLE profile_info_v6 ("1000" TEXT, "1002" INTEGER, "20002" TEXT, "20009" TEXT)')
        c.execute('CREATE TABLE buddy_list ("1000" TEXT)')
        c.executemany("INSERT INTO profile_info_v6 VALUES (?,?,?,?)", [
            ("u_me", 10001, "我自己", ""), ("u_friend", 20002, "老王", "")])
        c.execute("INSERT INTO buddy_list VALUES ('u_friend')")
        c.commit()
        c.close()
        c = sqlite3.connect(str(d / "nt_msg.db"))
        cols = '"40001" INTEGER, "40020" TEXT, "40021" TEXT, "40050" INTEGER, "40005" INTEGER, "40800" BLOB, "40090" TEXT'
        c.execute(f"CREATE TABLE c2c_msg_table ({cols})")
        c.execute(f"CREATE TABLE group_msg_table ({cols})")
        c.executemany("INSERT INTO c2c_msg_table VALUES (?,?,?,?,?,?,?)", [
            (7001, "u_friend", "u_friend", ts("2024-01-01"), 2, qq_text_body("周五一起吃晚饭"), None),
            (7002, "u_me", "u_friend", ts("2024-01-02"), 2, qq_text_body("可以，晚饭我请"), None),
            (7003, "u_friend", "u_friend", ts("2024-01-03"), 2, qq_image_body(), None),
        ])
        c.execute("INSERT INTO group_msg_table VALUES (?,?,?,?,?,?,?)",
                  (8001, "u_friend", "555", ts("2024-02-01"), 2, qq_text_body("群里约晚饭"), "群名片老王"))
        c.commit()
        c.close()
        import qq_store
        self.store = qq_store.QQStore(d, qq_number="10001")
        self.idx = si.SearchIndex(self.store, "qq", self.tmp / "idx" / "qq-10001.sqlite")

    def tearDown(self) -> None:
        self.idx.wait(10)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_qq_index_and_search(self) -> None:
        self.assertEqual(self.idx.update()["added"], 3)  # image stub skipped
        r = self.idx.search("晚饭")
        self.assertEqual(r["total"], 3)
        self.assertTrue(all(x["platform"] == "qq" for x in r["results"]))
        by_chat = {x["chat"]: x for x in r["results"]}
        self.assertIn("555@chatroom", by_chat)
        g = by_chat["555@chatroom"]
        self.assertTrue(g["is_group"])
        self.assertEqual(g["sender_name"], "群名片老王")
        self.assertEqual(g["locator"]["table"], "group_msg_table")
        self.assertEqual(g["locator"]["server_id"], "8001")
        self.assertEqual(self.idx.search("晚饭", sender="self")["total"], 1)
        self.assertEqual(self.idx.search("晚饭", chat="u_friend")["total"], 2)
        mine = self.idx.search("我请")["results"][0]
        self.assertEqual(mine["sender_name"], "你")
        self.assertEqual(self.idx.search("一起吃晚饭")["results"][0]["chat_name"], "老王")

    def test_qq_incremental(self) -> None:
        self.idx.update()
        nt = Path(self.store.dir) / "nt_msg.db"
        c = sqlite3.connect(str(nt))
        c.execute("INSERT INTO c2c_msg_table VALUES (?,?,?,?,?,?,?)",
                  (7004, "u_friend", "u_friend", ts("2024-03-01"), 2, qq_text_body("晚饭吃什么"), None))
        c.commit()
        c.close()
        bump_mtime(nt)
        summary = self.idx.update()
        self.assertEqual(summary["added"], 1)
        self.assertEqual(summary["total"], 1)
        self.assertEqual(self.idx.search("晚饭")["total"], 4)


# ---------------------------------------------------------------- HTTP

class HttpEndpointsTest(unittest.TestCase):
    def setUp(self) -> None:
        import etcli
        self.etcli = etcli
        self.tmp = Path(tempfile.mkdtemp(prefix="murmur-search-http-"))
        self.store = EchoStore(build_wechat_fixture(self.tmp))
        self._env = os.environ.get("MURMUR_SEARCH_INDEX_DIR")
        os.environ["MURMUR_SEARCH_INDEX_DIR"] = str(self.tmp / "idx")
        H = etcli._MurmurAPIHandler
        self._saved = (H.store, H._wechat_store, H._active_platform, H._active_id)
        H.store = self.store
        H._wechat_store = self.store
        H._active_platform = "wechat"
        H._active_id = ME
        from http.server import ThreadingHTTPServer
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        H = self.etcli._MurmurAPIHandler
        H.store, H._wechat_store, H._active_platform, H._active_id = self._saved
        idx = si.get_index(self.store, "wechat")
        idx.wait(30)
        with si._REGISTRY_LOCK:
            si._REGISTRY.pop(str(idx.path), None)
        if self._env is None:
            os.environ.pop("MURMUR_SEARCH_INDEX_DIR", None)
        else:
            os.environ["MURMUR_SEARCH_INDEX_DIR"] = self._env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _get(self, path: str, method: str = "GET"):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                     data=b"{}" if method == "POST" else None)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_status_search_rebuild(self) -> None:
        code, st = self._get("/api/search/status")
        self.assertEqual(code, 200)
        self.assertTrue(st["auto_started"])
        si.get_index(self.store, "wechat").wait(30)
        code, st = self._get("/api/search/status")
        self.assertEqual(st["state"], "ready")
        self.assertFalse(st["auto_started"])
        self.assertEqual(st["platform"], "wechat")

        q = urllib.parse.quote("晚饭")
        code, r = self._get(f"/api/search?q={q}&chat={urllib.parse.quote(GROUP)}&limit=10")
        self.assertEqual(code, 200)
        self.assertEqual(r["total"], 2)
        self.assertIn("index", r)
        code, r = self._get(f"/api/search?q={q}&from=2024-04-02&to=2024-12-31&type=text")
        self.assertEqual(r["total"], 2)

        code, r = self._get("/api/search?q=")
        self.assertEqual(code, 400)
        code, r = self._get(f"/api/search?q={q}&from=notadate")
        self.assertEqual(code, 400)

        code, r = self._get("/api/search/rebuild", method="POST")
        self.assertEqual(code, 200)
        self.assertTrue(r["ok"])
        si.get_index(self.store, "wechat").wait(30)
        code, st = self._get("/api/search/status")
        self.assertEqual(st["indexed_messages"], 7)

    def test_gated_without_store(self) -> None:
        H = self.etcli._MurmurAPIHandler
        H.store = None
        orig = self.etcli.discover_data_dir
        self.etcli.discover_data_dir = lambda: None
        try:
            code, _ = self._get("/api/search?q=abc")
            self.assertEqual(code, 503)
            code, _ = self._get("/api/search/status")
            self.assertEqual(code, 503)
            code, _ = self._get("/api/search/rebuild", method="POST")
            self.assertEqual(code, 503)
        finally:
            self.etcli.discover_data_dir = orig
            H.store = self.store


if __name__ == "__main__":
    unittest.main()
