"""macOS QQ re-sign safety net (review round 2 of #41):

- the original (Tencent) signature is backed up to ~/.murmur/qq-backup/<version>/
  before codesign touches QQ.app,
- "恢复原签名" puts it back,
- after re-signing QQ is started once; if it does not stay up, the original
  signature is restored automatically,
- the lldb settle countdown only starts once the same key shows up in two
  different breakpoint hits (same rule as #30's Windows script),
- the capture status endpoint never keeps the log / candidates and hands the
  verified key out only once.

No codesign, osascript, open or real QQ is ever run: every external command
goes through FakeMac, a scripted runner that edits a fake QQ.app on disk.
"""
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))
sys.path.insert(0, str(ROOT / "tests"))

import qq_mac_key  # noqa: E402
from test_qq_key_candidates import REAL_KEY  # noqa: E402
from test_qq_mac import _Debugger, _FakeLLDB, _Target, _Thread, cap  # noqa: E402

VENDOR_DV = ("Executable=/Applications/QQ.app/Contents/MacOS/QQ\n"
             "Identifier=com.tencent.qq\n"
             "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded\n"
             "Signature size=9000\n"
             "TeamIdentifier=FN2V63AD2J\n")
ADHOC_DV = ("Executable=/Applications/QQ.app/Contents/MacOS/QQ\n"
            "Identifier=com.tencent.qq\n"
            "CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+7 location=embedded\n"
            "Signature=adhoc\n"
            "TeamIdentifier=not set\n")
ORIGINAL_EXE = b"\xcf\xfa\xed\xfe original tencent-signed QQ" * 50
ORIGINAL_CODERES = b"<plist>original CodeResources</plist>"


def make_fake_app(base: Path, version="6.9.70", build="29271") -> Path:
    app = base / "Applications" / "QQ.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    (app / "Contents" / "_CodeSignature").mkdir()
    (app / "Contents" / "MacOS" / "QQ").write_bytes(ORIGINAL_EXE)
    (app / "Contents" / "_CodeSignature" / "CodeResources").write_bytes(ORIGINAL_CODERES)
    with open(app / "Contents" / "Info.plist", "wb") as f:
        plistlib.dump({"CFBundleIdentifier": "com.tencent.qq",
                       "CFBundleShortVersionString": version, "CFBundleVersion": build}, f)
    return app


class FakeMac:
    """Scripted stand-in for subprocess.run + qq_running_pids + time.sleep.

    launch: "ok" (QQ stays up), "crash" (starts then dies), "never" (never
    appears), "refused" (`open` fails).
    """

    def __init__(self, app: Path, backup_root: Path, *, launch="ok",
                 resign_rc=0, restore_rc=0, resign_makes_debuggable=True):
        self.app = app
        self.exe = app / "Contents" / "MacOS" / "QQ"
        self.root = backup_root
        self.launch = launch
        self.resign_rc = resign_rc
        self.restore_rc = restore_rc
        self.resign_makes_debuggable = resign_makes_debuggable
        self.signed = "vendor"          # vendor | adhoc | adhoc-broken
        self.running = False
        self.polls_since_launch = 0
        self.calls = []

    # --- subprocess.run ----------------------------------------------------
    def __call__(self, argv, **kw):
        argv = list(argv)
        self.calls.append(argv)
        tool = argv[0]
        if tool == "codesign" and "-v" in argv:
            text = VENDOR_DV if self.signed == "vendor" else ADHOC_DV
            if self.signed == "vendor":
                return self._done(argv, "", text)
            if self.signed == "adhoc-broken":
                text = text.replace("flags=0x2(adhoc)", "flags=0x10002(adhoc,runtime)")
            return self._done(argv, "", text)
        if tool == "codesign" and "--entitlements" in argv:
            ents = {"com.apple.security.app-sandbox": True}
            if self.signed == "adhoc":
                ents["com.apple.security.get-task-allow"] = True
            return self._done(argv, plistlib.dumps(ents), b"")
        if tool == "osascript":
            script = argv[2]
            if "to quit" in script:
                self.running = False
                return self._done(argv, "", "")
            if "with administrator privileges" in script:
                return self._admin(argv, script)
            raise AssertionError("unexpected osascript: " + script)
        if tool == "pkill":
            self.running = False
            return self._done(argv, "", "")
        if tool == "open":
            if self.launch == "refused":
                return self._done(argv, "", "LSOpenURLsWithRole() failed", rc=1)
            if self.launch in ("ok", "crash"):
                self.running = True
                self.polls_since_launch = 0
            return self._done(argv, "", "")
        raise AssertionError(f"unexpected command {argv}")

    def _admin(self, argv, script):
        if "codesign --force" in script:
            if self.resign_rc:
                return self._done(argv, "", "execution error: User canceled. (-128)", rc=self.resign_rc)
            self.exe.write_bytes(b"ADHOC" + ORIGINAL_EXE)
            (self.app / "Contents" / "_CodeSignature" / "CodeResources").write_bytes(b"adhoc res")
            self.signed = "adhoc" if self.resign_makes_debuggable else "adhoc-broken"
            return self._done(argv, "", "")
        if "/usr/bin/ditto" in script and str(self.root) in script.replace("\\\\", "\\"):
            if self.restore_rc:
                return self._done(argv, "", "execution error: User canceled. (-128)", rc=self.restore_rc)
            bdir = next(p for p in self.root.iterdir() if not p.name.endswith(".partial"))
            shutil.copy2(bdir / "MacOS" / "QQ", self.exe)
            cs = self.app / "Contents" / "_CodeSignature"
            shutil.rmtree(cs)
            shutil.copytree(bdir / "_CodeSignature", cs)
            self.signed = "vendor"
            return self._done(argv, "", "")
        raise AssertionError("unexpected admin script: " + script)

    @staticmethod
    def _done(argv, out, err, rc=0):
        return subprocess.CompletedProcess(argv, rc, out, err)

    # --- qq_running_pids / sleep --------------------------------------------
    def pids(self):
        if self.running and self.launch == "crash":
            self.polls_since_launch += 1
            if self.polls_since_launch > 2:
                self.running = False
        return [4242] if self.running else []

    def sleep(self, _secs):
        pass

    def admin_scripts(self):
        return [c[2] for c in self.calls if c[0] == "osascript" and "administrator" in c[2]]


class BackupRestoreTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.app = make_fake_app(self.tmp)
        self.exe = self.app / "Contents" / "MacOS" / "QQ"
        self.root = self.tmp / "home" / ".murmur" / "qq-backup"

    def tearDown(self):
        self._tmp.cleanup()

    def _resign(self, fake, **kw):
        return qq_mac_key.resign_qq(self.app, root=self.root, runner=fake,
                                    pids=fake.pids, sleep=fake.sleep, **kw)

    def _restore(self, fake):
        return qq_mac_key.restore_original(self.app, root=self.root, runner=fake,
                                           pids=fake.pids, sleep=fake.sleep)

    def test_backup_root_default_is_home_murmur(self):
        with mock.patch.dict(os.environ, {"MURMUR_QQ_BACKUP_DIR": ""}):
            self.assertEqual(qq_mac_key.backup_root(Path("/h")),
                             Path("/h") / ".murmur" / "qq-backup")

    def test_read_app_version_is_dir_safe(self):
        self.assertEqual(qq_mac_key.read_app_version(self.app), "6.9.70-29271")
        weird = make_fake_app(self.tmp / "w", version="../6.9 beta/x", build="6.9 beta/x")
        v = qq_mac_key.read_app_version(weird)
        self.assertNotIn("/", v)
        self.assertNotIn("\\", v)
        self.assertFalse(v.startswith("."))
        self.assertEqual(qq_mac_key.read_app_version(self.tmp / "nope.app"), "unknown")

    def test_successful_resign_backs_up_first_and_trial_launches(self):
        fake = FakeMac(self.app, self.root)
        res = self._resign(fake)
        self.assertTrue(res["ok"], res)
        bdir = self.root / "6.9.70-29271"
        self.assertEqual(Path(res["backup_dir"]), bdir)
        # backup holds the ORIGINAL bytes even though QQ.app is now re-signed
        self.assertEqual((bdir / "MacOS" / "QQ").read_bytes(), ORIGINAL_EXE)
        self.assertEqual((bdir / "_CodeSignature" / "CodeResources").read_bytes(), ORIGINAL_CODERES)
        man = json.loads((bdir / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["team_id"], "FN2V63AD2J")
        self.assertEqual(man["main_exec_rel"], "Contents/MacOS/QQ")
        self.assertNotEqual(self.exe.read_bytes(), ORIGINAL_EXE)
        # order: backup exists before codesign ran; then open (trial); then quit again
        tools = [c[0] for c in fake.calls]
        admin_idx = next(i for i, c in enumerate(fake.calls)
                         if c[0] == "osascript" and "codesign --force" in c[2])
        open_idx = tools.index("open")
        self.assertLess(admin_idx, open_idx)
        self.assertFalse(fake.running, "QQ must be quit after the trial launch")
        self.assertEqual(len(fake.admin_scripts()), 1)
        self.assertTrue(any("试启动" in line for line in res["log"]))
        info = qq_mac_key.backup_info(self.app, self.root)
        self.assertTrue(info["exists"])
        self.assertFalse((self.root / "6.9.70-29271.partial").exists())

    def test_trial_launch_crash_restores_original_automatically(self):
        fake = FakeMac(self.app, self.root, launch="crash")
        res = self._resign(fake)
        self.assertFalse(res["ok"])
        self.assertTrue(res["rolled_back"])
        self.assertIn("已自动恢复腾讯原签名", res["error"])
        self.assertEqual(self.exe.read_bytes(), ORIGINAL_EXE)
        self.assertEqual((self.app / "Contents" / "_CodeSignature" / "CodeResources").read_bytes(),
                         ORIGINAL_CODERES)
        self.assertEqual(fake.signed, "vendor")
        self.assertEqual(len(fake.admin_scripts()), 2)  # resign + restore

    def test_trial_launch_never_starts_restores(self):
        fake = FakeMac(self.app, self.root, launch="never")
        res = self._resign(fake)
        self.assertFalse(res["ok"])
        self.assertTrue(res["rolled_back"])
        self.assertIn("没有启动起来", res["error"])
        self.assertEqual(self.exe.read_bytes(), ORIGINAL_EXE)

    def test_open_refused_restores(self):
        fake = FakeMac(self.app, self.root, launch="refused")
        res = self._resign(fake)
        self.assertTrue(res["rolled_back"])
        self.assertEqual(self.exe.read_bytes(), ORIGINAL_EXE)

    def test_not_debuggable_after_codesign_restores(self):
        fake = FakeMac(self.app, self.root, resign_makes_debuggable=False)
        res = self._resign(fake)
        self.assertFalse(res["ok"])
        self.assertTrue(res["rolled_back"])
        self.assertNotIn("open", [c[0] for c in fake.calls])
        self.assertEqual(self.exe.read_bytes(), ORIGINAL_EXE)

    def test_rollback_failure_is_reported_and_backup_kept(self):
        fake = FakeMac(self.app, self.root, launch="crash", restore_rc=1)
        res = self._resign(fake)
        self.assertFalse(res["ok"])
        self.assertFalse(res["rolled_back"])
        self.assertIn("自动恢复原签名也失败了", res["error"])
        self.assertIn("恢复原签名", res["error"])
        self.assertTrue(qq_mac_key.backup_info(self.app, self.root)["exists"])

    def test_cancelled_codesign_leaves_app_untouched(self):
        fake = FakeMac(self.app, self.root, resign_rc=1)
        res = self._resign(fake)
        self.assertFalse(res["ok"])
        self.assertIn("取消", res["error"])
        self.assertEqual(self.exe.read_bytes(), ORIGINAL_EXE)
        self.assertNotIn("open", [c[0] for c in fake.calls])
        self.assertEqual(len(fake.admin_scripts()), 1)

    def test_refuses_when_already_adhoc_without_backup(self):
        fake = FakeMac(self.app, self.root)
        fake.signed = "adhoc"
        res = self._resign(fake)
        self.assertFalse(res["ok"])
        self.assertIn("重新安装", res["error"])
        self.assertEqual(fake.admin_scripts(), [])
        self.assertFalse(self.root.exists() and any(self.root.iterdir()))

    def test_second_resign_reuses_existing_backup(self):
        fake = FakeMac(self.app, self.root)
        self.assertTrue(self._resign(fake)["ok"])
        # QQ is ad-hoc now; re-signing again (e.g. after a failed capture) must
        # keep the original backup, not replace it with our own signature.
        res = self._resign(fake)
        self.assertTrue(res["ok"], res)
        self.assertTrue(any("沿用已有备份" in line for line in res["log"]))
        self.assertEqual((self.root / "6.9.70-29271" / "MacOS" / "QQ").read_bytes(), ORIGINAL_EXE)

    def test_tampered_backup_is_ignored(self):
        fake = FakeMac(self.app, self.root)
        self.assertTrue(self._resign(fake)["ok"])
        (self.root / "6.9.70-29271" / "MacOS" / "QQ").write_bytes(b"garbage")
        self.assertIsNone(qq_mac_key.load_backup(self.app, self.root))
        res = self._restore(fake)
        self.assertFalse(res["ok"])
        self.assertIn("没找到这个 QQ 版本", res["error"])

    def test_restore_button_puts_original_back(self):
        fake = FakeMac(self.app, self.root)
        self.assertTrue(self._resign(fake)["ok"])
        fake.running = True  # user opened QQ meanwhile
        res = self._restore(fake)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["restored"])
        self.assertEqual(self.exe.read_bytes(), ORIGINAL_EXE)
        self.assertFalse(fake.running, "QQ must be quit before restoring")
        # backup is kept so the user can re-sign and restore again later
        self.assertTrue(qq_mac_key.backup_info(self.app, self.root)["exists"])

    def test_restore_without_backup(self):
        fake = FakeMac(self.app, self.root)
        res = self._restore(fake)
        self.assertTrue(res["ok"])
        self.assertTrue(res["already_original"])
        self.assertEqual(fake.admin_scripts(), [])
        fake.signed = "adhoc"
        res = self._restore(fake)
        self.assertFalse(res["ok"])
        self.assertIn("重新安装", res["error"])

    def test_restore_cancelled_prompt(self):
        fake = FakeMac(self.app, self.root)
        self.assertTrue(self._resign(fake)["ok"])
        fake.restore_rc = 1
        res = self._restore(fake)
        self.assertFalse(res["ok"])
        self.assertIn("取消", res["error"])

    def test_restore_shell(self):
        sh = qq_mac_key.build_restore_shell(Path("/Applications/QQ's.app"), Path("/h/b k/6.9"),
                                            "Contents/MacOS/QQ", True)
        self.assertTrue(sh.startswith("set -e\n"))
        self.assertIn("/usr/bin/ditto", sh)
        self.assertIn("_CodeSignature", sh)
        self.assertIn("'\"'\"'", sh)  # hostile quote escaped
        no_cs = qq_mac_key.build_restore_shell(Path("/A/QQ.app"), Path("/b"), "Contents/MacOS/QQ", False)
        self.assertNotIn("rm -rf", no_cs)

    @unittest.skipUnless(shutil.which("sh") and os.name == "posix", "needs POSIX sh")
    def test_restore_shell_is_valid_sh(self):
        sh = qq_mac_key.build_restore_shell(Path("/Applications/QQ.app"), Path("/h/.murmur/qq-backup/6.9"),
                                            "Contents/MacOS/QQ", True)
        r = subprocess.run(["sh", "-n"], input=sh, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_vendor_signature_detection(self):
        self.assertTrue(qq_mac_key.is_vendor_signed(VENDOR_DV))
        self.assertFalse(qq_mac_key.is_vendor_signed(ADHOC_DV))
        self.assertEqual(qq_mac_key.team_identifier(VENDOR_DV), "FN2V63AD2J")
        self.assertIsNone(qq_mac_key.team_identifier(ADHOC_DV))


class SettleRuleTest(unittest.TestCase):
    def test_tracker_needs_two_distinct_hits(self):
        t = cap.SettleTracker()
        self.assertFalse(t.observe(1, REAL_KEY))
        self.assertFalse(t.observe(1, REAL_KEY))  # same hit, other register
        self.assertFalse(t.observe(2, "BD156D6710D54D87"))  # login.db key prefix never counts
        self.assertFalse(t.observe(2, "main"))
        self.assertTrue(t.observe(3, REAL_KEY))
        self.assertFalse(t.observe(4, REAL_KEY))  # only fires once

    def test_one_stray_key_does_not_start_countdown(self):
        bp = _FakeLLDB.eStopReasonBreakpoint
        memory = {0x5000: REAL_KEY.encode() + b"\x00"}
        script = [
            {"load_module": "/x/QQ.app/Contents/Resources/app/wrapper.node", "threads": []},
            {"threads": [_Thread(bp, 1, {"x2": 0x5000, "x3": 16})]},
        ]
        target = _Target(script, memory)
        dbg = _Debugger(target)
        out = []
        env = {"MURMUR_QQ_NO_LAUNCH": "1", "MURMUR_QQ_SETTLE": "0", "MURMUR_QQ_TIMEOUT": "1"}
        with mock.patch.dict(sys.modules, {"lldb": _FakeLLDB}), \
                mock.patch.dict(os.environ, env), \
                mock.patch.object(cap, "find_key_functions_in_file",
                                  return_value={"funcs": [0x1040], "error": None}), \
                mock.patch.object(cap, "_emit", side_effect=out.append):
            cap.murmur_qq_capture(dbg, "", None, {})
        log = "\n".join(out)
        self.assertNotIn("stage=key_seen", log)
        self.assertIn("reason=timeout", log)
        self.assertIn("MURMUR_KEY_CANDIDATE", log)  # still reported for verification


class StatusPrivacyTest(unittest.TestCase):
    def setUp(self):
        self._saved = dict(qq_mac_key._JOB)
        self.addCleanup(lambda: qq_mac_key._JOB.update(self._saved))

    def _wait_done(self):
        for _ in range(250):
            st = qq_mac_key.capture_state()
            if not st["running"]:
                return st
            time.sleep(0.02)
        self.fail("job did not finish")

    def test_public_result_drops_log_and_candidates(self):
        res = {"ok": True, "key": REAL_KEY, "qq": "a", "variant": "v", "error": None,
               "log": "MURMUR_KEY_CANDIDATE hex=" + REAL_KEY.encode().hex(),
               "candidates": [{"value": REAL_KEY}, {"value": "x"}], "statuses": []}
        pub = qq_mac_key.public_result(res)
        self.assertNotIn("log", pub)
        self.assertNotIn("candidates", pub)
        self.assertEqual(pub["n_candidates"], 2)
        self.assertEqual(pub["key"], REAL_KEY)
        self.assertNotIn(REAL_KEY.encode().hex(), json.dumps(pub))
        self.assertIsNone(qq_mac_key.public_result({"ok": False, "key": REAL_KEY})["key"])

    def test_key_is_handed_out_once(self):
        done = {"ok": True, "key": REAL_KEY, "error": None, "log": "secret log",
                "candidates": [{"value": REAL_KEY}]}
        with mock.patch.object(qq_mac_key, "run_capture", return_value=done):
            qq_mac_key.start_capture([], timeout=5)
            # The first status read that sees the finished job gets the key.
            st = self._wait_done()
        self.assertEqual(st["result"]["key"], REAL_KEY)
        self.assertNotIn("log", st["result"])
        again = qq_mac_key.capture_state()
        self.assertIsNone(again["result"]["key"])
        self.assertTrue(again["result"]["ok"])
        self.assertNotIn(REAL_KEY, json.dumps(again))
        self.assertNotIn(REAL_KEY, json.dumps(qq_mac_key._JOB))

    def test_unread_key_expires(self):
        with qq_mac_key._JOB_LOCK:
            qq_mac_key._JOB.update({"running": False, "finished_at": 1000, "stage": "done",
                                    "result": {"ok": True, "key": REAL_KEY, "error": None}})
        st = qq_mac_key.capture_state(now=1000 + qq_mac_key.RESULT_KEY_TTL + 1)
        self.assertIsNone(st["result"]["key"])
        self.assertTrue(st["result"]["expired"])
        self.assertNotIn(REAL_KEY, json.dumps(qq_mac_key._JOB))

    def test_cancel_reports_cancelled(self):
        def slow_capture(dbs, timeout, on_status, cancel_file):
            on_status({"stage": "bp_set"})
            for _ in range(250):
                if Path(cancel_file).exists():
                    break
                time.sleep(0.02)
            # lldb watchdog path: no "reason=cancelled" status, plain failure
            return {"ok": False, "key": None, "error": "等了很久 QQ 都没有启动。", "log": "x"}
        with mock.patch.object(qq_mac_key, "run_capture", side_effect=slow_capture):
            qq_mac_key.start_capture([], timeout=5)
            r = qq_mac_key.cancel_capture()
            self.assertTrue(r["cancelled"])
            self.assertEqual(qq_mac_key.capture_state()["stage"], "cancelling")
            st = self._wait_done()
        self.assertEqual(st["stage"], "cancelled")
        self.assertTrue(st["result"]["cancelled"])
        self.assertEqual(st["result"]["error"], "已取消抓 key。")


class RestoreEndpointTest(unittest.TestCase):
    def test_restore_route_and_profiles_backup_field(self):
        import io
        import etcli
        cls = etcli._MurmurAPIHandler
        h = cls.__new__(cls)
        h.headers = {"Content-Length": "2"}
        h.rfile = io.BytesIO(b"{}")
        sent = {}
        h._send_json = lambda payload, status=200: sent.update(payload=payload, status=status)
        with mock.patch("qq_paths.IS_MAC", True), mock.patch("qq_paths.IS_WINDOWS", False), \
                mock.patch.object(qq_mac_key, "restore_original",
                                  return_value={"ok": True, "restored": True, "log": []}) as ro:
            h._dispatch_qq_post("/api/qq/restore-signature")
        ro.assert_called_once()
        self.assertTrue(sent["payload"]["restored"])
        with mock.patch("qq_paths.IS_MAC", False), mock.patch("qq_paths.IS_WINDOWS", True):
            h.rfile = io.BytesIO(b"{}")
            h._dispatch_qq_post("/api/qq/restore-signature")
        self.assertEqual(sent["status"], 400)


if __name__ == "__main__":
    unittest.main()
