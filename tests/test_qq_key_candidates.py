"""QQ NT key-candidate filtering + HMAC verification (issue #5).

Builds a fake encrypted nt_msg.db page 1 with plain hashlib/hmac (no
`cryptography` needed) that follows the QQ NT layout: 1024-byte header, then a
SQLCipher page whose HMAC is computed with PBKDF2-HMAC-SHA512 (kdf_iter=4000)
and either HMAC-SHA1/reserve=48 or HMAC-SHA512/reserve=64.
"""
import hashlib
import hmac
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import qq_decrypt  # noqa: E402

REAL_KEY = "aB3$xY9!kL0@mN2#"  # 16 printable ASCII chars
assert len(REAL_KEY) == 16


def make_fake_nt_msg_db(path: Path, key: str, hmac_hash: str = "sha1") -> None:
    """Write a QQ NT-shaped encrypted DB: 1024-byte header + one 4096-byte page."""
    hmac_size, reserve = (20, 48) if hmac_hash == "sha1" else (32, 64)
    salt = os.urandom(16)
    body = os.urandom(4096 - 16 - reserve)
    iv = os.urandom(16)
    aes_key = hashlib.pbkdf2_hmac("sha512", key.encode("ascii"), salt, 4000, 32)
    mac_salt = bytes(b ^ 0x3A for b in salt)
    hmac_key = hashlib.pbkdf2_hmac("sha512", aes_key, mac_salt, 2, 32)
    mac = hmac.new(hmac_key, body + iv + (1).to_bytes(4, "little"),
                   getattr(hashlib, hmac_hash)).digest()[:hmac_size]
    page = salt + body + iv + mac
    page += b"\x00" * (4096 - len(page))
    assert len(page) == 4096
    header = b"QQ_NT DB" + b"\x00" * (1024 - 8)
    path.write_bytes(header + page)


def marker(source: str, value: str) -> str:
    return (f"MURMUR_KEY_CANDIDATE source={source} len={len(value)} "
            f"hex={value.encode('ascii').hex().upper()}")


class CandidateFilterTest(unittest.TestCase):
    def test_skips_login_db_constant(self):
        self.assertIsNotNone(qq_decrypt.candidate_skip_reason("BD156D6710D54D8782F4"))

    def test_skips_20_hex_zdb_names(self):
        self.assertIsNotNone(qq_decrypt.candidate_skip_reason("0123456789abcdefABCD"))
        # 20 chars but not hex -> worth trying
        self.assertIsNone(qq_decrypt.candidate_skip_reason("0123456789abcdefABCZ"))

    def test_skips_non_printable_and_empty(self):
        self.assertIsNotNone(qq_decrypt.candidate_skip_reason(""))
        self.assertIsNotNone(qq_decrypt.candidate_skip_reason("abc\x01defghijklmno"))

    def test_keeps_16_char_ascii(self):
        self.assertIsNone(qq_decrypt.candidate_skip_reason(REAL_KEY))

    def test_filter_splits_and_adds_16_char_prefix(self):
        long_val = REAL_KEY + "trailing-garbage"
        to_try, skipped = qq_decrypt.filter_key_candidates([
            {"source": "R8", "value": "BD156D6710D54D8782F4"},
            {"source": "RDX", "value": "FFFFEEEEDDDDCCCCBBBB"},
            {"source": "R9", "value": long_val},
        ])
        values = [c["value"] for c in to_try]
        self.assertIn(REAL_KEY, values)
        self.assertIn(long_val, values)
        # 16-char candidates are tried first
        self.assertEqual(values[0], REAL_KEY)
        self.assertEqual(len(skipped), 2)
        self.assertNotIn("BD156D6710D54D8782F4", values)

    def test_parse_marker_lines_dedup_and_legacy(self):
        log = "\n".join([
            "正在启动 QQ 进程并附加调试器...",
            marker("R8", "BD156D6710D54D8782F4"),
            marker("R8", "BD156D6710D54D8782F4"),
            "  " + marker("R9/nKey", REAL_KEY),
            "MURMUR_KEY_CANDIDATE source=R8 len=2 hex=ZZ",  # malformed -> ignored
            "找到密钥: legacyKey1234567",
        ])
        cands = qq_decrypt.parse_key_candidates(log)
        self.assertEqual([c["value"] for c in cands],
                         ["BD156D6710D54D8782F4", REAL_KEY, "legacyKey1234567"])
        self.assertEqual(cands[1]["source"], "R9/nKey")


class HmacSelectionTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_picks_the_candidate_that_verifies(self):
        db = self.tmp / "nt_msg.db"
        make_fake_nt_msg_db(db, REAL_KEY, "sha1")
        cands = [
            {"source": "R8", "value": "BD156D6710D54D8782F4"},
            {"source": "RCX", "value": "wrongwrongwrong1"},
            {"source": "R9", "value": REAL_KEY},
            {"source": "RDX", "value": "wrongwrongwrong2"},
        ]
        res = qq_decrypt.select_verified_key(cands, [("12345", db)])
        self.assertTrue(res["ok"])
        self.assertEqual(res["key"], REAL_KEY)
        self.assertEqual(res["tag"], "12345")
        self.assertEqual(res["variant"], "sha1")
        self.assertEqual(res["candidates"][0]["status"], "verified")
        # the UI summary never contains full candidate values
        self.assertNotIn(REAL_KEY, json.dumps(res["candidates"]))

    def test_sha512_reserve64_fallback(self):
        db = self.tmp / "nt_msg.db"
        make_fake_nt_msg_db(db, REAL_KEY, "sha512")
        res = qq_decrypt.select_verified_key([{"source": "R8", "value": REAL_KEY}], [("1", db)])
        self.assertTrue(res["ok"])
        self.assertEqual(res["variant"], "sha512")

    def test_key_found_inside_longer_string(self):
        db = self.tmp / "nt_msg.db"
        make_fake_nt_msg_db(db, REAL_KEY)
        res = qq_decrypt.select_verified_key(
            [{"source": "R8", "value": REAL_KEY + "XYZ"}], [("1", db)])
        self.assertTrue(res["ok"])
        self.assertEqual(res["key"], REAL_KEY)

    def test_picks_matching_profile_among_several(self):
        db_a = self.tmp / "a.db"
        db_b = self.tmp / "b.db"
        make_fake_nt_msg_db(db_a, "otherKey!1234567")
        make_fake_nt_msg_db(db_b, REAL_KEY)
        res = qq_decrypt.select_verified_key(
            [{"source": "R8", "value": REAL_KEY}], [("111", db_a), ("222", db_b)])
        self.assertTrue(res["ok"])
        self.assertEqual(res["tag"], "222")

    def test_all_candidates_fail_gives_clear_error(self):
        db = self.tmp / "nt_msg.db"
        make_fake_nt_msg_db(db, REAL_KEY)
        cands = [
            {"source": "R8", "value": "BD156D6710D54D8782F4"},
            {"source": "RDX", "value": "0011223344556677AABB"},
            {"source": "RCX", "value": "wrongwrongwrong1"},
        ]
        res = qq_decrypt.select_verified_key(cands, [("1", db)])
        self.assertFalse(res["ok"])
        self.assertIsNone(res["key"])
        err = res["error"]
        self.assertIn("抓到 3 个候选值", err)
        self.assertIn("2 个是已知的非消息库字符串", err)
        self.assertIn("1 个在 nt_msg.db 第 1 页做 HMAC 校验都没通过", err)
        self.assertIn("下一步", err)
        self.assertEqual(len(res["candidates"]), 3)

    def test_no_candidates_error(self):
        db = self.tmp / "nt_msg.db"
        make_fake_nt_msg_db(db, REAL_KEY)
        res = qq_decrypt.select_verified_key([], [("1", db)])
        self.assertFalse(res["ok"])
        self.assertIn("没有输出任何候选值", res["error"])

    def test_no_db_to_verify_against(self):
        res = qq_decrypt.select_verified_key(
            [{"source": "R8", "value": REAL_KEY}], [("1", self.tmp / "missing.db")])
        self.assertFalse(res["ok"])
        self.assertIn("没有找到可读的 nt_msg.db", res["error"])

    def test_finish_extraction_end_to_end_from_script_output(self):
        db = self.tmp / "nt_msg.db"
        make_fake_nt_msg_db(db, REAL_KEY)
        log = "\n".join([
            "wrapper.node 已加载到: 0x7FF000000000",
            marker("R8", "BD156D6710D54D8782F4"),
            marker("R8/16", "BD156D6710D54D87"),
            marker("R8", REAL_KEY),
            "MURMUR_KEY_SUMMARY hits=12 candidates=3",
        ])
        r = qq_decrypt.finish_extraction(log, [("12345", db)])
        self.assertTrue(r["ok"])
        self.assertEqual(r["key"], REAL_KEY)
        self.assertEqual(r["qq"], "12345")

        wrong_log = log.replace(REAL_KEY.encode("ascii").hex().upper(), "78" * 16)  # "xxxx..."
        r = qq_decrypt.finish_extraction(wrong_log, [("12345", db)], timed_out=True, timeout=240)
        self.assertFalse(r["ok"])
        self.assertTrue(r["error"].startswith("抓 key 超时（240 秒）"))

    def test_returned_log_has_no_candidate_values(self):
        db = self.tmp / "nt_msg.db"
        make_fake_nt_msg_db(db, REAL_KEY)
        other = "wrongwrongwrong1"
        log = "\n".join([
            "wrapper.node 已加载到: 0x7FF000000000",
            marker("R8", other),
            marker("R9", REAL_KEY),
            "找到密钥: legacyLegacy0001",
            "MURMUR_KEY_SUMMARY hits=12 candidates=3",
        ])
        for dbs in ([("1", db)], [("1", self.tmp / "missing.db")]):
            r = qq_decrypt.finish_extraction(log, dbs)
            out = r["log"]
            for value in (REAL_KEY, other, "legacyLegacy0001"):
                self.assertNotIn(value, out)
                self.assertNotIn(value.encode("ascii").hex().upper(), out)
            self.assertIn("MURMUR_KEY_CANDIDATE source=R9 len=16 hex=<redacted:16B>", out)
            self.assertIn("找到密钥: <redacted:16B>", out)
            self.assertIn("MURMUR_KEY_SUMMARY hits=12", out)
            self.assertNotIn(REAL_KEY, json.dumps(r["candidates"]))

    def test_redact_log_survives_truncation(self):
        # Redaction happens before the 3000-char tail cut, so a cut can't
        # leave a bare hex tail behind.
        log = "x" * 5000 + "\n" + marker("R8", REAL_KEY)
        out = qq_decrypt.finish_extraction(log, [])["log"]
        self.assertLessEqual(len(out), 3000)
        self.assertNotIn(REAL_KEY.encode("ascii").hex().upper(), out)

    def test_extract_fails_fast_without_nt_msg_db(self):
        with mock.patch.object(qq_decrypt.sys, "platform", "win32"), \
                mock.patch("subprocess.run") as run:
            r = qq_decrypt.extract_key_via_powershell(timeout=60, verify_dbs=[])
        run.assert_not_called()
        self.assertFalse(r["ok"])
        self.assertIn("没有找到可读的 nt_msg.db", r["error"])

    def test_verify_key_for_db(self):
        db = self.tmp / "nt_msg.db"
        make_fake_nt_msg_db(db, REAL_KEY)
        self.assertEqual(qq_decrypt.verify_key_for_db(db, REAL_KEY), (True, None))
        ok, err = qq_decrypt.verify_key_for_db(db, "wrongwrongwrong1")
        self.assertFalse(ok)
        self.assertIn("HMAC", err)
        ok, err = qq_decrypt.verify_key_for_db(db, "BD156D6710D54D8782F4")
        self.assertFalse(ok)
        self.assertIn("login.db", err)

    def test_decrypt_db_rejects_wrong_key_without_cryptography(self):
        db = self.tmp / "nt_msg.db"
        make_fake_nt_msg_db(db, REAL_KEY)
        with self.assertRaises(qq_decrypt.WrongKeyError):
            qq_decrypt.decrypt_db(db, self.tmp / "out.db", "wrongwrongwrong1")


class _FakeProfile:
    def __init__(self, qq, nt_db_dir):
        self.qq_number = qq
        self.nt_db_dir = Path(nt_db_dir)
        self.tencent_files_root = Path(nt_db_dir).parent


class QQKeyEndpointsTest(unittest.TestCase):
    """/api/qq/save-key verifies before persisting; /api/qq/extract-key passes
    the profiles' nt_msg.db (preferred QQ first) for verification."""

    def setUp(self):
        import etcli
        self.etcli = etcli
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.db_dir = self.tmp / "12345" / "nt_qq" / "nt_db"
        self.db_dir.mkdir(parents=True)
        make_fake_nt_msg_db(self.db_dir / "nt_msg.db", REAL_KEY)
        self.other_dir = self.tmp / "999" / "nt_qq" / "nt_db"
        self.other_dir.mkdir(parents=True)
        make_fake_nt_msg_db(self.other_dir / "nt_msg.db", "otherKey!1234567")
        self.profiles = [_FakeProfile("999", self.other_dir), _FakeProfile("12345", self.db_dir)]
        self.keys_path = self.tmp / "qq_keys.json"

    def tearDown(self):
        self._tmp.cleanup()

    def _post(self, path, payload):
        cls = self.etcli._MurmurAPIHandler
        h = cls.__new__(cls)
        body = json.dumps(payload).encode("utf-8")
        h.headers = {"Content-Length": str(len(body))}
        h.rfile = io.BytesIO(body)
        sent = {}

        def fake_send(payload, status=200):
            sent["payload"], sent["status"] = payload, status
        h._send_json = fake_send
        with mock.patch.object(cls, "_qq_keys_cfg_path", self.keys_path), \
                mock.patch("qq_paths.discover_qq_profiles", return_value=self.profiles):
            h._dispatch_qq_post(path)
        return sent["payload"], sent["status"]

    def test_save_key_accepts_verified_key(self):
        payload, status = self._post("/api/qq/save-key", {"qq": "12345", "key": REAL_KEY})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        saved = json.loads(self.keys_path.read_text(encoding="utf-8"))
        self.assertEqual(saved, {"12345": REAL_KEY})

    def test_save_key_rejects_wrong_key_and_does_not_persist(self):
        payload, _ = self._post("/api/qq/save-key", {"qq": "12345", "key": "wrongwrongwrong1"})
        self.assertFalse(payload["ok"])
        self.assertIn("未保存", payload["error"])
        self.assertFalse(self.keys_path.exists())

    def test_save_key_rejects_login_db_constant(self):
        payload, _ = self._post("/api/qq/save-key", {"qq": "12345", "key": "BD156D6710D54D8782F4"})
        self.assertFalse(payload["ok"])
        self.assertFalse(self.keys_path.exists())

    def test_save_key_unknown_qq(self):
        payload, _ = self._post("/api/qq/save-key", {"qq": "777", "key": REAL_KEY})
        self.assertFalse(payload["ok"])
        self.assertFalse(self.keys_path.exists())

    def test_extract_key_passes_verify_dbs_preferred_first(self):
        captured = {}

        def fake_extract(timeout=240, verify_dbs=None):
            captured["dbs"] = verify_dbs
            return {"ok": False, "key": None, "error": "x"}
        # The Windows path; on macOS the endpoint routes to qq_mac_key instead
        # (covered in test_qq_mac.py).
        with mock.patch.object(qq_decrypt, "extract_key_via_powershell", side_effect=fake_extract), \
                mock.patch("qq_paths.IS_MAC", False):
            self._post("/api/qq/extract-key", {"timeout": 60, "qq": "12345"})
        self.assertEqual([t[0] for t in captured["dbs"]], ["12345", "999"])
        self.assertEqual(captured["dbs"][0][1], self.db_dir / "nt_msg.db")


if __name__ == "__main__":
    unittest.main()
