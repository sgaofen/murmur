"""Failed requests are errors, not empty states (#48 review items 4-6).

- app/src/utils/pageStates.ts (Home's whole-page empty state, the offline
  signals table's outcome) is run through tests/js/page_states_check.mjs with
  Node >= 22.6 or Bun; skipped when neither is installed (CI only provisions
  Python).
- The wiring in Home.tsx / OfflineSignalsTable.tsx / MediaGallery.tsx is
  checked statically so it runs everywhere.
"""
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_diag_redact_frontend import _bun, _node_with_strip_types  # noqa: E402

CHECK_SCRIPT = ROOT / "tests" / "js" / "page_states_check.mjs"
PAGES = ROOT / "app" / "src" / "pages"


def _src(rel: str) -> str:
    return (PAGES / rel).read_text(encoding="utf-8")


class PageStatesTest(unittest.TestCase):
    def test_rules(self) -> None:
        runtime = _node_with_strip_types() or _bun()
        if runtime is None:
            self.skipTest("no Node >= 22.6 or Bun available to run pageStates.ts")
        r = subprocess.run(runtime + [str(CHECK_SCRIPT)], capture_output=True, timeout=120, cwd=str(ROOT))
        out = (r.stdout + r.stderr).decode("utf-8", "replace")
        self.assertEqual(r.returncode, 0, out)
        self.assertIn("0 failures", out)

    def test_home_passes_the_list_error(self) -> None:
        src = _src("Home.tsx")
        m = re.search(r"const noData = homeHasNoData\(\{(.*?)\}\);", src, re.S)
        self.assertIsNotNone(m, "Home.tsx must decide noData through homeHasNoData()")
        self.assertIn("friendsError", m.group(1))

    def test_signals_table_counts_failures(self) -> None:
        src = _src("OfflineSignalsTable.tsx")
        self.assertNotRegex(src, r"catch\s*\{\s*//\s*skip friends that fail\s*\}")
        self.assertIn("failed += 1", src)
        self.assertIn("signalsOutcome(targets.length, collected.length, failed)", src)
        self.assertIn("'all-failed'", src)
        self.assertIn("朋友详情全部读取失败", src)

    def test_media_gallery_has_an_error_state(self) -> None:
        src = _src("extras/MediaGallery.tsx")
        # The old bug: any failure became an empty list → 「这里还没有媒体」.
        self.assertNotIn(".catch(() => setItems([]))", src)
        self.assertNotIn("r.ok ? r.json() : []", src)
        self.assertIn("setLoadError(e)", src)
        self.assertRegex(src, r"<ErrorState[\s\S]*?onRetry=\{onRetry\}")
        self.assertIn("<MediaLoadError error={loadError} onRetry={loadMedia} />", src)
        # The empty state only shows when the request worked.
        self.assertIn("!loading && loadError == null && items.length === 0", src)


if __name__ == "__main__":
    unittest.main()
