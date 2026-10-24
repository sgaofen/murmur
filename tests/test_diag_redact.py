import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

from diag_redact import redact  # noqa: E402


MAC_HOME = "/Users/alice"
WIN_HOME = "C:\\Users\\Alice Zhang"


class RedactTest(unittest.TestCase):
    def r(self, text, **kw):
        kw.setdefault("home", MAC_HOME)
        return redact(text, **kw)

    def test_empty_passthrough(self) -> None:
        self.assertEqual(redact(""), "")
        self.assertIsNone(redact(None))

    def test_home_dir_mac(self) -> None:
        out = self.r("open /Users/alice/Library/Containers/com.tencent.xinWeChat failed")
        self.assertNotIn("alice", out)
        self.assertIn("~/Library/Containers/com.tencent.xinWeChat", out)

    def test_home_dir_windows_both_slash_styles(self) -> None:
        raw = "C:\\Users\\Alice Zhang\\Documents\\xwechat_files and C:/Users/Alice Zhang/AppData"
        out = redact(raw, home=WIN_HOME)
        self.assertNotIn("Alice", out)
        self.assertIn("~\\Documents", out)
        self.assertIn("~/AppData", out)

    def test_other_users_path_segment(self) -> None:
        out = self.r("root wrote /Users/bob/.murmur/keys and /home/carol/x and D:\\Users\\dave\\y")
        for name in ("bob", "carol", "dave"):
            self.assertNotIn(name, out)
        self.assertIn("/Users/<user>/.murmur/keys", out)
        self.assertIn("/Users/Shared", self.r("/Users/Shared/x"))

    def test_wxid_is_hashed_stably(self) -> None:
        raw = "profile wxid_n0cir36u32si12_97a5 then again wxid_n0cir36u32si12_97a5"
        out = self.r(raw)
        self.assertNotIn("n0cir36u32si12", out)
        self.assertNotIn("97a5", out)
        tokens = [t for t in out.split() if t.startswith("wxid_")]
        self.assertEqual(len(tokens), 2)
        self.assertEqual(tokens[0], tokens[1])

    def test_custom_account_folder(self) -> None:
        out = self.r("/Users/alice/Documents/xwechat_files/alice_wx_1a2b/db_storage/session/session.db")
        self.assertNotIn("alice_wx", out)
        self.assertIn("xwechat_files/<acct#", out)
        self.assertIn("/db_storage/session/session.db", out)
        out = redact("D:\\WeChat Files\\bobby123\\FileStorage", home=WIN_HOME)
        self.assertNotIn("bobby123", out)

    def test_chatroom(self) -> None:
        out = self.r("session 12345678901@chatroom opened")
        self.assertNotIn("12345678901", out)
        self.assertIn("@chatroom", out)

    def test_qq_numbers(self) -> None:
        out = redact("C:\\Users\\Alice Zhang\\Documents\\Tencent Files\\939919010\\nt_qq", home=WIN_HOME)
        self.assertNotIn("939919010", out)
        self.assertNotIn("939919010", self.r("active qq:939919010"))
        self.assertNotIn("939919010", self.r("QQ 939919010 decrypted"))

    def test_phone_numbers(self) -> None:
        for raw in ("call 13800138000 now", "tel +86 138-0013-8000", "86 13912345678"):
            with self.subTest(raw=raw):
                out = self.r(raw)
                self.assertIn("<phone>", out)
                self.assertNotRegex(out, r"1[3-9]\d")

    def test_does_not_eat_timestamps_or_counts(self) -> None:
        raw = "ts=1729661234567 ms=12345 size=1048576"
        self.assertEqual(self.r(raw), raw)

    def test_long_hex_keys(self) -> None:
        key = "a" * 16 + "0123456789abcdef" * 3
        out = self.r(f"[KEY] message_0.db: {key}\nsalt 0x{'f' * 32}")
        self.assertNotIn(key, out)
        self.assertIn("<hex64>", out)
        self.assertIn("<hex32>", out)
        # short hex (e.g. 4-char suffixes, short hashes) is left alone
        self.assertEqual(self.r("commit 31646a0"), "commit 31646a0")

    def test_nickname_fields(self) -> None:
        raw = 'nick_name=张三 remark: "老王" {"nickname": "Alice W"} 昵称：小李 备注: -'
        out = self.r(raw)
        for leaked in ("张三", "老王", "Alice W", "小李"):
            self.assertNotIn(leaked, out)
        self.assertIn('"nickname": "<name#', out)
        self.assertIn("备注: -", out)

    def test_explicit_names(self) -> None:
        out = self.r("loaded account 小明同学 (小明同学's data)", names=["小明同学", "", "x"])
        self.assertNotIn("小明同学", out)
        self.assertIn("<name#", out)

    def test_idempotent(self) -> None:
        raw = ("/Users/alice/x wxid_abc123_ffff 13800138000 nick_name=张三 "
               + "b" * 64 + " xwechat_files/acct_1/db qq:123456789")
        once = self.r(raw)
        self.assertEqual(self.r(once), once)

    def test_etcli_wrapper_uses_redactor(self) -> None:
        import etcli
        out = etcli._mask_user_paths(str(Path.home() / "x") + " wxid_abcdef123_1a2b 13800138000")
        self.assertTrue(out.startswith("~"))
        self.assertIn("<phone>", out)
        self.assertNotIn("abcdef123", out)


class RedactFollowupTest(unittest.TestCase):
    """Review follow-up for #38: e-mail, bare QQ numbers, 16-char keys, and
    names/secrets reaching the serve.log / tauri-shell.log sections."""

    def r(self, text, **kw):
        kw.setdefault("home", MAC_HOME)
        return redact(text, **kw)

    def test_email(self) -> None:
        out = self.r("contact alice.w+x@example.co.uk or BOB@qq.com today")
        self.assertNotIn("alice.w", out)
        self.assertNotIn("BOB", out)
        self.assertEqual(out.count("<email#"), 2)
        # chatroom ids are not e-mails and keep their own token
        self.assertIn("@chatroom", self.r("12345678@chatroom"))

    def test_bare_qq_numbers_from_names_on_digit_boundaries(self) -> None:
        out = self.r("decrypt 939919010 ok; ts=1939919010123", names=["939919010"])
        self.assertIn("decrypt <qq#", out)
        self.assertIn("ts=1939919010123", out)  # not part of a longer number
        # same token as the qq: prefix rule
        self.assertEqual(self.r("qq:939919010").split(":", 1)[1], out.split()[1].rstrip(";"))

    def test_qq_number_fields_and_nt_qq_dirs(self) -> None:
        raw = 'uin=939919010 "qq_number": "12345678" QQ号：87654321 D:\\data\\55667788\\nt_qq\\nt_db'
        out = self.r(raw)
        for n in ("939919010", "12345678", "87654321", "55667788"):
            self.assertNotIn(n, out)
        self.assertIn("nt_qq", out)

    def test_secret_fields(self) -> None:
        out = self.r('key=s3cr3tValue! passphrase: "hunter2hunter2" 密钥: Zx9vQ2mL7pR4tK8w key=None')
        for leaked in ("s3cr3tValue", "hunter2hunter2", "Zx9vQ2mL7pR4tK8w"):
            self.assertNotIn(leaked, out)
        self.assertIn("key=None", out)  # short values are not secrets

    def test_free_standing_16_char_key(self) -> None:
        for key in ("aB3$xY9!kL0@mN2#", "3s!x)e&q1v:{u4pt", "abcd1234EFGH5678"):
            with self.subTest(key=key):
                out = self.r(f"got {key} from R8")
                self.assertNotIn(key, out)
                self.assertIn("<secret16>", out)

    def test_16_char_non_secrets_kept(self) -> None:
        raw = "2026-10-23T22:54 LiveKeyJob.start TimeoutSeconds=1 message_10.db-wal"
        self.assertEqual(self.r(raw), raw)

    def test_caller_secrets(self) -> None:
        out = self.r("using qwertyuiop123456 now", secrets=["qwertyuiop123456"])
        self.assertNotIn("qwertyuiop123456", out)

    def test_followups_idempotent(self) -> None:
        raw = "a@b.com uin=123456789 aB3$xY9!kL0@mN2# key=s3cr3tValue!"
        once = self.r(raw)
        self.assertEqual(self.r(once), once)

    def test_diag_bundle_logs_get_names_and_secrets(self) -> None:
        from unittest import mock
        import etcli
        import paths
        import qq_paths
        key = "qwertyuiop123456"  # not random-looking: only the literal rule catches it
        logs = {"serve": f"loaded 小明同学 qq 939919010 decrypt 939919010 with {key}",
                "tauri_shell": "user 小明同学 mail a@b.com"}
        H = etcli._MurmurAPIHandler
        with mock.patch.object(etcli, "read_diagnostic_logs", return_value=logs), \
                mock.patch.object(H, "_build_profiles_payload",
                                  return_value={"profiles": [{"nick_name": "小明同学"}]}), \
                mock.patch.object(H, "_qq_load_keys_config", return_value={"939919010": key}), \
                mock.patch.object(paths, "discover_wechat_profiles", return_value=[]), \
                mock.patch.object(qq_paths, "discover_qq_profiles", return_value=[]):
            md = etcli._build_diag_bundle()
        for leaked in ("小明同学", "939919010", key, "a@b.com"):
            self.assertNotIn(leaked, md)
        self.assertIn("### serve.log", md)


if __name__ == "__main__":
    unittest.main()
