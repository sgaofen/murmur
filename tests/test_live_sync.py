"""Tests for WeChat live sync (cli/live_sync.py) and the shared refresh pipeline.

No real crypto: the "encrypted" databases are plain SQLite files and
`refresh.decrypt` is replaced by a copy, so CI needs no `cryptography`.
"""
import http.client
import json
import os
import shutil
import sqlite3
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import decrypt_cache  # noqa: E402
import live_sync  # noqa: E402
import refresh  # noqa: E402
import wal_frames  # noqa: E402

KEY = "a" * 64


def _make_db(path: Path, tables=("Msg_aaa",), rows: int = 3) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    try:
        for t in tables:
            conn.execute(f'CREATE TABLE "{t}" (local_id INTEGER PRIMARY KEY, content TEXT)')
            conn.executemany(f'INSERT INTO "{t}" (content) VALUES (?)',
                             [(f"m{i}",) for i in range(rows)])
        conn.commit()
    finally:
        conn.close()


def _insert(path: Path, table: str, n: int) -> None:
    conn = sqlite3.connect(str(path))
    try:
        conn.executemany(f'INSERT INTO "{table}" (content) VALUES (?)', [("new",)] * n)
        conn.commit()
    finally:
        conn.close()
    _bump(path)


def _bump(path: Path) -> None:
    """Guarantee a visible mtime change even on coarse-mtime filesystems."""
    st = path.stat()
    os.utime(str(path), ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))


class _FakeDecrypt:
    """Stand-in for refresh.decrypt: 'decrypts' by copying the plain file."""

    def __init__(self):
        self.calls = []
        self.gate = None  # optional threading.Event to block inside decrypt
        self.entered = threading.Event()

    def __call__(self, lib, src, dst, key, *, pre_derived=False):
        self.calls.append((Path(src).name, pre_derived))
        self.entered.set()
        if self.gate is not None:
            self.gate.wait(5)
        shutil.copyfile(str(src), str(dst))
        return None

    def names(self):
        return sorted(n for n, _ in self.calls)


class LiveSyncTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.src_root = self.tmp / "db_storage"
        self.dst = self.tmp / "decrypted" / "wxid_test"
        _make_db(self.src_root / "session" / "session.db", tables=("SessionTable",))
        _make_db(self.src_root / "contact" / "contact.db", tables=("contact",))
        _make_db(self.src_root / "message" / "message_0.db", tables=("Msg_aaa", "Msg_bbb"))
        _make_db(self.src_root / "message" / "message_1.db", tables=("Msg_ccc",))
        # A skipped DB must never be touched.
        _make_db(self.src_root / "message" / "message_fts.db", tables=("fts",))
        self.profile = SimpleNamespace(wxid="wxid_test", wxid_short="wxid_test",
                                       encrypted_root=self.src_root)
        self.cfg = {}
        self.synced_batches = []
        self.fake = _FakeDecrypt()
        patcher = mock.patch.object(refresh, "decrypt", self.fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self._tmp.cleanup()

    def make_sync(self, plan=None, lock=None, profile=True):
        plan = plan or refresh.KeyPlan("global", None, KEY)
        ls = live_sync.LiveSync(
            profile_resolver=(lambda: self.profile) if profile else (lambda: None),
            on_synced=self.synced_batches.append,
            plan_fn=lambda prof: plan,
            dst_dir_fn=lambda prof: self.dst,
            config_load=lambda: dict(self.cfg),
            config_save=self._save_cfg,
            lock=lock,
            log=lambda msg: None,
        )
        ls._lib_loaded = True  # never try to load go_decrypt.dll in tests
        return ls

    def _save_cfg(self, cfg):
        self.cfg = dict(cfg)


class ChangeDetectionTest(LiveSyncTestBase):
    def test_first_tick_syncs_all_then_idles(self):
        ls = self.make_sync()
        r = ls.tick()
        self.assertEqual(sorted(r["synced"]),
                         ["contact.db", "message_0.db", "message_1.db", "session.db"])
        self.assertNotIn("message_fts.db", self.fake.names())
        for name in r["synced"]:
            self.assertTrue((self.dst / name).exists(), name)

        self.fake.calls.clear()
        r2 = ls.tick()
        self.assertEqual(r2["synced"], [])
        self.assertEqual(self.fake.calls, [])

    def test_only_changed_db_is_processed_and_new_messages_counted(self):
        ls = self.make_sync()
        ls.tick()
        self.fake.calls.clear()
        self.synced_batches.clear()

        _insert(self.src_root / "message" / "message_1.db", "Msg_ccc", 4)
        r = ls.tick()
        self.assertEqual(self.fake.names(), ["message_1.db"])
        self.assertEqual(r["synced"], ["message_1.db"])
        self.assertEqual(r["new_messages"], 4)
        st = ls.status()
        self.assertEqual(st["last_new_messages"], 4)
        self.assertEqual(st["last_synced_dbs"], ["message_1.db"])
        self.assertIsNotNone(st["last_sync_ts"])
        self.assertEqual(self.synced_batches, [["message_1.db"]])

    def test_wal_only_change_is_detected(self):
        ls = self.make_sync()
        ls.tick()
        self.fake.calls.clear()
        wal = self.src_root / "message" / "message_0.db-wal"
        wal.write_bytes(b"\x00" * 64)  # not a valid WAL: merged as 0 frames
        r = ls.tick()
        self.assertEqual(self.fake.names(), ["message_0.db"])
        self.assertEqual(r["errors"], [])
        # The snapshot carried the -wal along; nothing was left in dst.
        self.assertFalse((self.dst / "message_0.db-wal").exists())

        self.fake.calls.clear()
        with wal.open("ab") as f:
            f.write(b"\x00" * 32)
        ls.tick()
        self.assertEqual(self.fake.names(), ["message_0.db"])

    def test_restart_uses_decrypt_cache_as_baseline(self):
        self.make_sync().tick()
        self.fake.calls.clear()
        # Fresh poller (e.g. after etcli restart): nothing changed on disk,
        # so the persisted DecryptCache says every output is current.
        r = self.make_sync().tick()
        self.assertEqual(r["synced"], [])
        self.assertEqual(self.fake.calls, [])

    def test_callback_not_called_without_changes(self):
        ls = self.make_sync()
        ls.tick()
        self.assertEqual(len(self.synced_batches), 1)
        ls.tick()
        ls.tick()
        self.assertEqual(len(self.synced_batches), 1)

    def test_decrypt_failure_is_reported_and_not_hammered(self):
        ls = self.make_sync()
        ls.tick()
        self.fake.calls.clear()
        _insert(self.src_root / "contact" / "contact.db", "contact", 1)
        with mock.patch.object(refresh, "decrypt", lambda *a, **k: "HMAC check failed: wrong key"):
            r = ls.tick()
        self.assertEqual(r["synced"], [])
        self.assertEqual(len(r["errors"]), 1)
        self.assertIn("contact.db", ls.status()["last_error"])
        # Same source state → not retried every tick.
        r2 = ls.tick()
        self.assertEqual(r2["changed"], [])

    def test_mac_per_db_keys(self):
        per_db = {"keys_by_db": {
            "session/session.db": "b" * 64,
            "contact/contact.db": "c" * 64,
            "message/message_0.db": "d" * 64,
            # message_1.db has no captured key → skipped, not an error
        }, "keys_by_salt": {}}
        ls = self.make_sync(plan=refresh.KeyPlan("per_db", per_db, None))
        r = ls.tick()
        self.assertEqual(sorted(r["synced"]), ["contact.db", "message_0.db", "session.db"])
        self.assertTrue(all(pre for _, pre in self.fake.calls))
        self.assertEqual(r["errors"], [])
        self.fake.calls.clear()
        self.assertEqual(ls.tick()["changed"], [])

    def test_no_profile_or_key_idles(self):
        ls = self.make_sync(profile=False)
        self.assertEqual(ls.tick(), {"skipped": "no_profile"})
        ls2 = live_sync.LiveSync(profile_resolver=lambda: self.profile, plan_fn=lambda p: None,
                                 dst_dir_fn=lambda p: self.dst, config_load=dict,
                                 config_save=lambda c: None, log=lambda m: None)
        self.assertEqual(ls2.tick(), {"skipped": "no_key"})
        self.assertEqual(self.fake.calls, [])


class ToggleAndLockTest(LiveSyncTestBase):
    def test_configure_persists_and_clamps(self):
        ls = self.make_sync(profile=False)
        ls.load_config()
        self.assertFalse(ls.enabled)  # default off
        self.assertEqual(ls.interval, live_sync.DEFAULT_INTERVAL)

        st = ls.configure(enabled=True, interval=0.5)
        try:
            self.assertTrue(st["enabled"])
            self.assertEqual(st["interval"], live_sync.MIN_INTERVAL)
            self.assertEqual(self.cfg["live_sync"], {"enabled": True, "interval": live_sync.MIN_INTERVAL})
            self.assertTrue(ls.running)
            ls.configure(interval=999)
            self.assertEqual(ls.interval, live_sync.MAX_INTERVAL)
        finally:
            ls.configure(enabled=False)
        self.assertFalse(ls.running)
        self.assertEqual(self.cfg["live_sync"]["enabled"], False)
        ls._thread.join(2)
        self.assertFalse(ls._thread.is_alive())

        ls2 = self.make_sync(profile=False)
        ls2.load_config()
        self.assertFalse(ls2.enabled)
        self.assertEqual(ls2.interval, live_sync.MAX_INTERVAL)

    def test_bad_config_values_fall_back(self):
        self.cfg = {"live_sync": {"enabled": True, "interval": "abc"}}
        ls = self.make_sync(profile=False)
        ls.load_config()
        self.assertTrue(ls.enabled)
        self.assertEqual(ls.interval, live_sync.DEFAULT_INTERVAL)

    def test_tick_skips_while_manual_refresh_holds_lock(self):
        lock = threading.Lock()
        ls = self.make_sync(lock=lock)
        with lock:
            self.assertEqual(ls.tick(), {"skipped": "busy"})
        self.assertEqual(self.fake.calls, [])

    def test_manual_refresh_cannot_run_during_sync(self):
        # Default lock is the module-wide DECRYPT_LOCK that /api/refresh uses.
        ls = self.make_sync(lock=None)
        self.assertIs(ls._lock, live_sync.DECRYPT_LOCK)
        self.fake.gate = threading.Event()
        t = threading.Thread(target=ls.tick)
        t.start()
        try:
            self.assertTrue(self.fake.entered.wait(5))
            self.assertTrue(ls.status()["syncing"])
            # What /api/refresh does: it cannot get in while a sync runs.
            self.assertFalse(live_sync.DECRYPT_LOCK.acquire(timeout=0.2))
        finally:
            self.fake.gate.set()
            t.join(5)
        self.assertFalse(ls.status()["syncing"])
        self.assertTrue(live_sync.DECRYPT_LOCK.acquire(timeout=1))
        live_sync.DECRYPT_LOCK.release()


class SnapshotAndCacheTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_snapshot_copies_db_wal_shm(self):
        src = self.tmp / "src" / "message_0.db"
        _make_db(src)
        Path(str(src) + "-wal").write_bytes(b"W" * 100)
        Path(str(src) + "-shm").write_bytes(b"S" * 10)
        snap, sig, ok = refresh.snapshot_db(src, self.tmp / "snap")
        self.assertTrue(ok)
        self.assertEqual(sig, decrypt_cache.db_signature(src))
        self.assertEqual(Path(str(snap) + "-wal").read_bytes(), b"W" * 100)
        self.assertEqual(Path(str(snap) + "-shm").read_bytes(), b"S" * 10)
        self.assertEqual(snap.read_bytes(), src.read_bytes())

    def test_snapshot_retries_when_source_changes_mid_copy(self):
        src = self.tmp / "src" / "message_0.db"
        _make_db(src)
        wal = Path(str(src) + "-wal")
        wal.write_bytes(b"A" * 10)
        real_copy = shutil.copyfile
        calls = {"n": 0}

        def racing_copy(a, b, *args, **kw):
            calls["n"] += 1
            if calls["n"] == 2:  # WeChat appends to the WAL during attempt 1
                with wal.open("ab") as f:
                    f.write(b"B" * 10)
            return real_copy(a, b, *args, **kw)

        with mock.patch.object(refresh.shutil, "copyfile", racing_copy):
            snap, sig, ok = refresh.snapshot_db(src, self.tmp / "snap", settle_s=0)
        self.assertTrue(ok)
        self.assertGreater(calls["n"], 3)  # retried
        self.assertEqual(Path(str(snap) + "-wal").read_bytes(), b"A" * 10 + b"B" * 10)
        self.assertEqual(sig, decrypt_cache.db_signature(src))

    def test_snapshot_gives_up_without_signature(self):
        src = self.tmp / "src" / "x.db"
        _make_db(src)
        real_copy = shutil.copyfile

        def always_racing(a, b, *args, **kw):
            _bump(src)
            return real_copy(a, b, *args, **kw)

        with mock.patch.object(refresh.shutil, "copyfile", always_racing):
            snap, sig, ok = refresh.snapshot_db(src, self.tmp / "snap", attempts=2, settle_s=0)
        self.assertFalse(ok)
        self.assertIsNone(sig)
        self.assertTrue(snap.exists())

    def test_cache_signature_tracks_wal_size(self):
        root = self.tmp / "src"
        src = root / "a.db"
        _make_db(src)
        dst = self.tmp / "dst"
        dst.mkdir()
        shutil.copyfile(str(src), str(dst / "a.db"))
        c = decrypt_cache.DecryptCache(dst, b"k", src_root=root)
        c.mark_done(src, decrypt_cache.db_signature(src))
        c.save()
        c2 = decrypt_cache.DecryptCache(dst, b"k", src_root=root)
        self.assertTrue(c2.is_fresh(src))
        Path(str(src) + "-wal").write_bytes(b"x")
        self.assertFalse(c2.is_fresh(src))
        # different key → whole cache invalid
        self.assertFalse(decrypt_cache.DecryptCache(dst, b"other", src_root=root).is_fresh(src))

    def test_message_marks_and_count(self):
        db = self.tmp / "m.db"
        _make_db(db, tables=("Msg_a", "Msg_b", "Name2Id"), rows=2)
        before = live_sync.message_marks(db)
        self.assertEqual(before, {"Msg_a": 2, "Msg_b": 2})
        _insert(db, "Msg_b", 3)
        conn = sqlite3.connect(str(db))
        conn.execute('CREATE TABLE "Msg_c" (local_id INTEGER PRIMARY KEY, content TEXT)')
        conn.execute('INSERT INTO "Msg_c" (content) VALUES ("x")')
        conn.commit()
        conn.close()
        self.assertEqual(live_sync.count_new_messages(before, live_sync.message_marks(db)), 4)
        self.assertEqual(live_sync.message_marks(self.tmp / "missing.db"), {})


def _wal(salt: bytes, frames, page_size: int = 4096) -> bytes:
    """frames: list of (page_no, commit_size, salt)."""
    hdr = struct.pack(">IIII", wal_frames.WAL_MAGIC_LE, 3007000, page_size, 0) + salt + b"\0" * 8
    out = bytearray(hdr)
    for page_no, commit, fsalt in frames:
        out += struct.pack(">II", page_no, commit) + fsalt + b"\0" * 8
        out += b"\x11" * page_size
    return bytes(out)


class WalFramesTest(unittest.TestCase):
    S = b"SALTSALT"
    T = b"OLDSALT!"

    def test_stale_generation_frames_are_skipped(self):
        buf = _wal(self.S, [(2, 0, self.S), (3, 9, self.S),   # committed txn
                            (4, 0, self.T), (5, 9, self.T)])  # leftovers of the previous cycle
        frames = wal_frames.valid_wal_frames(buf, 4096)
        self.assertEqual([f.page_no for f in frames], [2, 3])

    def test_uncommitted_tail_is_dropped(self):
        buf = _wal(self.S, [(2, 5, self.S), (3, 0, self.S), (4, 0, self.S)])
        self.assertEqual([f.page_no for f in wal_frames.valid_wal_frames(buf)], [2])

    def test_salt_mismatch_ends_log_even_if_later_frames_match(self):
        buf = _wal(self.S, [(2, 5, self.S), (3, 5, self.T), (4, 5, self.S)])
        self.assertEqual([f.page_no for f in wal_frames.valid_wal_frames(buf)], [2])

    def test_bad_header_and_page_size(self):
        self.assertEqual(wal_frames.valid_wal_frames(b"\0" * 100), [])
        buf = _wal(self.S, [(2, 5, self.S)], page_size=1024)
        self.assertEqual(wal_frames.valid_wal_frames(buf, 4096), [])
        self.assertEqual(len(wal_frames.valid_wal_frames(buf)), 1)

    def test_wal_best_effort_skips_stale_only_wal_without_crypto(self):
        # Only stale frames → returns before importing decrypt_py (which
        # needs `cryptography`, absent on CI).
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            src = d / "a.db"
            src.write_bytes(b"\0" * 4096)
            Path(str(src) + "-wal").write_bytes(_wal(self.S, [(2, 5, self.T)]))
            dst = d / "out.db"
            dst.write_bytes(b"\0" * 4096)
            self.assertEqual(refresh._apply_wal_best_effort(src, dst, KEY), (0, None))


class ProcessDbTest(LiveSyncTestBase):
    def test_swap_failure_is_reported_and_retried(self):
        ls = self.make_sync()
        with mock.patch.object(refresh, "swap_into_place", side_effect=PermissionError("locked")):
            r = ls.tick()
        self.assertEqual(r["synced"], [])
        self.assertEqual(len(r["errors"]), 4)
        self.fake.calls.clear()
        r2 = ls.tick()  # transient lock gone → everything retried
        self.assertEqual(len(r2["synced"]), 4)


class RefreshMainTest(LiveSyncTestBase):
    """The manual refresh now goes through the same process_db pipeline."""

    def _run_main(self, plan, *argv):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with mock.patch.object(refresh, "select_profile", return_value=self.profile), \
                mock.patch.object(refresh, "resolve_key_plan", return_value=plan), \
                mock.patch.object(refresh, "decrypted_root_for", return_value=self.dst), \
                mock.patch.object(refresh, "load_dll", return_value=None), \
                mock.patch.object(sys, "argv", ["refresh.py", *argv]), \
                redirect_stdout(buf):
            rc = refresh.main()
        return rc, buf.getvalue()

    def test_global_key_refresh_then_cache_then_live_sync_agrees(self):
        plan = refresh.KeyPlan("global", None, KEY)
        rc, out = self._run_main(plan)
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.fake.names(), ["contact.db", "message_0.db", "message_1.db", "session.db"])
        self.fake.calls.clear()
        rc, out = self._run_main(plan)
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.fake.calls, [])
        self.assertIn("缓存命中 4", out)
        # Live sync started afterwards sees the refresh's cache as baseline.
        self.assertEqual(self.make_sync(plan=plan).tick()["synced"], [])
        self.assertEqual(self.fake.calls, [])

    def test_per_db_refresh_uses_cache_and_reports_core(self):
        per_db = {"keys_by_db": {"session/session.db": "b" * 64, "contact/contact.db": "c" * 64},
                  "keys_by_salt": {}}
        plan = refresh.KeyPlan("per_db", per_db, None)
        rc, out = self._run_main(plan)
        self.assertEqual(rc, 0, out)  # message DBs without keys → WARN, not failure
        self.assertIn("[WARN]", out)
        self.assertEqual(self.fake.names(), ["contact.db", "session.db"])
        self.fake.calls.clear()
        rc, out = self._run_main(plan)
        self.assertEqual(rc, 0, out)  # core DBs cached still count as present
        self.assertEqual(self.fake.calls, [])
        rc, out = self._run_main(plan, "--force")
        self.assertEqual(self.fake.names(), ["contact.db", "session.db"])


def _have_crypto() -> bool:
    import importlib.util
    return importlib.util.find_spec("cryptography") is not None and shutil.which("sqlite3") is not None


@unittest.skipUnless(_have_crypto(), "needs `cryptography` + sqlite3 CLI (not on CI)")
class RealCryptoWalTest(unittest.TestCase):
    """End-to-end with real SQLCipher-v4-style pages: the -wal holds one
    current-generation commit plus stale frames from before a checkpoint.
    Without the salt check the stale frames roll the table back."""

    def test_process_db_merges_only_current_wal_generation(self):
        import hashlib
        import hmac as _hmac
        import subprocess
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        import decrypt_py

        ps = 4096
        key = "11" * 32
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            plain = work / "plain" / "message_0.db"
            plain.parent.mkdir()
            r = subprocess.run(["sqlite3", str(plain), ".filectrl reserve_bytes 80",
                                "PRAGMA page_size=4096;",
                                "CREATE TABLE Msg_x(local_id INTEGER PRIMARY KEY, content TEXT);",
                                "VACUUM;"], capture_output=True)
            with plain.open("rb") as f:
                if r.returncode != 0 or f.read(21)[20] != 80:
                    self.skipTest("sqlite3 CLI cannot set reserve_bytes")
            conn = sqlite3.connect(str(plain), isolation_level=None)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA wal_autocheckpoint=0")
            for i in range(10):
                conn.execute("INSERT INTO Msg_x(content) VALUES (?)", ("base%d" % i + "x" * 300,))
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            for i in range(5):
                conn.execute("INSERT INTO Msg_x(content) VALUES (?)", ("gen1-%d" % i + "y" * 300,))
            conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            conn.execute("INSERT INTO Msg_x(content) VALUES ('gen2')")  # WAL restarts, new salt
            wal_plain = Path(str(plain) + "-wal").read_bytes()
            db_plain = plain.read_bytes()
            conn.close()

            salt = os.urandom(16)
            aes_key, hmac_key = decrypt_py._derive_keys(bytes.fromhex(key), salt)

            def enc_page(page, page_no):
                body = page[16 if page_no == 1 else 0:ps - 80]
                iv = os.urandom(16)
                e = Cipher(algorithms.AES(aes_key), modes.CBC(iv)).encryptor()
                ct = e.update(body) + e.finalize()
                mac = _hmac.new(hmac_key, ct + iv + page_no.to_bytes(4, "little"), hashlib.sha512).digest()
                return (salt if page_no == 1 else b"") + ct + iv + mac

            src = work / "db_storage" / "message" / "message_0.db"
            src.parent.mkdir(parents=True)
            src.write_bytes(b"".join(enc_page(db_plain[i * ps:(i + 1) * ps], i + 1)
                                     for i in range(len(db_plain) // ps)))
            out = bytearray(wal_plain[:32])
            for i in range((len(wal_plain) - 32) // (24 + ps)):
                off = 32 + i * (24 + ps)
                page_no = struct.unpack(">I", wal_plain[off:off + 4])[0]
                out += wal_plain[off:off + 24] + enc_page(wal_plain[off + 24:off + 24 + ps], page_no)
            Path(str(src) + "-wal").write_bytes(bytes(out))

            dst = work / "dec"
            dst.mkdir()
            staging = work / "stage"
            staging.mkdir()
            res = refresh.process_db(src, dst_dir=dst, staging=staging, key_hex=key, lib=None)
            self.assertTrue(res.ok, res.error)
            self.assertGreaterEqual(res.wal_frames, 1)
            c = sqlite3.connect(str(dst / "message_0.db"))
            try:
                rows = [r[0] for r in c.execute("SELECT content FROM Msg_x ORDER BY local_id")]
                self.assertEqual(c.execute("PRAGMA quick_check").fetchone()[0], "ok")
            finally:
                c.close()
            self.assertEqual(len(rows), 16)
            self.assertEqual(rows[-1], "gen2")


class EtcliEndpointTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import etcli
        cls.etcli = etcli

    def setUp(self):
        from http.server import ThreadingHTTPServer
        self.cfg = {}
        e = self.etcli
        self.ls = e._LIVE_SYNC
        self._orig = (self.ls._config_load, self.ls._config_save, self.ls._resolve_profile)
        self.ls._config_load = lambda: dict(self.cfg)
        self.ls._config_save = lambda c: self.cfg.update(c)
        self.ls._resolve_profile = lambda: None
        # Keep the handler from auto-loading a real decrypted dir on dev boxes.
        p = mock.patch.object(e, "discover_data_dir", return_value=None)
        p.start()
        self.addCleanup(p.stop)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), e._MurmurAPIHandler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.ls.configure(enabled=False)
        self.httpd.shutdown()
        self.httpd.server_close()
        self.ls._config_load, self.ls._config_save, self.ls._resolve_profile = self._orig

    def _req(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=data, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        conn.close()
        return resp.status, payload

    def test_status_and_toggle(self):
        status, st = self._req("GET", "/api/live-sync/status")
        self.assertEqual(status, 200)
        self.assertIn("enabled", st)
        self.assertIn("last_sync_ts", st)
        self.assertEqual(st["platforms"], ["wechat"])

        status, st = self._req("POST", "/api/live-sync", {"enabled": True, "interval": 4})
        self.assertEqual(status, 200)
        self.assertTrue(st["ok"])
        self.assertTrue(st["enabled"])
        self.assertEqual(st["interval"], 4)
        self.assertEqual(self.cfg["live_sync"], {"enabled": True, "interval": 4.0})

        status, st = self._req("POST", "/api/live-sync", {"enabled": "yes"})
        self.assertEqual(status, 400)
        status, st = self._req("POST", "/api/live-sync", {"enabled": False})
        self.assertFalse(st["enabled"])

    def test_manual_refresh_returns_409_while_sync_holds_lock(self):
        e = self.etcli
        with mock.patch.object(e, "_REFRESH_LOCK_TIMEOUT_S", 0.2), \
                mock.patch.object(e.subprocess, "run", side_effect=AssertionError("must not spawn")):
            self.assertTrue(live_sync.DECRYPT_LOCK.acquire(timeout=1))
            try:
                status, body = self._req("POST", "/api/refresh", {})
            finally:
                live_sync.DECRYPT_LOCK.release()
        self.assertEqual(status, 409)
        self.assertFalse(body["ok"])

    def test_invalidate_flushes_caches(self):
        e = self.etcli
        e._HOME_SUMMARY_CACHE["data"] = {"x": 1}
        e._FRIENDS_LIST_CACHE["private"] = (time.time(), [1])
        e._GRAPH_CACHE["g"] = (time.time(), {})
        e._MENTIONS_CACHE["m"] = (time.time(), {})
        e._MSG_INDEX_CACHE["counts"] = {"a": 1}
        store = SimpleNamespace(_contacts={"a": 1}, _sessions=[1], _msg_db_for_session={"a": "b"},
                                _known_malformed={"x"})
        with mock.patch.object(e._MurmurAPIHandler, "_wechat_store", store), \
                mock.patch.object(e._MurmurAPIHandler, "_active_platform", "qq"), \
                mock.patch.object(e, "_disk_clear") as disk_clear:
            e._live_sync_invalidate(["message_0.db"])
        self.assertIsNone(e._HOME_SUMMARY_CACHE["data"])
        self.assertEqual(e._FRIENDS_LIST_CACHE, {})
        self.assertEqual(e._GRAPH_CACHE, {})
        self.assertEqual(e._MENTIONS_CACHE, {})
        self.assertIsNone(e._MSG_INDEX_CACHE["counts"])
        self.assertIsNone(store._contacts)
        self.assertIsNone(store._sessions)
        self.assertEqual(store._msg_db_for_session, {})
        disk_clear.assert_not_called()  # QQ active → its disk cache is left alone


if __name__ == "__main__":
    unittest.main()
