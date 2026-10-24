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

        def attach(pid, on_message):
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

        rc = hck.run_capture(cap, 1, attach=lambda pid, cb: (FakeSession(), FakeScript()),
                             stop_file=str(stop), sleep=sleep, clock=clock)
        self.assertEqual(rc, hck.EXIT_OK)
        self.assertLess(t[0], 5)  # stopped well before --seconds

    def test_attach_denied_exit_code(self):
        class PermissionDeniedError(Exception):
            pass

        def attach(pid, cb):
            raise PermissionDeniedError("unable to access process with pid 1")

        cap = self._cap()
        rc = hck.run_capture(cap, 1, attach=attach)
        self.assertEqual(rc, hck.EXIT_ATTACH_DENIED)
        prog = json.loads((self.d / "progress.json").read_text())
        self.assertEqual(prog["error"], "attach-denied")

    def test_frida_missing_exit_code(self):
        def attach(pid, cb):
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

    def __init__(self, argv, rc, keys, **kw):
        self.argv = argv
        self.returncode = None
        self._rc = rc
        self.stdout = None
        args = argv if argv[0] != "osascript" else None
        if args is not None and rc == 0:
            prog = Path(args[args.index("--progress") + 1])
            out = Path(args[args.index("--out-keys") + 1])
            out.write_text(json.dumps({"keys_by_db": keys}))
            prog.write_text(json.dumps({"phase": "done", "new": sorted(keys), "hits": 7,
                                        "remaining": 0}))
        elif argv[0] == "osascript" and rc == 0:
            script = argv[2]
            out = script.split("--out-keys ")[1].split(" ")[0]
            Path(out).write_text(json.dumps({"keys_by_db": keys}))

    def poll(self):
        self.returncode = self._rc
        return self.returncode

    def kill(self):
        self._rc = -9


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
            rc, keys = self.plan[len(self.calls)]
            self.calls.append(argv)
            if "--pages" in argv:
                pages = json.loads(Path(argv[argv.index("--pages") + 1]).read_text())
                self.pages_seen.append(sorted(pages["pages"]))
            return FakeProc(argv, rc, keys, **kw)

        self.job = live_key.LiveKeyJob(
            popen=popen,
            discover_profiles=lambda: [prof],
            collect_salts=lambda p: self.salt_map,
            keys_file=self.keys_file,
            poll_interval=0.01,
        )

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


if __name__ == "__main__":
    unittest.main()
