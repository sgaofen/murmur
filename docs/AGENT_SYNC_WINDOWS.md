# Agent Sync Notes - Windows side

Checked on 2026-05-02.

Branches compared:
- Windows: `origin/codex/windows-progress-2026-05-02`
- Mac: `origin/mac-llm-batch-progress` at `6b77533`

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
