"""While a macOS key-capture round runs (Frida live capture or the Frida-free
private copy), /api/resign-wechat and the Mac memory scan (/api/extract-key)
must refuse with 409 + KEY_CAPTURE_BUSY instead of killing WeChat under the
round or stacking a second admin-password prompt.

No real WeChat, codesign or osascript is touched: the jobs are fakes, and the
"nothing running" cases stop at a mocked "WeChat not found" before any side
effect.
"""
import json
import sys
import threading
import types
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


class _FakeJob:
    def __init__(self, running: bool) -> None:
        self.running = running

    def status(self) -> dict:
        return {"running": self.running, "phase": "capturing" if self.running else "idle"}


class KeyCaptureRunningTest(unittest.TestCase):
    def setUp(self) -> None:
        p1 = mock.patch.object(etcli, "_LIVE_KEY_JOB", None)
        p2 = mock.patch.object(etcli, "_PRIVATE_COPY_JOB", None)
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)

    def test_no_jobs_created(self) -> None:
        self.assertIsNone(etcli._key_capture_running())

    def test_idle_jobs(self) -> None:
        etcli._LIVE_KEY_JOB = _FakeJob(False)
        etcli._PRIVATE_COPY_JOB = _FakeJob(False)
        self.assertIsNone(etcli._key_capture_running())

    def test_live_key_running(self) -> None:
        etcli._LIVE_KEY_JOB = _FakeJob(True)
        self.assertEqual(etcli._key_capture_running(), "live-key")

    def test_private_copy_running(self) -> None:
        etcli._LIVE_KEY_JOB = _FakeJob(False)
        etcli._PRIVATE_COPY_JOB = _FakeJob(True)
        self.assertEqual(etcli._key_capture_running(), "private-copy")

    def test_code_is_registered(self) -> None:
        self.assertIn(ec.KEY_CAPTURE_BUSY, ec.ALL_CODES)


class KeyCaptureGuardEndpointTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._patches = [
            mock.patch.object(etcli, "discover_data_dir", return_value=None),
            mock.patch.object(etcli._MurmurAPIHandler, "store", None),
            # Pretend to be a Mac so the Mac-only branches run on every CI OS.
            mock.patch.object(etcli._paths, "IS_MAC", True),
            # Safety net: if a guard ever stops working, the request falls
            # through to "WeChat not found" instead of touching the real app.
            mock.patch.object(etcli._paths, "find_weixin_exe", return_value=None),
            mock.patch.object(etcli._paths, "wechat_main_exec", return_value=None),
            mock.patch.object(etcli._paths, "discover_wechat_profiles", return_value=[]),
            # The Mac branch imports extract_key_mac, which exits without
            # `cryptography` (CI installs no deps); it is never reached past
            # "no profile" here, so a stub is enough.
            mock.patch.dict(sys.modules, {"extract_key_mac": types.SimpleNamespace(collect_db_salts=lambda prof: {})}),
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

    def setUp(self) -> None:
        p1 = mock.patch.object(etcli, "_LIVE_KEY_JOB", None)
        p2 = mock.patch.object(etcli, "_PRIVATE_COPY_JOB", None)
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)

    def _post(self, path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode("utf-8"),
                                     method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_resign_refused_while_live_key_runs(self) -> None:
        etcli._LIVE_KEY_JOB = _FakeJob(True)
        status, body = self._post("/api/resign-wechat", {"relaunch": True})
        self.assertEqual(status, 409)
        self.assertFalse(body["ok"])
        self.assertEqual(body["code"], ec.KEY_CAPTURE_BUSY)
        self.assertEqual(body["busy"], "live-key")

    def test_resign_refused_while_private_copy_runs(self) -> None:
        etcli._PRIVATE_COPY_JOB = _FakeJob(True)
        status, body = self._post("/api/resign-wechat", {"relaunch": True})
        self.assertEqual(status, 409)
        self.assertEqual(body["code"], ec.KEY_CAPTURE_BUSY)
        self.assertEqual(body["busy"], "private-copy")

    def test_memory_scan_refused_while_live_key_runs(self) -> None:
        etcli._LIVE_KEY_JOB = _FakeJob(True)
        status, body = self._post("/api/extract-key", {"auto_restart": False, "timeout": 90})
        self.assertEqual(status, 409)
        self.assertEqual(body["code"], ec.KEY_CAPTURE_BUSY)

    def test_memory_scan_refused_while_private_copy_runs(self) -> None:
        etcli._PRIVATE_COPY_JOB = _FakeJob(True)
        status, body = self._post("/api/extract-key", {"auto_restart": False, "timeout": 90})
        self.assertEqual(status, 409)
        self.assertEqual(body["busy"], "private-copy")

    def test_resign_goes_ahead_when_idle(self) -> None:
        etcli._LIVE_KEY_JOB = _FakeJob(False)
        etcli._PRIVATE_COPY_JOB = _FakeJob(False)
        status, body = self._post("/api/resign-wechat", {"relaunch": True})
        self.assertEqual(status, 200)
        self.assertFalse(body["ok"])
        self.assertEqual(body["code"], ec.WECHAT_APP_NOT_FOUND)  # reached the real handler body

    def test_memory_scan_goes_ahead_when_idle(self) -> None:
        status, body = self._post("/api/extract-key", {"auto_restart": False, "timeout": 90})
        self.assertEqual(status, 200)
        self.assertFalse(body["ok"])
        self.assertEqual(body["code"], ec.WECHAT_DATA_NOT_FOUND)


if __name__ == "__main__":
    unittest.main()
