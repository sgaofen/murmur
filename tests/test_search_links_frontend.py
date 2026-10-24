"""The chat page's 「返回」 restores the whole search it came from (#46 review).

app/src/utils/searchLinks.ts is run through tests/js/search_links_check.mjs
with Node >= 22.6 or Bun (same runners as test_diag_redact_frontend.py);
skipped when neither is installed — CI only provisions Python.
"""
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_diag_redact_frontend import _bun, _node_with_strip_types  # noqa: E402

CHECK_SCRIPT = ROOT / "tests" / "js" / "search_links_check.mjs"


class SearchLinksTest(unittest.TestCase):
    def test_back_link_keeps_words_mode_and_dates(self) -> None:
        runtime = _node_with_strip_types() or _bun()
        if runtime is None:
            self.skipTest("no Node >= 22.6 or Bun available to run searchLinks.ts")
        r = subprocess.run(runtime + [str(CHECK_SCRIPT)], capture_output=True, timeout=120, cwd=str(ROOT))
        out = (r.stdout + r.stderr).decode("utf-8", "replace")
        self.assertEqual(r.returncode, 0, out)
        self.assertIn("0 failures", out)


if __name__ == "__main__":
    unittest.main()
