# Windows Release 0.2.8

Baseline: `origin/main` at `1c9172f` (`Improve agent progress handling`).

## What changed

- Bumped the Windows release version to `0.2.8` across npm, Tauri, Cargo, frontend display, and `etcli`.
- Absorbed the latest Mac/main updates through `1c9172f`, including batch progress handling, graph edge targeting, release install docs, and Mac notarization workflow docs.
- Fixed Windows CLI output crashes when GBK consoles print UTF-8 JSON/emoji by forcing stdout/stderr to UTF-8 with replacement fallback.
- Allowed local Vite dev origins on loopback ports `5173-5199`, so isolated QA servers such as `5175` can talk to the backend without false CORS failures.
- Kept the graph toolbar visible when a friend/edge side panel is open. The toolbar now gives the 460px side panel room and wraps controls instead of hiding `自动旋转` behind the panel.

## Mac Sync Notes

- This branch is merged with the latest `main`, so the Mac-side graph, pointer targeting, batch analysis, direct-evidence gate, progress tracking, and release-readiness changes already present in `main` are included.
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

- MSI: `app\src-tauri\target\release\bundle\msi\Murmur_0.2.8_x64_en-US.msi`
  - SHA256: `2D6AD71453A2C3A4AAF69603A0F25210CBD0A2B4A71559B2544A7A0D73AC1677`
- NSIS: `app\src-tauri\target\release\bundle\nsis\Murmur_0.2.8_x64-setup.exe`
  - SHA256: `813F3A6252633964D29D850AA42FB26A7FAEE12AF5C2761F04A47DED925FE33A`

## Not Run Automatically

- The generated installer/exe was not executed in this pass. Running or installing a newly generated package changes the local machine state, so do that only as an explicit install smoke test.
