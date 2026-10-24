"""semantic_index.py — optional on-device semantic search over chat history.

Off by default. It sits on top of the keyword index (search_index.py): the
keyword index already holds one normalized row per text message, so this
module only reads that SQLite file — it never touches WeChat's / QQ's data.

Pipeline:
    keyword index `messages`  --chunk_messages()-->  chunks of adjacent
    messages in one chat (up to CHUNK_MAX_MSGS, split on long silences)
    --Embedder-->  float16 vectors stored as BLOBs in Murmur's own SQLite
    file  --linear scan (numpy, or pure Python fallback)-->  top-k chunks.

Why SQLite + BLOB + linear scan instead of sqlite-vec / faiss: no native
extension to load (macOS system Pythons ship sqlite3 without
enable_load_extension), nothing to compile on Windows, and a chat archive is
at most a few hundred thousand chunks — one matrix-vector product over
125k x 512 float16 takes well under a second. float16 halves the file and
the in-memory cache versus float32 with no visible ranking change for
cosine similarity of normalized vectors.

Model: BAAI/bge-small-zh-v1.5 (512-dim, MIT), using the int8 ONNX export
from the Xenova/bge-small-zh-v1.5 repo (24 MB) run by onnxruntime with the
HuggingFace `tokenizers` package — no torch. Files are pinned to a commit
and verified by SHA-256, so the mirror (hf-mirror.com) is just as safe as
huggingface.co. Downloads only happen on an explicit request.

Optional deps (requirements-semantic.txt): onnxruntime, tokenizers, numpy.
Nothing here imports them at module load; status() reports what's missing.
No network access except the explicit model download; no cloud API calls.

Incremental rule: per chat we remember the highest keyword-index row id that
was embedded (plus its locator, to detect a rebuilt keyword index). New rows
are appended; the chat's last chunk is "open" (it may still grow), so it's
re-embedded together with the new rows. Rows edited/revoked after indexing
need a rebuild, same as the keyword index.

Stable references: keyword-index row ids are renumbered by a keyword rebuild,
so chunks store each message's locator (src, tbl, local_id) — the keyword
index's UNIQUE key — and results are hydrated through it, never through row
ids. The keyword index's `build_id` is remembered too; when it changes, every
chunk is re-embedded on the next pass.
"""
from __future__ import annotations

import hashlib
import heapq
import importlib.util
import json
import os
import re
import sqlite3
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Iterable, Optional, Sequence

import search_index as _si

SCHEMA_VERSION = 2  # 2: chunks.msg_locs (locators) replace keyword row ids

# Chunking: adjacent messages of one chat, cut at whichever comes first.
CHUNK_MAX_MSGS = 8
CHUNK_MAX_CHARS = 400
CHUNK_MAX_GAP = 3600          # seconds of silence that end a chunk
MSG_MAX_CHARS = 200           # a single long message is clipped to this

EMBED_BATCH = 16
PAGE_ROWS = 2000              # keyword-index rows read per page while building
MAX_LIMIT = 100
DEFAULT_CACHE_MB = 512

DEPS = ("onnxruntime", "tokenizers", "numpy")
INSTALL_HINT = "python3.12 -m pip install -r requirements-semantic.txt"

# Query-side instruction recommended by BAAI for short query -> passage retrieval.
BGE_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："

MODEL = {
    "id": "bge-small-zh-v1.5-int8",
    "name": "BAAI/bge-small-zh-v1.5（int8 ONNX）",
    "repo": "Xenova/bge-small-zh-v1.5",
    "revision": "75c43b069aac4d136ba6bc1122f995fedcfd2781",
    "license": "MIT",
    "homepage": "https://huggingface.co/BAAI/bge-small-zh-v1.5",
    "dim": 512,
    "max_tokens": 512,
    "files": [
        {"path": "onnx/model_quantized.onnx", "local": "model_quantized.onnx",
         "size": 24010842,
         "sha256": "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc"},
        {"path": "tokenizer.json", "local": "tokenizer.json",
         "size": 439125,
         "sha256": "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26"},
    ],
}

MIRRORS = [
    {"id": "huggingface", "label": "Hugging Face 官方（huggingface.co）",
     "endpoint": "https://huggingface.co"},
    {"id": "hf-mirror", "label": "国内镜像（hf-mirror.com）",
     "endpoint": "https://hf-mirror.com"},
]
DEFAULT_MIRROR = "huggingface"


# ---------------------------------------------------------------------------
# Locations / settings
# ---------------------------------------------------------------------------

def semantic_dir() -> Path:
    override = os.environ.get("MURMUR_SEMANTIC_DIR")
    if override:
        return Path(override).expanduser()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import paths as _paths  # noqa: E402
    return _paths.murmur_home() / "semantic"


def model_dir() -> Path:
    return semantic_dir() / "models" / MODEL["id"]


def _settings_path() -> Path:
    return semantic_dir() / "settings.json"


_SETTINGS_LOCK = threading.Lock()


def load_settings() -> dict:
    s = {"enabled": False, "mirror": DEFAULT_MIRROR}
    try:
        data = json.loads(_settings_path().read_text(encoding="utf-8-sig"))
        if isinstance(data, dict):
            s["enabled"] = bool(data.get("enabled", False))
            if data.get("mirror") in mirror_ids():
                s["mirror"] = data["mirror"]
    except (OSError, ValueError):
        pass
    return s


def save_settings(**changes) -> dict:
    with _SETTINGS_LOCK:
        s = load_settings()
        if "enabled" in changes and changes["enabled"] is not None:
            s["enabled"] = bool(changes["enabled"])
        if changes.get("mirror") is not None:
            m = changes["mirror"]
            if m not in mirror_ids():
                raise ValueError(f"未知的下载源: {m}")
            s["mirror"] = m
        p = _settings_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(str(tmp), str(p))
        return s


def mirrors() -> list:
    out = [dict(m) for m in MIRRORS]
    custom = (os.environ.get("MURMUR_HF_ENDPOINT") or "").strip().rstrip("/")
    if custom.startswith(("https://", "http://")):
        out.append({"id": "custom", "label": f"自定义（{custom}）", "endpoint": custom})
    return out


def mirror_ids() -> list:
    return [m["id"] for m in mirrors()]


def file_urls(mirror_id: str) -> list:
    ep = next((m["endpoint"] for m in mirrors() if m["id"] == mirror_id), None)
    if ep is None:
        raise ValueError(f"未知的下载源: {mirror_id}")
    return [f"{ep}/{MODEL['repo']}/resolve/{MODEL['revision']}/{f['path']}" for f in MODEL["files"]]


# ---------------------------------------------------------------------------
# Optional dependencies
# ---------------------------------------------------------------------------

def missing_deps() -> list:
    """Names of optional packages that aren't importable (no import done)."""
    out = []
    for name in DEPS:
        try:
            if importlib.util.find_spec(name) is None:
                out.append(name)
        except (ImportError, ValueError):
            out.append(name)
    return out


def model_files_present(d: Optional[Path] = None) -> bool:
    d = d or model_dir()
    for f in MODEL["files"]:
        p = d / f["local"]
        try:
            if p.stat().st_size != f["size"]:
                return False
        except OSError:
            return False
    return True


def model_size_bytes() -> int:
    return sum(f["size"] for f in MODEL["files"])


class ModelIntegrityError(ValueError):
    """Model files on disk don't match the pinned SHA-256."""


_VERIFIED: dict = {}   # (path, size, mtime_ns) -> sha256, so each file is hashed once
_VERIFIED_LOCK = threading.Lock()


def verify_model_files(d: Optional[Path] = None) -> None:
    """Raise ModelIntegrityError unless every model file matches its SHA-256.

    Runs before onnxruntime / tokenizers ever parse the files: the download
    is verified too, but files can be swapped or corrupted on disk later.
    """
    d = Path(d or model_dir())
    for f in MODEL["files"]:
        p = d / f["local"]
        try:
            st = p.stat()
        except OSError:
            raise ModelIntegrityError(f"模型文件缺失：{f['local']}，请重新下载模型")
        key = (str(p), st.st_size, st.st_mtime_ns)
        with _VERIFIED_LOCK:
            if _VERIFIED.get(key) == f["sha256"]:
                continue
        if st.st_size != f["size"] or _sha256(p) != f["sha256"]:
            raise ModelIntegrityError(f"模型文件 {f['local']} 校验失败（SHA-256 不一致），"
                                      "可能已损坏或被替换，请重新下载模型")
        with _VERIFIED_LOCK:
            _VERIFIED[key] = f["sha256"]


# ---------------------------------------------------------------------------
# Model download (explicit, background, verified)
# ---------------------------------------------------------------------------

class _Redirect308(urllib.request.HTTPRedirectHandler):
    """Python < 3.11 doesn't follow 308 (hf-mirror.com uses it)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if code == 308:
            code = 307
        return super().redirect_request(req, fp, code, msg, headers, newurl)

    http_error_308 = urllib.request.HTTPRedirectHandler.http_error_302


class ModelDownloader:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self.state = {"state": "idle", "mirror": None, "file": None, "done_bytes": 0,
                      "total_bytes": model_size_bytes(), "error": None, "finished_at": None}
        # Injection point for tests: (url, dest_path, on_bytes) -> None
        self.fetch: Callable = self._fetch

    def status(self) -> dict:
        with self._lock:
            return dict(self.state)

    def is_running(self) -> bool:
        return self._thread is not None

    def start(self, mirror_id: str, dest: Optional[Path] = None) -> dict:
        urls = file_urls(mirror_id)  # validates mirror_id
        with self._lock:
            if self._thread is not None:
                return {"started": False, "already_running": True}
            self.state.update({"state": "downloading", "mirror": mirror_id, "file": None,
                               "done_bytes": 0, "error": None, "finished_at": None})
            self._thread = threading.Thread(target=self._run, args=(urls, dest or model_dir()),
                                            name="murmur-semantic-download", daemon=True)
            self._thread.start()
            return {"started": True, "already_running": False}

    def wait(self, timeout: Optional[float] = None) -> None:
        t = self._thread
        if t is not None:
            t.join(timeout)

    def _run(self, urls: list, dest: Path) -> None:
        try:
            dest.mkdir(parents=True, exist_ok=True)
            base = 0
            for f, url in zip(MODEL["files"], urls):
                target = dest / f["local"]
                if target.exists() and target.stat().st_size == f["size"] \
                        and _sha256(target) == f["sha256"]:
                    base += f["size"]
                    with self._lock:
                        self.state["done_bytes"] = base
                    continue
                with self._lock:
                    self.state["file"] = f["path"]
                part = target.with_name(target.name + ".part")

                def on_bytes(n: int, _base=base, _f=f) -> None:
                    # Hard cap: a mirror serving more than the pinned size is
                    # wrong (or hostile) — stop instead of filling the disk.
                    if n > _f["size"]:
                        raise ValueError(f"{_f['path']} 超过预期大小（{_f['size']} 字节），"
                                         "已停止下载，请换一个下载源重试")
                    with self._lock:
                        self.state["done_bytes"] = _base + n

                try:
                    self.fetch(url, part, on_bytes)
                    size = part.stat().st_size
                    if size != f["size"]:
                        raise ValueError(f"{f['path']} 大小不对（{size} / {f['size']} 字节），"
                                         "请换一个下载源重试")
                    if _sha256(part) != f["sha256"]:
                        raise ValueError(f"{f['path']} 校验失败（SHA-256 不一致），请换一个下载源重试")
                except BaseException:
                    try:
                        part.unlink()
                    except OSError:
                        pass
                    raise
                os.replace(str(part), str(target))
                base += f["size"]
                with self._lock:
                    self.state["done_bytes"] = base
            with self._lock:
                self.state.update({"state": "done", "file": None, "finished_at": time.time()})
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"
            sys.stderr.write(f"[semantic] model download failed: {msg}\n")
            with self._lock:
                self.state.update({"state": "error", "error": msg, "finished_at": time.time()})
        finally:
            with self._lock:
                self._thread = None

    @staticmethod
    def _fetch(url: str, dest: Path, on_bytes: Callable[[int], None]) -> None:
        opener = urllib.request.build_opener(_Redirect308())
        req = urllib.request.Request(url, headers={"User-Agent": "Murmur"})
        n = 0
        with opener.open(req, timeout=60) as resp, open(dest, "wb") as out:
            while True:
                buf = resp.read(1 << 16)
                if not buf:
                    break
                out.write(buf)
                n += len(buf)
                on_bytes(n)


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for buf in iter(lambda: f.read(1 << 20), b""):
            h.update(buf)
    return h.hexdigest()


_DOWNLOADER = ModelDownloader()


def downloader() -> ModelDownloader:
    return _DOWNLOADER


# ---------------------------------------------------------------------------
# Embedders
# ---------------------------------------------------------------------------

class Embedder:
    """Interface. Vectors must be L2-normalized sequences of floats."""
    model_id = "abstract"
    dim = 0

    def embed_documents(self, texts: Sequence[str]) -> list:
        raise NotImplementedError

    def embed_query(self, text: str) -> list:
        raise NotImplementedError


class OnnxBgeEmbedder(Embedder):
    """bge-small-zh-v1.5 via onnxruntime + tokenizers (CLS pooling, L2 norm)."""
    model_id = MODEL["id"]
    dim = MODEL["dim"]

    def __init__(self, d: Optional[Path] = None, max_tokens: int = MODEL["max_tokens"]) -> None:
        d = Path(d or model_dir())
        verify_model_files(d)  # before any parser touches the files
        import numpy as np  # noqa: F401  (fail fast if missing)
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self._tok = Tokenizer.from_file(str(d / "tokenizer.json"))
        self._tok.enable_truncation(max_length=max_tokens)
        self._tok.enable_padding()
        opts = ort.SessionOptions()
        # Leave cores for the UI / other work; indexing is a background job.
        opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)
        self._sess = ort.InferenceSession(str(d / "model_quantized.onnx"), sess_options=opts,
                                          providers=["CPUExecutionProvider"])
        self._inputs = {i.name for i in self._sess.get_inputs()}
        self._lock = threading.Lock()

    def _encode(self, texts: Sequence[str]):
        import numpy as np
        enc = self._tok.encode_batch(list(texts))
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self._inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        with self._lock:
            out = self._sess.run(None, feed)[0][:, 0]
        norm = np.linalg.norm(out, axis=1, keepdims=True)
        norm[norm == 0] = 1.0
        return (out / norm).astype(np.float32)

    def embed_documents(self, texts: Sequence[str]):
        return self._encode(texts)

    def embed_query(self, text: str):
        return self._encode([BGE_QUERY_PREFIX + text])[0]


_EMBEDDER: Optional[Embedder] = None
_EMBEDDER_LOCK = threading.Lock()
# Tests replace this with a factory returning a deterministic fake embedder.
embedder_factory: Callable[[], Embedder] = lambda: OnnxBgeEmbedder()  # noqa: E731


def get_embedder() -> Embedder:
    global _EMBEDDER
    with _EMBEDDER_LOCK:
        if _EMBEDDER is None:
            _EMBEDDER = embedder_factory()
        return _EMBEDDER


def reset_embedder() -> None:
    global _EMBEDDER
    with _EMBEDDER_LOCK:
        _EMBEDDER = None


# ---------------------------------------------------------------------------
# Vector helpers (numpy when present, pure Python otherwise)
# ---------------------------------------------------------------------------

def _numpy():
    try:
        import numpy  # noqa: F401
        return numpy
    except ImportError:
        return None


def pack_vector(vec) -> bytes:
    np = _numpy()
    if np is not None and hasattr(vec, "dtype"):
        return np.asarray(vec, dtype=np.float16).tobytes()
    return struct.pack(f"<{len(vec)}e", *[float(x) for x in vec])


def unpack_vector(blob: bytes) -> list:
    return list(struct.unpack(f"<{len(blob) // 2}e", blob))


def _matvec(np, mat16, query):
    """float16 matrix x float32 vector, in blocks (no full float32 copy)."""
    q = np.asarray(query, dtype=np.float32)
    out = np.empty(mat16.shape[0], dtype=np.float32)
    step = 16384
    for i in range(0, mat16.shape[0], step):
        out[i:i + step] = mat16[i:i + step].astype(np.float32) @ q
    return out


def dot_scores(query, blobs: Sequence[bytes], force_pure: bool = False) -> list:
    """Cosine scores of a normalized query against float16 BLOB vectors."""
    if not blobs:
        return []
    np = None if force_pure else _numpy()
    if np is not None:
        mat = np.frombuffer(b"".join(blobs), dtype=np.float16).reshape(len(blobs), -1)
        return _matvec(np, mat, query).tolist()
    q = [float(x) for x in query]
    out = []
    for b in blobs:
        v = struct.unpack(f"<{len(b) // 2}e", b)
        out.append(sum(a * c for a, c in zip(v, q)))
    return out


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

def _clip(text: str, n: int = MSG_MAX_CHARS) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[:n] + "…"


def chunk_messages(msgs: Iterable[dict], max_msgs: int = CHUNK_MAX_MSGS,
                   max_chars: int = CHUNK_MAX_CHARS, max_gap: int = CHUNK_MAX_GAP) -> list:
    """Group consecutive messages of ONE chat (sorted by ts) into chunks.

    Each msg needs "id", "ts", "text". Returns lists of msgs. A chunk ends
    when it has max_msgs messages, would exceed max_chars, or the next
    message comes more than max_gap seconds later.
    """
    chunks: list = []
    cur: list = []
    chars = 0
    last_ts: Optional[int] = None
    for m in msgs:
        t = _clip(m.get("text") or "")
        if not t:
            continue
        n = len(t)
        if cur and (len(cur) >= max_msgs or chars + n > max_chars
                    or (last_ts is not None and int(m["ts"]) - last_ts > max_gap)):
            chunks.append(cur)
            cur, chars = [], 0
        cur.append(m)
        chars += n
        last_ts = int(m["ts"])
    if cur:
        chunks.append(cur)
    return chunks


def chunk_text(msgs: Sequence[dict]) -> str:
    return "\n".join(_clip(m.get("text") or "") for m in msgs)


def _bigrams(s: str) -> set:
    s = re.sub(r"\s+", "", (s or "").lower())
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


# ---------------------------------------------------------------------------
# The semantic index
# ---------------------------------------------------------------------------

class _Cancelled(Exception):
    pass


class SemanticIndex:
    def __init__(self, kw_index, path: Path, embedder: Optional[Embedder] = None) -> None:
        self.kw = kw_index                 # search_index.SearchIndex
        self.path = Path(path)
        self._embedder = embedder
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._pending: Optional[str] = None
        self._cancel = False
        self._progress = {"phase": "", "done": 0, "total": 0, "full": False,
                          "started_at": None, "finished_at": None, "last_error": None,
                          "added_chunks": 0}
        self._cache = None  # ((build_id, generation), ids, matrix)

    @property
    def embedder(self) -> Embedder:
        return self._embedder or get_embedder()

    # --- schema ---

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(str(self.path), timeout=30, check_same_thread=False)
        try:
            c.execute("PRAGMA journal_mode=WAL")
        except sqlite3.Error:
            pass
        c.execute("PRAGMA busy_timeout=30000")
        return c

    def _create_schema(self, c: sqlite3.Connection, model_id: str, dim: int) -> None:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY,
                chat_key TEXT NOT NULL,
                ts_start INTEGER NOT NULL,
                ts_end INTEGER NOT NULL,
                n_msgs INTEGER NOT NULL,
                msg_locs TEXT NOT NULL,
                senders TEXT NOT NULL,
                is_open INTEGER NOT NULL DEFAULT 0,
                vec BLOB NOT NULL);
            CREATE INDEX IF NOT EXISTS chunks_chat ON chunks(chat_key, ts_start);
            CREATE INDEX IF NOT EXISTS chunks_ts ON chunks(ts_start, ts_end);
            CREATE TABLE IF NOT EXISTS marks (
                chat_key TEXT PRIMARY KEY, last_msg_id INTEGER, last_locator TEXT);
        """)
        for k, v in (("schema_version", str(SCHEMA_VERSION)), ("model_id", model_id),
                     ("dim", str(dim)), ("kw_index", str(self.kw.path))):
            c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (k, v))
        # New identity whenever the tables are (re)created; part of the
        # in-memory matrix cache key together with `generation`.
        c.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('build_id', ?)",
                  (uuid.uuid4().hex,))
        c.commit()

    @staticmethod
    def _meta(c: sqlite3.Connection) -> dict:
        try:
            return dict(c.execute("SELECT key, value FROM meta").fetchall())
        except sqlite3.Error:
            return {}

    def _open_for_write(self, full: bool, model_id: str, dim: int) -> sqlite3.Connection:
        c = self._connect()
        meta = self._meta(c)
        compatible = (meta.get("schema_version") == str(SCHEMA_VERSION)
                      and meta.get("model_id") == model_id and meta.get("dim") == str(dim))
        if full or (meta and not compatible):
            # `generation` must keep growing across a reset: restarting it at 0
            # let a rebuilt index land on the cached generation and serve the
            # old in-memory matrix. The fresh build_id makes that doubly sure.
            prev_gen = _int(meta.get("generation"))
            self._cache = None
            c.executescript("DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS marks; "
                            "DROP TABLE IF EXISTS meta;")
            c.commit()
            self._create_schema(c, model_id, dim)
            c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('generation', ?)",
                      (str(prev_gen + 1),))
            c.commit()
        else:
            self._create_schema(c, model_id, dim)
        return c

    def _bump_generation(self, c: sqlite3.Connection) -> None:
        g = _int(self._meta(c).get("generation")) + 1
        c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('generation', ?)", (str(g),))

    def _sync_kw_build(self, c: sqlite3.Connection) -> None:
        """Forget every chunk when the keyword index was rebuilt under us.

        Chunks reference messages by locator, so they'd still hydrate
        correctly, but marks are keyword row ids and a rebuild reorders rows
        across files — re-embedding is the only way to be sure nothing is
        skipped or doubled. An unknown id on either side is adopted as is.
        """
        cur = self.kw.build_id()
        if not cur:
            return
        seen = self._meta(c).get("kw_build_id")
        if seen and seen != cur:
            c.execute("DELETE FROM chunks")
            c.execute("DELETE FROM marks")
            self._bump_generation(c)
        c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('kw_build_id', ?)", (cur,))
        c.commit()

    # --- building ---

    def _check_cancel(self) -> None:
        if self._cancel:
            raise _Cancelled()

    _KEY_SQL = "COALESCE(NULLIF(chat, ''), tbl)"
    _KEY_SQL_M = "COALESCE(NULLIF(m.chat, ''), m.tbl)"

    def update(self, full: bool = False) -> dict:
        """Synchronously embed everything new in the keyword index."""
        p = self._progress
        p.update({"phase": "keyword_index", "done": 0, "total": 0, "full": bool(full),
                  "added_chunks": 0})
        # The keyword index is our input: bring it up to date first.
        # Go through its own background driver so we never run two keyword
        # passes at once (the HTTP layer may kick one concurrently).
        if self.kw.is_building():
            self.kw.wait()
        if self.kw.needs_update():
            self.kw.start_update(full=False)
            self.kw.wait()
        self._check_cancel()

        emb = self.embedder
        p["phase"] = "planning"
        c = self._open_for_write(full, emb.model_id, emb.dim)
        added = 0
        try:
            self._sync_kw_build(c)
            if not self.kw.path.exists():
                p["phase"] = "done"
                return {"added_chunks": 0, "total": 0}
            kc = sqlite3.connect(str(self.kw.path), timeout=30)
            try:
                try:
                    chats = kc.execute(
                        f"SELECT {self._KEY_SQL} AS k, MAX(id) FROM messages GROUP BY k").fetchall()
                except sqlite3.OperationalError:
                    chats = []
                marks = {r[0]: (int(r[1]), r[2]) for r in c.execute(
                    "SELECT chat_key, last_msg_id, last_locator FROM marks").fetchall()}
                live = {k for k, _ in chats}
                for gone in set(marks) - live:
                    self._purge_chat(c, gone)
                plan = []
                total = 0
                for key, max_id in chats:
                    self._check_cancel()
                    mark = marks.get(key)
                    after = 0
                    if mark is not None:
                        row = kc.execute("SELECT src, tbl, local_id FROM messages WHERE id = ?",
                                         (mark[0],)).fetchone()
                        if row is None or _locator_str(row) != mark[1]:
                            # Keyword index was rebuilt / table replaced: start this chat over.
                            self._purge_chat(c, key)
                        else:
                            after = mark[0]
                    if int(max_id) <= after:
                        continue
                    n = kc.execute(f"SELECT COUNT(*) FROM messages WHERE {self._KEY_SQL} = ? "
                                   "AND id > ?", (key, after)).fetchone()[0]
                    plan.append((key, after))
                    total += int(n)
                c.commit()
                p.update({"phase": "embedding", "total": total})
                for key, after in plan:
                    added += self._embed_chat(c, kc, key, after)
            finally:
                kc.close()
            c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('last_built_at', ?)",
                      (str(time.time()),))
            c.commit()
            p["phase"] = "done"
            p["added_chunks"] = added
            return {"added_chunks": added, "total": p["total"]}
        finally:
            c.close()

    def _purge_chat(self, c: sqlite3.Connection, key: str) -> None:
        c.execute("DELETE FROM chunks WHERE chat_key = ?", (key,))
        c.execute("DELETE FROM marks WHERE chat_key = ?", (key,))
        self._bump_generation(c)

    def _embed_chat(self, c, kc, key: str, after: int) -> int:
        p = self._progress
        # Re-open the chat's trailing chunk so new messages can join it.
        carry: list = []
        open_row = c.execute("SELECT id, msg_locs FROM chunks WHERE chat_key = ? AND is_open = 1",
                             (key,)).fetchone()
        if open_row is not None:
            found = _rows_by_locators(kc, json.loads(open_row[1]),
                                      "m.id, m.ts, m.sender, m.text, m.src, m.tbl, m.local_id")
            carry = sorted((self._msg(r) for r in found.values()),
                           key=lambda m: (m["ts"], m["id"]))
            open_chunk_id = open_row[0]
        else:
            open_chunk_id = None
        added = 0
        last = after
        while True:
            self._check_cancel()
            rows = kc.execute(
                f"SELECT id, ts, sender, text, src, tbl, local_id FROM messages "
                f"WHERE {self._KEY_SQL} = ? AND id > ? ORDER BY id LIMIT ?",
                (key, last, PAGE_ROWS)).fetchall()
            if not rows:
                break
            page = [self._msg(r) for r in rows]
            last = page[-1]["id"]
            last_loc = page[-1]["locator"]
            p["done"] += len(page)
            msgs = sorted(carry + page, key=lambda m: (m["ts"], m["id"]))
            chunks = chunk_messages(msgs)
            # Every page is committed with its mark, so a cancelled build
            # resumes cleanly; the trailing chunk is stored "open" and is
            # replaced when the next page / next incremental run extends it.
            if open_chunk_id is not None:
                c.execute("DELETE FROM chunks WHERE id = ?", (open_chunk_id,))
                open_chunk_id = None
            n, open_chunk_id = self._insert_chunks(c, key, chunks)
            added += n
            carry = chunks[-1] if chunks else []
            c.execute("INSERT OR REPLACE INTO marks(chat_key, last_msg_id, last_locator) "
                      "VALUES (?, ?, ?)", (key, last, last_loc))
            self._bump_generation(c)
            c.commit()
            if len(rows) < PAGE_ROWS:
                break
        return added

    @staticmethod
    def _msg(r) -> dict:
        return {"id": int(r[0]), "ts": int(r[1]), "sender": r[2] or "", "text": r[3] or "",
                "locator": _locator_str(r[4:7]), "loc": [r[4], r[5], int(r[6])]}

    def _insert_chunks(self, c, key: str, chunks: list) -> tuple:
        """Embed + insert; the last chunk is marked open. Returns (n, open id)."""
        n = 0
        last_id = None
        for i in range(0, len(chunks), EMBED_BATCH):
            self._check_cancel()
            batch = chunks[i:i + EMBED_BATCH]
            vecs = self.embedder.embed_documents([chunk_text(ch) for ch in batch])
            for j, (ch, vec) in enumerate(zip(batch, vecs)):
                is_last = (i + j == len(chunks) - 1)
                senders = sorted({m["sender"] for m in ch if m["sender"]})
                c.execute(
                    "INSERT INTO chunks(chat_key, ts_start, ts_end, n_msgs, msg_locs, senders, "
                    "is_open, vec) VALUES (?,?,?,?,?,?,?,?)",
                    (key, ch[0]["ts"], ch[-1]["ts"], len(ch),
                     json.dumps([m["loc"] for m in ch], ensure_ascii=False),
                     "\x1f".join(senders), 1 if is_last else 0,
                     sqlite3.Binary(pack_vector(vec))))
                last_id = c.execute("SELECT last_insert_rowid()").fetchone()[0]
                n += 1
            self._progress["added_chunks"] = self._progress.get("added_chunks", 0) + len(batch)
        return n, last_id

    # --- background driver (same shape as SearchIndex) ---

    def start_update(self, full: bool = False) -> dict:
        with self._lock:
            if self._thread is not None:
                if full:
                    self._pending = "full"
                    self._cancel = True
                elif self._pending is None:
                    self._pending = "incr"
                return {"started": False, "queued": True}
            self._pending = "full" if full else "incr"
            self._cancel = False
            self._thread = threading.Thread(target=self._worker, name="murmur-semantic-index",
                                            daemon=True)
            self._thread.start()
            return {"started": True, "queued": False}

    def _worker(self) -> None:
        while True:
            with self._lock:
                job = self._pending
                self._pending = None
                self._cancel = False
                if job is None:
                    self._progress["finished_at"] = time.time()
                    self._thread = None
                    return
                self._progress["started_at"] = time.time()
                self._progress["last_error"] = None
            try:
                self.update(full=(job == "full"))
            except _Cancelled:
                continue
            except Exception as e:
                msg = f"{type(e).__name__}: {e}"
                sys.stderr.write(f"[semantic] build failed: {msg}\n")
                with self._lock:
                    self._progress["last_error"] = msg

    def cancel(self) -> None:
        with self._lock:
            self._pending = None
            self._cancel = True

    def wait(self, timeout: Optional[float] = None) -> None:
        t = self._thread
        if t is not None:
            t.join(timeout)

    def is_building(self) -> bool:
        return self._thread is not None

    # --- status ---

    def status(self) -> dict:
        p = dict(self._progress)
        building = self.is_building()
        chunks = 0
        messages = 0
        last_built = None
        stale = False
        if self.path.exists():
            try:
                c = sqlite3.connect(str(self.path), timeout=5)
                try:
                    meta = self._meta(c)
                    # An index from an older schema can't be searched: report
                    # it as empty so the UI offers to (re)build it.
                    if meta.get("schema_version") == str(SCHEMA_VERSION):
                        lb = meta.get("last_built_at")
                        last_built = float(lb) if lb else None
                        row = c.execute(
                            "SELECT COUNT(*), COALESCE(SUM(n_msgs), 0) FROM chunks").fetchone()
                        chunks, messages = int(row[0]), int(row[1])
                        kw_now = self.kw.build_id()
                        stale = bool(meta.get("kw_build_id") and kw_now
                                     and meta["kw_build_id"] != kw_now)
                finally:
                    c.close()
            except sqlite3.Error:
                pass
        total = int(p.get("total") or 0)
        done = min(int(p.get("done") or 0), total) if total else 0
        if building:
            state = "building"
        elif p.get("last_error"):
            state = "error"
        elif not chunks:
            state = "empty"
        else:
            state = "ready"
        return {
            "state": state,
            "phase": p.get("phase") if building else "",
            "full_rebuild": bool(p.get("full")) if building else False,
            "done": done if building else 0,
            "total": total if building else 0,
            "percent": (round(done * 100.0 / total, 1) if (building and total)
                        else (100.0 if state == "ready" else 0.0)),
            "chunks": chunks,
            "indexed_messages": messages,
            "last_built_at": last_built,
            "last_error": p.get("last_error"),
            # Keyword index rebuilt since the last pass: results stay correct
            # (locators), but new / changed messages need an incremental pass.
            "stale": stale,
        }

    # --- search ---

    def _load_candidates(self, c, where_sql: str, params: list):
        return c.execute(f"SELECT id, chat_key, ts_start, ts_end, senders, vec FROM chunks "
                         f"WHERE {where_sql}", params).fetchall()

    def _matrix(self, c):
        """(ids, matrix) for all chunks, cached in memory by generation."""
        np = _numpy()
        if np is None:
            return None
        meta = self._meta(c)
        gen = (meta.get("build_id"), meta.get("generation"))
        if self._cache is not None and self._cache[0] == gen:
            return self._cache[1], self._cache[2]
        n, dim = c.execute("SELECT COUNT(*), MAX(length(vec)) FROM chunks").fetchone()
        cap = int(os.environ.get("MURMUR_SEMANTIC_CACHE_MB") or DEFAULT_CACHE_MB) * (1 << 20)
        if not n or (n * int(dim or 0)) > cap:
            self._cache = None
            return None
        ids = []
        blobs = []
        for cid, vec in c.execute("SELECT id, vec FROM chunks ORDER BY id"):
            ids.append(cid)
            blobs.append(vec)
        mat = np.frombuffer(b"".join(blobs), dtype=np.float16).reshape(len(blobs), -1)
        id_arr = np.asarray(ids, dtype=np.int64)
        self._cache = (gen, id_arr, mat)
        return id_arr, mat

    def search(self, q: str, *, chat=None, sender=None, ts_from: Optional[int] = None,
               ts_to: Optional[int] = None, limit: int = 20, offset: int = 0,
               min_score: Optional[float] = None) -> dict:
        q = (q or "").strip()
        if not q:
            raise ValueError("q 不能为空")
        limit = max(1, min(int(limit or 20), MAX_LIMIT))
        offset = max(0, int(offset or 0))
        wheres: list = []
        params: list = []
        chats = _si._csv(chat)
        if chats:
            keys = list(chats)
            if self.kw.platform == "wechat":
                keys += [f"Msg_{hashlib.md5(x.encode()).hexdigest()}" for x in chats]
            wheres.append(f"chat_key IN ({','.join('?' * len(keys))})")
            params.extend(keys)
        if ts_from is not None:
            wheres.append("ts_end >= ?")
            params.append(int(ts_from))
        if ts_to is not None:
            wheres.append("ts_start <= ?")
            params.append(int(ts_to))
        senders = set(_si._csv(sender))
        where_sql = " AND ".join(wheres) if wheres else "1"

        scored: list = []  # (score, chunk_id)
        if self.path.exists():
            qv = self.embedder.embed_query(q)
            c = sqlite3.connect(str(self.path), timeout=10)
            try:
                try:
                    meta = self._meta(c)
                    # Old schema / other model: vectors aren't comparable —
                    # nothing to return until the index is rebuilt.
                    if (meta.get("schema_version") == str(SCHEMA_VERSION)
                            and meta.get("model_id") == self.embedder.model_id):
                        scored = self._score(c, qv, where_sql, params, senders, bool(wheres))
                except sqlite3.OperationalError as e:
                    if "no such table" not in str(e):
                        raise
            finally:
                c.close()
        if min_score is not None:
            scored = [s for s in scored if s[0] >= min_score]
        total = len(scored)
        top = heapq.nlargest(offset + limit, scored)[offset:]
        results = self._hydrate(top, q)
        return {
            "query": q,
            "terms": _si.split_terms(q),
            "mode": "semantic",
            "match": "semantic",
            "model": self.embedder.model_id,
            "total": total,
            "limit": limit,
            "offset": offset,
            "results": results,
        }

    def _score(self, c, qv, where_sql, params, senders: set, filtered: bool) -> list:
        mat = None if (filtered or senders) else self._matrix(c)
        if mat is not None:
            np = _numpy()
            ids, m = mat
            s = _matvec(np, m, qv)
            return list(zip(s.tolist(), ids.tolist()))
        rows = self._load_candidates(c, where_sql, params)
        if senders:
            rows = [r for r in rows if senders & set((r[4] or "").split("\x1f"))]
        scores = dot_scores(qv, [r[5] for r in rows])
        return [(float(s), int(r[0])) for s, r in zip(scores, rows)]

    def _hydrate(self, top: list, q: str) -> list:
        if not top:
            return []
        c = sqlite3.connect(str(self.path), timeout=10)
        try:
            meta = {r[0]: r for r in c.execute(
                f"SELECT id, chat_key, ts_start, ts_end, n_msgs, msg_locs FROM chunks "
                f"WHERE id IN ({','.join('?' * len(top))})", [cid for _, cid in top]).fetchall()}
        finally:
            c.close()
        all_locs = []
        for _, cid in top:
            if cid in meta:
                all_locs.extend(json.loads(meta[cid][5]))
        # Looked up by (src, tbl, local_id) — stable across keyword rebuilds,
        # unlike keyword row ids. Each row also carries its chat key so a
        # chunk can only ever show messages of its own chat.
        rows_by_loc: dict = {}
        if all_locs and self.kw.path.exists():
            kc = sqlite3.connect(str(self.kw.path), timeout=10)
            try:
                rows_by_loc = _rows_by_locators(
                    kc, all_locs, f"{self._KEY_SQL_M}, {_si.ROW_COLUMNS}")
            except sqlite3.OperationalError as e:
                if "no such table" not in str(e):
                    raise
            finally:
                kc.close()
        terms = _si.split_terms(q)
        qgrams = _bigrams(q)
        out = []
        for score, cid in top:
            m = meta.get(cid)
            if m is None:
                continue
            rows = []
            for loc in json.loads(m[5]):
                r = rows_by_loc.get(_loc_key(loc))
                if r is not None and r[0] == m[1]:
                    rows.append(r[1:])
            if not rows:
                continue
            formatted = self.kw.format_rows(rows)
            # Anchor = the message sharing the most character bigrams with the
            # query (first message when nothing overlaps): that's what the hit
            # "points at"; the whole chunk rides along as context.
            best = 0
            best_overlap = -1
            for k, (_, text) in enumerate(formatted):
                ov = len(qgrams & _bigrams(text))
                if ov > best_overlap:
                    best, best_overlap = k, ov
            item, text = formatted[best]
            item = dict(item)
            item.update(_si.build_snippet(text, terms))
            item["score"] = round(float(score), 4)
            item["chunk"] = {
                "id": int(cid),
                "ts_start": int(m[2]),
                "ts_end": int(m[3]),
                "message_count": len(rows),
                "anchor_index": best,
                "messages": [
                    {"sender": it["sender"], "sender_name": it["sender_name"], "ts": it["ts"],
                     "time": it["time"], "type": it["type"], "text": t,
                     "locator": it["locator"]}
                    for it, t in formatted
                ],
            }
            out.append(item)
        return out


def _locator_str(row) -> str:
    src, tbl, local_id = row
    return f"{src}|{tbl}|{int(local_id)}"


def _int(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _loc_key(loc) -> tuple:
    return (str(loc[0]), str(loc[1]), int(loc[2]))


def _rows_by_locators(kc: sqlite3.Connection, locs: Iterable, cols_sql: str) -> dict:
    """{(src, tbl, local_id): row} from the keyword index, via its UNIQUE key.

    `cols_sql` selects from `messages m`. Missing messages are simply absent.
    """
    groups: dict = {}
    for loc in locs:
        k = _loc_key(loc)
        groups.setdefault((k[0], k[1]), set()).add(k[2])
    out: dict = {}
    for (src, tbl), ids in groups.items():
        ids_l = sorted(ids)
        for i in range(0, len(ids_l), 500):
            part = ids_l[i:i + 500]
            for r in kc.execute(
                    f"SELECT m.local_id, {cols_sql} FROM messages m WHERE m.src = ? AND m.tbl = ? "
                    f"AND m.local_id IN ({','.join('?' * len(part))})", [src, tbl] + part):
                out[(src, tbl, int(r[0]))] = tuple(r[1:])
    return out


# ---------------------------------------------------------------------------
# Registry + overall status (what the HTTP layer uses)
# ---------------------------------------------------------------------------

_REGISTRY: dict = {}
_REGISTRY_LOCK = threading.Lock()


def index_path_for(kw_index) -> Path:
    return semantic_dir() / "index" / kw_index.path.name


def get_semantic_index(kw_index) -> SemanticIndex:
    path = index_path_for(kw_index)
    key = str(path)
    with _REGISTRY_LOCK:
        idx = _REGISTRY.get(key)
        if idx is None:
            idx = SemanticIndex(kw_index, path)
            _REGISTRY[key] = idx
        else:
            idx.kw = kw_index
        return idx


def availability() -> dict:
    """Install / settings / model state, independent of any account."""
    missing = missing_deps()
    settings = load_settings()
    present = model_files_present()
    dl = downloader().status()
    if missing:
        state, message = "not_installed", ("语义搜索需要额外的 Python 依赖（未安装："
                                           + "、".join(missing) + "）。安装命令：" + INSTALL_HINT)
    elif not settings["enabled"]:
        state, message = "disabled", "语义搜索默认关闭，需要在设置里手动开启。"
    elif dl["state"] == "downloading":
        state, message = "downloading", "正在下载嵌入模型…"
    elif not present:
        mb = model_size_bytes() / 1e6
        state, message = "model_missing", (f"需要下载嵌入模型 {MODEL['name']}，约 {mb:.0f} MB，"
                                           f"来源 {MODEL['repo']}。点击下载后才会联网，之后全部在本机运行。")
    else:
        state, message = "ready", ""
    return {
        "state": state,
        "message": message,
        "installed": not missing,
        "missing_deps": missing,
        "install_hint": INSTALL_HINT,
        "enabled": settings["enabled"],
        "mirror": settings["mirror"],
        "mirrors": [{"id": m["id"], "label": m["label"], "endpoint": m["endpoint"]} for m in mirrors()],
        "model": {
            "id": MODEL["id"],
            "name": MODEL["name"],
            "repo": MODEL["repo"],
            "revision": MODEL["revision"],
            "license": MODEL["license"],
            "homepage": MODEL["homepage"],
            "size_bytes": model_size_bytes(),
            "files": [{"path": f["path"], "size": f["size"], "sha256": f["sha256"]}
                      for f in MODEL["files"]],
            "downloaded": present,
            "dir": str(model_dir()),
        },
        "download": dl,
        "local_only": True,
    }


def full_status(kw_index=None) -> dict:
    st = availability()
    idx_status = None
    if kw_index is not None:
        sidx = get_semantic_index(kw_index)
        idx_status = sidx.status()
        if st["state"] == "ready":
            st["state"] = idx_status["state"]  # empty / building / ready / error
            if idx_status["state"] == "empty":
                st["message"] = "语义索引还没建立，点击「建立索引」开始（在本机后台运行）。"
            elif idx_status["state"] == "error":
                st["message"] = f"建立语义索引失败：{idx_status['last_error']}"
    st["index"] = idx_status
    return st


def ensure_usable() -> Optional[dict]:
    """None when search/build may run; otherwise the availability payload."""
    st = availability()
    return None if st["state"] == "ready" else st
