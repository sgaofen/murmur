"""batch_analyze.py — 用 Claude Code (或 Codex) 把每个朋友 + 每对关系都跑一遍

输出: ~/Desktop/Murmur/agent_reports/（可用 MURMUR_AGENT_REPORTS_DIR 覆盖）
  - friends/<name>.md       每个朋友的关系档案 (基于私聊+群聊上下文+提及)
  - pairs/<a>__<b>.md       每对朋友间关系的推断
  - index.md                所有报告的索引

策略:
- 每个朋友/对调用 1 次 agent (~2-3 min/次)
- 失败的会跳过并记录到 _errors.txt
- 默认: top 10 朋友 + top 10 朋友间已知有关系的对 (mention/mutual_reply >= threshold)
- 用 --top 50 等可调

用法:
    python batch_analyze.py             # 默认 top 10 + key pairs
    python batch_analyze.py --top 20    # top 20 朋友
    python batch_analyze.py --pairs-only
    python batch_analyze.py --friends-only
    python batch_analyze.py --cli codex  # 用 codex 替代

Codex 默认使用 gpt-5.2，避免旧 Codex CLI 默认模型过新导致启动失败。
可用 MURMUR_CODEX_MODEL 覆盖。
"""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path
from threading import Lock

# Force stdout/stderr to UTF-8 so unicode characters like ↔ don't crash threads.
# On Windows, default stdout is GBK and any unicode print raises UnicodeEncodeError —
# inside ThreadPoolExecutor that silently kills the worker, so 0 reports get written.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

CST = timezone(timedelta(hours=8))

ETCLI_URL = os.environ.get("ETCLI_URL", "http://127.0.0.1:9100").rstrip("/")
NPM_BIN = Path(os.environ.get("APPDATA") or "") / "npm"


def _agent_reports_root() -> Path:
    override = os.environ.get("MURMUR_AGENT_REPORTS_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / "Desktop" / "Murmur" / "agent_reports"


def _codex_model_args() -> list[str]:
    model = os.environ.get("MURMUR_CODEX_MODEL", "gpt-5.2").strip()
    return ["-m", model] if model else []


def _which_agent(cli: str) -> Path | None:
    if sys.platform.startswith("win"):
        for ext in (".cmd", ".bat", ".exe", ".ps1"):
            p = NPM_BIN / f"{cli}{ext}"
            if p.exists():
                return p
    import shutil
    found = shutil.which(cli)
    return Path(found) if found else None


def _api(path: str) -> dict:
    req = urllib.request.Request(ETCLI_URL + path)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def _api_post(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(ETCLI_URL + path, data=data,
                                  headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def _safe_filename(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\s]+', "_", name)[:80]


def _clean_agent_output(cli: str, output: str) -> str:
    out = (output or "").strip()
    if cli == "codex":
        banner = re.search(r"(?:^|\n)codex\s*\n", out, flags=re.IGNORECASE)
        if banner:
            out = out[banner.end():]
        tokens = re.search(r"\ntokens used\b", out, flags=re.IGNORECASE)
        if tokens:
            out = out[:tokens.start()]
    return out.strip()


def call_agent(cli: str, agent_path: Path, prompt: str, timeout: int = 900) -> tuple[bool, str]:
    """Call agent via stdin pipe (the proven-working approach). Returns (ok, output).

    IMPORTANT: when called from inside a packaged .app, our cwd is the bundle's
    read-only Resources dir. codex/claude need to write temp/log files in cwd,
    so we explicitly switch to a user-writable dir before spawning the agent.
    """
    use_shell = sys.platform.startswith("win") and agent_path.suffix.lower() in (".cmd", ".bat", ".ps1")
    if cli == "claude":
        cmd_args = [str(agent_path), "--print"]
    elif cli == "codex":
        cmd_args = [str(agent_path), "exec", "--skip-git-repo-check", "--ephemeral", *_codex_model_args(), "-"]
    else:
        cmd_args = [str(agent_path)]

    # Always run agents from a writable user dir. ~/Desktop/Murmur exists
    # because batch_analyze itself writes reports there; fall back to $HOME.
    work_dir = Path.home() / "Desktop" / "Murmur"
    try:
        work_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        work_dir = Path.home()

    try:
        if use_shell:
            cmd_str = " ".join(f'"{a}"' if " " in a else a for a in cmd_args)
            r = subprocess.run(cmd_str, input=prompt, capture_output=True, text=True,
                               timeout=timeout, encoding="utf-8", errors="replace",
                               shell=True, cwd=str(work_dir))
        else:
            r = subprocess.run(cmd_args, input=prompt, capture_output=True, text=True,
                               timeout=timeout, encoding="utf-8", errors="replace",
                               cwd=str(work_dir))
        ok = r.returncode == 0 and len(r.stdout or "") > 100
        out = _clean_agent_output(cli, r.stdout or "") if ok else (r.stdout or "")
        if r.stderr and not ok:
            out += "\n\n[stderr]\n" + r.stderr
        return ok, out
    except subprocess.TimeoutExpired:
        return False, "[TIMEOUT after %ds]" % timeout
    except Exception as e:
        return False, f"[EXCEPTION] {type(e).__name__}: {e}"


# ---------------- Main batch logic ----------------

def cmd_run(args):
    cli = args.cli
    agent_path = _which_agent(cli)
    if not agent_path:
        print(f"[X] {cli} not installed (looked in PATH and {NPM_BIN}).")
        sys.exit(2)
    print(f"[*] Using agent: {agent_path}")

    out_root = _agent_reports_root()
    friends_dir = out_root / "friends"
    pairs_dir = out_root / "pairs"
    friends_dir.mkdir(parents=True, exist_ok=True)
    pairs_dir.mkdir(parents=True, exist_ok=True)
    errors_log = out_root / "_errors.txt"

    summary: list[dict] = []
    summary_lock = Lock()
    err_lock = Lock()
    t0 = time.time()

    def log_err(msg: str):
        with err_lock:
            with errors_log.open("a", encoding="utf-8") as f_err:
                f_err.write(msg + "\n")

    def process_friend(idx_total: tuple[int, int], f: dict) -> None:
        idx, total = idx_total
        name, wxid = f["name"], f["id"]
        suffix = f"__{cli}" if args.tag_cli else ""
        out_path = friends_dir / f"{idx:02d}_{_safe_filename(name)}{suffix}.md"
        if out_path.exists() and not args.force:
            print(f"  [F {idx}/{total}] {name}: SKIP")
            return
        try:
            pack_resp = _api_post(f"/api/friend/{urllib.parse.quote(wxid)}/analyze-pack",
                                   {"sample": args.sample})
            pack = pack_resp.get("content") or ""
            if len(pack) < 200:
                print(f"  [F {idx}/{total}] {name}: SKIP (no data)")
                return
        except Exception as e:
            print(f"  [F {idx}/{total}] {name}: pack err: {e}")
            log_err(f"friend pack failed: {name} ({wxid}): {e}")
            return

        ti = time.time()
        print(f"  [F {idx}/{total}] {name} START (pack {len(pack)//1000}KB)")
        ok, out = call_agent(cli, agent_path, pack, timeout=args.timeout)
        elapsed = time.time() - ti
        if ok:
            content = (
                f"# {name} 关系档案\n\n"
                f"> 由 {cli} 生成 · {datetime.now(CST).isoformat()} · 用时 {elapsed:.0f}s\n"
                f"> wxid: `{wxid}`\n\n---\n\n{out}\n"
            )
            out_path.write_text(content, encoding="utf-8")
            print(f"  [F {idx}/{total}] {name} OK ({len(out)//1000}KB, {elapsed:.0f}s)")
            with summary_lock:
                summary.append({"type": "friend", "name": name, "wxid": wxid,
                                "out": str(out_path), "elapsed": elapsed, "size": len(out)})
        else:
            print(f"  [F {idx}/{total}] {name} FAIL ({elapsed:.0f}s)")
            log_err(f"friend agent failed: {name} ({wxid}):\n{out[:1000]}")

    def process_pair(idx_total: tuple[int, int], rec: dict) -> None:
        idx, total = idx_total
        a, b = rec["wxid_a"], rec["wxid_b"]
        an, bn = rec["name_a"], rec["name_b"]
        label = f"{_safe_filename(an)}__{_safe_filename(bn)}"
        suffix = f"__{cli}" if args.tag_cli else ""
        out_path = pairs_dir / f"{idx:02d}_{label}{suffix}.md"
        if out_path.exists() and not args.force:
            print(f"  [P {idx}/{total}] {an} ↔ {bn}: SKIP")
            return
        try:
            pack_resp = _api(f"/api/friend-pair-pack?a={urllib.parse.quote(a)}&b={urllib.parse.quote(b)}")
            pack = pack_resp.get("pack") or ""
            if len(pack) < 200:
                print(f"  [P {idx}/{total}] {an} ↔ {bn}: SKIP")
                return
        except Exception as e:
            print(f"  [P {idx}/{total}] {an} ↔ {bn}: pack err: {e}")
            return
        ti = time.time()
        print(f"  [P {idx}/{total}] {an} ↔ {bn} START ({rec['total_mentions']} mentions)")
        ok, out = call_agent(cli, agent_path, pack, timeout=args.timeout)
        elapsed = time.time() - ti
        if ok:
            content = (
                f"# {an} ↔ {bn} 关系推断\n\n"
                f"> 由 {cli} 生成 · 用时 {elapsed:.0f}s · 提及次数 {rec['total_mentions']}\n\n"
                f"> wxid_a: `{a}`\n"
                f"> wxid_b: `{b}`\n\n"
                f"---\n\n{out}\n"
            )
            out_path.write_text(content, encoding="utf-8")
            print(f"  [P {idx}/{total}] {an} ↔ {bn} OK ({len(out)//1000}KB, {elapsed:.0f}s)")
            with summary_lock:
                summary.append({"type": "pair", "a": an, "b": bn, "wxid_a": a, "wxid_b": b,
                                "out": str(out_path), "elapsed": elapsed, "size": len(out)})
        else:
            print(f"  [P {idx}/{total}] {an} ↔ {bn} FAIL ({elapsed:.0f}s)")
            log_err(f"pair agent failed: {an} ↔ {bn}:\n{out[:1000]}")

    # === Phase 1: Top friends (PARALLEL) ===
    if not args.pairs_only:
        scope_label = "all" if args.top <= 0 else f"top {args.top}"
        print(f"\n[*] Phase 1: {scope_label} friends with {cli} (parallel={args.parallel})...")
        friends = _api("/api/friends?type=private")
        top_friends = friends if args.top <= 0 else friends[:args.top]
        with ThreadPoolExecutor(max_workers=args.parallel) as ex:
            futs = []
            for i, f in enumerate(top_friends, 1):
                futs.append(ex.submit(process_friend, (i, len(top_friends)), f))
            for _ in as_completed(futs):
                pass

    # === Phase 2: Key pairs (PARALLEL) ===
    if not args.friends_only:
        pair_scope = "all" if args.top_pairs <= 0 else f"top {args.top_pairs}"
        print(f"\n[*] Phase 2: {pair_scope} pairs (mode={args.pair_mode}) with {cli} (parallel={args.parallel})...")
        sorted_pairs: list[dict] = []
        try:
            if args.pair_mode == "graph":
                # Pull all friend-friend edges from the graph and rank by combined-edge weight.
                # Includes only direct evidence. Co-group alone is too weak for an
                # AI relationship report; it caused hallucinated links for unrelated people.
                graph_top_n = 0 if args.top_pairs <= 0 else 300
                graph = _api(f"/api/graph?scope=private&top_n={graph_top_n}")
                # Build per-pair max-priority edge
                priority = {"mutual_reply": 4, "mention": 3, "moments_cross": 2}
                pair_edges: dict[tuple[str, str], dict] = {}
                for e in graph.get("edges", []):
                    if e.get("source") == "self" or e.get("target") == "self":
                        continue
                    if e.get("type") not in priority and not (e.get("mention_count") or e.get("moments_cross")):
                        continue
                    key = tuple(sorted([e["source"], e["target"]]))
                    cur = pair_edges.get(key)
                    new_pri = priority.get(e["type"], 3 if e.get("mention_count") else 2 if e.get("moments_cross") else 0)
                    cur_pri = (priority.get(cur["type"], 3 if cur.get("mention_count") else 2 if cur.get("moments_cross") else 0)
                               if cur else -1)
                    if new_pri > cur_pri:
                        pair_edges[key] = e
                node_lookup = {n["id"]: n.get("name", n["id"]) for n in graph.get("nodes", [])}
                # Score: priority class × 100 + raw signal magnitude
                def score(e):
                    p = priority.get(e["type"], 3 if e.get("mention_count") else 2 if e.get("moments_cross") else 0)
                    sig = e.get("mention_count") or e.get("moments_cross") or \
                          e.get("shared_group_count") or e["weight"] or 0
                    return p * 1e6 + sig
                ranked = sorted(pair_edges.values(), key=lambda e: -score(e))
                selected_pairs = ranked if args.top_pairs <= 0 else ranked[:args.top_pairs]
                for e in selected_pairs:
                    a, b = e["source"], e["target"]
                    sorted_pairs.append({
                        "wxid_a": a, "wxid_b": b,
                        "name_a": node_lookup.get(a, a),
                        "name_b": node_lookup.get(b, b),
                        "total_mentions": e.get("mention_count") or 0,
                        "_edge_type": e["type"],
                        "_edge_weight": e["weight"],
                    })
            else:
                # Original mention-based mode
                mention_top_n = 0 if args.top_pairs <= 0 else 80
                pairs = _api(f"/api/friend-mentions?top_n={mention_top_n}&min={args.min_mentions}")
                ranked_pairs = sorted(pairs.values(), key=lambda r: -r["total_mentions"])
                sorted_pairs = ranked_pairs if args.top_pairs <= 0 else ranked_pairs[:args.top_pairs]
        except Exception as e:
            print(f"[X] pair selection failed: {e}")
            sorted_pairs = []

        with ThreadPoolExecutor(max_workers=args.parallel) as ex:
            futs = []
            for i, rec in enumerate(sorted_pairs, 1):
                futs.append(ex.submit(process_pair, (i, len(sorted_pairs)), rec))
            for _ in as_completed(futs):
                pass

    # === Phase 3: Index ===
    total_elapsed = time.time() - t0
    index_lines = [
        "# Murmur 关系档案合集",
        "",
        f"由 {cli} 自动生成 · {datetime.now(CST).strftime('%Y-%m-%d %H:%M')} · "
        f"耗时 {total_elapsed/60:.1f} 分钟 · 共 {len(summary)} 份报告",
        "",
        "---",
        "",
        "## 个人档案",
        "",
    ]
    friends_list = sorted([s for s in summary if s["type"] == "friend"],
                            key=lambda s: -s.get("size", 0))
    for s in friends_list:
        rel = Path(s["out"]).relative_to(out_root).as_posix()
        index_lines.append(f"- [{s['name']}]({rel}) — {s['size']//1000} KB · {s['elapsed']:.0f}s")
    index_lines.extend(["", "## 朋友间关系推断", ""])
    pair_list = sorted([s for s in summary if s["type"] == "pair"],
                        key=lambda s: -s.get("size", 0))
    for s in pair_list:
        rel = Path(s["out"]).relative_to(out_root).as_posix()
        index_lines.append(f"- [{s['a']} ↔ {s['b']}]({rel}) — {s['size']//1000} KB · {s['elapsed']:.0f}s")

    (out_root / "index.md").write_text("\n".join(index_lines), encoding="utf-8")
    (out_root / "_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n[DONE] {len(summary)} reports in {total_elapsed/60:.1f} min")
    print(f"  → {out_root}/index.md")
    if errors_log.exists():
        print(f"  ⚠ errors logged to: {errors_log}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cli", default="claude", choices=["claude", "codex"])
    p.add_argument("--top", type=int, default=10, help="Top N friends to analyze; 0 means all (default 10)")
    p.add_argument("--top-pairs", type=int, default=10, help="Top N friend pairs; 0 means all (default 10)")
    p.add_argument("--sample", type=int, default=80, help="Pack sample size (default 80)")
    p.add_argument("--timeout", type=int, default=900, help="Agent timeout per call (default 900s = 15min)")
    p.add_argument("--parallel", type=int, default=5, help="How many agents to run concurrently (default 5)")
    p.add_argument("--tag-cli", action="store_true", help="Append __claude/__codex to report filenames")
    p.add_argument("--min-mentions", type=int, default=3, help="Min mention count (mention mode only, default 3)")
    p.add_argument("--pair-mode", choices=["mention", "graph"], default="mention",
                    help="How to pick pairs: 'mention' (only pairs cross-mentioned in chat) | "
                         "'graph' (top-N friend-friend edges by combined signal — covers more)")
    p.add_argument("--force", action="store_true", help="Re-run even if report exists")
    p.add_argument("--pairs-only", action="store_true")
    p.add_argument("--friends-only", action="store_true")
    args = p.parse_args()
    cmd_run(args)


if __name__ == "__main__":
    main()
