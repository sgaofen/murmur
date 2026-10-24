import json
import re
import sqlite3
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import error_codes as ec  # noqa: E402
import etcli  # noqa: E402


class ClassifyTest(unittest.TestCase):
    """Raw messages the backend / helper scripts really emit → stable codes."""

    CASES = (
        # etcli.py endpoints
        ("no_decrypted_data", ec.NO_DECRYPTED_DATA),
        ("onboarding_required", ec.NO_DECRYPTED_DATA),
        ("database_malformed", ec.DB_MALFORMED),
        ("origin_not_allowed", ec.ORIGIN_NOT_ALLOWED),
        ("key must be 64 hex chars", ec.KEY_FORMAT_INVALID),
        ("未找到 WeChat profile（请先在微信里登录一次）", ec.WECHAT_DATA_NOT_FOUND),
        ("没找到加密 DB — 让微信完成首次同步后再试", ec.WECHAT_DB_NOT_SYNCED),
        ("没找到 WeChat.app / Weixin.app；请先安装并打开微信，或设置 MURMUR_WECHAT_APP", ec.WECHAT_APP_NOT_FOUND),
        ("已保存路径，但里面还没找到 wxid_*/db_storage。请确认粘贴的是包含 xwechat_files 的路径", ec.WECHAT_DATA_NOT_FOUND),
        ("重签名被 macOS 系统授权窗口取消了。请重新点击重签名", ec.AUTH_CANCELLED),
        ("重签名被系统权限拦截。请先把 Murmur 拖到 Applications", ec.TCC_BLOCKED),
        ("codesign 重签名失败。请确认 WeChat 已退出", ec.RESIGN_FAILED),
        ("macOS only", ec.PLATFORM_UNSUPPORTED),
        ("QQ 导入目前只支持 Windows。Mac 版暂时可以继续使用微信数据", ec.PLATFORM_UNSUPPORTED),
        ("超时", ec.TIMEOUT),
        ("codex not installed", ec.AGENT_NOT_INSTALLED),
        # refresh.py
        ("找不到 Mac 解密密钥。\n请先回到 Murmur 点「密钥」", ec.KEY_NOT_FOUND),
        ("找不到密钥。请先运行：", ec.KEY_NOT_FOUND),
        ("找不到微信账号数据。请先在微信里登录一次。", ec.WECHAT_DATA_NOT_FOUND),
        ("[ERR] 核心数据库未解密: session.db", ec.DECRYPT_INCOMPLETE),
        ("FAIL session.db: wrong key  →  密钥不属于这个账号", ec.KEY_INVALID),
        ("FAIL a.db: database is locked", ec.DB_BUSY),
        ("FAIL a.db: disk I/O error", ec.DISK_IO),
        ("FAIL a.db: permission denied", ec.PERMISSION_DENIED),
        # extract_key_mac.py / extract_key_dll.py
        ("[ERR] no WeChat process found — start WeChat and log in first", ec.WECHAT_NOT_RUNNING),
        ("[ERR] task_for_pid denied.", ec.WECHAT_HARDENED),
        ("[ERR] no key matched any DB salt.", ec.KEY_NOT_FOUND),
        ("[X] Weixin.exe / WeChat.exe not running.", ec.WECHAT_NOT_RUNNING),
        ("[X] Hook install failed: (wx_key.dll did not return detail)", ec.WIN_HOOK_FAILED),
        ("[X] No key after 90s (30 polls).", ec.KEY_NOT_FOUND),
        ("[X] Could not find Weixin.exe path. Install WeChat", ec.WECHAT_APP_NOT_FOUND),
        # sqlite
        ("database disk image is malformed", ec.DB_MALFORMED),
        ("file is not a database", ec.DB_MALFORMED),
    )

    def test_known_messages(self) -> None:
        for raw, code in self.CASES:
            with self.subTest(raw=raw):
                self.assertEqual(ec.classify(raw), code)

    def test_unknown_and_empty(self) -> None:
        self.assertIsNone(ec.classify("something totally new"))
        self.assertIsNone(ec.classify(""))
        self.assertIsNone(ec.classify(None))

    def test_info_line_about_cleared_hardening_is_not_hardened(self) -> None:
        log = "[info] WeChat is ad-hoc signed (hardened runtime cleared).\n[ERR] no key matched any DB salt."
        self.assertEqual(ec.classify(log), ec.KEY_NOT_FOUND)

    def test_qq_scope_remaps_key_codes(self) -> None:
        self.assertEqual(ec.classify("wrong key: hmac mismatch", scope="qq"), ec.QQ_KEY_INVALID)
        self.assertEqual(ec.classify("no saved key — extract-key first", scope="qq"), ec.QQ_KEY_NOT_FOUND)
        self.assertEqual(ec.classify("qq 12345 not found in Tencent Files", scope="qq"), ec.QQ_DATA_NOT_FOUND)

    def test_all_codes_are_upper_snake(self) -> None:
        self.assertIn("WECHAT_NOT_RUNNING", ec.ALL_CODES)
        for c in ec.ALL_CODES:
            self.assertRegex(c, r"^[A-Z][A-Z0-9_]+$")
        for code, _ in ec._RULES:
            self.assertIn(code, ec.ALL_CODES)

    def test_frontend_catalog_covers_every_code(self) -> None:
        catalog = (ROOT / "app" / "src" / "data" / "errorCatalog.ts").read_text(encoding="utf-8")
        keys = set(re.findall(r"^  ([A-Z][A-Z0-9_]+): \{", catalog, re.MULTILINE))
        # Every backend code needs a frontend explanation; the catalog may
        # carry a few extra client-only codes (e.g. BACKEND_UNREACHABLE).
        self.assertEqual(set(ec.ALL_CODES) - keys, set())


class HelperTest(unittest.TestCase):
    def test_annotate_leaves_success_untouched(self) -> None:
        self.assertEqual(ec.annotate({"ok": True}), {"ok": True})
        self.assertEqual(ec.annotate({"running": True, "error": None}), {"running": True, "error": None})

    def test_annotate_keeps_original_error_and_explicit_code(self) -> None:
        p = ec.annotate({"ok": False, "error": "key must be 64 hex chars"})
        self.assertEqual(p["error"], "key must be 64 hex chars")
        self.assertEqual(p["code"], ec.KEY_FORMAT_INVALID)
        p = ec.annotate({"error": "超时", "code": "CUSTOM"})
        self.assertEqual(p["code"], "CUSTOM")

    def test_refresh_failure_code(self) -> None:
        self.assertIsNone(ec.refresh_failure_code("[DONE] ok", None, ok=True))
        self.assertEqual(ec.refresh_failure_code("", "OperationalError: no such table: SessionTable", ok=True),
                         ec.STORE_INIT_FAILED)
        self.assertEqual(ec.refresh_failure_code("", "DatabaseError: file is not a database", ok=True),
                         ec.DB_MALFORMED)
        self.assertEqual(ec.refresh_failure_code("[ERR] 核心数据库未解密: session.db"), ec.DECRYPT_INCOMPLETE)
        self.assertEqual(ec.refresh_failure_code("Traceback ... ValueError"), ec.DECRYPT_FAILED)

    def test_extract_key_failure_code_defaults_to_key_not_found(self) -> None:
        self.assertEqual(ec.extract_key_failure_code(""), ec.KEY_NOT_FOUND)
        self.assertEqual(ec.extract_key_failure_code("[ERR] task_for_pid denied."), ec.WECHAT_HARDENED)


class EndpointCodeTest(unittest.TestCase):
    """Real HTTP round-trips through _MurmurAPIHandler: `code` rides along
    with the untouched `error` text and the status code is unchanged."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._patches = [
            # Never touch the real disk / real WeChat data on the test machine.
            mock.patch.object(etcli, "discover_data_dir", return_value=None),
            mock.patch.object(etcli._MurmurAPIHandler, "store", None),
            mock.patch.object(etcli._MurmurAPIHandler, "_qq_load_keys_config", return_value={}, create=True),
        ]
        for p in cls._patches:
            p.start()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), etcli._MurmurAPIHandler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for p in cls._patches:
            p.stop()

    def _req(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_bootstrap_gate_returns_no_decrypted_data_code(self) -> None:
        status, body = self._req("GET", "/api/friends")
        self.assertEqual(status, 503)
        self.assertEqual(body["error"], "no_decrypted_data")
        self.assertEqual(body["code"], ec.NO_DECRYPTED_DATA)

    def test_save_key_rejects_bad_key_with_code(self) -> None:
        status, body = self._req("POST", "/api/save-key", {"key": "abc"})
        self.assertEqual(status, 200)  # unchanged: this branch always answered 200
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"], "key must be 64 hex chars")
        self.assertEqual(body["code"], ec.KEY_FORMAT_INVALID)

    def test_qq_endpoint_uses_qq_scope(self) -> None:
        status, body = self._req("POST", "/api/qq/decrypt", {"qq": "12345"})
        self.assertEqual(status, 400)
        self.assertEqual(body["code"], ec.QQ_KEY_NOT_FOUND)

    def test_disallowed_origin(self) -> None:
        status, body = self._req("GET", "/api/info", headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        self.assertEqual(body["code"], ec.ORIGIN_NOT_ALLOWED)

    def test_unhandled_exception_gets_internal_or_specific_code(self) -> None:
        with mock.patch.object(etcli._MurmurAPIHandler, "_dispatch_get", side_effect=RuntimeError("boom")):
            status, body = self._req("GET", "/api/anything")
        self.assertEqual(status, 500)
        self.assertEqual(body["error"], "boom")
        self.assertEqual(body["code"], ec.INTERNAL_ERROR)

        err = sqlite3.DatabaseError("database disk image is malformed")
        with mock.patch.object(etcli._MurmurAPIHandler, "_dispatch_get", side_effect=err):
            status, body = self._req("GET", "/api/anything")
        self.assertEqual(status, 503)
        self.assertEqual(body["error"], "database_malformed")
        self.assertEqual(body["code"], ec.DB_MALFORMED)


if __name__ == "__main__":
    unittest.main()
