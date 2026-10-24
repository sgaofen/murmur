"""Export formats + media policy on synthetic data (no third-party deps)."""
import csv
import hashlib
import io
import json
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import exporters  # noqa: E402
import export_media  # noqa: E402
from etcli import EchoStore  # noqa: E402

ME = "wxid_me"
PEER = "wxid_friend"
GROUP = "123@chatroom"
MEMBER = "wxid_member"

IMG_OK = "a" * 32       # decrypted original exists
IMG_THUMB = "b" * 32    # only thumbnail decrypted, source .dat still on disk
IMG_GONE = "c" * 32     # in hardlink.db, source deleted, nothing decrypted
IMG_UNKNOWN = "d" * 32  # never downloaded (not in hardlink.db)
IMG_WXGF = "e" * 32     # decrypted, but only as .wxgf
VID_OK = "f" * 32       # video file present


def img_xml(md5):
    return f'<?xml version="1.0"?><msg><img aeskey="k" length="10" md5="{md5}" /></msg>'


def vid_xml(md5):
    return f'<?xml version="1.0"?><msg><videomsg length="9" playlength="3" md5="{md5}" /></msg>'


def build_store(tmp: Path, rows_by_chat):
    """Minimal WeChat-4-shaped decrypted dir → real EchoStore."""
    d = tmp / ME
    d.mkdir()
    c = sqlite3.connect(d / "session.db")
    c.execute("CREATE TABLE SessionTable (username TEXT)")
    for chat in rows_by_chat:
        c.execute("INSERT INTO SessionTable VALUES (?)", (chat,))
    c.commit(); c.close()
    c = sqlite3.connect(d / "contact.db")
    c.execute("CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, alias TEXT, local_type INT)")
    c.execute("CREATE TABLE chat_room (username TEXT)")
    c.executemany("INSERT INTO contact VALUES (?,?,?,?,?)", [
        (ME, "", "我自己", "", 1),
        (PEER, "老王, \"大哥\"", "wang", "", 1),
        (MEMBER, "", "群友=甲", "", 3),
        (GROUP, "", "周末*爬山*群", "", 2),
    ])
    c.execute("INSERT INTO chat_room VALUES (?)", (GROUP,))
    c.commit(); c.close()
    c = sqlite3.connect(d / "message_0.db")
    c.execute("CREATE TABLE Name2Id (user_name TEXT)")
    ids = {}
    for u in (ME, PEER, MEMBER):
        cur = c.execute("INSERT INTO Name2Id VALUES (?)", (u,))
        ids[u] = cur.lastrowid
    for chat, rows in rows_by_chat.items():
        t = "Msg_" + hashlib.md5(chat.encode()).hexdigest()
        c.execute(f"CREATE TABLE {t} (local_id INTEGER, create_time INT, real_sender_id INT, "
                  f"local_type INT, message_content TEXT)")
        for i, (ts, sender, mtype, content) in enumerate(rows, 1):
            c.execute(f"INSERT INTO {t} VALUES (?,?,?,?,?)", (i, ts, ids[sender], mtype, content))
    c.commit(); c.close()
    return EchoStore(d)


T0 = 1700000000  # 2023-11-15 06:13:20 CST

PRIVATE_ROWS = [
    (T0, PEER, 1, '你好，"朋友"\n第二行, 有逗号'),
    (T0 + 60, ME, 1, "=HYPERLINK(\"http://x\")"),
    (T0 + 120, ME, 1, "# 不是标题\n- 也不是列表 <b>"),
    (T0 + 180, PEER, 3, img_xml(IMG_OK)),
    (T0 + 240, PEER, 3, img_xml(IMG_THUMB)),
    (T0 + 300, ME, 3, img_xml(IMG_GONE)),
    (T0 + 360, ME, 3, img_xml(IMG_UNKNOWN)),
    (T0 + 420, PEER, 3, img_xml(IMG_WXGF)),
    (T0 + 480, PEER, 43, vid_xml(VID_OK)),
    (T0 + 540, PEER, 3, "<msg>broken</msg>"),
    (T0 + 86400, PEER, 49, "<msg><appmsg><title>转账</title><type>2000</type></appmsg></msg>"),
    (T0 + 86460, PEER, 10000, "\"老王\" 拍了拍我"),
]

GROUP_ROWS = [
    (T0, MEMBER, 1, f"{MEMBER}:\n大家好"),
    (T0 + 30, ME, 1, "hi"),
    (T0 + 60, PEER, 1, f"{PEER}:\n来了"),
]


def build_media_layout(tmp: Path):
    """hardlink.db + decrypted media dir + raw xwechat_files dir."""
    decrypted = tmp / ME
    media_root = tmp / "media" / ME
    wechat = tmp / "xwechat_files" / ME
    (media_root / "all").mkdir(parents=True)
    c = sqlite3.connect(decrypted / "hardlink.db")
    c.execute("CREATE TABLE dir2id (username TEXT)")
    for name in ("chathash", "2023-11"):
        c.execute("INSERT INTO dir2id VALUES (?)", (name,))
    c.execute("CREATE TABLE image_hardlink_info_v4 (md5 TEXT, file_name TEXT, dir1 INT, dir2 INT, file_size INT)")
    c.execute("CREATE TABLE video_hardlink_info_v4 (md5 TEXT, file_name TEXT, dir1 INT, dir2 INT, file_size INT)")
    for md5, stem in ((IMG_OK, "s_ok"), (IMG_THUMB, "s_thumb"), (IMG_GONE, "s_gone"), (IMG_WXGF, "s_wxgf")):
        c.execute("INSERT INTO image_hardlink_info_v4 VALUES (?,?,1,2,10)", (md5, stem + ".dat"))
    c.execute("INSERT INTO video_hardlink_info_v4 VALUES (?,?,2,0,10)", (VID_OK, "v1.mp4"))
    c.commit(); c.close()
    (media_root / "all" / "s_ok.jpg").write_bytes(b"\xff\xd8\xffORIG")
    (media_root / "all" / "s_ok_t.jpg").write_bytes(b"\xff\xd8\xffTHUMB")
    (media_root / "all" / "s_thumb_t.jpg").write_bytes(b"\xff\xd8\xffTHUMB2")
    (media_root / "all" / "s_wxgf.wxgf").write_bytes(b"wxgf")
    img_dir = wechat / "msg" / "attach" / "chathash" / "2023-11" / "Img"
    img_dir.mkdir(parents=True)
    (img_dir / "s_thumb.dat").write_bytes(b"enc")
    vid_dir = wechat / "msg" / "video" / "2023-11"
    vid_dir.mkdir(parents=True)
    (vid_dir / "v1.mp4").write_bytes(b"mp4")
    (vid_dir / "v1_thumb.jpg").write_bytes(b"\xff\xd8\xffVT")
    return export_media.MediaResolver(decrypted, media_root, wechat)


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.store = build_store(self.tmp, {PEER: PRIVATE_ROWS, GROUP: GROUP_ROWS})

    def tearDown(self):
        try:
            self._tmp.cleanup()
        except OSError:
            pass  # Windows: sqlite handles can linger briefly

    def export(self, fmt, chat=PEER):
        buf = io.StringIO()
        n = exporters.write_export(chat, fmt, buf, store=self.store)
        return n, buf.getvalue()


class FormatTests(Base):
    def test_csv_bom_header_and_escaping(self):
        n, out = self.export("csv")
        self.assertEqual(n, len(PRIVATE_ROWS))
        self.assertTrue(out.startswith("﻿"))
        # The BOM must become EF BB BF once encoded for the HTTP body.
        self.assertTrue(out.encode("utf-8").startswith(b"\xef\xbb\xbf"))
        rows = list(csv.reader(io.StringIO(out[1:], newline="")))
        self.assertEqual(rows[0], exporters.CSV_COLUMNS)
        self.assertEqual(len(rows), len(PRIVATE_ROWS) + 1)
        first = dict(zip(rows[0], rows[1]))
        # quotes, comma and newline survive a round trip
        self.assertEqual(first["text"], '你好，"朋友"\n第二行, 有逗号')
        self.assertEqual(first["sender"], '老王, "大哥"')
        self.assertEqual(first["time"], "2023-11-15 06:13:20")
        self.assertEqual(first["timestamp"], str(T0))
        # formula injection neutralised
        self.assertEqual(rows[2][5], "'=HYPERLINK(\"http://x\")")
        self.assertIn("\r\n", out)

    def test_csv_formula_guard_is_narrow(self):
        self.assertEqual(exporters._csv_cell("-_-"), "-_-")
        self.assertEqual(exporters._csv_cell("+1"), "+1")
        self.assertEqual(exporters._csv_cell("@sum"), "'@sum")
        self.assertEqual(exporters._csv_cell("-1+cmd|' /C calc'!A0"), "'-1+cmd|' /C calc'!A0")

    def test_markdown_structure(self):
        n, out = self.export("md")
        lines = out.split("\n")
        self.assertTrue(lines[0].startswith("# 与 老王, \"大哥\" 的聊天记录"))
        self.assertEqual([l for l in lines if l.startswith("## ")], ["## 2023-11-15", "## 2023-11-16"])
        self.assertIn("**你** · 06:14", out)
        # user text can't create headings / lists / raw HTML
        self.assertIn("\\# 不是标题", out)
        self.assertIn("\\- 也不是列表 &lt;b>", out)
        self.assertNotIn("\n# 不是标题", out)

    def test_markdown_escapes_sender_asterisks(self):
        n, out = self.export("md", chat=GROUP)
        self.assertTrue(out.startswith("# 与 周末*爬山*群 的聊天记录"))
        self.assertIn("**群友=甲** · 06:13", out)

    def test_chatlab_schema_private(self):
        n, out = self.export("chatlab")
        doc = json.loads(out)
        self.assertEqual(set(doc), {"chatlab", "meta", "members", "messages"})
        self.assertEqual(doc["chatlab"]["version"], "0.0.2")
        self.assertIsInstance(doc["chatlab"]["exportedAt"], int)
        self.assertEqual(doc["meta"], {"name": '老王, "大哥"', "platform": "wechat",
                                       "type": "private", "ownerId": ME})
        member_ids = {m["platformId"] for m in doc["members"]}
        self.assertEqual(member_ids, {ME, PEER})
        for m in doc["members"]:
            self.assertEqual(set(m), {"platformId", "accountName"})
        allowed = {"sender", "accountName", "timestamp", "type", "content"}
        valid_types = {0, 1, 2, 3, 4, 5, 7, 8, 20, 21, 22, 23, 24, 25, 26, 27, 80, 81, 99}
        for msg in doc["messages"]:
            self.assertTrue(set(msg) <= allowed | {"groupNickname", "platformMessageId", "replyToMessageId"})
            self.assertTrue(allowed <= set(msg))
            self.assertIn(msg["sender"], member_ids)  # every sender references a member
            self.assertIn(msg["type"], valid_types)
            self.assertIsInstance(msg["timestamp"], int)
            self.assertLess(msg["timestamp"], 10 ** 11)  # seconds, not ms
        types = [m["type"] for m in doc["messages"]]
        self.assertEqual(types[0], 0)
        self.assertEqual(types[3], 1)       # image
        self.assertEqual(types[8], 3)       # video
        self.assertEqual(types[10], 21)     # appmsg 2000 → TRANSFER
        self.assertEqual(types[11], 22)     # 拍一拍 → POKE
        self.assertEqual(doc["messages"][1]["sender"], ME)

    def test_chatlab_type_packed_appmsg(self):
        packed = lambda sub: (sub << 32) | 49  # noqa: E731
        self.assertEqual(exporters.chatlab_type(packed(5), None, ""), 7)       # link
        self.assertEqual(exporters.chatlab_type(packed(6), None, ""), 4)       # file
        self.assertEqual(exporters.chatlab_type(packed(57), None, ""), 25)     # reply
        self.assertEqual(exporters.chatlab_type(packed(2001), None, ""), 20)   # red packet
        self.assertEqual(exporters.chatlab_type(packed(62), None, ""), 22)     # pat
        # legacy 49: the quoted message's <type> must not win
        raw = "<msg><appmsg><title>好</title><type>57</type><refermsg><type>1</type></refermsg></appmsg></msg>"
        self.assertEqual(exporters.chatlab_type(49, raw, ""), 25)
        raw = "<msg><appmsg><refermsg><type>3</type></refermsg><type>57</type></appmsg></msg>"
        self.assertEqual(exporters.chatlab_type(49, raw, ""), 25)
        self.assertEqual(exporters.chatlab_type(12345, None, ""), 99)

    def test_chatlab_group(self):
        n, out = self.export("chatlab", chat=GROUP)
        doc = json.loads(out)
        self.assertEqual(doc["meta"]["type"], "group")
        self.assertEqual(doc["meta"]["groupId"], GROUP)
        self.assertEqual({m["platformId"] for m in doc["members"]}, {ME, PEER, MEMBER})
        self.assertEqual(doc["messages"][0]["content"], "大家好")

    def test_json_txt_html_still_work(self):
        n, out = self.export("json")
        doc = json.loads(out)
        self.assertEqual(doc["format_version"], 1)
        self.assertEqual(len(doc["messages"]), len(PRIVATE_ROWS))
        self.assertNotIn("media", doc["messages"][3])
        n, out = self.export("txt")
        self.assertIn("[2023-11-15 06:13:20] 老王", out)
        n, out = self.export("html")
        self.assertIn("&lt;b&gt;", out)

    def test_unknown_format(self):
        with self.assertRaises(ValueError):
            exporters.write_export(PEER, "xlsx", io.StringIO(), store=self.store)
        self.assertEqual(exporters.http_export_meta("chatlab"), ("application/json", "chatlab.json"))
        self.assertEqual(exporters.http_export_meta("csv")[1], "csv")


class MediaTests(Base):
    def run_export(self, policy, fmt="md"):
        resolver = build_media_layout(self.tmp)
        return exporters.export_to_dir(self.store, PEER, fmt, policy, self.tmp / "out", resolver=resolver)

    def test_originals_policy(self):
        rep = self.run_export("originals")
        m = rep["media"]
        self.assertEqual(m["media_messages"], 7)
        self.assertEqual(m["exported_original"], 2)     # IMG_OK + VID_OK
        self.assertEqual(m["exported_thumbnail"], 0)
        self.assertEqual(m["missing_total"], 5)
        self.assertEqual(m["missing_reasons"], {
            "not_decrypted": 1, "not_downloaded": 2, "unsupported_format": 1, "no_media_ref": 1,
        })
        self.assertEqual(m["thumbnail_skipped"], 1)
        out_dir = Path(rep["dir"])
        self.assertEqual(sorted(p.name for p in (out_dir / "media").iterdir()), ["s_ok.jpg", "v1.mp4"])
        self.assertEqual((out_dir / "media" / "s_ok.jpg").read_bytes(), b"\xff\xd8\xffORIG")
        md = Path(rep["file"]).read_text(encoding="utf-8")
        self.assertIn("![图片](<media/s_ok.jpg>)", md)
        self.assertIn("[视频](<media/v1.mp4>)", md)
        report = (out_dir / "导出报告.md").read_text(encoding="utf-8")
        self.assertIn("共 12 条", report)
        self.assertIn("附件导出成功：2 个", report)
        self.assertIn("附件缺失：5 个", report)
        self.assertIn(export_media.REASON_LABELS["not_decrypted"], report)

    def test_best_policy_falls_back_to_thumbnail(self):
        rep = self.run_export("best", fmt="json")
        m = rep["media"]
        self.assertEqual(m["exported_original"], 2)
        self.assertEqual(m["exported_thumbnail"], 1)    # IMG_THUMB → s_thumb_t.jpg
        self.assertEqual(m["missing_total"], 4)
        doc = json.loads(Path(rep["file"]).read_text(encoding="utf-8"))
        rels = [x.get("media") for x in doc["messages"]]
        self.assertEqual(rels[3], "media/s_ok.jpg")
        self.assertEqual(rels[4], "media/s_thumb_t.jpg")
        self.assertIsNone(rels[5])
        self.assertTrue(all(r is None or not ("\\" in r or r.startswith("/")) for r in rels))
        for r in filter(None, rels):
            self.assertTrue((Path(rep["dir"]) / r).is_file())

    def test_csv_and_html_reference_media(self):
        rep = self.run_export("originals", fmt="csv")
        rows = list(csv.reader(io.StringIO(Path(rep["file"]).read_text(encoding="utf-8-sig"), newline="")))
        self.assertEqual(rows[4][6], "media/s_ok.jpg")
        rep = exporters.export_to_dir(self.store, PEER, "html", "originals", self.tmp / "out2",
                                      resolver=build_media_layout_again(self.tmp))
        html = Path(rep["file"]).read_text(encoding="utf-8")
        self.assertIn('<img loading="lazy" src="media/s_ok.jpg"', html)
        self.assertIn('<video controls preload="none" src="media/v1.mp4">', html)

    def test_none_policy_copies_nothing(self):
        rep = self.run_export("none")
        self.assertEqual(rep["media"]["media_messages"], 0)
        self.assertFalse((Path(rep["dir"]) / "media").exists())
        self.assertTrue((Path(rep["dir"]) / "导出报告.md").is_file())

    def test_platform_unsupported(self):
        media = export_media.MediaExporter("best", self.tmp / "x", None, platform_supported=False)
        self.assertIsNone(media.handle(3, img_xml(IMG_OK)))
        self.assertIsNone(media.handle(1, "text"))
        self.assertEqual(media.summary()["missing_reasons"], {"platform_unsupported": 1})

    def test_bad_policy(self):
        with self.assertRaises(ValueError):
            export_media.MediaExporter("all", self.tmp, None)

    def test_with_raw_only_for_media_rows(self):
        msgs = list(self.store.messages(PEER, with_raw=True))
        self.assertIsNone(msgs[0].raw)
        self.assertIn(IMG_OK, msgs[3].raw)
        self.assertEqual(msgs[3].local_id, 4)
        plain = list(self.store.messages(PEER))
        self.assertIsNone(plain[3].raw)


class FollowupTests(unittest.TestCase):
    """Review follow-up for #36: no remote-image tracking in Markdown exports,
    and exports with attachments (disk side effect) are POST-only."""

    META = exporters.ChatMeta(chat_id="wxid_x", name="![n](https://t.example/name.png)",
                              is_group=False, platform="wechat", self_id="self", self_name="我")

    def _rec(self, text, sender="老王"):
        return {"ts": T0, "time": "2023-11-15 06:13:20", "from_id": "wxid_x", "from": sender,
                "type": "text", "type_id": 1, "text": text, "media": None, "chatlab_type": 0}

    def test_markdown_neutralizes_remote_images(self):
        recs = [self._rec("看 ![x](https://t.example/p.png) 和 ![a][r]\n[r]: https://t.example/q.png"),
                self._rec("hi", sender="![s](https://t.example/s.png)"),
                self._rec("真的!太好了 [链接](https://example.com)")]
        buf = io.StringIO()
        exporters.write_md(self.META, recs, buf)
        out = buf.getvalue()
        # every "![" that survives is backslash-escaped
        self.assertIsNone(re.search(r"!\[", out.replace("!\\[", "")))
        self.assertIn("!\\[x](https://t.example/p.png)", out)
        self.assertIn("!\\[a][r]", out)
        self.assertIn("# 与 !\\[n]", out)
        self.assertIn("**!\\[s]", out)
        self.assertIn("真的!太好了", out)  # plain "!" untouched

    def test_attachment_links_stay_images(self):
        # Our own attachment links are written after escaping, so they still embed.
        rec = dict(self._rec("[图片]"), type_id=3, media="media/a.jpg")
        buf = io.StringIO()
        exporters.write_md(self.META, [rec], buf)
        self.assertIn("![图片](<media/a.jpg>)", buf.getvalue())

    def test_pair_markdown_neutralizes_images(self):
        from unittest import mock
        with mock.patch.object(exporters, "_pair_meta",
                               return_value={"pack_md": "# A x B\n> ![p](https://t.example/x.png)\n"}):
            buf = io.StringIO()
            exporters.export_pair_txt("a", "b", buf)
        self.assertIn("!\\[p]", buf.getvalue())


class ExportEndpointTests(unittest.TestCase):
    def setUp(self):
        import etcli
        self.etcli = etcli
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _call(self, method, path, body=None):
        from unittest import mock
        cls = self.etcli._MurmurAPIHandler
        h = cls.__new__(cls)
        raw = json.dumps(body).encode("utf-8") if body is not None else b""
        h.headers = {"Content-Length": str(len(raw))}
        h.rfile = io.BytesIO(raw)
        h.path = path
        sent = {}

        def fake_send(payload, status=200):
            sent["payload"], sent["status"] = payload, status
        h._send_json = fake_send
        with mock.patch.object(cls, "store", object()), \
                mock.patch.object(cls, "export_dir", self.tmp), \
                mock.patch.object(exporters, "export_to_dir",
                                  return_value={"ok": True, "dir": "d"}) as etd:
            (h._dispatch_get if method == "GET" else h._dispatch_post)()
        return sent, etd

    def test_get_with_media_is_refused(self):
        sent, etd = self._call("GET", "/api/export?wxid=wxid_x&format=md&media=best")
        etd.assert_not_called()
        self.assertEqual(sent["status"], 405)
        self.assertIn("POST", sent["payload"]["error"])

    def test_post_exports_with_media(self):
        sent, etd = self._call("POST", "/api/export", {"wxid": "wxid_x", "format": "md", "media": "best"})
        self.assertEqual(sent["status"], 200)
        self.assertEqual(sent["payload"], {"ok": True, "dir": "d"})
        args = etd.call_args[0]
        self.assertEqual(args[1:4], ("wxid_x", "md", "best"))
        self.assertEqual(args[4], self.tmp / "聊天导出")

    def test_post_validates_input(self):
        for body in ({"format": "md", "media": "best"},
                     {"wxid": "wxid_x", "format": "xlsx", "media": "best"},
                     {"wxid": "wxid_x", "format": "md", "media": "none"},
                     {"wxid": "wxid_x", "format": "md", "media": "all"},
                     ["not", "a", "dict"]):
            with self.subTest(body=body):
                sent, etd = self._call("POST", "/api/export", body)
                etd.assert_not_called()
                self.assertEqual(sent["status"], 400)

    def test_frontend_uses_post_for_media_exports(self):
        api = (ROOT / "app" / "src" / "data" / "api.ts").read_text(encoding="utf-8")
        fn = api[api.index("export async function exportFriendChat"):]
        fn = fn[:fn.index("\n}\n")]
        self.assertIn("method: 'POST'", fn)
        self.assertNotIn("&media=", fn)


def build_media_layout_again(tmp: Path):
    # Layout already exists from the first export in the same test.
    return export_media.MediaResolver(tmp / ME, tmp / "media" / ME, tmp / "xwechat_files" / ME)


class PairCsvTests(unittest.TestCase):
    def test_pair_csv(self):
        meta = {"evidence": {
            "direct_edges": [{"type": "mention", "source": "a", "target": "b", "mention_count": 3,
                              "samples": ["x"]}],
            "weak_edges": [{"type": "co_group", "source": "a", "target": "b", "weight": 0.5}],
        }}
        buf = io.StringIO()
        n = exporters.write_pair_csv(meta, buf)
        self.assertEqual(n, 2)
        out = buf.getvalue()
        self.assertTrue(out.startswith("﻿"))
        rows = list(csv.reader(io.StringIO(out[1:], newline="")))
        self.assertEqual(rows[0], ["evidence", "type", "source", "target", "mention_count", "weight"])
        self.assertEqual(rows[1], ["direct", "mention", "a", "b", "3", ""])
        self.assertEqual(rows[2], ["weak", "co_group", "a", "b", "", "0.5"])
        self.assertIn("md", exporters.PAIR_FORMATS)
        self.assertIn("csv", exporters.PAIR_FORMATS)


if __name__ == "__main__":
    unittest.main()
