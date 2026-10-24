"""App lock: hashing, back-off, the 423 gate on the HTTP API, unlock / disable."""
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import app_lock  # noqa: E402
import error_codes as ec  # noqa: E402

FAST = 1000  # PBKDF2 iterations for tests (production default is 600k)


class FakeClock:
    def __init__(self, t: float = 1_000_000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


class HashTest(unittest.TestCase):
    def test_roundtrip_and_salt(self) -> None:
        a = app_lock.hash_password("hunter22", iterations=FAST)
        b = app_lock.hash_password("hunter22", iterations=FAST)
        self.assertEqual(a["algo"], "pbkdf2_sha256")
        self.assertEqual(len(bytes.fromhex(a["salt"])), app_lock.SALT_BYTES)
        self.assertNotEqual(a["salt"], b["salt"])
        self.assertNotEqual(a["hash"], b["hash"])
        self.assertNotIn("hunter22", json.dumps(a))
        self.assertTrue(app_lock.verify_password("hunter22", a))
        self.assertFalse(app_lock.verify_password("hunter23", a))
        self.assertFalse(app_lock.verify_password("", a))

    def test_default_iterations_are_strong(self) -> None:
        self.assertGreaterEqual(app_lock.DEFAULT_ITERATIONS, 600_000)

    def test_verify_uses_stored_iterations(self) -> None:
        rec = app_lock.hash_password("pw1234", iterations=1234)
        self.assertEqual(rec["iterations"], 1234)
        self.assertTrue(app_lock.verify_password("pw1234", rec))

    def test_verify_rejects_garbage_records(self) -> None:
        for rec in ({}, {"algo": "md5"}, {"algo": "pbkdf2_sha256", "iterations": "x", "salt": "zz", "hash": ""},
                    {"algo": "pbkdf2_sha256", "iterations": 0, "salt": "00", "hash": "00"}):
            self.assertFalse(app_lock.verify_password("pw1234", rec))

    def test_nfc_normalized(self) -> None:
        composed, decomposed = "café!", "café!"
        rec = app_lock.hash_password(decomposed, iterations=FAST)
        self.assertTrue(app_lock.verify_password(composed, rec))
        self.assertTrue(app_lock.verify_password(decomposed, rec))

    def test_legacy_unnormalized_hash_still_verifies(self) -> None:
        # A record hashed from the raw (decomposed) string, as before NFC.
        decomposed = "café!"
        salt = b"\x01" * 16
        rec = {"algo": "pbkdf2_sha256", "iterations": FAST, "salt": salt.hex(),
               "hash": hashlib.pbkdf2_hmac("sha256", decomposed.encode("utf-8"), salt, FAST).hex()}
        self.assertTrue(app_lock.verify_password(decomposed, rec))
        self.assertFalse(app_lock.verify_password("cafe!", rec))

    def test_codes_registered(self) -> None:
        for code in (app_lock.APP_LOCKED, app_lock.APP_LOCK_WRONG_PASSWORD,
                     app_lock.APP_LOCK_RATE_LIMITED, app_lock.APP_LOCK_INVALID):
            self.assertIn(code, ec.ALL_CODES)


class AppLockStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "murmur" / "app_lock.json"
        self.clock = FakeClock()

    def make(self) -> app_lock.AppLock:
        return app_lock.AppLock(self.path, iterations=FAST, clock=self.clock)

    def test_off_by_default(self) -> None:
        lock = self.make()
        self.assertFalse(lock.enabled)
        self.assertFalse(lock.is_locked())
        self.assertFalse(lock.lock())
        self.assertFalse(self.path.exists())

    def test_set_then_restart_starts_locked(self) -> None:
        lock = self.make()
        lock.set_password("pw1234", idle_minutes=5)
        self.assertFalse(lock.is_locked())  # the user who set it stays in
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertNotIn("pw1234", json.dumps(stored))
        self.assertEqual(stored["idle_minutes"], 5)

        again = self.make()  # simulates a backend restart
        self.assertTrue(again.enabled)
        self.assertTrue(again.is_locked())
        again.unlock("pw1234")
        self.assertFalse(again.is_locked())

    def test_password_rules(self) -> None:
        lock = self.make()
        with self.assertRaises(app_lock.AppLockError) as cm:
            lock.set_password("abc")
        self.assertEqual(cm.exception.code, app_lock.APP_LOCK_INVALID)
        with self.assertRaises(app_lock.AppLockError):
            lock.set_password("abcd", idle_minutes=7)
        self.assertFalse(lock.enabled)

    def test_change_needs_current_password(self) -> None:
        lock = self.make()
        lock.set_password("pw1234")
        with self.assertRaises(app_lock.AppLockError) as cm:
            lock.set_password("newpass", current_password="wrong")
        self.assertEqual(cm.exception.code, app_lock.APP_LOCK_WRONG_PASSWORD)
        lock.set_password("newpass", current_password="pw1234")
        lock.lock()
        with self.assertRaises(app_lock.AppLockError):
            lock.unlock("pw1234")
        lock.unlock("newpass")

    def test_backoff_grows_and_survives_restart(self) -> None:
        lock = self.make()
        lock.set_password("pw1234")
        lock.lock()
        # First FREE_ATTEMPTS failures carry no wait.
        for _ in range(app_lock.FREE_ATTEMPTS - 1):
            with self.assertRaises(app_lock.AppLockError) as cm:
                lock.unlock("nope")
            self.assertEqual(cm.exception.retry_after, 0)
        with self.assertRaises(app_lock.AppLockError) as cm:
            lock.unlock("nope")
        self.assertEqual(cm.exception.code, app_lock.APP_LOCK_WRONG_PASSWORD)
        self.assertEqual(cm.exception.retry_after, app_lock.BASE_DELAY)

        # During the wait even the right password is refused, unchecked.
        with self.assertRaises(app_lock.AppLockError) as cm:
            lock.unlock("pw1234")
        self.assertEqual(cm.exception.code, app_lock.APP_LOCK_RATE_LIMITED)
        self.assertEqual(cm.exception.status, 429)

        # Relaunching the app does not reset the counter.
        lock = self.make()
        self.assertEqual(lock.status()["retry_after"], int(app_lock.BASE_DELAY))
        with self.assertRaises(app_lock.AppLockError) as cm:
            lock.unlock("pw1234")
        self.assertEqual(cm.exception.code, app_lock.APP_LOCK_RATE_LIMITED)

        self.clock.t += app_lock.BASE_DELAY
        with self.assertRaises(app_lock.AppLockError) as cm:
            lock.unlock("nope")
        self.assertEqual(cm.exception.retry_after, app_lock.BASE_DELAY * 2)

        self.clock.t += app_lock.BASE_DELAY * 2
        lock.unlock("pw1234")
        self.assertFalse(lock.is_locked())
        self.assertEqual(lock.status()["failed_attempts"], 0)

    def test_delay_never_overflows(self) -> None:
        self.assertEqual(app_lock.retry_delay(10 ** 6), app_lock.MAX_DELAY)

    def test_clock_rollback_caps_wait(self) -> None:
        lock = self.make()
        lock.set_password("pw1234")
        lock.lock()
        for _ in range(app_lock.FREE_ATTEMPTS + 6):
            try:
                lock.unlock("nope")
            except app_lock.AppLockError:
                pass
            self.clock.t += app_lock.MAX_DELAY
        with self.assertRaises(app_lock.AppLockError):
            lock.unlock("nope")  # starts a fresh MAX_DELAY wait
        self.clock.t -= 10 ** 7  # wall clock jumps back ~4 months
        self.assertLessEqual(lock.status()["retry_after"], app_lock.MAX_DELAY)
        self.assertLessEqual(self.make().status()["retry_after"], app_lock.MAX_DELAY)
        self.clock.t += app_lock.MAX_DELAY
        lock.unlock("pw1234")
        self.assertFalse(lock.is_locked())

    def test_backend_idle_autolock(self) -> None:
        lock = self.make()
        lock.set_password("pw1234", idle_minutes=5)
        self.clock.t += 299
        self.assertFalse(lock.is_locked())
        self.assertTrue(lock.touch())
        self.clock.t += 299
        self.assertFalse(lock.is_locked())
        self.clock.t += 2
        self.assertTrue(lock.is_locked())
        self.assertTrue(lock.status()["locked"])
        self.assertFalse(lock.touch())  # activity can't undo the lock
        self.assertTrue(lock.is_locked())
        lock.unlock("pw1234")
        self.clock.t += 299
        self.assertFalse(lock.is_locked())

    def test_idle_never(self) -> None:
        lock = self.make()
        lock.set_password("pw1234", idle_minutes=0)
        self.clock.t += 10 ** 6
        self.assertFalse(lock.is_locked())

    def test_idle_clock_rollback_restarts_window(self) -> None:
        lock = self.make()
        lock.set_password("pw1234", idle_minutes=5)
        self.clock.t -= 10 ** 6
        self.assertFalse(lock.is_locked())
        self.clock.t += 299
        self.assertFalse(lock.is_locked())
        self.clock.t += 2
        self.assertTrue(lock.is_locked())

    def test_overlong_password_is_a_failed_attempt(self) -> None:
        lock = self.make()
        lock.set_password("pw1234")
        lock.lock()
        with self.assertRaises(app_lock.AppLockError) as cm:
            lock.unlock("x" * (app_lock.MAX_PASSWORD_LEN + 1))
        self.assertEqual(cm.exception.code, app_lock.APP_LOCK_WRONG_PASSWORD)
        self.assertEqual(lock.status()["failed_attempts"], 1)
        with self.assertRaises(app_lock.AppLockError):
            lock.set_password("y" * (app_lock.MAX_PASSWORD_LEN + 1))

    @unittest.skipIf(os.name == "nt", "POSIX file modes")
    def test_lock_file_is_private(self) -> None:
        lock = self.make()
        lock.set_password("pw1234")
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        self.assertFalse(self.path.with_name(self.path.name + ".tmp").exists())

    def test_delay_is_capped(self) -> None:
        self.assertEqual(app_lock.retry_delay(0), 0)
        self.assertEqual(app_lock.retry_delay(100), app_lock.MAX_DELAY)

    def test_disable(self) -> None:
        lock = self.make()
        lock.set_password("pw1234")
        with self.assertRaises(app_lock.AppLockError):
            lock.disable("wrong")
        self.assertTrue(lock.enabled)
        lock.disable("pw1234")
        self.assertFalse(lock.enabled)
        self.assertFalse(self.path.exists())
        self.assertFalse(self.make().is_locked())

    def test_deleting_file_is_the_reset(self) -> None:
        lock = self.make()
        lock.set_password("pw1234")
        self.path.unlink()
        self.assertFalse(self.make().is_locked())

    def test_corrupt_file_means_off(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{not json", encoding="utf-8")
        self.assertFalse(self.make().enabled)

    def test_idle_minutes(self) -> None:
        lock = self.make()
        with self.assertRaises(app_lock.AppLockError):
            lock.set_idle_minutes(5)  # no password yet
        lock.set_password("pw1234")
        self.assertEqual(lock.idle_minutes, app_lock.DEFAULT_IDLE_MINUTES)
        lock.set_idle_minutes(0)
        self.assertEqual(self.make().idle_minutes, 0)
        with self.assertRaises(app_lock.AppLockError):
            lock.set_idle_minutes(10)


class ReleaseBuildTest(unittest.TestCase):
    def test_release_build_has_no_devtools(self) -> None:
        # With the webview inspector in release builds, anyone at the lock
        # screen could open Inspect and call Tauri commands behind the lock.
        cargo = (ROOT / "app" / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
        deps = [ln for ln in cargo.splitlines() if ln.strip().startswith("tauri ")
                or ln.strip().startswith("tauri=")]
        self.assertEqual(len(deps), 1, deps)
        self.assertNotIn("devtools", deps[0])


class ApiGateTest(unittest.TestCase):
    """The lock is enforced by the backend, not just drawn by the frontend."""

    def setUp(self) -> None:
        import etcli
        from etcli import EchoStore, _MurmurAPIHandler

        self.H = _MurmurAPIHandler
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        data_dir = tmp / "wxid_abc123"
        data_dir.mkdir()
        conn = sqlite3.connect(data_dir / "session.db")
        try:
            conn.execute("CREATE TABLE SessionTable (username TEXT)")
        finally:
            conn.close()

        saved = {name: self.H.__dict__.get(name) for name in ("store", "export_dir", "app_lock")}
        self.addCleanup(self._restore, saved)
        self.H.store = EchoStore(data_dir)
        self.H.export_dir = tmp / "exports"
        self.clock = FakeClock()
        self.lock_path = tmp / "home" / ".murmur" / "app_lock.json"
        self.H.app_lock = app_lock.AppLock(self.lock_path, iterations=FAST, clock=self.clock)
        self.assertIsNotNone(etcli)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def _restore(self, saved: dict) -> None:
        for name, value in saved.items():
            setattr(self.H, name, value)
        self._tmp.cleanup()

    def call(self, path: str, body=None):
        port = self.server.server_address[1]
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                     headers={"Content-Type": "application/json"},
                                     method="GET" if body is None else "POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_disabled_lock_is_transparent(self) -> None:
        status, body = self.call("/api/info")
        self.assertEqual(status, 200)
        self.assertIn("data_dir", body)
        status, body = self.call("/api/app-lock/status")
        self.assertEqual(status, 200)
        self.assertFalse(body["enabled"])
        self.assertFalse(body["locked"])

    def test_locked_refuses_data_then_unlock_restores(self) -> None:
        status, body = self.call("/api/app-lock/set", {"password": "pw1234", "idle_minutes": 30})
        self.assertEqual(status, 200)
        self.assertTrue(body["enabled"])
        self.assertFalse(body["locked"])
        self.assertNotIn("password", body)

        status, body = self.call("/api/app-lock/lock", {})
        self.assertEqual(status, 200)
        self.assertTrue(body["locked"])

        for path in ("/api/info", "/api/friends", "/api/media/abc", "/api/diagnose", "/api/profiles"):
            status, body = self.call(path)
            self.assertEqual(status, 423, path)
            self.assertEqual(body["code"], ec.APP_LOCKED, path)
            self.assertNotIn("data_dir", body)
        # POSTs too — and they never reach the handler.
        status, body = self.call("/api/refresh", {})
        self.assertEqual((status, body["code"]), (423, ec.APP_LOCKED))
        # Lock management needs an unlocked app (except status/unlock/lock).
        status, body = self.call("/api/app-lock/disable", {"current_password": "pw1234"})
        self.assertEqual((status, body["code"]), (423, ec.APP_LOCKED))
        status, body = self.call("/api/app-lock/status")
        self.assertEqual(status, 200)
        self.assertTrue(body["locked"])
        self.assertEqual(body["idle_minutes"], 30)

        status, body = self.call("/api/app-lock/unlock", {"password": "wrong"})
        self.assertEqual((status, body["code"]), (401, ec.APP_LOCK_WRONG_PASSWORD))
        status, _ = self.call("/api/info")
        self.assertEqual(status, 423)

        status, body = self.call("/api/app-lock/unlock", {"password": "pw1234"})
        self.assertEqual(status, 200)
        self.assertFalse(body["locked"])
        status, body = self.call("/api/info")
        self.assertEqual(status, 200)
        self.assertIn("data_dir", body)

    def test_rate_limit_over_http(self) -> None:
        self.call("/api/app-lock/set", {"password": "pw1234"})
        self.call("/api/app-lock/lock", {})
        for _ in range(app_lock.FREE_ATTEMPTS):
            status, body = self.call("/api/app-lock/unlock", {"password": "nope"})
            self.assertEqual(status, 401)
        self.assertEqual(body["retry_after"], int(app_lock.BASE_DELAY))
        status, body = self.call("/api/app-lock/unlock", {"password": "pw1234"})
        self.assertEqual((status, body["code"]), (429, ec.APP_LOCK_RATE_LIMITED))
        self.assertGreater(body["retry_after"], 0)
        self.clock.t += app_lock.BASE_DELAY
        status, _ = self.call("/api/app-lock/unlock", {"password": "pw1234"})
        self.assertEqual(status, 200)

    def test_turn_off(self) -> None:
        self.call("/api/app-lock/set", {"password": "pw1234"})
        status, body = self.call("/api/app-lock/disable", {"current_password": "bad"})
        self.assertEqual((status, body["code"]), (401, ec.APP_LOCK_WRONG_PASSWORD))
        status, body = self.call("/api/app-lock/disable", {"current_password": "pw1234"})
        self.assertEqual(status, 200)
        self.assertFalse(body["enabled"])
        self.assertFalse(self.lock_path.exists())
        self.assertEqual(self.call("/api/app-lock/lock", {})[1]["locked"], False)
        self.assertEqual(self.call("/api/info")[0], 200)

    def raw_post(self, path: str, body: bytes):
        port = self.server.server_address[1]
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body,
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_body_size_limit(self) -> None:
        self.call("/api/app-lock/set", {"password": "pw1234"})
        self.call("/api/app-lock/lock", {})
        big = json.dumps({"password": "a" * (app_lock.MAX_BODY_BYTES + 10)}).encode("utf-8")
        status, body = self.raw_post("/api/app-lock/unlock", big)
        self.assertEqual((status, body["code"]), (413, ec.APP_LOCK_INVALID))
        self.assertEqual(self.call("/api/app-lock/status")[1]["failed_attempts"], 0)
        # Fits in 4 KB but is longer than any password: a failed attempt.
        status, body = self.call("/api/app-lock/unlock", {"password": "a" * 1000})
        self.assertEqual((status, body["code"]), (401, ec.APP_LOCK_WRONG_PASSWORD))
        self.assertEqual(self.call("/api/app-lock/status")[1]["failed_attempts"], 1)

    def test_backend_idle_lock_ignores_data_polling(self) -> None:
        self.call("/api/app-lock/set", {"password": "pw1234", "idle_minutes": 5})
        self.clock.t += 200
        self.assertEqual(self.call("/api/info")[0], 200)  # a poll, not activity
        self.clock.t += 101
        status, body = self.call("/api/info")
        self.assertEqual((status, body["code"]), (423, ec.APP_LOCKED))
        self.assertTrue(self.call("/api/app-lock/status")[1]["locked"])

    def test_activity_heartbeat_keeps_unlocked(self) -> None:
        self.call("/api/app-lock/set", {"password": "pw1234", "idle_minutes": 5})
        for _ in range(3):
            self.clock.t += 250
            status, body = self.call("/api/app-lock/activity", {})
            self.assertEqual(status, 200)
            self.assertFalse(body["locked"])
        self.assertEqual(self.call("/api/info")[0], 200)
        self.clock.t += 301
        # Once locked, a heartbeat is refused and does not unlock.
        status, body = self.call("/api/app-lock/activity", {})
        self.assertEqual((status, body["code"]), (423, ec.APP_LOCKED))
        self.assertEqual(self.call("/api/info")[0], 423)

    def test_bad_input(self) -> None:
        status, body = self.call("/api/app-lock/set", {"password": "ab"})
        self.assertEqual((status, body["code"]), (400, ec.APP_LOCK_INVALID))
        status, body = self.call("/api/app-lock/set", {"password": 12345})
        self.assertEqual((status, body["code"]), (400, ec.APP_LOCK_INVALID))
        status, _ = self.call("/api/app-lock/nope", {})
        self.assertEqual(status, 404)
        # JSON false is not "0 minutes" (bool is an int subclass in Python).
        status, body = self.call("/api/app-lock/set", {"password": "pw1234", "idle_minutes": False})
        self.assertEqual(status, 200)
        self.assertEqual(body["idle_minutes"], app_lock.DEFAULT_IDLE_MINUTES)


if __name__ == "__main__":
    unittest.main()
