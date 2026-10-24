"""Shared redaction cases for the diagnostics copy (tests/fixtures/diag_redact_cases.json).

* The backend redactor (cli/diag_redact.py) must pass every case not marked
  ``"py": false`` — keeps the two rule sets from drifting apart.
* The front-end port (app/src/utils/diagRedact.ts, used by 「复制诊断信息」
  regardless of privacy mode) is run through tests/js/diag_redact_check.mjs
  with whatever JS runtime is available: Node >= 22.6 (type stripping) or Bun.
  Skipped when neither is installed — CI only provisions Python.
"""
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

from diag_redact import redact  # noqa: E402


CASES = json.loads((ROOT / "tests" / "fixtures" / "diag_redact_cases.json").read_text(encoding="utf-8"))["cases"]
CHECK_SCRIPT = ROOT / "tests" / "js" / "diag_redact_check.mjs"


class SharedCasesBackendTest(unittest.TestCase):
    def test_backend_redactor_passes_shared_cases(self) -> None:
        for case in CASES:
            if case.get("py", True) is False:
                continue
            with self.subTest(case=case["id"]):
                # A home that matches nothing, so the generic path rules do the work
                # (the front end has no home dir either).
                out = redact(case["input"], home=os.path.join("nonexistent", "home"),
                             names=case.get("names", []))
                for s in case["absent"]:
                    self.assertNotIn(s, out)
                for s in case["present"]:
                    self.assertIn(s, out)


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


class FrontendRedactorTest(unittest.TestCase):
    def test_frontend_redactor_passes_shared_cases(self) -> None:
        runtime = _node_with_strip_types() or _bun()
        if runtime is None:
            self.skipTest("no Node >= 22.6 or Bun available to run diagRedact.ts")
        r = subprocess.run(runtime + [str(CHECK_SCRIPT)], capture_output=True, timeout=120,
                           cwd=str(ROOT))
        out = (r.stdout + r.stderr).decode("utf-8", "replace")
        self.assertEqual(r.returncode, 0, out)
        self.assertIn("0 failures", out)


if __name__ == "__main__":
    unittest.main()
