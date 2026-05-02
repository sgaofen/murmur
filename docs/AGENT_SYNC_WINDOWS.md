# Agent Sync Notes - Windows side

Checked on 2026-05-02.

Branches compared:
- Windows: `origin/codex/windows-progress-2026-05-02`
- Mac: `origin/mac-llm-batch-progress` at `c4514df`

## 2026-05-02 latest Mac pass

After Mac published `f68a5e2` and `c4514df`, Windows re-reviewed the diff and
pulled the safe shared pieces instead of merging the branch wholesale.

Pulled into Windows:
- Added Mac's `docs/AGENT_SYNC_MAC.md` so both agents can read the other side's
  exact state from this branch.
- Ported the batch index rebuild from `cli/batch_analyze.py`: small top-up or
  smoke runs now rebuild `agent_reports/index.md` from all existing reports
  instead of replacing the index with only the current run's summary.
- Ported the current-run error counter so stale `_errors.txt` files no longer
  make clean runs look failed.
- Ported the Graph self-edge panel affordances: clicking a `你 ↔ friend` line can
  open the complete person file, read an existing AI report, or launch Claude /
  Codex analysis for that one relationship.
- Ported Yearbook quote identity/privacy fixes on top of the Windows keyword UI:
  quote/signature senders now carry `from_id`, respect privacy mode, and mask
  quoted text when privacy mode is enabled.

Still not pulled as-is:
- Mac's broad `cli/etcli.py` hunk would remove Windows' direct-evidence gate for
  pair reports and roll the graph cache key back from `graph_v3` to `graph_v2`.
  Windows keeps the stricter gate because it prevents Kevin/Zhihui-style false
  relationships.
- Mac's `Graph.tsx` import path assumes `app/src/utils/usePrivacy.ts`; Windows
  currently exposes the hook from `components/PrivacyToggle.tsx`, so Windows kept
  the local import shape.
- Mac's reduced Graph batch parallel defaults (`2/4/6`) were not adopted. The
  Windows UI keeps the more aggressive `3/5/8` options because the user has
  explicitly asked for faster multi-agent runs.

## Latest Windows sync status

Windows has now absorbed the useful Mac relationship-analysis work in commit
`b472e67` (`Absorb Mac relationship analysis improvements`), but not by merging
the Mac branch wholesale. The branches have diverged enough that a direct merge
would regress Windows fixes and the new Yearbook keyword design.

Absorbed from Mac:
- Exact pair mention rescans via pair-specific mention extraction, so long-tail
  pairs are not hidden by the global Top-N mention cache.
- Full shared-group history scanning for pair evidence instead of stopping at
  the first 2000/3000 messages.
- Time-spread samples for pair reports instead of only head/tail snippets.
- Direct-turn counting in shared groups: A/B messages within 10 minutes are
  surfaced as stronger evidence than mere co-presence.
- Non-text samples (voice/image/video/call metadata) are included as weak but
  useful context for LLM reports.
- Direct Moments interaction examples (`you -> friend`, `friend -> you`) are
  included for single-friend analysis packs.
- Stronger pair-report prompt that asks for an evidence matrix, uncertainty,
  relationship strength, and UI-ready edge summary.
- Reports UI can choose `Claude`, `Codex`, or `both`, and can set a parallelism
  level. The backend already supports `pids`/`log_paths`.
- Graph selected-edge endpoint highlighting was mirrored, on top of the Windows
  edge glow and "do not clear selected friend" behavior.

Validation done on Windows after absorbing:
- `python -m py_compile cli/etcli.py cli/sns.py cli/batch_analyze.py`
- `npm run build`
- `npm run lint` (0 errors, 8 pre-existing warnings)
- `git diff --check`
- Temporary fresh backend on port `9102` using the real decrypted data directory:
  `/api/graph`, `/api/agents`, `/api/reports`, `/api/friend-pair-pack`.
- In-app browser smoke test:
  - Reports batch panel shows Claude/Codex/both and parallel controls.
  - Graph: select a friend, click one of that friend's edges, stay on the graph.
  - Selected edge stays thick/glowing and endpoints stay highlighted.
  - EdgePanel loads the richer evidence pack and then detects both local CLIs.

## Not absorbed from Mac, with reasons

These are not "bad" changes in isolation; they were not pulled as-is because they
would conflict with newer Windows work, reintroduce known false positives, or
need platform-specific validation first.

1. `co_group` as a pair-report batch signal

   Mac's `cli/batch_analyze.py` revision allows `co_group` to be selected as an
   AI pair-report candidate. Windows intentionally does not absorb that. Shared
   group membership is context, not proof that two people know or interact with
   each other. This is exactly the class of bug that produced false relationships
   such as Kevin/Zhihui. Keep `co_group` visible in the graph, but do not feed it
   to LLM pair-report generation unless there is also direct metadata such as:
   `mutual_reply`, `mention_count`, `moments_cross`, or another explicit signal.

2. Whole-file Mac `Yearbook.tsx` / `YearData` shape

   Mac is behind the Windows Yearbook work. Pulling Mac's `Yearbook.tsx` or its
   older `YearData` interface would remove the new `top_words`, `signature.reason`,
   and `signature.terms` UI that came from the Claude Design handoff. Mac should
   port the Windows Yearbook keyword module instead of overwriting it.

3. Deleting Windows coordination/design docs

   Mac branch deletes `docs/AGENT_SYNC_WINDOWS.md` and
   `docs/YEARBOOK_KEYWORDS_DESIGN_BRIEF.md`. Windows keeps both. They are active
   cross-agent coordination artifacts, not stale generated files.

4. Deleting `build-windows.ps1`

   Not pulled. Windows still needs a first-class build/install path. If this
   script is obsolete, replace it with a tested Windows equivalent before
   deleting it.

5. `cli/paths.py` platform discovery changes

   Mac's version changes Windows discovery behavior too: it drops some WeChat/
   Weixin fallback paths and changes extraction capability semantics. Those may
   be good on Mac, but they are risky for Windows users with non-standard
   installs. Split platform-specific discovery changes or test them on Windows
   before porting.

6. Dependency changes that remove or reshuffle Windows requirements

   Do not remove Windows crypto/media dependencies from shared requirement files
   unless Windows gets its own requirements file. In particular, Windows image
   `.dat` decrypt still depends on the crypto stack.

7. Broad UI/privacy refactors

   Mac has useful-looking UI cleanup around privacy helpers and multiple pages,
   but Windows did not pull those broad edits in this pass. They touch many
   surfaces and need a separate visual/manual QA pass so they do not regress the
   graph, friend page, report export, or Yearbook.

8. Mac onboarding/run-guide rewrites

   Keep Mac docs on the Mac branch, but do not overwrite Windows onboarding docs
   with Mac-specific install language. The product is shared, but onboarding must
   remain platform-aware.

## Suggested next steps for the Mac agent

- Pull or manually port Windows commit `b472e67` for the relationship-evidence
  algorithm improvements.
- Keep the pair-report direct-evidence gate. Do not run pair LLM reports for
  co-group-only pairs.
- Port the Yearbook keyword module from Windows instead of reverting it.
- If changing shared platform files (`requirements.txt`, `cli/paths.py`,
  `build-windows.ps1`, onboarding docs), explicitly mark what is Mac-only vs.
  shared.
- Bump graph/pair cache keys when changing evidence semantics. Windows currently
  uses `graph_v3` and `pairpack_v3` after the latest evidence-pack changes.

## Good Mac-side changes pulled into the Windows branch

- Added cross-platform backend bundling scripts:
  - `app/scripts/bundle-backend.mjs`
  - `app/scripts/tauri-build.mjs`
  - `app/src-tauri/etcli/.keep`
- Switched Tauri dev server targets to `127.0.0.1` to avoid localhost privacy/network quirks.
- Centralized generated report paths behind `MURMUR_AGENT_REPORTS_DIR`.
- Added `MURMUR_AGENT_WORKDIR` for isolated LLM/batch test runs.
- Added `MURMUR_CODEX_MODEL`, defaulting to `gpt-5.2`, and `codex exec --ephemeral`.
- Added structured batch progress fields parsed from logs: friends/pairs done/total, failures, skips, crash flag, last stage.
- Track spawned batch child processes so status checks do not rely only on process table probing.
- Pair reports now write `wxid_a` and `wxid_b` frontmatter, and report lookup prefers those stable ids.
- `top=0` now means all for batch friend selection, mention extraction, and graph node selection.

## Windows-side changes Mac should pull or mirror

- Do not generate pair LLM reports from `co_group` alone. Shared group membership is useful context, but it is not direct evidence that two people have a relationship.
- Keep the `pair_direct_evidence()` gate before `/api/friend-pair-pack` and `/api/agents/invoke-pair`; otherwise unrelated people can get hallucinated pair reports.
- The Kevin/Zhihui false positive came from analyzing an arbitrary/co-group-only pair. Batch graph mode must require at least one direct signal: `mutual_reply`, `mention`, `moments_cross`, or equivalent direct metadata.
- Keep `pycryptodome` in the shared Windows dependency path, or split platform requirements. Removing it from shared `requirements.txt` breaks Windows `.dat` image decrypt.
- If Mac keeps `top=0` semantics, backend graph and mention extraction must also treat `0` as all; otherwise the UI can request all and receive an empty graph.
- For pair report lookup, do not match by report body text. Use `wxid_a`/`wxid_b` frontmatter first and deterministic filename only for legacy reports.
- Windows has Claude+Codex `both` mode plus per-CLI parallelism. Mac can reuse the API shape: `cli: "both"`, `pids`, `log_paths`, and `parallel`.

## Not pulled from Mac as-is

- Mac branch graph batch selection still allows `co_group` as a pair-report signal. Windows intentionally rejects that for LLM pair reports.
- Mac branch removed `pycryptodome` from shared requirements. That is okay only if Mac has platform-specific requirements, not if Windows uses the same file.
