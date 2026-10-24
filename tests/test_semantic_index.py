"""Tests for cli/semantic_index.py.

The embedding model is replaced by a deterministic fake (hashed character
bigrams -> normalized vector), so nothing here needs onnxruntime, tokenizers
or numpy. Cases that compare against the numpy code path are skipped when
numpy isn't installed (the pure-Python path is what runs then).

A real-model smoke test runs only when MURMUR_TEST_SEMANTIC_MODEL_DIR points
at a directory holding the downloaded model files and the optional deps are
installed.
"""
import hashlib
import json
import math
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import search_index as si  # noqa: E402
import semantic_index as sem  # noqa: E402
import test_search_index as base  # noqa: E402  (fixture builders only)
from etcli import EchoStore  # noqa: E402

try:
    import numpy  # noqa: F401
    HAVE_NUMPY = True
except ImportError:
    HAVE_NUMPY = False


def _bigrams(text):
    t = "".join((text or "").split()).lower()
    return [t[i:i + 2] for i in range(len(t) - 1)] or ([t] if t else [])


class FakeEmbedder(sem.Embedder):
    """Bag of hashed character bigrams: texts sharing words score higher."""
    model_id = "fake-bigram-64"
    dim = 64

    def __init__(self):
        self.doc_calls = 0
        self.docs_embedded = []
        self.lock = threading.Lock()

    def _vec(self, text):
        v = [0.0] * self.dim
        for g in _bigrams(text):
            h = int(hashlib.md5(g.encode("utf-8")).hexdigest(), 16)
            v[h % self.dim] += 1.0 if (h >> 8) & 1 else -1.0
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / n for x in v]

    def embed_documents(self, texts):
        with self.lock:
            self.doc_calls += 1
            self.docs_embedded.extend(texts)
        return [self._vec(t) for t in texts]

    def embed_query(self, text):
        return self._vec(text)


def add_alice_msgs(data: Path, items):
    c = sqlite3.connect(str(data / "message_1.db"))
    for when, sender, text in items:
        base.add_msg(c, base.ALICE, sender, when, text)
    c.commit()
    c.close()
    base.bump_mtime(data / "message_1.db")


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="murmur-semantic-"))
        self._env = {k: os.environ.get(k) for k in ("MURMUR_SEMANTIC_DIR", "MURMUR_SEARCH_INDEX_DIR",
                                                     "MURMUR_HF_ENDPOINT")}
        os.environ["MURMUR_SEMANTIC_DIR"] = str(self.tmp / "semantic")
        os.environ["MURMUR_SEARCH_INDEX_DIR"] = str(self.tmp / "kw")
        os.environ.pop("MURMUR_HF_ENDPOINT", None)
        self.data = base.build_wechat_fixture(self.tmp)
        self.store = EchoStore(self.data)
        self.kw = si.SearchIndex(self.store, "wechat", self.tmp / "kw" / "wechat-test.sqlite")
        self.emb = FakeEmbedder()
        self.idx = sem.SemanticIndex(self.kw, self.tmp / "semantic" / "index" / "wechat-test.sqlite",
                                     embedder=self.emb)

    def tearDown(self):
        self.idx.wait(10)
        self.kw.wait(10)
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def chunk_rows(self):
        c = sqlite3.connect(str(self.idx.path))
        try:
            return c.execute("SELECT id, chat_key, msg_ids, is_open FROM chunks ORDER BY id").fetchall()
        finally:
            c.close()

    def covered_ids(self):
        ids = []
        for _, _, msg_ids, _ in self.chunk_rows():
            ids.extend(json.loads(msg_ids))
        return ids

    def kw_ids(self):
        c = sqlite3.connect(str(self.kw.path))
        try:
            return sorted(r[0] for r in c.execute("SELECT id FROM messages"))
        finally:
            c.close()


class ChunkingTest(unittest.TestCase):
    def m(self, i, ts, text="hi"):
        return {"id": i, "ts": ts, "text": text}

    def test_max_messages(self):
        msgs = [self.m(i, 1000 + i) for i in range(20)]
        chunks = sem.chunk_messages(msgs, max_msgs=8)
        self.assertEqual([len(c) for c in chunks], [8, 8, 4])

    def test_gap_splits(self):
        msgs = [self.m(1, 0), self.m(2, 60), self.m(3, 60 + 7200), self.m(4, 60 + 7260)]
        chunks = sem.chunk_messages(msgs, max_gap=3600)
        self.assertEqual([[x["id"] for x in c] for c in chunks], [[1, 2], [3, 4]])

    def test_char_cap_and_blank_skip(self):
        msgs = [self.m(1, 0, "a" * 150), self.m(2, 1, "  "), self.m(3, 2, "b" * 150),
                self.m(4, 3, "c" * 150)]
        chunks = sem.chunk_messages(msgs, max_chars=320)
        self.assertEqual([[x["id"] for x in c] for c in chunks], [[1, 3], [4]])

    def test_long_message_clipped(self):
        text = sem.chunk_text([{"text": "字" * 1000}])
        self.assertEqual(len(text), sem.MSG_MAX_CHARS + 1)


class VectorTest(unittest.TestCase):
    def test_pack_roundtrip(self):
        v = [0.5, -0.25, 0.125, 0.0]
        self.assertEqual(sem.unpack_vector(sem.pack_vector(v)), v)

    def test_pure_python_scores(self):
        q = [1.0, 0.0]
        blobs = [sem.pack_vector([1.0, 0.0]), sem.pack_vector([0.0, 1.0]),
                 sem.pack_vector([math.sqrt(0.5), math.sqrt(0.5)])]
        s = sem.dot_scores(q, blobs, force_pure=True)
        self.assertAlmostEqual(s[0], 1.0, places=3)
        self.assertAlmostEqual(s[1], 0.0, places=3)
        self.assertAlmostEqual(s[2], math.sqrt(0.5), places=3)

    @unittest.skipUnless(HAVE_NUMPY, "numpy 未安装：只测纯 Python 回退路径")
    def test_numpy_matches_pure_python(self):
        emb = FakeEmbedder()
        texts = ["今晚吃火锅", "明天开会", "生日快乐", "火锅店推荐"]
        blobs = [sem.pack_vector(v) for v in emb.embed_documents(texts)]
        q = emb.embed_query("火锅")
        a = sem.dot_scores(q, blobs, force_pure=True)
        b = sem.dot_scores(q, blobs)
        for x, y in zip(a, b):
            self.assertAlmostEqual(x, y, places=4)


class BuildTest(_Base):
    def test_build_covers_every_message_once(self):
        r = self.idx.update()
        self.assertGreater(r["added_chunks"], 0)
        self.assertEqual(sorted(self.covered_ids()), self.kw_ids())
        st = self.idx.status()
        self.assertEqual(st["state"], "ready")
        self.assertEqual(st["indexed_messages"], len(self.kw_ids()))
        self.assertIsNotNone(st["last_built_at"])
        # Index lives under Murmur's own dir, never inside the decrypted data dir.
        self.assertNotIn(str(self.data.resolve()), str(self.idx.path.resolve()))
        self.assertFalse(any(p.name.endswith(".sqlite") for p in self.data.iterdir()))

    def test_chunks_stay_within_one_chat_and_one_open_per_chat(self):
        self.idx.update()
        per_chat = {}
        for _, key, _, is_open in self.chunk_rows():
            per_chat.setdefault(key, []).append(is_open)
        for key, opens in per_chat.items():
            self.assertEqual(sum(opens), 1, key)
            self.assertEqual(opens[-1], 1, key)

    def test_incremental_only_embeds_new_and_open_tail(self):
        self.idx.update()
        before = {r[0]: r for r in self.chunk_rows()}
        self.emb.docs_embedded.clear()
        r = self.idx.update()
        self.assertEqual(r["added_chunks"], 0)  # nothing new
        self.assertEqual(self.emb.docs_embedded, [])

        add_alice_msgs(self.data, [(base.ts("2024-05-20", 13), base.ALICE, "我养的猫咪生病了"),
                                   (base.ts("2024-05-20", 14), base.ME, "快带猫咪去宠物医院")])
        self.idx.update()
        after = self.chunk_rows()
        self.assertEqual(sorted(self.covered_ids()), self.kw_ids())
        # Only Alice's trailing chunk was re-embedded (it absorbed the new rows).
        self.assertEqual(len(self.emb.docs_embedded), 1)
        self.assertIn("宠物医院", self.emb.docs_embedded[0])
        closed_before = {i for i, r in before.items() if r[3] == 0}
        self.assertTrue(closed_before.issubset({r[0] for r in after}))

    def test_gap_closes_tail_chunk(self):
        self.idx.update()
        add_alice_msgs(self.data, [(base.ts("2024-09-01"), base.ALICE, "好久不见")])
        self.idx.update()
        alice = [r for r in self.chunk_rows() if r[1] == base.ALICE]
        self.assertEqual(sum(r[3] for r in alice), 1)
        self.assertEqual(sorted(self.covered_ids()), self.kw_ids())

    def test_paging_matches_single_pass(self):
        many = [(base.ts("2024-07-01") + i * 60, base.ALICE if i % 2 else base.ME, f"第{i}条消息聊聊天气")
                for i in range(30)]
        add_alice_msgs(self.data, many)
        self.idx.update()
        one_pass = sorted(json.loads(r[2]) for r in self.chunk_rows())
        self.idx.update(full=True)
        with mock.patch.object(sem, "PAGE_ROWS", 3):
            self.idx.update(full=True)
        paged = sorted(json.loads(r[2]) for r in self.chunk_rows())
        self.assertEqual(paged, one_pass)

    def test_keyword_rebuild_invalidates_marks(self):
        self.idx.update()
        self.kw.update(full=True)  # new row ids for every message
        self.idx.update()
        ids = self.covered_ids()
        self.assertEqual(sorted(ids), self.kw_ids())
        self.assertEqual(len(ids), len(set(ids)))

    def test_model_change_resets_index(self):
        self.idx.update()

        class Other(FakeEmbedder):
            model_id = "other"
        self.idx._embedder = Other()
        self.idx.update()
        c = sqlite3.connect(str(self.idx.path))
        try:
            self.assertEqual(dict(c.execute("SELECT key, value FROM meta"))["model_id"], "other")
        finally:
            c.close()
        self.assertEqual(sorted(self.covered_ids()), self.kw_ids())

    def test_background_build_and_status(self):
        r = self.idx.start_update()
        self.assertTrue(r["started"])
        self.idx.wait(30)
        self.assertEqual(self.idx.status()["state"], "ready")

    def test_build_error_surfaces_in_status(self):
        class Boom(FakeEmbedder):
            def embed_documents(self, texts):
                raise RuntimeError("model exploded")
        self.idx._embedder = Boom()
        self.idx.start_update()
        self.idx.wait(30)
        st = self.idx.status()
        self.assertEqual(st["state"], "error")
        self.assertIn("model exploded", st["last_error"])


class SearchTest(_Base):
    def setUp(self):
        super().setUp()
        add_alice_msgs(self.data, [(base.ts("2024-08-01"), base.ALICE, "我养的猫咪生病了"),
                                   (base.ts("2024-08-01", 13), base.ME, "快带猫咪去宠物医院")])
        self.idx.update()

    def test_ranking_and_shape(self):
        r = self.idx.search("猫咪 宠物医院")
        self.assertEqual(r["mode"], "semantic")
        self.assertGreater(r["total"], 1)
        scores = [x["score"] for x in r["results"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        top = r["results"][0]
        self.assertIn("宠物医院", top["snippet"])
        for k in ("platform", "chat", "chat_name", "is_group", "sender", "sender_name", "ts", "time",
                  "type", "type_code", "locator", "snippet", "segments", "highlights", "score", "chunk"):
            self.assertIn(k, top)
        self.assertEqual(top["chat"], base.ALICE)
        self.assertEqual(top["chat_name"], "爱丽丝")
        # The anchor is the message that overlaps the query most.
        self.assertEqual(top["sender_name"], "你")
        self.assertEqual(top["chunk"]["messages"][top["chunk"]["anchor_index"]]["locator"],
                         top["locator"])
        self.assertTrue(any(s["hit"] for s in top["segments"]))

    def test_hotpot_query_prefers_hotpot_chunk(self):
        r = self.idx.search("火锅")
        texts = "\n".join(m["text"] for m in r["results"][0]["chunk"]["messages"])
        self.assertIn("火锅", texts)

    def test_filters_and_paging(self):
        r = self.idx.search("晚饭", chat=base.GROUP)
        self.assertTrue(r["results"])
        self.assertTrue(all(x["chat"] == base.GROUP for x in r["results"]))
        r = self.idx.search("晚饭", ts_from=base.ts("2024-08-01", 0), ts_to=base.ts("2024-08-02", 0))
        self.assertTrue(all(x["chunk"]["ts_end"] >= base.ts("2024-08-01", 0) for x in r["results"]))
        r = self.idx.search("晚饭", sender=base.BOB)
        self.assertTrue(r["results"])
        for x in r["results"]:
            self.assertIn(base.BOB, [m["sender"] for m in x["chunk"]["messages"]])
        all_r = self.idx.search("晚饭", limit=100)
        page = self.idx.search("晚饭", limit=1, offset=1)
        self.assertEqual(page["total"], all_r["total"])
        self.assertEqual(page["results"][0]["chunk"]["id"], all_r["results"][1]["chunk"]["id"])
        hi = self.idx.search("晚饭", min_score=0.99)
        self.assertLess(hi["total"], all_r["total"])

    def test_pure_python_path_same_order(self):
        a = self.idx.search("猫咪 宠物医院")
        self.idx._cache = None
        with mock.patch.object(sem, "_numpy", lambda: None):
            b = self.idx.search("猫咪 宠物医院")
        self.assertEqual([x["chunk"]["id"] for x in a["results"]],
                         [x["chunk"]["id"] for x in b["results"]])

    def test_empty_query_and_no_index(self):
        with self.assertRaises(ValueError):
            self.idx.search("  ")
        other = sem.SemanticIndex(self.kw, self.tmp / "nope.sqlite", embedder=self.emb)
        self.assertEqual(other.search("x")["total"], 0)


class AvailabilityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="murmur-semantic-av-"))
        self._env = {k: os.environ.get(k) for k in ("MURMUR_SEMANTIC_DIR", "MURMUR_HF_ENDPOINT")}
        os.environ["MURMUR_SEMANTIC_DIR"] = str(self.tmp)
        os.environ.pop("MURMUR_HF_ENDPOINT", None)

    def tearDown(self):
        sem.downloader().wait(10)
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_not_installed_reports_missing_and_hint(self):
        with mock.patch.object(sem, "DEPS", ("murmur_no_such_pkg_xyz", "json")):
            st = sem.availability()
        self.assertEqual(st["state"], "not_installed")
        self.assertEqual(st["missing_deps"], ["murmur_no_such_pkg_xyz"])
        self.assertIn("requirements-semantic.txt", st["install_hint"])
        self.assertIn("requirements-semantic.txt", st["message"])

    def test_state_progression(self):
        with mock.patch.object(sem, "missing_deps", lambda: []):
            st = sem.availability()
            self.assertEqual(st["state"], "disabled")       # off by default
            self.assertFalse(st["enabled"])
            sem.save_settings(enabled=True)
            st = sem.availability()
            self.assertEqual(st["state"], "model_missing")
            self.assertIn("MB", st["message"])
            self.assertEqual(st["model"]["size_bytes"], sum(f["size"] for f in sem.MODEL["files"]))
            self.assertTrue(st["local_only"])
            d = sem.model_dir()
            d.mkdir(parents=True)
            for f in sem.MODEL["files"]:
                with open(d / f["local"], "wb") as fh:
                    fh.truncate(f["size"])
            st = sem.availability()
            self.assertEqual(st["state"], "ready")
            self.assertIsNone(sem.ensure_usable())

    def test_settings_validation_and_mirrors(self):
        with self.assertRaises(ValueError):
            sem.save_settings(mirror="evil")
        s = sem.save_settings(mirror="hf-mirror")
        self.assertEqual(s["mirror"], "hf-mirror")
        self.assertFalse(s["enabled"])
        urls = sem.file_urls("hf-mirror")
        self.assertTrue(all(u.startswith("https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/")
                            for u in urls))
        self.assertTrue(all(sem.MODEL["revision"] in u for u in urls))
        self.assertNotIn("custom", sem.mirror_ids())
        os.environ["MURMUR_HF_ENDPOINT"] = "https://example.invalid/hf/"
        self.assertIn("custom", sem.mirror_ids())
        self.assertTrue(sem.file_urls("custom")[0].startswith("https://example.invalid/hf/Xenova/"))

    def _fake_model(self, payloads):
        files = []
        for (name, data) in payloads:
            files.append({"path": "onnx/" + name, "local": name, "size": len(data),
                          "sha256": hashlib.sha256(data).hexdigest()})
        return dict(sem.MODEL, files=files)

    def test_download_verifies_sha256(self):
        payloads = [("a.bin", b"A" * 1000), ("b.json", b"{}")]
        fake_model = self._fake_model(payloads)
        served = dict(payloads)
        seen = []

        def fetch(url, dest, on_bytes):
            seen.append(url)
            data = served[url.rsplit("/", 1)[1]]
            Path(dest).write_bytes(data)
            on_bytes(len(data))

        dl = sem.ModelDownloader()
        dl.fetch = fetch
        with mock.patch.object(sem, "MODEL", fake_model):
            self.assertTrue(dl.start("hf-mirror")["started"])
            dl.wait(10)
            st = dl.status()
            self.assertEqual(st["state"], "done", st)
            self.assertEqual(st["done_bytes"], 1002)
            self.assertTrue(sem.model_files_present())
            self.assertTrue(all(u.startswith("https://hf-mirror.com/") for u in seen))
            # Second run: files already verified → nothing fetched.
            seen.clear()
            dl.start("huggingface")
            dl.wait(10)
            self.assertEqual(seen, [])

            # Corrupted payload → error, no file left behind.
            shutil.rmtree(sem.model_dir())
            served["a.bin"] = b"B" * 1000
            dl.start("huggingface")
            dl.wait(10)
            st = dl.status()
            self.assertEqual(st["state"], "error")
            self.assertIn("SHA-256", st["error"])
            self.assertFalse((sem.model_dir() / "a.bin").exists())
            self.assertFalse((sem.model_dir() / "a.bin.part").exists())

    def test_download_unknown_mirror(self):
        with self.assertRaises(ValueError):
            sem.ModelDownloader().start("nope")


class HttpTest(unittest.TestCase):
    def setUp(self):
        import etcli
        self.etcli = etcli
        self.tmp = Path(tempfile.mkdtemp(prefix="murmur-semantic-http-"))
        self.store = EchoStore(base.build_wechat_fixture(self.tmp))
        self._env = {k: os.environ.get(k) for k in ("MURMUR_SEMANTIC_DIR", "MURMUR_SEARCH_INDEX_DIR")}
        os.environ["MURMUR_SEMANTIC_DIR"] = str(self.tmp / "semantic")
        os.environ["MURMUR_SEARCH_INDEX_DIR"] = str(self.tmp / "kw")
        self.emb = FakeEmbedder()
        self._factory = sem.embedder_factory
        sem.embedder_factory = lambda: self.emb
        sem.reset_embedder()
        H = etcli._MurmurAPIHandler
        self._saved = (H.store, H._wechat_store, H._active_platform, H._active_id)
        H.store = self.store
        H._wechat_store = self.store
        H._active_platform = "wechat"
        H._active_id = base.ME
        from http.server import ThreadingHTTPServer
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        H = self.etcli._MurmurAPIHandler
        H.store, H._wechat_store, H._active_platform, H._active_id = self._saved
        kw = si.get_index(self.store, "wechat")
        sidx = sem.get_semantic_index(kw)
        sidx.wait(30)
        kw.wait(30)
        with si._REGISTRY_LOCK:
            si._REGISTRY.pop(str(kw.path), None)
        with sem._REGISTRY_LOCK:
            sem._REGISTRY.pop(str(sidx.path), None)
        sem.embedder_factory = self._factory
        sem.reset_embedder()
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _req(self, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data,
                                     method="GET" if body is None else "POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_not_installed(self):
        with mock.patch.object(sem, "missing_deps", lambda: ["onnxruntime"]):
            code, st = self._req("/api/search/semantic/status")
            self.assertEqual(code, 200)
            self.assertEqual(st["state"], "not_installed")
            self.assertEqual(st["missing_deps"], ["onnxruntime"])
            q = urllib.parse.quote("火锅")
            code, r = self._req(f"/api/search?q={q}&mode=semantic")
            self.assertEqual(code, 409)
            self.assertEqual(r["error"], "semantic_unavailable")
            self.assertEqual(r["status"]["state"], "not_installed")
            code, r = self._req("/api/search/semantic/build", {})
            self.assertEqual(code, 409)
            code, r = self._req("/api/search/semantic/download", {})
            self.assertEqual(code, 409)
            # Keyword search is unaffected.
            code, r = self._req(f"/api/search?q={q}")
            self.assertEqual(code, 200)

    def test_enable_build_search(self):
        def present(d=None):
            return True
        with mock.patch.object(sem, "missing_deps", lambda: []), \
                mock.patch.object(sem, "model_files_present", present):
            code, st = self._req("/api/search/semantic/status")
            self.assertEqual(st["state"], "disabled")
            q = urllib.parse.quote("吃火锅")
            code, r = self._req(f"/api/search/semantic?q={q}")
            self.assertEqual(code, 409)
            self.assertEqual(r["status"]["state"], "disabled")

            code, st = self._req("/api/search/semantic/settings", {"enabled": True, "mirror": "hf-mirror"})
            self.assertEqual(code, 200)
            self.assertTrue(st["enabled"])
            self.assertEqual(st["mirror"], "hf-mirror")
            self.assertEqual(st["state"], "empty")
            code, st = self._req("/api/search/semantic/settings", {"mirror": "evil"})
            self.assertEqual(code, 400)

            code, st = self._req("/api/search/semantic/build", {})
            self.assertEqual(code, 200)
            self.assertTrue(st["ok"])
            kw = si.get_index(self.store, "wechat")
            sem.get_semantic_index(kw).wait(30)
            code, st = self._req("/api/search/semantic/status")
            self.assertEqual(st["state"], "ready")
            self.assertGreater(st["index"]["chunks"], 0)

            code, r = self._req(f"/api/search?q={q}&mode=semantic&limit=5")
            self.assertEqual(code, 200)
            self.assertEqual(r["mode"], "semantic")
            self.assertTrue(r["results"])
            self.assertIn("score", r["results"][0])
            self.assertIn("index", r)
            code, r = self._req(f"/api/search?q={q}&mode=semantic&min_score=abc")
            self.assertEqual(code, 400)

            code, st = self._req("/api/search/semantic/settings", {"enabled": False})
            self.assertEqual(st["state"], "disabled")


@unittest.skipUnless(os.environ.get("MURMUR_TEST_SEMANTIC_MODEL_DIR") and not sem.missing_deps(),
                     "真实模型冒烟测试：需要设置 MURMUR_TEST_SEMANTIC_MODEL_DIR 并安装可选依赖")
class RealModelSmokeTest(_Base):
    def test_real_model_ranks_related_chunk_first(self):
        self.idx._embedder = sem.OnnxBgeEmbedder(Path(os.environ["MURMUR_TEST_SEMANTIC_MODEL_DIR"]))
        add_alice_msgs(self.data, [(base.ts("2024-08-01"), base.ALICE, "我家猫咪这两天不吃东西"),
                                   (base.ts("2024-08-01", 13), base.ME, "赶紧带它去宠物医院看看")])
        self.idx.update()
        r = self.idx.search("宠物生病")
        texts = "".join(m["text"] for m in r["results"][0]["chunk"]["messages"])
        self.assertIn("猫咪", texts)


if __name__ == "__main__":
    unittest.main()
