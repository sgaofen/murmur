"""Tests for cli/mcp_server.py (the `etcli mcp` stdio server).

Builds a tiny synthetic decrypted-WeChat directory (session.db / contact.db /
message_0.db) and drives the server both through its dispatch function and
through a real stdio subprocess. Standard library only.
"""
import hashlib
import io
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import etcli  # noqa: E402
import mcp_server  # noqa: E402

CST = timezone(timedelta(hours=8))
SELF = "wxid_me"
ALICE = "wxid_alice001"
BOB = "wxid_bob002"
CAROL = "alias123456789"          # old-style username (not wxid_*)
GROUP = "12345@chatroom"
STRANGER = "wxid_stranger9"


def _ts(y, mo, d, h=12, mi=0):
    return int(datetime(y, mo, d, h, mi, tzinfo=CST).timestamp())


def build_fixture(root: Path) -> Path:
    data = root / SELF
    data.mkdir(parents=True)

    c = sqlite3.connect(str(data / "session.db"))
    c.execute("CREATE TABLE SessionTable (username TEXT, last_timestamp INTEGER, summary TEXT)")
    c.executemany("INSERT INTO SessionTable VALUES (?,?,?)", [
        (ALICE, _ts(2025, 12, 20), "明天打羽毛球吗"),
        (BOB, _ts(2025, 6, 1), "好的"),
        (GROUP, _ts(2025, 11, 1), "周六见"),
        (CAROL, _ts(2024, 3, 3), "hi"),
        ("wxid_nomsgs", _ts(2023, 1, 1), ""),
    ])
    c.commit()
    c.close()

    c = sqlite3.connect(str(data / "contact.db"))
    c.execute("CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, alias TEXT, local_type INTEGER)")
    c.execute("CREATE TABLE chat_room (username TEXT)")
    c.executemany("INSERT INTO contact VALUES (?,?,?,?,?)", [
        (SELF, "", "我自己", "", 1),
        (ALICE, "爱丽丝", "Alice Wang", "alice_w88", 1),
        (BOB, "", "老王头", "", 1),
        (CAROL, "", "Carol", "", 1),
        (GROUP, "", "周末羽毛球群", "", 2),
        (STRANGER, "", "路人甲", "", 3),
        ("wxid_nomsgs", "", "没聊过", "", 1),
    ])
    c.execute("INSERT INTO chat_room VALUES (?)", (GROUP,))
    c.commit()
    c.close()

    c = sqlite3.connect(str(data / "message_0.db"))
    c.execute("CREATE TABLE Name2Id (user_name TEXT)")
    ids = {}
    for u in (SELF, ALICE, BOB, CAROL, STRANGER):
        cur = c.execute("INSERT INTO Name2Id (user_name) VALUES (?)", (u,))
        ids[u] = cur.lastrowid

    def table(u):
        t = "Msg_" + hashlib.md5(u.encode()).hexdigest()
        c.execute(f"CREATE TABLE {t} (local_id INTEGER PRIMARY KEY, create_time INTEGER, "
                  f"real_sender_id INTEGER, local_type INTEGER, message_content TEXT, compress_content BLOB)")
        return t

    t = table(ALICE)
    rows = []
    base = _ts(2025, 1, 5, 21)
    for i in range(40):
        sender = SELF if i % 2 == 0 else ALICE
        text = f"第{i}条 今天怎么样"
        if i == 7:
            text = "我的电话是 13800138000，找爱丽丝也行"
        if i == 12:
            text = "周末一起打羽毛球吧"
        if i == 30:
            text = "Alice Wang 你好"
        rows.append((base + i * 86400 * 9, ids[sender], 1, text))
    rows.append((base + 3600, ids[ALICE], 3, "<img/>"))
    c.executemany(f"INSERT INTO {t} (create_time, real_sender_id, local_type, message_content) VALUES (?,?,?,?)", rows)

    t = table(BOB)
    c.executemany(f"INSERT INTO {t} (create_time, real_sender_id, local_type, message_content) VALUES (?,?,?,?)", [
        (_ts(2025, 5, d), ids[SELF if d % 2 else BOB], 1, f"bob 消息 {d}") for d in range(1, 11)
    ])

    t = table(CAROL)
    c.executemany(f"INSERT INTO {t} (create_time, real_sender_id, local_type, message_content) VALUES (?,?,?,?)", [
        (_ts(2024, 3, 1), ids[CAROL], 1, "hi from carol"),
        (_ts(2024, 3, 2), ids[SELF], 1, "hey Carol"),
        (_ts(2024, 3, 3), ids[CAROL], 1, "羽毛球拍借我"),
    ])

    t = table(GROUP)
    c.executemany(f"INSERT INTO {t} (create_time, real_sender_id, local_type, message_content) VALUES (?,?,?,?)", [
        (_ts(2025, 10, 1), ids[ALICE], 1, f"{ALICE}:\n大家周六打羽毛球"),
        (_ts(2025, 10, 1, 13), ids[BOB], 1, f"{BOB}:\n@爱丽丝 我来"),
        (_ts(2025, 10, 2), ids[STRANGER], 1, f"{STRANGER}:\n算我一个"),
        (_ts(2025, 10, 3), ids[SELF], 1, "收到"),
    ])
    c.commit()
    c.close()
    return data


def reset_etcli_caches():
    etcli._MurmurAPIHandler._flush_analysis_caches()
    etcli._ANNUAL_REPORT_CACHE.clear()
    for name in ("_MENTIONS_CACHE",):
        cache = getattr(etcli, name, None)
        if isinstance(cache, dict):
            cache.clear()


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="murmur-mcp-test-")
        cls.data_dir = build_fixture(Path(cls._tmp))
        cls.cache_dir = Path(cls._tmp) / "cache"
        cls.cache_dir.mkdir()
        cls._orig_cache_dir = etcli._disk_cache_dir
        cls._orig_ro = etcli._DISK_CACHE_READONLY
        etcli._disk_cache_dir = lambda: cls.cache_dir
        etcli._DISK_CACHE_READONLY = True

    @classmethod
    def tearDownClass(cls):
        etcli._disk_cache_dir = cls._orig_cache_dir
        etcli._DISK_CACHE_READONLY = cls._orig_ro
        reset_etcli_caches()
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def setUp(self):
        reset_etcli_caches()

    def make_server(self, privacy=False, **kw):
        store = etcli.EchoStore(self.data_dir)
        return mcp_server.MurmurMCPServer(etcli, store=store, privacy=privacy, **kw)

    def rpc(self, server, method, params=None, req_id=1):
        msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        return server.handle(msg)

    def call(self, server, name, arguments=None):
        resp = self.rpc(server, "tools/call", {"name": name, "arguments": arguments or {}})
        self.assertIn("result", resp, resp)
        return resp["result"]

    def call_ok(self, server, name, arguments=None):
        res = self.call(server, name, arguments)
        self.assertFalse(res.get("isError"), res)
        payload = res["structuredContent"]
        self.assertEqual(json.loads(res["content"][0]["text"]), payload)
        return payload


class ProtocolTest(_Base):
    def test_initialize_legacy_echoes_supported_version(self):
        s = self.make_server()
        resp = self.rpc(s, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                          "clientInfo": {"name": "t", "version": "1"}})
        r = resp["result"]
        self.assertEqual(r["protocolVersion"], "2025-06-18")
        self.assertIn("tools", r["capabilities"])
        self.assertEqual(r["serverInfo"]["name"], "murmur")
        self.assertNotIn("resultType", r)

    def test_initialize_unknown_version_offers_latest_legacy(self):
        s = self.make_server()
        r = self.rpc(s, "initialize", {"protocolVersion": "1999-01-01", "capabilities": {}})["result"]
        self.assertEqual(r["protocolVersion"], mcp_server.LEGACY_VERSIONS[0])

    def test_initialize_requires_version(self):
        s = self.make_server()
        resp = self.rpc(s, "initialize", {"capabilities": {}})
        self.assertEqual(resp["error"]["code"], mcp_server.INVALID_PARAMS)

    def test_notifications_get_no_response(self):
        s = self.make_server()
        self.assertIsNone(s.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertIsNone(s.handle({"jsonrpc": "2.0", "method": "notifications/cancelled",
                                    "params": {"requestId": 3}}))

    def test_ping(self):
        s = self.make_server()
        self.assertEqual(self.rpc(s, "ping", req_id="p1"), {"jsonrpc": "2.0", "id": "p1", "result": {}})

    def test_modern_discover_and_per_request_meta(self):
        s = self.make_server()
        meta = {"io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {}}
        r = self.rpc(s, "server/discover", {"_meta": meta})["result"]
        self.assertEqual(r["resultType"], "complete")
        self.assertIn("2026-07-28", r["supportedVersions"])
        self.assertIn("2025-11-25", r["supportedVersions"])
        self.assertEqual(r["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "murmur")
        r = self.rpc(s, "tools/list", {"_meta": meta})["result"]
        self.assertEqual(r["resultType"], "complete")
        self.assertEqual(len(r["tools"]), 7)

    def test_modern_unsupported_version(self):
        s = self.make_server()
        resp = self.rpc(s, "tools/list", {"_meta": {"io.modelcontextprotocol/protocolVersion": "1900-01-01",
                                                    "io.modelcontextprotocol/clientCapabilities": {}}})
        self.assertEqual(resp["error"]["code"], -32022)
        self.assertEqual(resp["error"]["data"]["requested"], "1900-01-01")
        self.assertIn("2026-07-28", resp["error"]["data"]["supported"])

    def test_modern_missing_client_capabilities(self):
        s = self.make_server()
        resp = self.rpc(s, "tools/list", {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}})
        self.assertEqual(resp["error"]["code"], mcp_server.INVALID_PARAMS)

    def test_tools_list_schemas(self):
        s = self.make_server()
        tools = self.rpc(s, "tools/list", {})["result"]["tools"]
        names = [t["name"] for t in tools]
        self.assertEqual(names, ["list_contacts", "list_chats", "get_messages", "search_messages",
                                 "get_friend_stats", "get_relationship_evidence", "get_annual_summary"])
        for t in tools:
            self.assertEqual(t["inputSchema"]["type"], "object")
            self.assertTrue(t["annotations"]["readOnlyHint"])
            self.assertTrue(t["description"])
            json.dumps(t)  # serialisable

    def test_unknown_method_and_tool(self):
        s = self.make_server()
        self.assertEqual(self.rpc(s, "resources/list", {})["error"]["code"], mcp_server.METHOD_NOT_FOUND)
        resp = self.rpc(s, "tools/call", {"name": "drop_everything", "arguments": {}})
        self.assertEqual(resp["error"]["code"], mcp_server.INVALID_PARAMS)
        resp = self.rpc(s, "tools/call", {"arguments": {}})
        self.assertEqual(resp["error"]["code"], mcp_server.INVALID_PARAMS)

    def test_invalid_requests(self):
        s = self.make_server()
        self.assertEqual(s.handle([1, 2])["error"]["code"], mcp_server.INVALID_REQUEST)
        self.assertEqual(s.handle({"jsonrpc": "1.0", "id": 1, "method": "ping"})["error"]["code"],
                         mcp_server.INVALID_REQUEST)
        self.assertEqual(s.handle({"jsonrpc": "2.0", "id": None, "method": "ping"})["error"]["code"],
                         mcp_server.INVALID_REQUEST)
        self.assertEqual(s.handle({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": [1]})["error"]["code"],
                         mcp_server.INVALID_PARAMS)
        self.assertIsNone(s.handle({"jsonrpc": "2.0", "id": 9, "result": {}}))


class ToolsTest(_Base):
    def test_list_contacts_sorted_by_messages(self):
        s = self.make_server()
        r = self.call_ok(s, "list_contacts", {"kind": "private", "min_messages": 1})
        self.assertEqual([i["wxid"] for i in r["items"]], [ALICE, BOB, CAROL])
        self.assertEqual(r["items"][0]["message_count"], 41)
        self.assertEqual(r["items"][0]["name"], "爱丽丝")

    def test_list_contacts_filter_and_paging(self):
        s = self.make_server()
        r = self.call_ok(s, "list_contacts", {"query": "alice"})
        self.assertEqual([i["wxid"] for i in r["items"]], [ALICE])
        r = self.call_ok(s, "list_contacts", {"kind": "friends", "limit": 2, "offset": 0})
        self.assertEqual(r["count"], 2)
        self.assertEqual(r["next_offset"], 2)
        self.assertNotIn(STRANGER, [i["wxid"] for i in r["items"]])
        r = self.call_ok(s, "list_contacts", {"kind": "groups"})
        self.assertEqual([i["wxid"] for i in r["items"]], [GROUP])

    def test_list_chats(self):
        s = self.make_server()
        r = self.call_ok(s, "list_chats", {})
        self.assertEqual([i["wxid"] for i in r["items"]], [ALICE, GROUP, BOB, CAROL])  # recent first, no empty
        r = self.call_ok(s, "list_chats", {"include_empty": True, "sort": "messages"})
        self.assertEqual(r["total"], 5)
        self.assertEqual(r["items"][0]["wxid"], ALICE)
        r = self.call_ok(s, "list_chats", {"kind": "groups"})
        self.assertEqual(r["items"][0]["message_count"], 4)

    def test_get_messages_paging_and_range(self):
        s = self.make_server()
        r = self.call_ok(s, "get_messages", {"chat": "爱丽丝", "limit": 5})
        self.assertEqual(r["chat"], ALICE)
        self.assertEqual(r["total"], 41)
        self.assertEqual(r["count"], 5)
        self.assertEqual(r["next_offset"], 5)
        ts = [m["ts"] for m in r["messages"]]
        self.assertEqual(ts, sorted(ts))
        newest = r["messages"][-1]
        r2 = self.call_ok(s, "get_messages", {"chat": ALICE, "limit": 5, "offset": 5})
        self.assertLess(r2["messages"][-1]["ts"], r["messages"][0]["ts"] + 1)
        self.assertNotEqual(r2["messages"][-1], newest)
        r3 = self.call_ok(s, "get_messages", {"chat": ALICE, "order": "asc", "limit": 3, "text_only": True})
        self.assertEqual(r3["messages"][0]["text"], "第0条 今天怎么样")
        self.assertEqual(r3["messages"][0]["from_id"], "self")
        r4 = self.call_ok(s, "get_messages", {"chat": ALICE, "since": "2025-01-05", "until": "2025-01-05"})
        self.assertEqual(r4["total"], 2)  # text #0 at 21:00 + image at 22:00, until covers whole day

    def test_get_messages_group_sender(self):
        s = self.make_server()
        r = self.call_ok(s, "get_messages", {"chat": GROUP, "order": "asc"})
        self.assertEqual(r["messages"][0]["from_id"], ALICE)
        self.assertEqual(r["messages"][0]["text"], "大家周六打羽毛球")
        self.assertEqual(r["messages"][-1]["from_id"], "self")

    def test_get_messages_row_cap(self):
        s = self.make_server(max_rows=10)
        tool = [t for t in s.tools if t["name"] == "get_messages"][0]
        self.assertEqual(tool["inputSchema"]["properties"]["limit"]["maximum"], 10)
        res = self.call(s, "get_messages", {"chat": ALICE, "limit": 50})
        self.assertTrue(res["isError"])

    def test_search_messages(self):
        s = self.make_server()
        r = self.call_ok(s, "search_messages", {"keyword": "羽毛球"})
        sessions = sorted(h["session"] for h in r["results"])
        self.assertEqual(sessions, sorted([ALICE, GROUP, CAROL]))
        r = self.call_ok(s, "search_messages", {"keyword": "羽毛球", "chat": "周末羽毛球群"})
        self.assertEqual([h["session"] for h in r["results"]], [GROUP])
        r = self.call_ok(s, "search_messages", {"keyword": "羽毛球", "since": "2025-01-01"})
        self.assertNotIn(CAROL, [h["session"] for h in r["results"]])
        r = self.call_ok(s, "search_messages", {"keyword": "ALICE WANG"})  # case-insensitive
        self.assertEqual(r["count"], 1)
        slow = self.make_server(search_time_budget=-1)
        r = self.call_ok(slow, "search_messages", {"keyword": "羽毛球"})
        self.assertTrue(r["time_budget_exceeded"])
        self.assertEqual(r["chats_scanned"], 0)
        r = self.call_ok(s, "search_messages", {"keyword": "今天", "limit": 3})
        self.assertEqual(r["count"], 3)
        self.assertTrue(r["limit_reached"])

    def test_friend_stats(self):
        s = self.make_server()
        r = self.call_ok(s, "get_friend_stats", {"who": ALICE})
        self.assertEqual(r["message_count"], 41)
        self.assertEqual(r["by_sender"]["self"], 20)
        full = self.call_ok(s, "get_friend_stats", {"who": ALICE, "detail": "full"})
        self.assertEqual(full["totals"]["messages"], 41)
        self.assertIn("relationship_signals", full)

    def test_relationship_evidence(self):
        s = self.make_server()
        r = self.call_ok(s, "get_relationship_evidence", {"who": "Alice", "sample": 5})
        self.assertEqual(r["wxid"], ALICE)
        self.assertIsInstance(r["relationship_signals"], dict)
        self.assertEqual(len(r["sample_messages"]), 5)
        r = self.call_ok(s, "get_relationship_evidence", {"who": ALICE, "other": BOB})
        self.assertIn("ok", r)
        self.assertIn("direct_edges", r)
        res = self.call(s, "get_relationship_evidence", {"who": ALICE, "other": ALICE})
        self.assertTrue(res["isError"])

    def test_annual_summary(self):
        s = self.make_server()
        r = self.call_ok(s, "get_annual_summary", {})
        self.assertEqual(r["year"], 2025)
        self.assertEqual(r["available_years"], [2024, 2025])
        self.assertEqual(r["top_friends"][0]["wxid"], ALICE)
        r = self.call_ok(s, "get_annual_summary", {"year": 2024, "top_n": 1})
        self.assertEqual(r["year"], 2024)
        self.assertLessEqual(len(r["top_friends"]), 1)

    def test_no_cache_written(self):
        s = self.make_server()
        self.call_ok(s, "get_annual_summary", {})
        self.call_ok(s, "get_relationship_evidence", {"who": ALICE, "other": BOB})
        self.assertEqual(list(self.cache_dir.iterdir()), [])


class ArgumentErrorTest(_Base):
    def assertToolError(self, s, name, args, needle=None):
        res = self.call(s, name, args)
        self.assertTrue(res["isError"], res)
        if needle:
            self.assertIn(needle, res["content"][0]["text"])

    def test_bad_arguments(self):
        s = self.make_server()
        self.assertToolError(s, "get_messages", {}, "chat")
        self.assertToolError(s, "get_messages", {"chat": ALICE, "limit": "10"}, "integer")
        self.assertToolError(s, "get_messages", {"chat": ALICE, "limit": 0})
        self.assertToolError(s, "get_messages", {"chat": ALICE, "order": "sideways"})
        self.assertToolError(s, "get_messages", {"chat": ALICE, "bogus": 1}, "bogus")
        self.assertToolError(s, "get_messages", {"chat": ALICE, "since": "yesterday"}, "YYYY-MM-DD")
        self.assertToolError(s, "get_messages", {"chat": "完全不存在的人"}, "找不到联系人")
        self.assertToolError(s, "search_messages", {"keyword": ""}, "keyword")
        self.assertToolError(s, "get_annual_summary", {"year": 1990})
        self.assertToolError(s, "list_contacts", {"limit": True})
        res = self.rpc(s, "tools/call", {"name": "list_chats", "arguments": [1]})["result"]
        self.assertTrue(res["isError"])

    def test_missing_data_dir_is_tool_error(self):
        empty = Path(self._tmp) / "nothing-here"
        s = mcp_server.MurmurMCPServer(etcli, data_dir=str(empty))
        res = self.call(s, "list_chats", {})
        self.assertTrue(res["isError"])
        self.assertIn("数据目录", res["content"][0]["text"])
        # protocol methods still work without data
        self.assertIn("tools", self.rpc(s, "tools/list", {})["result"])


class PrivacyTest(_Base):
    def test_hash_matches_frontend(self):
        # Reference values computed with app/src/utils/privacy.ts (shortHash / aliasFor / maskedWxid).
        self.assertEqual(mcp_server.js_short_hash("wxid_alice001"), 1683083476)
        self.assertEqual(mcp_server.js_short_hash("张三😀很长的名字"), 1761373579)
        self.assertEqual(mcp_server.alias_for("wxid_alice001", False), "朋友 WL")
        self.assertEqual(mcp_server.alias_for("wxid_bob002", False), "朋友 WJ")
        self.assertEqual(mcp_server.alias_for("12345@chatroom", True), "群 92")
        self.assertEqual(mcp_server.masked_wxid_base("wxid_alice001"), "wxid_1801")
        self.assertEqual(mcp_server.masked_wxid_base("alias123456789"), "wxid_7359")
        self.assertEqual(mcp_server.masked_wxid_base("12345@chatroom"), "group_613")

    def _blob(self, payload):
        return json.dumps(payload, ensure_ascii=False)

    def assertNoLeak(self, payload):
        blob = self._blob(payload)
        for secret in (ALICE, BOB, CAROL, GROUP, STRANGER, "爱丽丝", "Alice Wang", "alice_w88",
                       "老王头", "Carol", "周末羽毛球群", "路人甲", "13800138000"):
            self.assertNotIn(secret, blob, f"{secret!r} leaked in {blob[:400]}")

    def test_privacy_masks_every_tool(self):
        s = self.make_server(privacy=True)
        payloads = [
            self.call_ok(s, "list_contacts", {}),
            self.call_ok(s, "list_chats", {"include_empty": True}),
            self.call_ok(s, "get_messages", {"chat": ALICE, "limit": 50}),
            self.call_ok(s, "get_messages", {"chat": GROUP}),
            self.call_ok(s, "get_messages", {"chat": CAROL}),
            self.call_ok(s, "search_messages", {"keyword": "羽毛球"}),
            self.call_ok(s, "get_friend_stats", {"who": ALICE, "detail": "full"}),
            self.call_ok(s, "get_relationship_evidence", {"who": ALICE, "sample": 40}),
            self.call_ok(s, "get_annual_summary", {}),
        ]
        for p in payloads:
            self.assertNoLeak(p)
        contacts = payloads[0]["items"]
        alice = [c for c in contacts if c["message_count"] == 41][0]
        self.assertEqual(alice["name"], "朋友 WL")
        self.assertEqual(alice["wxid"], "wxid_1801")
        msgs = payloads[2]["messages"]
        self.assertTrue(any("朋友 WL" in m["text"] for m in msgs))     # 爱丽丝 / Alice Wang in text
        self.assertTrue(any("num_" in m["text"] for m in msgs))        # phone number masked
        # timestamps untouched
        self.assertRegex(msgs[0]["time"], r"^\d{4}-\d{2}-\d{2}T")

    def test_privacy_masked_handles_round_trip(self):
        s = self.make_server(privacy=True)
        items = self.call_ok(s, "list_chats", {})["items"]
        group = [i for i in items if i["is_group"]][0]
        self.assertTrue(group["wxid"].startswith("group_"))
        r = self.call_ok(s, "get_messages", {"chat": group["wxid"]})
        self.assertEqual(r["total"], 4)
        r = self.call_ok(s, "get_friend_stats", {"who": "朋友 WL"})
        self.assertEqual(r["message_count"], 41)
        r = self.call_ok(s, "get_friend_stats", {"who": "wxid_7359"})   # Carol, non-wxid username
        self.assertEqual(r["message_count"], 3)

    def test_privacy_never_rewrites_schema_keys(self):
        p = mcp_server.Privacy(True)
        p._tokens["ok"] = "朋友 TX"
        p._tokens["text"] = "朋友 QQ"
        p._exact["ok"] = "朋友 TX"
        out = p.mask({"ok": True, "type": "text", "by_sender": {"wxid_abc": 1, "self": 2}, "words": {"ok": 3}})
        self.assertIn("ok", out)
        self.assertEqual(out["type"], "text")
        self.assertNotIn("wxid_abc", out["by_sender"])
        self.assertIn("self", out["by_sender"])

    def test_privacy_off_returns_real_names(self):
        s = self.make_server(privacy=False)
        r = self.call_ok(s, "get_friend_stats", {"who": ALICE})
        self.assertEqual(r["name"], "爱丽丝")
        self.assertEqual(r["wxid"], ALICE)

    def test_mask_id_collision_suffix(self):
        p = mcp_server.Privacy(True)
        a = p.mask_id("wxid_aaa")
        p._id_rev["wxid_9999"] = "someone"
        p._id_fwd.clear()
        p._id_rev[a] = "other_real"   # force collision for wxid_aaa's base
        b = p.mask_id("wxid_aaa")
        self.assertEqual(b, a + "~2")
        self.assertEqual(p.unmask(b), "wxid_aaa")


class StdioTest(_Base):
    def test_serve_stdio_in_process(self):
        s = self.make_server()
        lines = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
             "params": {"name": "get_messages", "arguments": {"chat": ALICE, "limit": 2}}},
        ]
        raw = ("\n".join(json.dumps(m, ensure_ascii=False) for m in lines) + "\n\nnot json\n").encode("utf-8")
        out = io.BytesIO()
        self.assertEqual(mcp_server.serve_stdio(s, stdin=io.BytesIO(raw), stdout=out), 0)
        frames = out.getvalue().decode("ascii").splitlines()
        self.assertEqual(len(frames), 3)
        r1, r2, r3 = (json.loads(f) for f in frames)
        self.assertEqual(r1["result"]["protocolVersion"], "2025-11-25")
        self.assertEqual(r2["id"], 2)
        self.assertEqual(r2["result"]["structuredContent"]["count"], 2)
        self.assertEqual(r3["error"]["code"], mcp_server.PARSE_ERROR)
        self.assertIsNone(r3["id"])

    def test_etcli_mcp_subprocess(self):
        reqs = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "list_contacts", "arguments": {"kind": "private", "min_messages": 1}}},
        ]
        stdin = "".join(json.dumps(r) + "\n" for r in reqs).encode("utf-8")
        proc = subprocess.run(
            [sys.executable, str(ROOT / "cli" / "etcli.py"), "mcp", "--data-dir", str(self.data_dir), "--privacy"],
            input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
        frames = [json.loads(l) for l in proc.stdout.decode("utf-8").splitlines() if l.strip()]
        self.assertEqual([f["id"] for f in frames], [1, 2, 3])
        self.assertEqual(frames[0]["result"]["serverInfo"]["name"], "murmur")
        self.assertEqual(len(frames[1]["result"]["tools"]), 7)
        items = frames[2]["result"]["structuredContent"]["items"]
        self.assertEqual(items[0]["name"], "朋友 WL")
        self.assertNotIn("爱丽丝", proc.stdout.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
