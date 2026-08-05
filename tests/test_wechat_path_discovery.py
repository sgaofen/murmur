"""Regression tests for manually-pasted WeChat data paths.

Reported from the field (Windows): pasting the folder WeChat's 「文件管理」
shows still ended in "已保存路径，但里面还没找到 wxid_*/db_storage". Two
independent causes, both covered here:

  1. `_windows_xwechat_variants` enumerates a fixed set of wrapper folder names,
     so any custom layout (`D:\\Weixin\\xwechat_files`, `D:\\微信文件\\...`)
     was invisible no matter which level the user pasted.
  2. `_looks_like_account_dir` rejected every directory whose name started with
     "all" — intended for `all_users`, but it also swallowed real accounts
     (`allen_9f3a`).
"""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cli import paths  # noqa: E402


def make_tree(base: Path, rel: str, account: str = "wxid_a1b2c3d4e5") -> Path:
    """Create <base>/<rel>/<account>/db_storage/session/session.db."""
    session = base / rel / account / "db_storage" / "session"
    session.mkdir(parents=True, exist_ok=True)
    (session / "session.db").write_bytes(b"SQLite format 3\x00" + b"\x00" * 64)
    return base / rel / account


class WeChatPathDiscoveryTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        cfg = self.tmp / "config.json"
        cfg.write_text("{}", encoding="utf-8")

        self.cfg = cfg
        self._orig_cfg_path = paths.murmur_config_path
        self._orig_is_windows = paths.IS_WINDOWS
        self._orig_is_mac = paths.IS_MAC
        paths.murmur_config_path = lambda: cfg
        # Exercise the Windows-only branches regardless of the host OS.
        paths.IS_WINDOWS = True
        paths.IS_MAC = False

    def tearDown(self) -> None:
        paths.murmur_config_path = self._orig_cfg_path
        paths.IS_WINDOWS = self._orig_is_windows
        paths.IS_MAC = self._orig_is_mac
        self._tmp.cleanup()

    def discover_after_pasting(self, pasted: Path) -> list[str]:
        # save_wechat_root() keeps up to 8 previous roots, so each case starts
        # from a clean config — otherwise earlier subTests leak in as extra hits.
        self.cfg.write_text("{}", encoding="utf-8")
        paths.save_wechat_root(str(pasted))
        return [p.wxid for p in paths.discover_wechat_profiles()]

    # ── layout variants: the user pastes WeChat's configured storage folder ──

    def test_finds_account_under_custom_wrapper_folders(self) -> None:
        for rel in (
            "xwechat_files",
            "Tencent/xwechat_files",
            "WeChat/xwechat_files",
            "Weixin/xwechat_files",
            "wechatData/xwechat_files",
            "微信文件/xwechat_files",
            "data/wx/xwechat_files",
        ):
            with self.subTest(layout=rel):
                base = Path(tempfile.mkdtemp(dir=self.tmp))
                make_tree(base, rel)
                self.assertEqual(
                    self.discover_after_pasting(base), ["wxid_a1b2c3d4e5"]
                )

    def test_finds_account_at_every_level_the_user_might_paste(self) -> None:
        base = Path(tempfile.mkdtemp(dir=self.tmp))
        account = make_tree(base, "xwechat_files")
        for label, pasted in (
            ("parent of xwechat_files", base),
            ("xwechat_files", account.parent),
            ("account dir", account),
            ("db_storage", account / "db_storage"),
            ("a .db file", account / "db_storage" / "session" / "session.db"),
        ):
            with self.subTest(pasted=label):
                self.assertEqual(
                    self.discover_after_pasting(pasted), ["wxid_a1b2c3d4e5"]
                )

    # ── account names beginning with "all" ──

    def test_account_named_like_all_users_is_still_found(self) -> None:
        for account in ("allen_9f3a", "ally_1a2b", "alice_2b7c"):
            with self.subTest(account=account):
                base = Path(tempfile.mkdtemp(dir=self.tmp))
                make_tree(base, "xwechat_files", account=account)
                self.assertEqual(self.discover_after_pasting(base), [account])

    def test_all_users_directory_is_still_ignored(self) -> None:
        base = Path(tempfile.mkdtemp(dir=self.tmp))
        make_tree(base, "xwechat_files", account="wxid_real1234")
        # WeChat ships a shared `all_users` folder next to the real accounts;
        # giving it a db_storage must not make it look like an account.
        noise = base / "xwechat_files" / "all_users" / "db_storage"
        noise.mkdir(parents=True)
        (noise / "x.db").write_bytes(b"SQLite format 3\x00")
        self.assertEqual(self.discover_after_pasting(base), ["wxid_real1234"])

    # ── guards on the bounded descent ──

    def test_empty_account_shell_is_not_reported(self) -> None:
        # db_storage exists but holds no .db files — decrypt would return 0 rows
        # and the user would get "no decrypted directory found" much later.
        base = Path(tempfile.mkdtemp(dir=self.tmp))
        (base / "xwechat_files" / "wxid_empty0001" / "db_storage").mkdir(parents=True)
        self.assertEqual(self.discover_after_pasting(base), [])

    def test_descent_does_not_run_past_its_depth_budget(self) -> None:
        base = Path(tempfile.mkdtemp(dir=self.tmp))
        make_tree(base, "a/b/c/d/e/f/xwechat_files")
        self.assertEqual(self.discover_after_pasting(base), [])

    def test_descent_stops_at_the_account_dir(self) -> None:
        # Nothing below an account dir should be walked: real ones hold tens of
        # thousands of media files.
        base = Path(tempfile.mkdtemp(dir=self.tmp))
        account = make_tree(base, "xwechat_files")
        buried = account / "msg" / "attach" / "xwechat_files" / "wxid_nested999"
        (buried / "db_storage").mkdir(parents=True)
        (buried / "db_storage" / "s.db").write_bytes(b"SQLite format 3\x00")
        self.assertEqual(self.discover_after_pasting(base), ["wxid_a1b2c3d4e5"])


if __name__ == "__main__":
    unittest.main()
