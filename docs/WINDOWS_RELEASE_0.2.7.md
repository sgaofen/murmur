# Windows Release 0.2.7

Baseline: `origin/main` at `31542ab` (`Merge mac and Windows release readiness`).

## What changed

- Bumped the Windows release version from `0.2.6` to `0.2.7` across npm, Tauri, Cargo, frontend display, and `etcli`.
- Fixed Windows CLI output crashes when GBK consoles print UTF-8 JSON/emoji by forcing stdout/stderr to UTF-8 with replacement fallback.
- Allowed local Vite dev origins on loopback ports `5173-5199`, so isolated QA servers such as `5175` can talk to the backend without false CORS failures.
- Kept the graph toolbar visible when a friend/edge side panel is open. The toolbar now gives the 460px side panel room and wraps controls instead of hiding `自动旋转` behind the panel.

## Mac Sync Notes

- This branch starts from the latest merged `main`, so the Mac-side graph, pointer targeting, batch analysis, direct-evidence gate, and release-readiness changes already present in `main` are included.
- No extra Mac-only code was copied beyond `main`; Windows-specific changes here are limited to release versioning, Windows console/CORS robustness, and the graph toolbar layout fix.

## Verification

- `python -m py_compile cli\etcli.py cli\sns.py cli\batch_analyze.py cli\paths.py cli\media.py cli\refresh.py cli\extract_key.py cli\extract_key_dll.py cli\extract_image_key_v2.py cli\transcribe_voice.py`
- `npm run lint`
- `npm run build`
- API smoke on `127.0.0.1:9103`: `/api/info`, `/api/home-summary`, `/api/graph`, `/api/friend`, `/api/friend/.../connections`, `/api/agents`, `/api/reports`, direct pair pack, and Kevin/Zhihui direct-evidence rejection.
- Browser QA on `127.0.0.1:5175/#graph`: auto-rotate toggle, selected-friend toolbar visibility, edge click staying in graph focus, edge panel highlight.
- Isolated Codex LLM smoke: top 1 friend, sample 8, single concurrency, reports redirected to `.codex-release-logs/agent-reports`.
- Windows package build: `.\build-windows.ps1 -SkipInstall`.

## Artifacts

- MSI: `app\src-tauri\target\release\bundle\msi\Murmur_0.2.7_x64_en-US.msi`
  - SHA256: `83827B31EAD4019E0AEB7B7309E024F61715CBFE3BDFE1BA270F874A04B019C5`
- NSIS: `app\src-tauri\target\release\bundle\nsis\Murmur_0.2.7_x64-setup.exe`
  - SHA256: `11605A2EB79FCC888EFE56EC026D1051721B85DBD5B30882440EDC5925C2FCAF`

## Not Run Automatically

- The generated installer/exe was not executed in this pass. Running or installing a newly generated package changes the local machine state, so do that only as an explicit install smoke test.
