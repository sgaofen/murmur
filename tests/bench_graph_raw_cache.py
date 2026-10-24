"""Before/after timing for the graph raw-summary cache (#24). Not a unit test.

    python3 tests/bench_graph_raw_cache.py [--scale N]

Builds a synthetic QQ nt_msg.db in a temp dir, then times switching top_n
across 50 → 100 → 200 → 300 → 600 (scope=private, the /api/graph default):

  old        frozen pre-#24 builder; every top_n rescans every group
  new cold   get_relationship_graph_cached with empty caches: first top_n
             collects the raw summary, later ones assemble from memory
  new disk   memory caches dropped (≈ app restart), raw summary on disk,
             finished graphs not — every top_n is a fresh assembly

Friend-mention pairs and Moments signals have their own caches, untouched by
this change; they are pre-warmed for every top_n before timing so the numbers
isolate the graph build itself.
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import etcli  # noqa: E402
import qq_store  # noqa: E402

import _graph_synth as synth  # noqa: E402
from _legacy_graph import legacy_build_relationship_graph  # noqa: E402

TOP_NS = (50, 100, 200, 300, 600)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=int, default=4)
    args = ap.parse_args()
    k = args.scale

    tmp = Path(tempfile.mkdtemp(prefix="murmur-graph-bench-"))
    try:
        cache_dir = tmp / "cache"
        cache_dir.mkdir()
        etcli._disk_cache_dir = lambda: cache_dir

        t0 = time.perf_counter()
        d = synth.build_qq_dir(tmp / "qq", n_friends=150 * k, n_strangers=400 * k,
                               n_groups=30 * k, group_msgs=1500, private_msgs=200)
        store = qq_store.QQStore(d)
        c = sqlite3.connect(str(d / "nt_msg.db"))
        n_grp = c.execute("SELECT COUNT(*) FROM group_msg_table").fetchone()[0]
        n_c2c = c.execute("SELECT COUNT(*) FROM c2c_msg_table").fetchone()[0]
        c.close()
        size_mb = (d / "nt_msg.db").stat().st_size / 1e6
        print(f"synthetic QQ: {n_grp} group msgs, {n_c2c} private msgs, "
              f"{size_mb:.1f} MB nt_msg.db, built in {time.perf_counter()-t0:.1f}s")

        ids = sorted(u for u, ct in store.contacts().items() if not ct.is_group)
        etcli._SNS_SIGNALS_CACHE.update(data=synth.fake_sns_signals(ids), ts=time.time() + 3600)
        etcli._FF_MOMENTS_CACHE.update(data=synth.fake_ff_moments(ids), ts=time.time() + 3600)
        for n in TOP_NS:
            etcli.get_friend_mentions_cached(store, top_n=max(50, n), min_mention_count=3)

        def timed(fn):
            t = time.perf_counter()
            out = fn()
            return out, time.perf_counter() - t

        rows = {n: {} for n in TOP_NS}
        olds = {}
        for n in TOP_NS:
            olds[n], rows[n]["old"] = timed(lambda: legacy_build_relationship_graph(
                store, scope="private", top_n=n))

        etcli._GRAPH_CACHE.clear()
        etcli._GRAPH_RAW_CACHE.clear()
        for n in TOP_NS:
            g, rows[n]["new cold"] = timed(lambda: etcli.get_relationship_graph_cached(
                store, scope="private", top_n=n))
            assert g == olds[n], n

        etcli._GRAPH_CACHE.clear()
        etcli._GRAPH_RAW_CACHE.clear()
        for f in cache_dir.glob("graph_v5*.json"):
            f.unlink()
        for n in TOP_NS:
            g, rows[n]["new disk"] = timed(lambda: etcli.get_relationship_graph_cached(
                store, scope="private", top_n=n))
            assert g == olds[n], n

        raw_files = list(cache_dir.glob("graph_raw_v*.json"))
        print(f"raw summary on disk: {sum(f.stat().st_size for f in raw_files)/1e6:.2f} MB\n")
        print("| top_n | old | new cold | new (raw from disk) |")
        print("|---:|---:|---:|---:|")
        tot = {"old": 0.0, "new cold": 0.0, "new disk": 0.0}
        for n in TOP_NS:
            r = rows[n]
            for key in tot:
                tot[key] += r[key]
            print(f"| {n} | {r['old']*1000:.0f} ms | {r['new cold']*1000:.0f} ms | {r['new disk']*1000:.0f} ms |")
        print(f"| total | {tot['old']*1000:.0f} ms | {tot['new cold']*1000:.0f} ms | {tot['new disk']*1000:.0f} ms |")
        print("\nall new outputs == old outputs")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
