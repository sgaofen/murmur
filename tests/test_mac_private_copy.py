"""Tests for the Frida-free / root-free macOS key capture (private copy).

No Frida, no WeChat, no real copying or re-signing: every side effect
(discover profile, collect salts, copytree, codesign, launch) is injected.
The capture dylib is replaced by a fake Popen that appends the same
`key …` / `pbkdf …` lines the real dylib (cli/native/murmur_keycap.c) writes.

Pure stdlib so it runs in the dependency-free CI env.
"""
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import mac_private_copy as mpc  # noqa: E402

PAGE = 4096
SALT = 16
RESERVE = 80
AES_BLOCK = 16


def make_page1(key: bytes, salt: bytes) -> bytes:
    """Build a page 1 whose SQLCipher-4 HMAC verifies for `key` + `salt`."""
    body_end = PAGE - RESERVE
    body = bytes(range(256)) * ((body_end - SALT) // 256 + 1)
    body = body[: body_end - SALT]
    iv = bytes(range(AES_BLOCK))
    mac_salt = bytes(b ^ 0x3A for b in salt)
    hk = hashlib.pbkdf2_hmac("sha512", key, mac_salt, 2, 32)
    mac = hmac.new(hk, digestmod=hashlib.sha512)
    mac.update(body)
    mac.update(iv)
    mac.update((1).to_bytes(4, "little"))
    tail = iv + mac.digest()
    tail = tail + bytes(RESERVE - len(tail))
    page = salt + body + tail
    assert len(page) == PAGE, len(page)
    return page


class FakeProfile:
    def __init__(self, wxid="wxid_test"):
        self.wxid = wxid


class FakeProc:
    def __init__(self):
        self.terminated = False

        self.killed = False

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True

    def poll(self):
        return 0 if (self.terminated or self.killed) else None

    def wait(self, timeout=None):
        return self.poll()


# ------------------------------------------------------- pure helpers ----

class EntitlementsTest(unittest.TestCase):
    def test_entitlements_have_injection_keys(self):
        d = mpc.entitlements_dict()
        self.assertTrue(d["com.apple.security.get-task-allow"])
        self.assertTrue(d["com.apple.security.cs.disable-library-validation"])
        self.assertTrue(d["com.apple.security.cs.allow-dyld-environment-variables"])

    def test_entitlements_xml_roundtrips(self):
        import plistlib
        blob = mpc.entitlements_xml()
        self.assertEqual(plistlib.loads(blob), mpc.entitlements_dict())


class CommandTest(unittest.TestCase):
    def test_resign_argv_is_adhoc_and_has_entitlements(self):
        argv = mpc.resign_argv(Path("/x/WeChat.app"), Path("/x/ent.plist"))
        self.assertEqual(argv[0], "codesign")
        self.assertIn("--force", argv)
        self.assertIn("--deep", argv)
        # Ad-hoc identity.
        self.assertEqual(argv[argv.index("--sign") + 1], "-")
        # Paths are compared via Path so the test is OS-separator agnostic.
        self.assertEqual(argv[argv.index("--entitlements") + 1], str(Path("/x/ent.plist")))
        # The hardened runtime is dropped by NOT passing --options runtime.
        self.assertNotIn("runtime", argv)
        self.assertEqual(argv[-1], str(Path("/x/WeChat.app")))

    def test_launch_env_injects_dylib_and_out(self):
        env = mpc.launch_env(Path("/o/cap.txt"), Path("/d/k.dylib"), base_env={"PATH": "/bin"})
        self.assertEqual(env["DYLD_INSERT_LIBRARIES"], str(Path("/d/k.dylib")))
        self.assertEqual(env["MURMUR_KEYCAP_OUT"], str(Path("/o/cap.txt")))
        self.assertEqual(env["PATH"], "/bin")

    def test_launch_argv_finds_executable(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td) / "WeChat.app"
            macos = app / "Contents" / "MacOS"
            macos.mkdir(parents=True)
            exe = macos / "WeChat"
            exe.write_text("#!/bin/sh\n")
            exe.chmod(0o755)
            self.assertEqual(mpc.launch_argv(app), [str(exe)])

    def test_launch_argv_raises_when_empty(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td) / "WeChat.app"
            (app / "Contents" / "MacOS").mkdir(parents=True)
            with self.assertRaises(FileNotFoundError):
                mpc.launch_argv(app)


# -------------------------------------------------- candidate parsing ----

class ParseTest(unittest.TestCase):
    def test_parse_keys_and_pbkdf_dedup(self):
        text = (
            "key " + "ab" * 32 + "\n"
            "key " + "ab" * 32 + "\n"            # duplicate
            "pbkdf 5 256000 " + "aa" * 10 + " " + "bb" * 32 + "\n"
            "pbkdf 5 256000 " + "aa" * 10 + " " + "bb" * 32 + "\n"  # duplicate
        )
        out = mpc.parse_candidates(text)
        self.assertEqual(len(out["keys"]), 1)
        self.assertEqual(out["keys"][0], bytes.fromhex("ab" * 32))
        self.assertEqual(len(out["pbkdf"]), 1)
        self.assertEqual(out["pbkdf"][0]["pw"], bytes.fromhex("aa" * 10))
        self.assertEqual(out["pbkdf"][0]["prf"], 5)
        self.assertEqual(out["pbkdf"][0]["rounds"], 256000)

    def test_parse_ignores_malformed_and_partial_last_line(self):
        text = (
            "garbage\n"
            "key nothex!!\n"
            "key " + "cd" * 32 + "\n"
            "pbkdf 5\n"                      # too few fields
            "key " + "ef" * 20               # partial final line (wrong length, no newline)
        )
        out = mpc.parse_candidates(text)
        self.assertEqual(out["keys"], [bytes.fromhex("cd" * 32)])
        self.assertEqual(out["pbkdf"], [])

    def test_parse_empty(self):
        self.assertEqual(mpc.parse_candidates(""), {"keys": [], "pbkdf": []})


# ------------------------------------------------ verify / derive flow ----

class DeriveTest(unittest.TestCase):
    def test_derive_db_key_verifies(self):
        pw = b"account-passphrase"
        salt = bytes(range(16))
        rounds = 3  # fast
        key = hashlib.pbkdf2_hmac("sha512", pw, salt, rounds, 32)
        page1 = make_page1(key, salt)
        got = mpc.derive_db_key(pw, page1, prf=5, rounds=rounds)
        self.assertEqual(got, key)

    def test_derive_db_key_wrong_passphrase(self):
        salt = bytes(range(16))
        key = hashlib.pbkdf2_hmac("sha512", b"right", salt, 3, 32)
        page1 = make_page1(key, salt)
        self.assertIsNone(mpc.derive_db_key(b"wrong", page1, prf=5, rounds=3))

    def test_match_candidates_passphrase_unlocks_all(self):
        pw = b"pp"
        rounds = 2
        pending = {}
        for i in range(3):
            salt = bytes([i]) + bytes(range(15))
            key = hashlib.pbkdf2_hmac("sha512", pw, salt, rounds, 32)
            pending[f"db{i}/x.db"] = make_page1(key, salt)
        cands = {"keys": [], "pbkdf": [{"pw": pw, "prf": 5, "rounds": rounds}]}
        found = mpc.match_candidates(cands, pending)
        self.assertEqual(set(found), {"db0/x.db", "db1/x.db", "db2/x.db"})

    def test_match_candidates_raw_key(self):
        salt = bytes(range(16))
        key = bytes(range(32))
        pending = {"a/b.db": make_page1(key, salt)}
        cands = {"keys": [key], "pbkdf": []}
        found = mpc.match_candidates(cands, pending)
        self.assertEqual(found, {"a/b.db": key.hex()})


# --------------------------------------------------------------- job ----

class JobTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.keys_file = self.root / "decrypted_keys.json"
        self.copy_dir = self.root / "wechat-copy"
        # A real source app to copy from.
        self.src_app = self.root / "src" / "WeChat.app"
        (self.src_app / "Contents" / "MacOS").mkdir(parents=True)
        exe = self.src_app / "Contents" / "MacOS" / "WeChat"
        exe.write_text("#!/bin/sh\n")
        exe.chmod(0o755)
        self.dylib = self.root / "murmur_keycap.dylib"
        self.dylib.write_bytes(b"\xcf\xfa")  # content irrelevant (fake popen)

    def tearDown(self):
        self.tmp.cleanup()

    def _salt_map(self, pw, rounds):
        salt_map = {}
        self._pending_pages = {}
        for i in range(2):
            salt = bytes([i]) + bytes(range(15))
            key = hashlib.pbkdf2_hmac("sha512", pw, salt, rounds, 32)
            page1 = make_page1(key, salt)
            rel = f"db{i}/x.db"
            salt_map[salt.hex()] = {"name": rel, "page1": page1}
            self._pending_pages[rel] = page1
        return salt_map

    def _make_job(self, salt_map, popen):
        return mpc.PrivateCopyJob(
            popen=popen,
            run=lambda *a, **k: type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})(),
            discover_profiles=lambda: [FakeProfile()],
            collect_salts=lambda prof: salt_map,
            find_app=lambda: self.src_app,
            dylib=lambda: self.dylib,
            keys_file=self.keys_file,
            copy_dir=self.copy_dir,
            poll_interval=0.01,
        )

    def test_full_capture_merges_keys(self):
        pw = b"pp"
        rounds = 2
        salt_map = self._salt_map(pw, rounds)

        def fake_popen(argv, env=None, **kw):
            # The "dylib" writes the passphrase candidate into the out file.
            out = Path(env["MURMUR_KEYCAP_OUT"])
            out.write_text("pbkdf 5 %d %s %s\n" % (rounds, pw.hex(), ("00" * 32)))
            return FakeProc()

        job = self._make_job(salt_map, fake_popen)
        r = job.start(seconds=30)
        self.assertTrue(r.get("started"))
        self._wait(job)
        st = job.status()
        self.assertEqual(st["phase"], "done")
        self.assertEqual(sorted(st["new"]), ["db0/x.db", "db1/x.db"])
        self.assertTrue(st["passphrase_found"])
        # Keys merged into the keys file.
        saved = json.loads(self.keys_file.read_text())
        self.assertEqual(set(saved["keys_by_db"]), {"db0/x.db", "db1/x.db"})
        # The source app was never modified; the copy exists + was re-signed.
        self.assertTrue((self.copy_dir / "WeChat.app").exists())
        self.assertTrue((self.copy_dir / "entitlements.plist").exists())

    def test_capture_nothing_reports_error(self):
        salt_map = self._salt_map(b"pp", 2)
        job = self._make_job(salt_map, lambda argv, env=None, **kw: FakeProc())
        # Fast-forward the collect loop's clock so the deadline passes at once
        # (no candidates are ever written by this fake Popen).
        ticks = iter(range(0, 1_000_000, 10_000))
        job._clock = lambda: next(ticks)
        job.start(seconds=30)
        self._wait(job)
        self.assertEqual(job.status()["phase"], "error")
        self.assertEqual(job.status()["error"], "no-keys")

    def test_missing_dylib_fails_fast(self):
        salt_map = self._salt_map(b"pp", 2)
        job = self._make_job(salt_map, lambda *a, **k: FakeProc())
        job._dylib = lambda: None
        r = job.start(seconds=30)
        self.assertFalse(r["ok"])
        self.assertIn("murmur_keycap.dylib", r["error"])

    def test_no_wechat_app_fails(self):
        salt_map = self._salt_map(b"pp", 2)
        job = self._make_job(salt_map, lambda *a, **k: FakeProc())
        job._find_app = lambda: None
        r = job.start(seconds=30)
        self.assertFalse(r["ok"])

    def test_resign_failure_surfaces(self):
        salt_map = self._salt_map(b"pp", 2)

        def failing_run(*a, **k):
            return type("R", (), {"returncode": 1, "stdout": "", "stderr": "bad sig"})()

        job = mpc.PrivateCopyJob(
            popen=lambda *a, **k: FakeProc(),
            run=failing_run,
            discover_profiles=lambda: [FakeProfile()],
            collect_salts=lambda prof: salt_map,
            find_app=lambda: self.src_app,
            dylib=lambda: self.dylib,
            keys_file=self.keys_file,
            copy_dir=self.copy_dir,
            poll_interval=0.01,
        )
        job.start(seconds=30)
        self._wait(job)
        st = job.status()
        self.assertEqual(st["phase"], "error")
        self.assertIn("重签名失败", st["error"])

    def test_delete_copy(self):
        self.copy_dir.mkdir(parents=True)
        (self.copy_dir / "WeChat.app").mkdir()
        job = self._make_job(self._salt_map(b"pp", 2), lambda *a, **k: FakeProc())
        r = job.delete_copy()
        self.assertTrue(r["ok"])
        self.assertTrue(r["deleted"])
        self.assertFalse((self.copy_dir / "WeChat.app").exists())

    def test_coverage_reports_pending(self):
        job = self._make_job(self._salt_map(b"pp", 2), lambda *a, **k: FakeProc())
        cov = job.coverage()
        self.assertEqual(cov["total"], 2)
        self.assertEqual(cov["known"], 0)
        self.assertEqual(len(cov["pending"]), 2)

    def _wait(self, job, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            if not job.status()["running"]:
                return
            time.sleep(0.02)
        self.fail("job did not finish")


# ------------------------------------------------- process lifecycle ----

class FakeOS:
    """A tiny fake process table: the copy's main process (what Popen returns)
    plus a helper it spawned (crashpad_handler-like) — both live under the
    copy dir — and optionally the original WeChat. `stubborn` processes ignore
    SIGTERM / terminate() and only die on SIGKILL / kill(); `immortal` ones
    never die (e.g. stuck in the kernel)."""

    def __init__(self):
        self.procs = {}  # pid -> {"cmd", "alive", "stubborn", "immortal"}
        self.next_pid = 1000
        self.signals = []

    def spawn(self, cmd, stubborn=False, immortal=False):
        pid = self.next_pid
        self.next_pid += 1
        self.procs[pid] = {"cmd": cmd, "alive": True,
                           "stubborn": stubborn, "immortal": immortal}
        return pid

    def alive(self, pid):
        return self.procs.get(pid, {}).get("alive", False)

    def list_procs(self):
        return [(pid, p["cmd"]) for pid, p in self.procs.items() if p["alive"]]

    def kill(self, pid, sig):
        self.signals.append((pid, sig))
        p = self.procs.get(pid)
        if p is None or not p["alive"]:
            raise ProcessLookupError(pid)
        if p["immortal"]:
            return
        if sig == mpc._SIGKILL or not p["stubborn"]:
            p["alive"] = False


class FakeOSProc:
    """Popen-like handle onto a FakeOS process."""

    def __init__(self, fos, pid):
        self.fos = fos
        self.pid = pid

    def poll(self):
        return None if self.fos.alive(self.pid) else 0

    def terminate(self):
        if self.fos.alive(self.pid):
            self.fos.kill(self.pid, mpc._SIGTERM)

    def kill(self):
        if self.fos.alive(self.pid):
            self.fos.kill(self.pid, mpc._SIGKILL)

    def wait(self, timeout=None):
        if self.fos.alive(self.pid):
            raise subprocess.TimeoutExpired("fake", timeout)
        return 0


class ProcessLifecycleTest(unittest.TestCase):
    """The copy must never outlive a round: it keeps appending every key and
    the passphrase to candidates.txt in plaintext, and a later round / delete
    would rmtree a running app."""

    setUp = JobTest.setUp
    tearDown = JobTest.tearDown
    _salt_map = JobTest._salt_map
    _wait = JobTest._wait

    def _job(self, salt_map, fos, write_candidates=True, stubborn=False,
             rounds=2, pw=b"pp"):
        self.launched = []

        def popen(argv, env=None, **kw):
            out = Path(env["MURMUR_KEYCAP_OUT"])
            if write_candidates:
                out.write_text("pbkdf 5 %d %s %s\n" % (rounds, pw.hex(), "00" * 32))
            else:
                out.write_text("key %s\n" % ("11" * 32))
            pid = fos.spawn(argv[0], stubborn=stubborn)
            # The copy forks a helper of its own, also under the copy dir.
            helper = str(Path(argv[0]).parent.parent / "Frameworks" / "crashpad_handler")
            fos.spawn(helper, stubborn=stubborn)
            self.launched.append(pid)
            return FakeOSProc(fos, pid)

        return mpc.PrivateCopyJob(
            popen=popen,
            run=lambda *a, **k: type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})(),
            discover_profiles=lambda: [FakeProfile()],
            collect_salts=lambda prof: salt_map,
            find_app=lambda: self.src_app,
            dylib=lambda: self.dylib,
            keys_file=self.keys_file,
            copy_dir=self.copy_dir,
            poll_interval=0.01,
            list_procs=fos.list_procs,
            kill=fos.kill,
            stop_timeout=0.05,
        )

    def _copy_alive(self, fos):
        root = str(self.copy_dir)
        return [pid for pid, cmd in fos.list_procs() if cmd.startswith(root)]

    def test_copy_stopped_after_successful_round(self):
        fos = FakeOS()
        job = self._job(self._salt_map(b"pp", 2), fos)
        self.assertTrue(job.start(seconds=30).get("started"))
        self._wait(job)
        self.assertEqual(job.status()["phase"], "done")
        self.assertEqual(self._copy_alive(fos), [])
        self.assertFalse((self.copy_dir / "candidates.txt").exists())

    def test_copy_stopped_after_timeout(self):
        fos = FakeOS()
        job = self._job(self._salt_map(b"pp", 2), fos, write_candidates=False)
        ticks = iter(range(0, 1_000_000, 10_000))
        job._clock = lambda: next(ticks)
        job.start(seconds=30)
        self._wait(job)
        self.assertEqual(job.status()["error"], "no-keys")
        self.assertEqual(self._copy_alive(fos), [])
        self.assertFalse((self.copy_dir / "candidates.txt").exists())

    def test_stubborn_copy_is_killed(self):
        fos = FakeOS()
        job = self._job(self._salt_map(b"pp", 2), fos, stubborn=True)
        job.start(seconds=30)
        self._wait(job)
        self.assertEqual(self._copy_alive(fos), [])
        self.assertIn(mpc._SIGKILL, [sig for _, sig in fos.signals])

    def test_cancel_stops_copy(self):
        fos = FakeOS()
        job = self._job(self._salt_map(b"pp", 2), fos, write_candidates=False)
        job.start(seconds=30)
        end = time.time() + 5
        while not self.launched and time.time() < end:
            time.sleep(0.01)
        job.cancel()
        self._wait(job)
        self.assertEqual(self._copy_alive(fos), [])
        self.assertFalse((self.copy_dir / "candidates.txt").exists())

    def _leftover_copy(self, fos, immortal=False):
        """A copy launched by an earlier Murmur session, still running."""
        exe = self.copy_dir / "WeChat.app" / "Contents" / "MacOS" / "WeChat"
        exe.parent.mkdir(parents=True)
        exe.write_text("#!/bin/sh\n")
        (self.copy_dir / "candidates.txt").write_text("key %s\n" % ("22" * 32))
        return fos.spawn(str(exe), immortal=immortal)

    def test_start_stops_leftover_copy_before_rmtree(self):
        fos = FakeOS()
        old = self._leftover_copy(fos)
        job = self._job(self._salt_map(b"pp", 2), fos)
        self.assertTrue(job.start(seconds=30).get("started"))
        self._wait(job)
        self.assertFalse(fos.alive(old))
        self.assertEqual(self._copy_alive(fos), [])

    def test_start_refuses_when_copy_cannot_be_stopped(self):
        fos = FakeOS()
        self._leftover_copy(fos, immortal=True)
        job = self._job(self._salt_map(b"pp", 2), fos)
        r = job.start(seconds=30)
        self.assertFalse(r["ok"])
        self.assertEqual(r.get("code"), "copy-running")
        # Never rmtree'd the running app.
        self.assertTrue((self.copy_dir / "WeChat.app" / "Contents" / "MacOS" / "WeChat").exists())
        self.assertEqual(self.launched, [])

    def test_delete_stops_leftover_copy_then_deletes(self):
        fos = FakeOS()
        old = self._leftover_copy(fos)
        job = self._job(self._salt_map(b"pp", 2), fos)
        r = job.delete_copy()
        self.assertTrue(r["ok"])
        self.assertFalse(fos.alive(old))
        self.assertFalse(self.copy_dir.exists())

    def test_delete_refuses_when_copy_cannot_be_stopped(self):
        fos = FakeOS()
        self._leftover_copy(fos, immortal=True)
        job = self._job(self._salt_map(b"pp", 2), fos)
        r = job.delete_copy()
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "copy-running")
        self.assertTrue((self.copy_dir / "WeChat.app").exists())
        # The plaintext capture file is still scrubbed.
        self.assertFalse((self.copy_dir / "candidates.txt").exists())

    def test_start_refuses_while_original_wechat_runs(self):
        fos = FakeOS()
        fos.spawn(str(self.src_app / "Contents" / "MacOS" / "WeChat"))
        job = self._job(self._salt_map(b"pp", 2), fos)
        r = job.start(seconds=30)
        self.assertFalse(r["ok"])
        self.assertEqual(r.get("code"), "original-running")
        self.assertIn("退出", r["error"])
        self.assertEqual(self.launched, [])
        self.assertFalse(self.copy_dir.exists())
        self.assertEqual(job.status()["phase"], "error")

    def test_original_check_ignores_the_copy_and_other_apps(self):
        fos = FakeOS()
        fos.spawn("/Applications/WeChatOther.app/Contents/MacOS/WeChatOther")
        fos.spawn(str(self.root / "src" / "WeChat.app.bak" / "Contents" / "MacOS" / "WeChat"))
        self._leftover_copy(fos)
        job = self._job(self._salt_map(b"pp", 2), fos)
        self.assertEqual(job.original_pids(self.src_app), [])


class ListProcsTest(unittest.TestCase):
    def test_parses_ps_output(self):
        out = ("  1 /sbin/launchd\n"
               "4321 /Users/a b/.murmur/wechat-copy/WeChat.app/Contents/MacOS/WeChat -x\n"
               "garbage line\n")
        seen = {}

        def run(argv, **kw):
            seen["argv"] = argv
            return type("R", (), {"returncode": 0, "stdout": out, "stderr": ""})()

        procs = mpc.list_processes(run)
        self.assertEqual(seen["argv"][0], "ps")
        self.assertEqual(procs[0], (1, "/sbin/launchd"))
        self.assertEqual(procs[1][0], 4321)
        self.assertTrue(procs[1][1].startswith("/Users/a b/.murmur/wechat-copy/"))
        self.assertEqual(len(procs), 2)

    def test_ps_failure_is_empty(self):
        def run(argv, **kw):
            raise OSError("no ps")
        self.assertEqual(mpc.list_processes(run), [])


if __name__ == "__main__":
    unittest.main()
