"""Relationship-graph raw-summary cache (#24).

1. Equivalence: on synthetic QQ and WeChat databases, the split path
   (collect_graph_raw → build_graph_from_raw, through the caches) must produce
   JSON-identical output to the frozen pre-#24 one-pass builder for every
   scope / top_n / show_clusters combination — including after the raw summary
   has round-tripped through the disk cache.
2. Caching: one DB scan serves every top_n; disk hits survive a memory flush;
   DB changes, /api/refresh-style flushes, TTL expiry and version bumps all
   force a rescan.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import etcli  # noqa: E402
import qq_store  # noqa: E402

import _graph_synth as synth  # noqa: E402
from _legacy_graph import legacy_build_relationship_graph  # noqa: E402

SCOPES = ("private", "recent", "all")
TOP_NS = (0, 1, 5, 20, 50, 100, 600)


def _dump(obj) -> str:
    # No sort_keys: key order and list order must match too.
    return json.dumps(obj, ensure_ascii=False)


class _GraphEnv(unittest.TestCase):
    """Temp data dir + temp disk cache + clean module-level caches."""

    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp(prefix="murmur-graph-")
        self.tmp = Path(self._tmp)
        self.cache_dir = self.tmp / "cache"
        self.cache_dir.mkdir()
        self._orig_cache_dir = etcli._disk_cache_dir
        etcli._disk_cache_dir = lambda: self.cache_dir
        self._reset_caches()

    def tearDown(self) -> None:
        etcli._disk_cache_dir = self._orig_cache_dir
        self._reset_caches()
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _reset_caches(self) -> None:
        etcli._MurmurAPIHandler._flush_analysis_caches()
        etcli._MENTIONS_CACHE.clear()

    def _prime_sns(self, store) -> None:
        ids = sorted(u for u, c in store.contacts().items() if not c.is_group)
        now = time.time()
        etcli._SNS_SIGNALS_CACHE["data"] = synth.fake_sns_signals(ids)
        etcli._SNS_SIGNALS_CACHE["ts"] = now
        etcli._FF_MOMENTS_CACHE["data"] = synth.fake_ff_moments(ids)
        etcli._FF_MOMENTS_CACHE["ts"] = now

    def _forget_memory(self) -> None:
        etcli._GRAPH_CACHE.clear()
        etcli._GRAPH_RAW_CACHE.clear()


class GraphEquivalenceTest(_GraphEnv):
    def _check_store(self, store) -> None:
        self._prime_sns(store)
        combos = [(s, n, c) for s in SCOPES for n in TOP_NS for c in (False, True)]
        legacy = {k: _dump(legacy_build_relationship_graph(
            store, scope=k[0], top_n=k[1], show_clusters=k[2])) for k in combos}

        # Sanity: the synthetic data actually exercises every edge type.
        full = json.loads(legacy[("all", 0, False)])
        types = {e["type"] for e in full["edges"]}
        self.assertTrue({"private", "mutual_reply", "mention", "co_group", "moments_cross"} <= types, types)
        self.assertGreater(len(full["clusters"]), 0)

        # Fresh raw summary in memory.
        for k in combos:
            got = etcli.get_relationship_graph_cached(store, scope=k[0], top_n=k[1], show_clusters=k[2])
            self.assertEqual(_dump(got), legacy[k], k)

        # Raw summary reloaded from disk (JSON round-trip), finished graphs dropped.
        self._forget_memory()
        for f in self.cache_dir.glob("graph_v5*.json"):
            f.unlink()
        for k in combos:
            got = etcli.get_relationship_graph_cached(store, scope=k[0], top_n=k[1], show_clusters=k[2])
            self.assertEqual(_dump(got), legacy[k], k)

        # Uncached wrapper keeps the old signature and output.
        self.assertEqual(_dump(etcli.build_relationship_graph(store, scope="private", top_n=20)),
                         legacy[("private", 20, False)])

    def test_qq_store_matches_legacy(self) -> None:
        d = synth.build_qq_dir(self.tmp / "qq")
        self._check_store(qq_store.QQStore(d))

    def test_wechat_store_matches_legacy(self) -> None:
        d = synth.build_wechat_dir(self.tmp / "wx")
        self._check_store(etcli.EchoStore(d))

    def test_non_default_filters_match_legacy(self) -> None:
        store = qq_store.QQStore(synth.build_qq_dir(self.tmp / "qq", seed=21))
        self._prime_sns(store)
        for min_private, recent_days in ((1, 365), (50, 365), (10, 30), (10, 0)):
            for top_n in (10, 0):
                want = legacy_build_relationship_graph(
                    store, scope="private", min_private=min_private,
                    recent_days=recent_days, top_n=top_n)
                got = etcli.get_relationship_graph_cached(
                    store, scope="private", min_private=min_private,
                    recent_days=recent_days, top_n=top_n)
                self.assertEqual(_dump(got), _dump(want), (min_private, recent_days, top_n))


class GraphRawCacheTest(_GraphEnv):
    def setUp(self) -> None:
        super().setUp()
        self.data_dir = synth.build_qq_dir(self.tmp / "qq")
        self.store = qq_store.QQStore(self.data_dir)
        self._prime_sns(self.store)
        self.calls = 0
        self._orig_collect = etcli.collect_graph_raw

        def counting(*a, **kw):
            self.calls += 1
            return self._orig_collect(*a, **kw)

        etcli.collect_graph_raw = counting

    def tearDown(self) -> None:
        etcli.collect_graph_raw = self._orig_collect
        super().tearDown()

    def _graph(self, **kw):
        kw.setdefault("scope", "private")
        return etcli.get_relationship_graph_cached(self.store, **kw)

    def test_one_scan_serves_every_top_n_and_scope(self) -> None:
        for scope in SCOPES:
            for top_n in (10, 30, 100, 0):
                for clusters in (False, True):
                    self._graph(scope=scope, top_n=top_n, show_clusters=clusters)
        self.assertEqual(self.calls, 1)
        # min_private doesn't affect collection either.
        self._graph(top_n=10, min_private=1)
        self.assertEqual(self.calls, 1)
        # A different message window is a different summary.
        self._graph(top_n=10, recent_days=30)
        self.assertEqual(self.calls, 2)

    def test_disk_hit_after_memory_flush(self) -> None:
        self._graph(top_n=10)
        self._forget_memory()
        g = self._graph(top_n=77)  # never built before, raw comes from disk
        self.assertEqual(self.calls, 1)
        self.assertLessEqual(g["stats"]["total_people"], 77)
        self.assertTrue(list(self.cache_dir.glob("graph_raw_v*.json")))

    def test_db_change_invalidates(self) -> None:
        before = self._graph(top_n=0)
        nt = self.data_dir / "nt_msg.db"
        c = sqlite3.connect(str(nt))
        try:
            # A brand-new heavy private chat with an existing real friend.
            peer = "u_f00001"
            body = synth._qq_body("新消息")
            now = int(time.time())
            c.executemany(
                'INSERT INTO c2c_msg_table VALUES (?,?,?,?,?,?,?)',
                [(10_000_000 + i, peer, now - i, 1, body, "", peer) for i in range(500)])
            c.commit()
        finally:
            c.close()
        st = nt.stat()
        os.utime(nt, (st.st_atime, st.st_mtime + 10))

        # The cached graph is not served for the old fingerprint, even from disk.
        self._forget_memory()
        store2 = qq_store.QQStore(self.data_dir)
        after = etcli.get_relationship_graph_cached(store2, scope="private", top_n=0)
        self.assertEqual(self.calls, 2)
        self.assertNotEqual(_dump(after), _dump(before))
        node = next(n for n in after["nodes"] if n["id"] == "u_f00001")
        self.assertGreaterEqual(node["private_msgs"], 500)

    def test_refresh_flush_invalidates(self) -> None:
        self._graph(top_n=10)
        # Same steps /api/refresh runs after a re-decrypt.
        etcli._MurmurAPIHandler._flush_analysis_caches()
        etcli._disk_clear()
        self._prime_sns(self.store)
        self._graph(top_n=10)
        self.assertEqual(self.calls, 2)

    def test_ttl_expiry(self) -> None:
        self._graph(top_n=10)
        ck = etcli._graph_raw_cache_key(365)
        ts, fp, raw = etcli._GRAPH_RAW_CACHE[ck]
        etcli._GRAPH_RAW_CACHE[ck] = (ts - etcli._CACHE_TTL - 1, fp, raw)
        etcli._GRAPH_CACHE.clear()
        for f in self.cache_dir.glob("*.json"):
            f.unlink()
        self._graph(top_n=20)
        self.assertEqual(self.calls, 2)

    def test_version_or_fingerprint_mismatch_on_disk_is_ignored(self) -> None:
        self._graph(top_n=10)
        ck = etcli._graph_raw_cache_key(365)
        disk = etcli._disk_load(ck)
        disk["_payload"]["raw"]["version"] = -1
        etcli._disk_save(ck, disk["_payload"])
        self._forget_memory()
        self._graph(top_n=20)
        self.assertEqual(self.calls, 2)

        disk = etcli._disk_load(ck)
        disk["_payload"]["fp"] = "stale"
        etcli._disk_save(ck, disk["_payload"])
        self._forget_memory()
        self._graph(top_n=30)
        self.assertEqual(self.calls, 3)

    def test_fingerprint_tracks_db_files(self) -> None:
        fp1 = etcli._graph_source_fingerprint(self.store)
        self.assertEqual(fp1, etcli._graph_source_fingerprint(self.store))
        p = self.data_dir / "group_info.db"
        st = p.stat()
        os.utime(p, (st.st_atime, st.st_mtime + 5))
        self.assertNotEqual(fp1, etcli._graph_source_fingerprint(self.store))


if __name__ == "__main__":
    unittest.main()
