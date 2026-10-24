"""/api/info reports export_dir (shown in the app's 设置 → 数据与目录)."""
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import etcli  # noqa: E402
from etcli import EchoStore, _MurmurAPIHandler  # noqa: E402


def make_minimal_store(tmp_path: Path) -> EchoStore:
    data_dir = tmp_path / "wxid_abc123"
    data_dir.mkdir()
    conn = sqlite3.connect(data_dir / "session.db")
    try:
        conn.execute("CREATE TABLE SessionTable (username TEXT)")
    finally:
        conn.close()
    return EchoStore(data_dir)


class ApiInfoExportDirTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.export_dir = self.tmp / "exports"
        saved = {name: _MurmurAPIHandler.__dict__.get(name) for name in ("store", "export_dir")}
        self.addCleanup(self._restore, saved)
        _MurmurAPIHandler.export_dir = self.export_dir

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _MurmurAPIHandler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def _restore(self, saved: dict) -> None:
        for name, value in saved.items():
            setattr(_MurmurAPIHandler, name, value)
        self._tmp.cleanup()

    def _get_info(self) -> dict:
        port = self.server.server_address[1]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info", timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def test_info_with_store_includes_export_dir(self) -> None:
        store = make_minimal_store(self.tmp)
        _MurmurAPIHandler.store = store

        info = self._get_info()

        self.assertEqual(info["export_dir"], str(self.export_dir))
        self.assertEqual(info["data_dir"], str(store.dir))
        self.assertNotIn("bootstrap", info)

    def test_bootstrap_info_includes_export_dir(self) -> None:
        _MurmurAPIHandler.store = None
        # Keep the bootstrap probe away from the real machine's WeChat data.
        with mock.patch.object(etcli, "discover_data_dir", return_value=None), \
                mock.patch.object(etcli._paths, "discover_wechat_profiles", return_value=[]), \
                mock.patch.object(etcli._paths, "detect_capabilities",
                                  return_value=SimpleNamespace(can_decrypt_db=False)):
            info = self._get_info()

        self.assertTrue(info["bootstrap"])
        self.assertIsNone(info["data_dir"])
        self.assertEqual(info["export_dir"], str(self.export_dir))


if __name__ == "__main__":
    unittest.main()
