"""The search page's automatic re-run never overwrites a newer search (#48 review).

app/src/utils/searchRerun.ts is run through tests/js/search_rerun_check.mjs
with Node >= 22.6 or Bun (same runners as test_diag_redact_frontend.py);
skipped when neither is installed — CI only provisions Python. The wiring in
Search.tsx is checked statically so it runs everywhere.
"""
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_diag_redact_frontend import _bun, _node_with_strip_types  # noqa: E402

CHECK_SCRIPT = ROOT / "tests" / "js" / "search_rerun_check.mjs"
SEARCH_PAGE = ROOT / "app" / "src" / "pages" / "Search.tsx"


class SearchRerunTest(unittest.TestCase):
    def test_rerun_rules(self) -> None:
        runtime = _node_with_strip_types() or _bun()
        if runtime is None:
            self.skipTest("no Node >= 22.6 or Bun available to run searchRerun.ts")
        r = subprocess.run(runtime + [str(CHECK_SCRIPT)], capture_output=True, timeout=120, cwd=str(ROOT))
        out = (r.stdout + r.stderr).decode("utf-8", "replace")
        self.assertEqual(r.returncode, 0, out)
        self.assertIn("0 failures", out)

    def test_search_page_uses_the_guard(self) -> None:
        src = SEARCH_PAGE.read_text(encoding="utf-8")
        # The re-run asks the guard with the newest request number ...
        self.assertRegex(src, r"rerunWhenReady\(\s*lastRef\.current\s*,\s*reqRef\.current\s*\)")
        # ... the shown search records the request it came from ...
        self.assertRegex(src, r"ShownSearch<Mode>\s*=\s*\{\s*req\s*,")
        # ... and there is no other path that re-runs lastRef unguarded.
        self.assertEqual(len(re.findall(r"run\(\s*last\.q", src)), 1)
        self.assertIn("rerunOnLanding(shown, indexStateRef.current, isRerun)", src)


if __name__ == "__main__":
    unittest.main()
