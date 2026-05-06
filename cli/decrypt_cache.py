"""decrypt_cache.py — mtime-based incremental decrypt cache.

灵感来自 huohuoer/wechat-cli (`wechat_cli/core/db_cache.py`)。当用户的 db_storage 体积达到
GB 级时，每次 refresh 全量重解密会消耗几十秒到几分钟。这个模块按 (.db mtime, .db-wal mtime)
做缓存命中判断，绝大多数文件可以原样跳过；只有真正变动了的 DB 才进入解密管线。

缓存文件存放在解密目录里，文件名 `_decrypt_mtimes.json`，结构：

    {
        "key_hash": "<hash of decrypt key>",   # key 变了就整体作废
        "version":  1,
        "entries":  {
            "<src_relative_path>": {
                "db_mtime":  1714712345.0,
                "wal_mtime": 1714712399.0,
                "size":      52428800,
                "decrypted_at": 1714712400
            }
        }
    }

「key 变了整体作废」靠 key_hash —— 用 key_bytes 的 sha256 前 16 字节做指纹（不存原始 key）。
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Optional


_CACHE_FILENAME = "_decrypt_mtimes.json"
_CACHE_VERSION = 1


def _key_fingerprint(key_bytes: bytes) -> str:
    """First 16 hex chars of SHA-256(key) — enough to detect key changes without
    storing anything sensitive in the cache file."""
    return hashlib.sha256(key_bytes).hexdigest()[:16]


def _safe_mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0


def _safe_size(p: Path) -> int:
    try:
        return p.stat().st_size
    except OSError:
        return 0


class DecryptCache:
    """Per-account decrypt skip cache.

    Usage::

        cache = DecryptCache(dst_dir, key_bytes)
        for src in src_dbs:
            if cache.is_fresh(src):
                continue
            # ... do decrypt + swap ...
            cache.mark_done(src)
        cache.save()

    Cache is *advisory* — `is_fresh` only returns True if all of:
      - cache file exists and version matches
      - key fingerprint matches the current key
      - the source file's (mtime, wal mtime, size) all match the recorded values
      - the corresponding decrypted output still exists on disk

    Any one of these failing makes is_fresh return False (force re-decrypt).
    """

    def __init__(self, dst_dir: Path, key_bytes: bytes, *, src_root: Optional[Path] = None) -> None:
        self.dst_dir = dst_dir
        self.src_root = src_root  # used to compute relative paths (stable across moves)
        self.key_fp = _key_fingerprint(key_bytes)
        self.path = dst_dir / _CACHE_FILENAME
        self._loaded: dict = {"version": _CACHE_VERSION, "key_hash": self.key_fp, "entries": {}}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            # Corrupt cache: pretend it's empty rather than crashing the user.
            return
        # Schema mismatch / key change — drop the whole cache.
        if data.get("version") != _CACHE_VERSION or data.get("key_hash") != self.key_fp:
            return
        if isinstance(data.get("entries"), dict):
            self._loaded["entries"] = data["entries"]

    def _rel_key(self, src: Path) -> str:
        if self.src_root is not None:
            try:
                return str(src.relative_to(self.src_root)).replace("\\", "/")
            except ValueError:
                pass
        return src.name

    def is_fresh(self, src: Path) -> bool:
        """Whether `src` is unchanged since the last successful decrypt."""
        rel = self._rel_key(src)
        entry = self._loaded["entries"].get(rel)
        if not entry:
            return False
        wal = src.with_suffix(src.suffix + "-wal")
        cur_db_mtime = _safe_mtime(src)
        cur_wal_mtime = _safe_mtime(wal)
        cur_size = _safe_size(src)
        if (entry.get("db_mtime") != cur_db_mtime
                or entry.get("wal_mtime") != cur_wal_mtime
                or entry.get("size") != cur_size):
            return False
        # Output must still exist or the cache lied — the user might have
        # nuked the dst_dir manually.
        dst = self.dst_dir / src.name
        if not dst.exists():
            return False
        return True

    def mark_done(self, src: Path) -> None:
        """Record that `src` was successfully decrypted with the current key."""
        rel = self._rel_key(src)
        wal = src.with_suffix(src.suffix + "-wal")
        self._loaded["entries"][rel] = {
            "db_mtime": _safe_mtime(src),
            "wal_mtime": _safe_mtime(wal),
            "size": _safe_size(src),
            "decrypted_at": int(time.time()),
        }

    def forget(self, src: Path) -> None:
        rel = self._rel_key(src)
        self._loaded["entries"].pop(rel, None)

    def save(self) -> None:
        self.dst_dir.mkdir(parents=True, exist_ok=True)
        # Always rewrite the key_hash + version in case load() saw a mismatch
        # and reset entries to empty.
        payload = {
            "version": _CACHE_VERSION,
            "key_hash": self.key_fp,
            "entries": self._loaded["entries"],
        }
        # Write atomically so a crash mid-write doesn't corrupt the index.
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError:
            # Cache is best-effort; failure to persist isn't fatal.
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

    def stats(self) -> dict:
        return {"entries": len(self._loaded["entries"])}
