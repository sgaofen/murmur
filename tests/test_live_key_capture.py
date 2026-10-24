"""Tests for macOS live key capture (Frida) — sgaofen/murmur#27.

WeChat 4.1.9+ doesn't keep DB keys resident in memory, so the memory scan in
extract_key_mac.py finds nothing and the App has to fall back to hooking
CommonCrypto (hook_cc_key_frida.py) while the user actively uses WeChat.
Frida and WeChat are never touched here: the agent is replaced by a fake
attach() that feeds candidate keys, and the subprocess by a fake Popen.
"""
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import hook_cc_key_frida as hck  # noqa: E402
import live_key  # noqa: E402


# Never let a test touch the user's real ~/.murmur/decrypted_keys.json:
# Capture.save() without out_keys (CLI mode) merges into hck.OUT_PATH, and
# ReattachTest once did exactly that on a dev machine.
_KEYS_TMP = tempfile.TemporaryDirectory()
_KEYS_PATCHES = [
    mock.patch.object(hck, "OUT_PATH", os.path.join(_KEYS_TMP.name, "decrypted_keys.json")),
    mock.patch.object(live_key, "keys_path",
                      lambda: Path(_KEYS_TMP.name) / "decrypted_keys.json"),
]


def setUpModule():
    for p in _KEYS_PATCHES:
        p.start()


def tearDownModule():
    for p in _KEYS_PATCHES:
        p.stop()
    _KEYS_TMP.cleanup()

PAGE = 4096


def make_page1(key: bytes, salt: bytes) -> bytes:
    """Build a page 1 whose HMAC verifies for `key` (SQLCipher 4 layout)."""
    body = os.urandom(PAGE - 80 - 16)
    iv = os.urandom(16)
    mac_salt = bytes(b ^ 0x3A for b in salt)
    hk = hashlib.pbkdf2_hmac("sha512", key, mac_salt, 2, 32)
    m = hmac.new(hk, digestmod=hashlib.sha512)
    m.update(body)
    m.update(iv)
    m.update((1).to_bytes(4, "little"))
    page = salt + body + iv + m.digest()
    return page + b"\x00" * (PAGE - len(page))


class FakeSession:
    def __init__(self):
        self.detached = False

    def detach(self):
        self.detached = True


class FakeScript:
    def unload(self):
        pass


class CaptureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.k1, self.k2 = os.urandom(32), os.urandom(32)
        self.pages = {
            "session/session.db": make_page1(self.k1, os.urandom(16)),
            "message/message_0.db": make_page1(self.k2, os.urandom(16)),
        }
        patcher = mock.patch.object(hck, "LOG_PATH", str(self.d / "log.txt"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def _cap(self, **kw):
        return hck.Capture(self.pages, wxid="wxid_x", seconds=5,
                           out_keys=str(self.d / "new.json"),
                           progress_path=str(self.d / "progress.json"), **kw)

    def test_candidate_matching_and_out_keys(self):
        cap = self._cap()
        self.assertFalse(cap.on_candidate(os.urandom(32)))
        self.assertTrue(cap.on_candidate(self.k1, "CCCrypt"))
        out = json.loads((self.d / "new.json").read_text())
        self.assertEqual(out["keys_by_db"], {"session/session.db": self.k1.hex()})
        prog = json.loads((self.d / "progress.json").read_text())
        self.assertEqual(prog["matched_count"], 1)
        self.assertEqual(prog["total"], 2)
        self.assertEqual(prog["new"], ["session/session.db"])
        self.assertEqual(cap.hits, 2)

    def test_agent_message_routing(self):
        cap = self._cap()
        cap.on_message({"type": "send", "payload": {"type": "candidate", "fn": "CCCryptorCreate",
                                                    "key": list(self.k2)}}, None)
        cap.on_message({"type": "send", "payload": {"type": "info", "msg": "hooked"}}, None)
        cap.on_message({"type": "error", "description": "boom"}, None)
        self.assertEqual(set(cap.new), {"message/message_0.db"})

    def test_run_capture_stops_when_complete(self):
        cap = self._cap()

        def attach(pid, on_message, on_detached=None):
            # The agent fires both keys as soon as hooks are live.
            on_message({"type": "send", "payload": {"type": "candidate", "key": list(self.k1)}}, None)
            on_message({"type": "send", "payload": {"type": "candidate", "key": list(self.k2)}}, None)
            return FakeSession(), FakeScript()

        rc = hck.run_capture(cap, 123, attach=attach, sleep=lambda s: None)
        self.assertEqual(rc, hck.EXIT_OK)
        self.assertEqual(cap.pending, {})
        prog = json.loads((self.d / "progress.json").read_text())
        self.assertEqual(prog["phase"], "done")

    def test_run_capture_honours_stop_file_and_timeout(self):
        cap = self._cap()
        stop = self.d / "stop"
        t = [0.0]

        def clock():
            return t[0]

        def sleep(s):
            t[0] += s
            if t[0] >= 1.0:
                stop.write_text("x")

        rc = hck.run_capture(cap, 1, attach=lambda pid, cb, det=None: (FakeSession(), FakeScript()),
                             stop_file=str(stop), sleep=sleep, clock=clock)
        self.assertEqual(rc, hck.EXIT_OK)
        self.assertLess(t[0], 5)  # stopped well before --seconds

    def test_attach_denied_exit_code(self):
        class PermissionDeniedError(Exception):
            pass

        def attach(pid, cb, det=None):
            raise PermissionDeniedError("unable to access process with pid 1")

        cap = self._cap()
        rc = hck.run_capture(cap, 1, attach=attach)
        self.assertEqual(rc, hck.EXIT_ATTACH_DENIED)
        prog = json.loads((self.d / "progress.json").read_text())
        self.assertEqual(prog["error"], "attach-denied")

    def test_frida_missing_exit_code(self):
        def attach(pid, cb, det=None):
            raise ImportError("No module named 'frida'")

        rc = hck.run_capture(self._cap(), 1, attach=attach)
        self.assertEqual(rc, hck.EXIT_NO_FRIDA)

    def test_pages_file_roundtrip(self):
        f = self.d / "pages.json"
        f.write_text(json.dumps({"__wxid__": "wxid_x",
                                 "pages": {k: v.hex() for k, v in self.pages.items()}}))
        pages, wxid = hck.load_pages_file(str(f))
        self.assertEqual(wxid, "wxid_x")
        self.assertEqual(pages, self.pages)


class LiveKeyHelpersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_version_gate(self):
        self.assertTrue(live_key.version_needs_live_capture("4.1.22"))
        self.assertTrue(live_key.version_needs_live_capture("4.1.9"))
        self.assertTrue(live_key.version_needs_live_capture("4.2.0"))
        self.assertFalse(live_key.version_needs_live_capture("4.1.8"))
        self.assertFalse(live_key.version_needs_live_capture("4.0.6.21"))
        self.assertFalse(live_key.version_needs_live_capture(None))

    def test_split_pending_only_trusts_verifying_keys(self):
        k_ok, k_stale = os.urandom(32), os.urandom(32)
        s1, s2, s3 = os.urandom(16), os.urandom(16), os.urandom(16)
        salt_map = {
            s1.hex(): {"name": "a.db", "page1": make_page1(k_ok, s1)},
            s2.hex(): {"name": "b.db", "page1": make_page1(os.urandom(32), s2)},
            s3.hex(): {"name": "c.db", "page1": make_page1(k_ok, s3)},
        }
        existing = {"keys_by_db": {"a.db": k_ok.hex(), "b.db": k_stale.hex()},
                    "keys_by_salt": {s3.hex(): k_ok.hex()}}
        pending, known = live_key.split_pending(salt_map, existing)
        self.assertEqual(set(known), {"a.db", "c.db"})
        self.assertEqual(set(pending), {"b.db"})

    def test_merge_keeps_previous_rounds(self):
        path = self.d / "keys.json"
        path.write_text(json.dumps({"wxid": "wxid_x", "keys_by_db": {"a.db": "aa"},
                                    "keys_by_salt": {"s_a": "aa"}}))
        merged = live_key.merge_keys({"b.db": "bb"}, {"b.db": "s_b"}, None, path)
        self.assertEqual(merged["keys_by_db"], {"a.db": "aa", "b.db": "bb"})
        self.assertEqual(merged["keys_by_salt"], {"s_a": "aa", "s_b": "bb"})
        self.assertEqual(merged["wxid"], "wxid_x")
        self.assertEqual(json.loads(path.read_text())["keys_by_db"]["b.db"], "bb")

    def test_elevated_cmd_quotes_and_sets_pythonpath(self):
        cmd = live_key._elevated_cmd(["/usr/bin/python3", "/tmp/a b/x.py", "--seconds", "60"],
                                     "/Users/me/Library/Python/3.9/lib/python/site-packages")
        self.assertEqual(cmd[:2], ["osascript", "-e"])
        self.assertIn("with administrator privileges", cmd[2])
        self.assertIn("PYTHONPATH=", cmd[2])
        self.assertIn("'/tmp/a b/x.py'", cmd[2])

    def test_installer_uses_user_site_outside_venv(self):
        inst = live_key.FridaInstaller()
        with mock.patch.object(live_key.sys, "prefix", "/usr"), \
                mock.patch.object(live_key.sys, "base_prefix", "/usr", create=True):
            argv = inst.pip_argv()
        self.assertIn("--user", argv)
        self.assertEqual(argv[-1], live_key.FRIDA_REQ)

    def test_installer_refuses_when_frozen(self):
        with mock.patch.object(live_key, "is_frozen", return_value=True):
            r = live_key.FridaInstaller().start()
        self.assertFalse(r["ok"])


class FakeProc:
    """Stands in for the hook_cc_key_frida subprocess: writes progress and
    new keys like the real script would, then exits with `rc`."""

    def __init__(self, argv, rc, keys, progress=None, **kw):
        self.argv = argv
        self.killed = False
        self.returncode = None
        self._rc = rc
        self.stdout = None
        # Elevated runs are ["osascript", "-e", "<script>", *argv] here: the
        # tests patch live_key._elevated_cmd so the fake never has to parse
        # an AppleScript string (Windows temp paths don't survive that).
        args = argv[3:] if argv[0] == "osascript" else argv
        if rc == 0:
            prog = Path(args[args.index("--progress") + 1])
            out = Path(args[args.index("--out-keys") + 1])
            out.write_text(json.dumps({"keys_by_db": keys}))
            prog.write_text(json.dumps({"phase": "done", "new": sorted(keys), "hits": 7,
                                        "remaining": 0}))
        if progress is not None:
            Path(args[args.index("--progress") + 1]).write_text(json.dumps(progress))

    def poll(self):
        self.returncode = self._rc
        return self.returncode

    def kill(self):
        self.killed = True
        self._rc = -9

    def wait(self, timeout=None):
        return self.poll()


class LiveKeyJobTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.keys_file = self.d / "decrypted_keys.json"
        self.k1, self.k2 = os.urandom(32), os.urandom(32)
        self.s1, self.s2 = os.urandom(16), os.urandom(16)
        self.salt_map = {
            self.s1.hex(): {"name": "session/session.db", "page1": make_page1(self.k1, self.s1)},
            self.s2.hex(): {"name": "message/message_0.db", "page1": make_page1(self.k2, self.s2)},
        }
        prof = mock.Mock(wxid="wxid_x")
        self.calls = []
        self.plan = []  # list of (rc, keys) per Popen call

        self.pages_seen = []

        def popen(argv, **kw):
            rc, keys, *rest = self.plan[len(self.calls)]
            self.calls.append(argv)
            if "--pages" in argv:
                pages = json.loads(Path(argv[argv.index("--pages") + 1]).read_text())
                self.pages_seen.append(sorted(pages["pages"]))
            return FakeProc(argv, rc, keys, progress=rest[0] if rest else None, **kw)

        self.job = live_key.LiveKeyJob(
            popen=popen,
            discover_profiles=lambda: [prof],
            collect_salts=lambda p: self.salt_map,
            keys_file=self.keys_file,
            poll_interval=0.01,
        )

        patcher = mock.patch.object(live_key, "_elevated_cmd",
                                    lambda argv, pythonpath: ["osascript", "-e", "<script>", *argv])
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def _wait(self):
        for _ in range(500):
            if not self.job.status()["running"]:
                return self.job.status()
            time.sleep(0.01)
        self.fail("job did not finish")

    def test_user_level_capture_merges_keys(self):
        self.plan = [(0, {"session/session.db": self.k1.hex()})]
        r = self.job.start(60)
        self.assertTrue(r["started"])
        st = self._wait()
        self.assertEqual(st["phase"], "done")
        self.assertEqual(st["matched_count"], 1)
        self.assertEqual(st["total"], 2)
        self.assertEqual(len(self.calls), 1)
        self.assertNotEqual(self.calls[0][0], "osascript")
        saved = json.loads(self.keys_file.read_text())
        self.assertEqual(saved["keys_by_db"], {"session/session.db": self.k1.hex()})
        self.assertEqual(saved["keys_by_salt"], {self.s1.hex(): self.k1.hex()})

    def test_attach_denied_retries_with_admin(self):
        self.plan = [(live_key.EXIT_ATTACH_DENIED, {}), (0, {"message/message_0.db": self.k2.hex()})]
        self.job.start(60)
        st = self._wait()
        self.assertEqual(st["phase"], "done")
        self.assertTrue(st["elevated"])
        self.assertEqual(self.calls[1][0], "osascript")
        self.assertIn("message/message_0.db",
                      json.loads(self.keys_file.read_text())["keys_by_db"])

    def test_second_round_only_tracks_missing_dbs(self):
        self.keys_file.write_text(json.dumps({"keys_by_db": {"session/session.db": self.k1.hex()}}))
        self.plan = [(0, {"message/message_0.db": self.k2.hex()})]
        self.job.start(60)
        st = self._wait()
        self.assertEqual(st["known"], 1)
        self.assertEqual(st["matched_count"], 2)
        self.assertEqual(self.pages_seen, [["message/message_0.db"]])
        saved = json.loads(self.keys_file.read_text())["keys_by_db"]
        self.assertEqual(set(saved), {"session/session.db", "message/message_0.db"})

    def test_ignores_keys_for_unrequested_dbs(self):
        self.keys_file.write_text(json.dumps({"keys_by_db": {"session/session.db": self.k1.hex()}}))
        self.plan = [(0, {"session/session.db": "00" * 32})]
        self.job.start(60)
        self._wait()
        saved = json.loads(self.keys_file.read_text())["keys_by_db"]
        self.assertEqual(saved["session/session.db"], self.k1.hex())

    def test_nothing_pending_is_complete_without_spawning(self):
        self.keys_file.write_text(json.dumps({"keys_by_db": {
            "session/session.db": self.k1.hex(), "message/message_0.db": self.k2.hex()}}))
        r = self.job.start(60)
        self.assertTrue(r["complete"])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.job.coverage(), {"total": 2, "known": 2, "pending": []})

    def test_frida_missing_reported(self):
        self.plan = [(live_key.EXIT_NO_FRIDA, {})]
        self.job.start(60)
        st = self._wait()
        self.assertEqual(st["phase"], "error")
        self.assertEqual(st["error"], "frida-missing")

    def test_seconds_clamped(self):
        self.plan = [(0, {})]
        self.job.start(99999)
        self._wait()
        argv = self.calls[0]
        self.assertEqual(argv[argv.index("--seconds") + 1], str(live_key.MAX_SECONDS))



class KeysFileIsolationTest(unittest.TestCase):
    def test_cli_mode_save_goes_to_patched_path(self):
        real = os.path.expanduser("~/.murmur/decrypted_keys.json")
        self.assertNotEqual(hck.OUT_PATH, real)
        self.assertTrue(hck.OUT_PATH.startswith(_KEYS_TMP.name))
        self.assertNotEqual(str(live_key.keys_path()), real)

if __name__ == "__main__":
    unittest.main()


class ReviewFixesTest(unittest.TestCase):
    """Regressions from the #28 review."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        patcher = mock.patch.object(hck, "LOG_PATH", str(self.d / "log.txt"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    # 1. frozen etcli needs "--" before the forwarded args
    def test_frozen_runner_argv_has_separator(self):
        with mock.patch.object(live_key, "is_frozen", return_value=True):
            argv = live_key._runner_argv(self.d, "--seconds", "15")
        self.assertEqual(argv[1:], ["hook-cc-key-frida", "--", "--seconds", "15"])

    def test_etcli_forwards_args_to_hook_script(self):
        import etcli
        with mock.patch.object(hck, "main", return_value=0) as m:
            rc = etcli.main(["hook-cc-key-frida", "--", "--seconds", "15", "--pid", "1"])
        self.assertEqual(rc, 0)
        m.assert_called_once_with(["--seconds", "15", "--pid", "1"])

    # 2. stop file / vanished temp dir / dead parent end the child
    def test_should_stop_signals(self):
        stop = self.d / "job" / "stop"
        stop.parent.mkdir()
        self.assertFalse(hck.should_stop(str(stop), os.getpid() if os.name == "posix" else None))
        stop.write_text("x")
        self.assertTrue(hck.should_stop(str(stop)))
        stop.unlink()
        stop.parent.rmdir()
        self.assertTrue(hck.should_stop(str(stop)))   # backend cleaned up
        with mock.patch.object(hck.os, "kill", side_effect=ProcessLookupError), \
                mock.patch.object(hck.os, "name", "posix"):
            self.assertTrue(hck.should_stop(None, 999999))

    def test_stop_requested_before_attach_never_attaches(self):
        stop = self.d / "stop"
        stop.write_text("x")
        cap = hck.Capture({"a.db": make_page1(os.urandom(32), os.urandom(16))}, seconds=5)
        attach = mock.Mock()
        self.assertEqual(hck.run_capture(cap, 1, attach=attach, stop_file=str(stop)), hck.EXIT_OK)
        attach.assert_not_called()

    def test_main_accepts_parent_pid_and_log(self):
        pages = self.d / "pages.json"
        pages.write_text(json.dumps({"pages": {}}))
        log = self.d / "cap.log"
        with mock.patch.object(hck, "find_wechat_pid", return_value=None):
            rc = hck.main(["--pages", str(pages), "--parent-pid", str(os.getpid()),
                           "--log", str(log), "--progress", str(self.d / "p.json")])
        self.assertEqual(rc, hck.EXIT_FAIL)      # nothing to capture → no-dbs
        self.assertEqual(json.loads((self.d / "p.json").read_text())["error"], "no-dbs")
        self.assertTrue(log.exists())

    # 6. log never follows a planted symlink
    @unittest.skipUnless(hasattr(os, "symlink") and os.name == "posix", "POSIX only")
    def test_log_refuses_symlink(self):
        target = self.d / "victim"
        target.write_text("keep")
        link = self.d / "log.txt"
        os.symlink(target, link)
        with self.assertRaises(OSError):
            hck._open_log(str(link))
        hck.log("hello")            # must not raise, must not touch the victim
        self.assertEqual(target.read_text(), "keep")

    # CLI mode merges instead of overwriting, and keeps the file private
    def test_cli_save_merges_and_is_private(self):
        out = self.d / "keys.json"
        out.write_text(json.dumps({"keys_by_db": {"old.db": "aa"}, "keys_by_salt": {"s": "aa"}}))
        cap = hck.Capture({}, seconds=1, already={"new.db": "bb"})
        with mock.patch.object(hck, "OUT_PATH", str(out)):
            cap.save()
        d = json.loads(out.read_text())
        self.assertEqual(d["keys_by_db"], {"old.db": "aa", "new.db": "bb"})
        self.assertEqual(d["keys_by_salt"], {"s": "aa"})
        if os.name == "posix":
            self.assertEqual(out.stat().st_mode & 0o777, 0o600)

    # 7. concurrent merges don't lose keys; file is 0600
    def test_concurrent_merge_keeps_everything(self):
        import threading
        path = self.d / "decrypted_keys.json"
        ts = [threading.Thread(target=live_key.merge_keys, args=({f"db{i}.db": f"{i:02x}"}, {}, None, path))
              for i in range(20)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(len(json.loads(path.read_text())["keys_by_db"]), 20)
        if os.name == "posix":
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    # 9. only a scan that really ran and came up short hands over to live capture
    def test_scan_suggests_live(self):
        f = live_key.scan_suggests_live
        self.assertTrue(f("[ERR] no key matched any DB salt.", 0, 10))
        self.assertTrue(f("0:120: execution error: [info] scanning (4)", 0, 10))
        self.assertFalse(f("0:120: execution error: User canceled. (-128)", 0, 10))
        self.assertFalse(f("0:99: execution error: [ERR] task_for_pid denied. (3)", 0, 10))
        self.assertFalse(f("[ERR] task_for_pid denied.", 0, 10))
        self.assertFalse(f("[ERR] no WeChat process found — start WeChat", 0, 10))
        self.assertTrue(f("[OK] matched 3 of 10 encrypted DBs", 3, 10))
        self.assertFalse(f("[OK] matched 10 of 10 encrypted DBs", 10, 10))


class JobReviewFixesTest(LiveKeyJobTest):
    """Job-level regressions from the #28 review (reuses LiveKeyJobTest's fixtures)."""

    # 3. two concurrent starts → one capture
    def test_concurrent_start_claims_once(self):
        import threading
        gate = threading.Event()
        orig = self.job._salts

        def slow_salts(p):
            gate.wait(2)
            return orig(p)

        self.job._salts = slow_salts
        self.plan = [(0, {})]
        results = []
        ts = [threading.Thread(target=lambda: results.append(self.job.start(60))) for _ in range(2)]
        for t in ts:
            t.start()
        gate.set()
        for t in ts:
            t.join()
        self._wait()
        self.assertEqual(sum(1 for r in results if r.get("already_running")), 1)
        self.assertEqual(len(self.calls), 1)

    # 5. the child's own error code reaches the UI
    def test_child_error_is_passed_through(self):
        self.plan = [(1, {}, {"phase": "error", "error": "wechat-not-running", "new": []})]
        self.job.start(60)
        st = self._wait()
        self.assertEqual(st["phase"], "error")
        self.assertEqual(st["error"], "wechat-not-running")

    # 8. keys from the child are re-verified against page 1
    def test_unverifiable_key_from_child_is_dropped(self):
        self.plan = [(0, {"session/session.db": "00" * 32, "message/message_0.db": self.k2.hex()})]
        self.job.start(60)
        st = self._wait()
        saved = json.loads(self.keys_file.read_text())["keys_by_db"]
        self.assertEqual(saved, {"message/message_0.db": self.k2.hex()})
        self.assertEqual(st["new"], ["message/message_0.db"])

    # 2. cancel while elevated: never kill osascript once the root child runs
    def test_cancel_elevated_after_child_started_does_not_kill(self):
        proc = FakeProc(["x"], None, {})
        stop = self.d / "job" / "stop"
        stop.parent.mkdir()
        (stop.parent / "progress.json").write_text("{}")
        self.job._proc, self.job._proc_elevated, self.job._stop_file = proc, True, stop
        self.job.cancel()
        self.assertFalse(proc.killed)
        self.assertTrue(stop.exists())

    def test_cancel_elevated_while_password_dialog_up_kills_osascript(self):
        proc = FakeProc(["x"], None, {})
        stop = self.d / "job" / "stop"
        stop.parent.mkdir()
        self.job._proc, self.job._proc_elevated, self.job._stop_file = proc, True, stop
        self.job.cancel()
        self.assertTrue(proc.killed)
        self.assertTrue(stop.exists())

    # 4. watchdog: a child that never finishes is asked to stop, then killed
    def test_watchdog_stops_runaway_child(self):
        t = [0.0]
        self.job._clock = lambda: t[0]
        self.job._poll = 0
        procs = []

        class Hung(FakeProc):
            def poll(self_inner):
                t[0] += 10
                return self_inner._rc if self_inner.killed else None

        def popen(argv, **kw):
            self.calls.append(argv)
            prog = Path(argv[argv.index("--progress") + 1])
            prog.write_text(json.dumps({"phase": "capturing", "new": []}))
            procs.append(Hung(argv, None, {}))
            procs[-1].stop_file = Path(argv[argv.index("--stop-file") + 1])
            return procs[-1]

        orig_request_stop = self.job._request_stop
        asked = []
        self.job._request_stop = lambda: (asked.append(t[0]), orig_request_stop())
        self.job._popen = popen
        self.job.start(15)
        st = self._wait()
        self.assertFalse(st["running"])
        self.assertTrue(asked)                 # asked to stop first …
        self.assertTrue(procs[0].killed)       # … then killed after STOP_WAIT


class PassphraseTest(unittest.TestCase):
    """CCKeyDerivationPBKDF hook: one passphrase -> every DB's key."""

    ROUNDS = 1000  # real WeChat uses 256000; keep tests fast

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        patcher = mock.patch.object(hck, "LOG_PATH", str(self.d / "log.txt"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.pw = os.urandom(32)
        self.pages = {}
        for rel in ("session/session.db", "contact/contact.db", "message/message_7.db"):
            salt = os.urandom(16)
            key = hashlib.pbkdf2_hmac("sha512", self.pw, salt, self.ROUNDS, 32)
            self.pages[rel] = make_page1(key, salt)

    def tearDown(self):
        self.tmp.cleanup()

    def test_one_passphrase_derives_every_db(self):
        cap = hck.Capture(self.pages, seconds=5, out_keys=str(self.d / "new.json"),
                          progress_path=str(self.d / "p.json"))
        self.assertEqual(cap.on_passphrase(os.urandom(32), 5, self.ROUNDS), 0)
        self.assertEqual(cap.on_passphrase(self.pw, 5, self.ROUNDS), 3)
        self.assertEqual(cap.pending, {})
        out = json.loads((self.d / "new.json").read_text())
        self.assertEqual(len(out["keys_by_db"]), 3)
        self.assertEqual(out["passphrase"], {"hex": self.pw.hex(), "prf": 5, "rounds": self.ROUNDS})
        self.assertTrue(json.loads((self.d / "p.json").read_text())["passphrase_found"])
        # same passphrase again is a no-op
        self.assertEqual(cap.on_passphrase(self.pw, 5, self.ROUNDS), 0)

    def test_agent_pbkdf_message(self):
        cap = hck.Capture(self.pages, seconds=5)
        with mock.patch.object(cap, "save"):
            cap.on_message({"type": "send", "payload": {
                "type": "pbkdf", "password": list(self.pw), "prf": 5, "rounds": self.ROUNDS}}, None)
        self.assertEqual(len(cap.new), 3)

    def test_unknown_prf_is_ignored(self):
        page1 = next(iter(self.pages.values()))
        self.assertIsNone(hck.derive_db_key(self.pw, page1, prf=99, rounds=self.ROUNDS))

    def test_saved_passphrase_covers_new_dbs(self):
        salt_map = {page1[:16].hex(): {"name": rel, "page1": page1} for rel, page1 in self.pages.items()}
        existing = {"keys_by_db": {}, "passphrase": {"hex": self.pw.hex(), "prf": 5, "rounds": self.ROUNDS}}
        pending, known = live_key.split_pending(salt_map, existing)
        self.assertEqual(pending, {})
        self.assertEqual(set(known), set(self.pages))

    def test_merge_keeps_passphrase(self):
        path = self.d / "keys.json"
        pp = {"hex": self.pw.hex(), "prf": 5, "rounds": self.ROUNDS}
        live_key.merge_keys({"a.db": "aa"}, {}, "wxid_x", path, passphrase=pp)
        live_key.merge_keys({"b.db": "bb"}, {}, None, path)  # later round without passphrase
        self.assertEqual(json.loads(path.read_text())["passphrases"], {"wxid_x": pp})


class PerAccountPassphraseTest(unittest.TestCase):
    """Review follow-up for #32: passphrases are stored per wxid so another
    account's passphrase never burns a PBKDF2 per DB on every poll."""

    ROUNDS = 1000

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.path = self.d / "keys.json"
        self.pw_a, self.pw_b = os.urandom(32), os.urandom(32)
        self.pp_a = {"hex": self.pw_a.hex(), "prf": 5, "rounds": self.ROUNDS}
        self.pp_b = {"hex": self.pw_b.hex(), "prf": 5, "rounds": self.ROUNDS}
        salt = os.urandom(16)
        key_b = hashlib.pbkdf2_hmac("sha512", self.pw_b, salt, self.ROUNDS, 32)
        self.page_b = make_page1(key_b, salt)
        self.salt_map = {salt.hex(): {"name": "message/message_1.db", "page1": self.page_b}}

    def tearDown(self):
        self.tmp.cleanup()

    def test_merge_stores_each_accounts_passphrase(self):
        live_key.merge_keys({}, {}, "wxid_a", self.path, passphrase=self.pp_a)
        live_key.merge_keys({}, {}, "wxid_b", self.path, passphrase=self.pp_b)
        saved = json.loads(self.path.read_text())
        self.assertEqual(saved["passphrases"], {"wxid_a": self.pp_a, "wxid_b": self.pp_b})
        self.assertNotIn("passphrase", saved)
        self.assertEqual(live_key.passphrase_for(saved, "wxid_a"), self.pp_a)
        self.assertEqual(live_key.passphrase_for(saved, "wxid_b"), self.pp_b)
        self.assertIsNone(live_key.passphrase_for(saved, "wxid_c"))

    def test_other_accounts_passphrase_is_never_tried(self):
        existing = {"wxid": "wxid_a", "passphrases": {"wxid_a": self.pp_a}}
        with mock.patch.object(live_key, "derive_from_passphrase") as derive:
            pending, known = live_key.split_pending(self.salt_map, existing, "wxid_b")
        derive.assert_not_called()
        self.assertEqual(set(pending), {"message/message_1.db"})
        self.assertEqual(known, {})

    def test_own_passphrase_derives(self):
        existing = {"passphrases": {"wxid_a": self.pp_a, "wxid_b": self.pp_b}}
        pending, known = live_key.split_pending(self.salt_map, existing, "wxid_b")
        self.assertEqual(pending, {})
        self.assertEqual(set(known), {"message/message_1.db"})

    def test_legacy_top_level_passphrase_belongs_to_file_wxid(self):
        legacy = {"wxid": "wxid_a", "keys_by_db": {}, "passphrase": self.pp_a}
        self.assertEqual(live_key.passphrase_for(legacy, "wxid_a"), self.pp_a)
        self.assertIsNone(live_key.passphrase_for(legacy, "wxid_b"))
        # no owner recorded: still usable (old single-account files)
        self.assertEqual(live_key.passphrase_for({"passphrase": self.pp_a}, "wxid_b"), self.pp_a)
        # callers that don't know the wxid keep the old behaviour
        self.assertEqual(live_key.passphrase_for(legacy), self.pp_a)
        self.assertEqual(live_key.passphrase_for({"passphrases": {"wxid_a": self.pp_a}}), self.pp_a)
        self.assertIsNone(live_key.passphrase_for(
            {"passphrases": {"wxid_a": self.pp_a, "wxid_b": self.pp_b}}))

    def test_merge_migrates_legacy_passphrase_to_its_account(self):
        self.path.write_text(json.dumps({"wxid": "wxid_a", "keys_by_db": {"a.db": "aa"},
                                         "passphrase": self.pp_a}))
        live_key.merge_keys({}, {}, "wxid_b", self.path, passphrase=self.pp_b)
        saved = json.loads(self.path.read_text())
        self.assertNotIn("passphrase", saved)
        self.assertEqual(saved["passphrases"], {"wxid_a": self.pp_a, "wxid_b": self.pp_b})
        self.assertEqual(saved["wxid"], "wxid_b")
        self.assertEqual(saved["keys_by_db"], {"a.db": "aa"})

    def test_job_coverage_passes_profile_wxid(self):
        class Prof:
            wxid = "wxid_b"
        self.path.write_text(json.dumps({"passphrases": {"wxid_a": self.pp_a}}))
        job = live_key.LiveKeyJob(discover_profiles=lambda: [Prof()], collect_salts=lambda p: self.salt_map,
                                  keys_file=self.path)
        with mock.patch.object(live_key, "derive_from_passphrase") as derive:
            cov = job.coverage()
        derive.assert_not_called()
        self.assertEqual(cov["known"], 0)

    def test_refresh_key_for_db_only_uses_this_accounts_passphrase(self):
        import refresh
        enc = self.d / "db_storage"
        (enc / "message").mkdir(parents=True)
        db = enc / "message" / "message_1.db"
        db.write_bytes(self.page_b)
        refresh._PASSPHRASE_KEYS.clear()
        self.addCleanup(refresh._PASSPHRASE_KEYS.clear)
        per_db = {"wxid": "wxid_a", "passphrases": {"wxid_a": self.pp_a}}
        with mock.patch.object(live_key, "derive_from_passphrase") as derive:
            self.assertIsNone(refresh.key_for_db(db, enc, per_db, "wxid_b"))
        derive.assert_not_called()
        per_db = {"passphrases": {"wxid_a": self.pp_a, "wxid_b": self.pp_b}}
        key = refresh.key_for_db(db, enc, per_db, "wxid_b")  # real PBKDF2 (1000 rounds)
        self.assertEqual(key, hashlib.pbkdf2_hmac("sha512", self.pw_b, self.page_b[:16],
                                                  self.ROUNDS, 32).hex())

    def test_decrypt_per_db_passes_profile_wxid(self):
        import types
        import refresh
        enc = self.d / "db_storage"
        enc.mkdir()
        (enc / "session.db").write_bytes(self.page_b)
        prof = types.SimpleNamespace(wxid="wxid_b", encrypted_root=enc)
        with mock.patch.object(refresh, "decrypted_root_for", return_value=self.d / "out"), \
                mock.patch.object(refresh, "key_for_db", return_value=None) as kfd:
            refresh._decrypt_per_db(prof, {"passphrases": {"wxid_a": self.pp_a}})
        self.assertEqual(kfd.call_args[0][3], "wxid_b")

class ReattachTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        patcher = mock.patch.object(hck, "LOG_PATH", str(self.d / "log.txt"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def test_waits_for_relaunch_and_reattaches(self):
        k = os.urandom(32)
        cap = hck.Capture({"a.db": make_page1(k, os.urandom(16))}, seconds=30,
                          progress_path=str(self.d / "p.json"),
                          out_keys=str(self.d / "keys.json"))
        attached = []
        t = [0.0]
        pids = iter([None, None, 222])

        def attach(pid, cb, on_detached=None):
            attached.append(pid)
            if pid == 111:
                on_detached("process-terminated")   # user quits WeChat
            else:
                cb({"type": "send", "payload": {"type": "candidate", "key": list(k)}}, None)
            return FakeSession(), FakeScript()

        def sleep(s):
            t[0] += s

        rc = hck.run_capture(cap, 111, attach=attach, sleep=sleep, clock=lambda: t[0],
                             find_pid=lambda: next(pids, 222))
        self.assertEqual(rc, hck.EXIT_OK)
        self.assertEqual(attached, [111, 222])
        self.assertEqual(cap.pending, {})

    def test_without_find_pid_stops_when_wechat_exits(self):
        cap = hck.Capture({"a.db": make_page1(os.urandom(32), os.urandom(16))}, seconds=30)
        t = [0.0]

        def attach(pid, cb, on_detached=None):
            on_detached("process-terminated")
            return FakeSession(), FakeScript()

        def sleep(s):
            t[0] += s

        rc = hck.run_capture(cap, 1, attach=attach, sleep=sleep, clock=lambda: t[0])
        self.assertEqual(rc, hck.EXIT_OK)
        self.assertLess(t[0], 1)
