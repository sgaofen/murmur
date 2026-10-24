"""Onboarding flow model (app/src/onboarding/flow.ts).

The WeChat onboarding's decision tree (where a fresh /api/diagnose lands) and
its 环境自检 rows are pure TypeScript. tests/js/onboarding_flow_check.mjs runs
them against hand-written diagnose payloads with whatever JS runtime is
available: Node >= 22.6 (type stripping) or Bun. Skipped when neither is
installed — CI only provisions Python, so this mostly guards local runs.

The same script also covers the #47 review fixes that live in pure modules:
when the dialogs count as busy (capture.ts / flow.ts dialogBusy), which
capture method to resume, the double-click guard (guard.ts), where the
完成 screen says the key was saved, and the extract-key failure code.

The Python side checks what a JS runtime can't be needed for: every
diagnose field flow.ts reads is actually sent by /api/diagnose, and the
React wiring of those helpers (static source checks — CI has no browser).
"""
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHECK_SCRIPT = ROOT / "tests" / "js" / "onboarding_flow_check.mjs"
FLOW = ROOT / "app" / "src" / "onboarding" / "flow.ts"


def _node_with_strip_types():
    node = shutil.which("node")
    if not node:
        return None
    try:
        r = subprocess.run([node, "--experimental-strip-types", "-e", "0"],
                           capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0 or b"bun" in (r.stderr + r.stdout).lower():
        return None
    return [node, "--experimental-strip-types", "--no-warnings"]


def _bun():
    bun = shutil.which("bun") or str(Path.home() / ".bun" / "bin" / ("bun.exe" if os.name == "nt" else "bun"))
    return [bun] if os.path.isfile(bun) else None


class OnboardingFlowTest(unittest.TestCase):
    def test_flow_matches_expected_routes_and_rows(self) -> None:
        runtime = _node_with_strip_types() or _bun()
        if runtime is None:
            self.skipTest("no Node >= 22.6 or Bun available to run flow.ts")
        r = subprocess.run(runtime + [str(CHECK_SCRIPT)], capture_output=True, timeout=120,
                           cwd=str(ROOT))
        out = (r.stdout + r.stderr).decode("utf-8", "replace")
        self.assertEqual(r.returncode, 0, out)
        self.assertIn("0 failures", out)

    def test_flow_only_reads_fields_the_backend_sends(self) -> None:
        src = FLOW.read_text(encoding="utf-8")
        etcli = (ROOT / "cli" / "etcli.py").read_text(encoding="utf-8")
        start = etcli.index('if path == "/api/diagnose":')
        handler = etcli[start:etcli.index("if path ==", start + 10)]
        used = set(re.findall(r"\b(?:d|caps)\.(?:capabilities\.)?([a-z_]+)\b", src))
        used |= set(re.findall(r"capabilities\.([a-z_]+)", src))
        used -= {"capabilities", "profiles", "platform", "length", "some", "filter", "map"}
        for field in sorted(used):
            with self.subTest(field=field):
                self.assertIn(f'"{field}"', handler, f"flow.ts reads {field!r} but /api/diagnose does not send it")



def _src(*parts: str) -> str:
    return (ROOT / "app" / "src" / Path(*parts)).read_text(encoding="utf-8")


class OnboardingWiringTest(unittest.TestCase):
    """#47 review: the dialogs actually use the helpers tested above."""

    DIALOGS = (("pages", "OnboardingDialog.tsx"), ("pages", "ExtractKeyDialog.tsx"))

    def test_capture_busy_locks_rail_and_esc(self) -> None:
        for parts in self.DIALOGS:
            src = _src(*parts)
            with self.subTest(dialog=parts[-1]):
                self.assertIn("onBusyChange={setCaptureBusy}", src)
                self.assertIn("dismissible={!busy}", src)
                self.assertRegex(src, r"onStepClick=\{busy \? undefined")
        self.assertIn("dialogBusy(screen, checking, captureBusy)", _src("pages", "OnboardingDialog.tsx"))
        self.assertIn("phase === 'live' && captureBusy", _src("pages", "ExtractKeyDialog.tsx"))

    def test_capture_components_report_busy_and_resume(self) -> None:
        live = _src("components", "LiveKeyCapture.tsx")
        self.assertIn("resumeMethod(live, pc)", live)
        self.assertIn("onBusyChange={setPcBusy}", live)
        self.assertIn("onBusyChange?.(anyBusy)", live)
        self.assertIn("onBusyChange?.(anyBusy)", _src("components", "PrivateCopyCapture.tsx"))

    def test_double_click_guard(self) -> None:
        for parts in self.DIALOGS:
            with self.subTest(dialog=parts[-1]):
                self.assertIn("createActionGuard", _src(*parts))
        for name in ("LiveKeyCapture.tsx", "PrivateCopyCapture.tsx"):
            with self.subTest(component=name):
                self.assertIn("if (startingRef.current) return;", _src("components", name))

    def test_private_copy_shortcut_and_frida_resign_chip(self) -> None:
        self.assertIn("privateCopyShortcut(diag)", _src("onboarding", "KeySteps.tsx"))
        self.assertIn("微信需要先重签名", _src("components", "LiveKeyCapture.tsx"))

    def test_extract_dialog_keeps_real_error_code(self) -> None:
        src = _src("pages", "ExtractKeyDialog.tsx")
        self.assertNotIn("?? 'KEY_NOT_FOUND'", src)
        self.assertIn("keyExtractFailureCode(r, !mac)", src)

    def test_force_decrypt_confirmed_and_key_path(self) -> None:
        src = _src("pages", "OnboardingDialog.tsx")
        self.assertIn("canForceDecrypt(diag)", src)
        self.assertIn("确定清空并重新解密", src)
        self.assertIn("savedKeyPath(platform, keySource)", src)
        self.assertNotIn("mac ? '~/.murmur/decrypted_keys.json'", src)


if __name__ == "__main__":
    unittest.main()
