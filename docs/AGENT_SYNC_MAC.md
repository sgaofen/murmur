# Agent Sync Notes - Mac Side

Checked on 2026-05-02.

Branches compared:
- Mac: `origin/mac-llm-batch-progress`
- Windows: `origin/codex/windows-progress-2026-05-02`

Latest Mac commit when this note was written:
- `f68a5e2` `Absorb safe Windows graph and yearbook refinements`

This document is for cross-agent coordination. The Windows branch has its own
`docs/AGENT_SYNC_WINDOWS.md`; read both documents before merging ideas between
branches. Do not merge either branch wholesale. The branches contain
platform-specific fixes plus some intentionally different product choices.

## Current Mac Product State

Mac is currently focused on making a non-technical user able to:

1. open Murmur on macOS,
2. decrypt/import WeChat data,
3. browse friends, groups, Moments evidence, and relationship graphs,
4. run real Claude/Codex local-agent analysis,
5. inspect generated friend reports and friend-to-friend pair reports from the UI,
6. keep enough privacy controls that screenshots and demos are usable without
   exposing full wxids or raw chat text unnecessarily.

The current local development URLs are:

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:9137`

## Mac Code Map

### Backend and Data Extraction

- `cli/etcli.py`
  - Main CLI and HTTP API server.
  - Important endpoints:
    - `GET /api/info`
    - `GET /api/friends`
    - `GET /api/friend/:wxid`
    - `GET /api/friend/:wxid/yearbook`
    - `GET /api/friend/:wxid/connections`
    - `GET /api/graph?scope=private&top_n=N`
    - `GET /api/friend-pair-pack?a=A&b=B`
    - `GET /api/pair-report?a=A&b=B`
    - `POST /api/agents/batch`
    - `POST /api/agents/batch/status`
    - `POST /api/agents/invoke`
    - `POST /api/agents/invoke-pair`
  - Important functions:
    - `local_analysis()`: local no-LLM friend stats, rhythms, signals, vocabulary.
    - `relationship_signals()`: longevity, silence/resurrection, care, vulnerability,
      apology, lifecycle, calls, Moments summary notes.
    - `build_analysis_pack()`: single-friend LLM pack.
    - `build_pair_inference_pack()`: friend-to-friend LLM pack, cache key
      `pairpack_v3`, with exact pair mention rescans, full group-history scanning,
      direct-turn samples, non-text samples, Moments context, and a required
      evidence-matrix prompt.
    - `friend_yearbook()`: per-year data for the two-person Yearbook page.
    - `build_relationship_graph()`: graph nodes/edges, including private edges,
      mutual-reply edges, mention edges, Moments cross edges, and light co-group
      context edges.

- `cli/batch_analyze.py`
  - Real Claude/Codex batch runner.
  - Supports `--cli claude|codex`, `--tag-cli`, `--top 0`, `--top-pairs 0`,
    `--pair-mode graph`, `--parallel`, and `--force`.
  - Graph pair mode only selects direct signals for LLM pair reports:
    `mutual_reply`, `mention`, `moments_cross`, or direct metadata such as
    `mention_count`/`moments_cross`. Pure `co_group` is not selected for batch
    LLM pair reports.
  - Rebuilds `agent_reports/index.md` from all existing report files after a
    run, so small top-up/smoke runs do not hide older reports from the index.
  - Only prints `_errors.txt` when the current run actually wrote errors.

- `cli/sns.py`
  - Moments extraction and relationship signals.
  - Current Mac has:
    - `per_friend_signals()`
    - `friend_to_friend_signals()`
    - `direct_interaction_examples()`
  - Windows has additional `friend_context()` sample extraction; see "Not Yet
    Absorbed" below.

- `cli/paths.py`, `cli/refresh.py`, `cli/extract_key*.py`, `cli/media.py`
  - Platform-sensitive data discovery, decrypt/refresh, key extraction, and
    media helpers.
  - Treat Windows changes here as platform-specific until tested on macOS and
    Windows independently.

### Frontend

- `app/src/pages/Graph.tsx`
  - Relationship graph page, graph controls, side panels, edge panels, and
    graph-page batch analysis panel.
  - Friend-to-self private edges now preserve `raw_weight`, so the panel shows
    real counts such as `201 条` rather than the normalized drawing weight `1`.
  - Self-friend edge panel now has:
    - raw private message count,
    - "打开完整人物档案",
    - saved AI report preview/read button when available,
    - Claude/Codex/Gemini local-agent analysis buttons when no report exists.
  - Friend-friend edge panel still shows evidence pack previews, saved pair
    reports, live pair-agent streaming, and per-edge stats.
  - Graph batch panel supports `claude`, `codex`, or `both`, plus per-CLI
    parallelism and multi-log status polling.

- `app/src/components/extras/GraphView.tsx`
  - SVG 3D graph renderer.
  - Edge selection is sticky and highlighted; selected edges are thicker and
    glowing, and clicking an edge does not clear the selected friend network.
  - Hit testing is manual because pointer capture breaks normal bubbling.

- `app/src/pages/Yearbook.tsx`
  - Two-person Yearbook page.
  - Shows per-year stats, themed evidence quotes, and the new keyword/signature
    module adapted from Windows.
  - Uses privacy helpers:
    - `displayName()`
    - `maskedWxid()`
    - `maskText()`
    - `usePrivacy()`
  - Important: Mac kept `from_id` on quotes and signatures so labels remain
    privacy-safe and stable.

- `app/src/pages/Reports.tsx`
  - User-facing batch analysis controls.
  - Supports Claude/Codex/both and parallelism.
  - Reads generated reports from `~/Desktop/Murmur/agent_reports` or
    `MURMUR_AGENT_REPORTS_DIR`.

- `app/src/pages/Friend.tsx`
  - Full friend detail page.
  - Report and chat overlays are fixed-position and stop close-button event
    propagation, so they are not clipped by parent containers.

- `app/src/utils/privacy.ts` and `app/src/utils/usePrivacy.ts`
  - Mac keeps this split. Do not replace it with raw names/text or remove
    `usePrivacy` without a complete privacy QA pass.

## What Mac Absorbed From Windows

Mac absorbed these ideas manually rather than merging the Windows branch:

1. Yearbook keyword/signature module

   Added `top_words`, `signature.reason`, and `signature.terms` support.
   Mac adapted the UI while preserving `from_id`, `displayName()`, and
   `maskText()` so privacy mode still works.

   Code:
   - `cli/etcli.py`: `YEARBOOK_CACHE_VERSION = 4`, `_word_counts()`,
     scored `friend_yearbook()` signature selection.
   - `app/src/data/api.ts`: `YearData.top_words`, `signature.reason`,
     `signature.terms`.
   - `app/src/pages/Yearbook.tsx`: `YearInsightModule`, `WordCloud`,
     `SignatureBlock`.

2. Graph raw edge weight display

   Windows exposed the bug that the side panel was showing normalized drawing
   weight as if it were a message count. Mac now preserves `raw_weight` and uses
   it in `EdgePanel`.

   Verified case:
   - Alex Zhang backend private edge weight: `201`.
   - Previous UI showed `1 条`.
   - Current UI shows raw counts; another verified private edge displayed
     `346 条`.

3. Selected-edge emphasis

   Mac kept its existing sticky selected-friend behavior and added stronger
   selected-edge rendering: thick yellow line and glow.

4. Graph-page dual-engine batch controls

   Graph batch analysis now supports:
   - `claude`
   - `codex`
   - `both`
   - per-CLI parallelism
   - `pids`/`log_paths`
   - combined progress from multiple logs

5. Friend overlay stability

   Report and message overlays in `Friend.tsx` now use fixed positioning and
   close buttons stop propagation.

6. Batch status and report-index cleanup

   - Stale `_errors.txt` no longer causes a scary warning when the current run
     had no errors.
   - Small top-up runs no longer shrink `index.md` to only the latest reports.

## What Mac Did Not Absorb From Windows

These items are intentionally documented so the next cross-agent pass can decide
whether to port them.

### 1. Whole Windows branch

Not absorbed. It contains Windows build scripts, Windows path/decrypt changes,
and UI changes mixed with regressions for Mac privacy and evidence extraction.
Mac should continue cherry-picking, not merging.

### 2. Windows privacy refactor that removes `app/src/utils/usePrivacy.ts`

Not absorbed. The Windows branch changes imports to `../components/PrivacyToggle`
and in several places renders raw names/text that Mac currently masks. Mac keeps:

- `app/src/utils/privacy.ts`
- `app/src/utils/usePrivacy.ts`
- `displayName()`
- `maskedWxid()`
- `maskText()`

Reason: Mac has active privacy-mode behavior in Graph, Friend, Yearbook, and
report previews. Removing or relocating these helpers needs a full privacy QA
pass.

### 3. Windows hard `pair_direct_evidence()` API gate

Not fully absorbed yet.

Mac has already prevented pure `co_group` from being selected by graph batch mode
for LLM pair reports. However, Mac does not yet hard-reject arbitrary manual
`/api/friend-pair-pack?a=A&b=B` or `/api/agents/invoke-pair` calls when the pair
has only shared-group evidence.

Windows has:

- `pair_direct_evidence()`
- a pre-pack/pre-agent gate
- a direct-evidence section inside the pair pack
- `graph_v3` cache keys after that semantic change

Recommended Mac decision:

- Port this gate next, but adapt UI copy so co-group-only graph edges remain
  browsable as context and clearly say "no direct relationship evidence yet".
- After porting, bump graph/pair-related cache keys again.

### 4. Windows `sns.friend_context()`

Not absorbed yet.

Mac currently includes direct Moments interaction examples through
`direct_interaction_examples()` and friend-to-friend Moments via
`friend_to_friend_signals()`. Windows adds `friend_context()` which returns
concrete friend posts, your interactions on their posts, their interactions on
your posts, and "with each other" co-presence samples.

Recommended Mac decision:

- Port it after confirming it parses macOS decrypted `sns.db` XML the same way.
- Add it to `build_analysis_pack()` as richer single-friend Moments evidence.

### 5. Windows graph cache key `graph_v3`

Not absorbed in the last Mac commit.

Mac currently uses `graph_v2` and did not change graph-building semantics in the
latest Windows absorption pass; it changed UI display and Yearbook semantics.
If Mac ports `pair_direct_evidence()` or changes graph evidence semantics, bump
to `graph_v3` or newer.

### 6. Windows-specific build/install scripts

Not absorbed:

- `build-windows.ps1`
- Windows batch upload helpers
- Windows-specific `cli/paths.py` fallback behavior
- Windows `.dat`/crypto dependency changes

Reason: Mac branch should not rewrite Windows install/decrypt behavior without
testing on Windows. Keep these on Windows or split shared/platform-specific
files.

### 7. Dependency reshuffle around Windows crypto/media

Not absorbed as a Mac change.

Mac currently keeps core requirements lean:

- `zstandard`
- `cryptography`

Voice transcription remains optional in `requirements-voice.txt`.

Windows may need additional crypto/media dependencies such as `pycryptodome`.
If the product keeps one shared `requirements.txt`, Windows dependencies must
not be silently removed. Prefer platform-specific requirements files if needed.

### 8. Windows tooltip/raw-name display changes

Not absorbed. Some Windows UI changes render raw node names or skip privacy
helpers. Mac keeps privacy-safe display in tooltips and panels.

## Mac Validation Already Performed

Recent validation on Mac:

- `python3 -m py_compile cli/etcli.py cli/batch_analyze.py`
- `npm run lint`
- `npm run build`
- `git diff --check`
- API smoke:
  - `/api/graph?scope=private&top_n=100`
  - `/api/friend/{wxid}/yearbook`
  - `/api/agents`
  - `/api/agents/batch`
  - `/api/agents/batch/status`
- Browser smoke on `http://127.0.0.1:5173/#graph`:
  - private edge raw count is correct,
  - self-friend edge panel has full-profile link,
  - self-friend edge panel exposes Claude/Codex analysis actions,
  - selected edge remains highlighted.
- Real dual-engine top-1 pair batch:
  - Claude completed `SHY ↔ for river`.
  - Codex completed `SHY ↔ for river`.
- Local reports index rebuilt:
  - 32 friend reports,
  - 25 pair reports,
  - 57 total reports.

## Known Mac Gaps / Next Coordination Points

1. Decide whether to port Windows `pair_direct_evidence()` as a hard API gate.
   This is the most important false-positive prevention item.

2. Decide whether to port Windows `sns.friend_context()` into single-friend
   analysis packs.

3. Keep privacy behavior consistent across both platforms. If Windows keeps a
   different privacy hook location, both branches need a shared API contract so
   UI components do not drift.

4. Keep Yearbook `from_id` fields. Any design change that drops `from_id` breaks
   privacy-safe labels.

5. Keep graph UI semantics separate:
   - `co_group` is useful graph context.
   - `co_group` alone is not enough for LLM pair-report generation.

6. If either branch changes evidence semantics, bump disk cache keys so stale
   graph/pair/yearbook packs do not hide the change.

## How Another Agent Should Review Mac Code

Use these commands from the repo root:

```bash
git fetch origin
git checkout mac-llm-batch-progress
git log --oneline --decorate --max-count=12
git diff --stat origin/main..HEAD
```

For the core implementation, inspect these files first:

```bash
sed -n '260,360p' cli/batch_analyze.py
sed -n '3060,3130p' cli/etcli.py
sed -n '4540,5025p' cli/etcli.py
sed -n '720,1120p' app/src/pages/Graph.tsx
sed -n '1,360p' app/src/pages/Yearbook.tsx
sed -n '1,120p' app/src/components/extras/GraphView.tsx
```

Run these checks before proposing a merge back:

```bash
python3 -m py_compile cli/etcli.py cli/batch_analyze.py
cd app && npm run lint && npm run build
git diff --check
```

Do not use the Windows branch as the only source of truth for Mac behavior.
The Mac branch has newer fixes after Windows compared against `69c51b8`.
