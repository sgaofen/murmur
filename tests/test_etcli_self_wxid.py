import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

from etcli import EchoStore  # noqa: E402


def make_minimal_store(tmp_path: Path, dirname: str) -> EchoStore:
    data_dir = tmp_path / dirname
    data_dir.mkdir()
    conn = sqlite3.connect(data_dir / "session.db")
    try:
        conn.execute("CREATE TABLE SessionTable (username TEXT)")
    finally:
        conn.close()
    return EchoStore(data_dir)


class EchoStoreSelfWxidTest(unittest.TestCase):
    def test_guess_self_wxid_allows_non_wxid_account_short(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = make_minimal_store(Path(tmp), "alias123456789")

        self.assertEqual(store.me, "alias123456789")

    def test_guess_self_wxid_keeps_wxid_account_short(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = make_minimal_store(Path(tmp), "wxid_abc123")

        self.assertEqual(store.me, "wxid_abc123")


if __name__ == "__main__":
    unittest.main()
