"""live_sync.py — opt-in background "实时同步" for WeChat.

Polls the encrypted db_storage every few seconds and, for every database
whose (.db, -wal) signature changed, runs the exact same per-DB pipeline as a
manual refresh (refresh.process_db: snapshot db+wal+shm → decrypt → WAL merge
→ atomic swap). After a sync that changed something it calls `on_synced`
so etcli can drop its in-memory / on-disk analysis caches.

Design notes
- Off by default. State lives in ~/.murmur/config.json under "live_sync":
  {"enabled": bool, "interval": seconds}.
- Interval clamps to [MIN_INTERVAL, MAX_INTERVAL]; default 3 s. Peers poll
  at 30 ms (328336690/wechat-decrypt) but Murmur re-decrypts whole DB files,
  so a few seconds keeps CPU/disk use sane.
- `DECRYPT_LOCK` serialises live sync against the manual /api/refresh
  (which spawns refresh.py as a subprocess). A tick never waits on it: if a
  manual refresh holds it, the tick is skipped.
- Only WeChat. QQ NT databases use a different cipher/pipeline (qq_decrypt).
- Imports nothing third-party; `cryptography` is only touched lazily by
  refresh.decrypt when an actual decrypt runs.
"""
from __future__ import annotations

import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import refresh as _refresh  # noqa: E402
from decrypt_cache import DecryptCache, db_signature  # noqa: E402

DECRYPT_LOCK = threading.Lock()

CONFIG_KEY = "live_sync"
DEFAULT_INTERVAL = 3.0
MIN_INTERVAL = 2.0
MAX_INTERVAL = 60.0

_MSG_DB_RE = re.compile(r"^message_\d+\.db$")


def clamp_interval(value, default: float = DEFAULT_INTERVAL) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(MIN_INTERVAL, min(MAX_INTERVAL, v))


def message_marks(db_path: Path) -> Dict[str, int]:
    """max(rowid) per Msg_* table of a *decrypted* message_N.db.

    WeChat 4.x message tables use an INTEGER PRIMARY KEY (local_id), so
    max(rowid) is an O(log n) lookup — cheap enough to run before and after
    every sync to count newly arrived messages.
    """
    if not db_path.exists():
        return {}
    marks: Dict[str, int] = {}
    try:
        conn = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    except sqlite3.Error:
        return {}
    try:
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg\\_%' ESCAPE '\\'")]
        for t in tables:
            try:
                row = conn.execute(f'SELECT max(rowid) FROM "{t}"').fetchone()
                marks[t] = int(row[0] or 0)
            except sqlite3.Error:
                continue
    except sqlite3.Error:
        pass
    finally:
        conn.close()
    return marks


def count_new_messages(before: Dict[str, int], after: Dict[str, int]) -> int:
    return sum(max(0, n - before.get(t, 0)) for t, n in after.items())


def _rel(src: Path, root: Path) -> str:
    try:
        return str(src.relative_to(root)).replace("\\", "/")
    except ValueError:
        return src.name


class LiveSync:
    """Background poller. One instance per etcli process.

    All collaborators are injectable so tests can run on plain SQLite files
    without touching ~/.murmur or real keys:
      profile_resolver() -> WeChatProfile | None   (the account to sync)
      on_synced(list_of_db_names)                  (cache-invalidation hook)
      plan_fn(profile) -> refresh.KeyPlan | None
      dst_dir_fn(profile) -> Path                  (decrypted dir)
      config_load() -> dict / config_save(dict)
    """

    def __init__(self, *, profile_resolver: Callable[[], object],
                 on_synced: Optional[Callable[[List[str]], None]] = None,
                 plan_fn: Optional[Callable] = None,
                 dst_dir_fn: Optional[Callable] = None,
                 config_load: Optional[Callable[[], dict]] = None,
                 config_save: Optional[Callable[[dict], None]] = None,
                 lock: Optional[threading.Lock] = None,
                 log: Optional[Callable[[str], None]] = None) -> None:
        if config_load is None or config_save is None:
            from paths import load_config, save_config
            config_load = config_load or load_config
            config_save = config_save or save_config
        if dst_dir_fn is None:
            from paths import decrypted_root_for
            dst_dir_fn = decrypted_root_for
        self._resolve_profile = profile_resolver
        self._on_synced = on_synced
        self._plan_fn = plan_fn or _refresh.resolve_key_plan
        self._dst_dir_fn = dst_dir_fn
        self._config_load = config_load
        self._config_save = config_save
        self._lock = lock or DECRYPT_LOCK
        self._log = log or (lambda msg: sys.stderr.write(msg + "\n"))

        self._state = threading.Lock()
        self.enabled = False
        self.interval = DEFAULT_INTERVAL
        self._thread: Optional[threading.Thread] = None
        self._stop: Optional[threading.Event] = None
        self._syncing = False
        self._lib = None
        self._lib_loaded = False
        # rel path -> db_signature last seen/handled. Survives across ticks
        # only (not persisted): on restart the DecryptCache is the baseline.
        self._sigs: Dict[str, tuple] = {}
        self._account: Optional[str] = None

        self.last_check_ts: Optional[float] = None
        self.last_sync_ts: Optional[float] = None
        self.last_new_messages = 0
        self.last_synced_dbs: List[str] = []
        self.last_duration_ms: Optional[int] = None
        self.last_error: Optional[str] = None
        self.total_new_messages = 0
        self.sync_count = 0

    # ---------- config ----------

    def load_config(self) -> None:
        try:
            cfg = self._config_load() or {}
        except Exception:
            cfg = {}
        ls = cfg.get(CONFIG_KEY) or {}
        if not isinstance(ls, dict):
            ls = {}
        self.enabled = bool(ls.get("enabled", False))
        self.interval = clamp_interval(ls.get("interval", DEFAULT_INTERVAL))

    def _persist(self) -> None:
        try:
            cfg = self._config_load() or {}
            cfg[CONFIG_KEY] = {"enabled": self.enabled, "interval": self.interval}
            self._config_save(cfg)
        except Exception as e:
            self._log(f"[live-sync] could not persist config: {e}")

    def configure(self, *, enabled: Optional[bool] = None,
                  interval=None, persist: bool = True) -> dict:
        with self._state:
            if interval is not None:
                self.interval = clamp_interval(interval, self.interval)
            if enabled is not None:
                self.enabled = bool(enabled)
        if persist:
            self._persist()
        if self.enabled:
            self.start()
        else:
            self.stop()
        return self.status()

    # ---------- thread ----------

    def start(self) -> None:
        """Start the poller if enabled and not already running."""
        with self._state:
            if not self.enabled:
                return
            if self._thread is not None and self._thread.is_alive() \
                    and self._stop is not None and not self._stop.is_set():
                return
            stop = threading.Event()
            t = threading.Thread(target=self._run, args=(stop,),
                                 name="murmur-live-sync", daemon=True)
            self._stop = stop
            self._thread = t
        t.start()

    def stop(self) -> None:
        # Don't join: a tick may be mid-decrypt of a large DB. The thread
        # exits as soon as that tick ends.
        with self._state:
            if self._stop is not None:
                self._stop.set()

    def _run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.tick()
            except (Exception, SystemExit) as e:  # never let the thread die
                with self._state:
                    self.last_error = f"{type(e).__name__}: {e}"
                self._log(f"[live-sync] tick crashed: {type(e).__name__}: {e}")
            if stop.wait(self.interval):
                break

    @property
    def running(self) -> bool:
        t = self._thread
        return bool(t is not None and t.is_alive() and self._stop is not None
                    and not self._stop.is_set())

    # ---------- one poll ----------

    def _get_lib(self):
        if not self._lib_loaded:
            self._lib_loaded = True
            try:
                self._lib = _refresh.load_dll()
            except Exception as e:
                self._log(f"[live-sync] go_decrypt.dll unavailable, using pure Python: {e}")
                self._lib = None
        return self._lib

    def tick(self) -> dict:
        """Check every encrypted DB once; sync the changed ones. Returns a
        small report dict (also handy for tests)."""
        with self._state:
            self.last_check_ts = time.time()
        profile = self._resolve_profile()
        if profile is None:
            with self._state:
                self.last_error = "还没有已解密的微信账号，先点「更新数据」完成一次解密"
            return {"skipped": "no_profile"}
        plan = self._plan_fn(profile)
        if plan is None or (plan.mode == "global" and len(plan.key_hex or "") != 64):
            with self._state:
                self.last_error = "找不到可用的微信解密密钥"
            return {"skipped": "no_key"}
        if not self._lock.acquire(blocking=False):
            # Manual refresh (or another sync) in flight — try next tick.
            return {"skipped": "busy"}
        try:
            with self._state:
                self._syncing = True
            return self._sync_locked(profile, plan)
        finally:
            with self._state:
                self._syncing = False
            self._lock.release()

    def _sync_locked(self, profile, plan) -> dict:
        t0 = time.time()
        src_root = Path(profile.encrypted_root)
        account = getattr(profile, "wxid", None) or str(src_root)
        if account != self._account:
            # Switched WeChat account: signatures of the old one are meaningless.
            self._sigs = {}
            self._account = account
        dst_dir = Path(self._dst_dir_fn(profile))
        dst_dir.mkdir(parents=True, exist_ok=True)
        if plan.mode == "per_db":
            fp = _refresh.per_db_fingerprint(plan.per_db or {})
            pre_derived, lib = True, None
        else:
            fp = (plan.key_hex or "").encode("utf-8")
            pre_derived, lib = False, self._get_lib()
        cache = DecryptCache(dst_dir, fp, src_root=src_root)

        changed = []
        for src in _refresh.list_source_dbs(src_root):
            rel = _rel(src, src_root)
            # Per-DB mode: the key is part of the state. decrypted_keys.json is
            # re-read every tick and grows as live key capture finds more DBs,
            # so a DB whose key just appeared (or changed) gets synced even if
            # its file did not change.
            if plan.mode == "per_db":
                key_hex = _refresh.key_for_db(src, src_root, plan.per_db or {})
                tag = _refresh.key_tag(key_hex) if key_hex else None
            else:
                key_hex, tag = plan.key_hex, None
            state = (db_signature(src), tag)
            prev = self._sigs.get(rel)
            if prev == state:
                continue
            if prev is None and key_hex and cache.is_fresh(src, tag):
                # First sight after start: the decrypted copy already matches.
                self._sigs[rel] = state
                continue
            changed.append((src, rel, state, key_hex, tag))

        if not changed:
            with self._state:
                self.last_error = None
            return {"changed": [], "synced": [], "new_messages": 0, "errors": []}

        synced: List[str] = []
        errors: List[str] = []
        new_msgs = 0
        staging = Path(tempfile.mkdtemp(prefix="murmur_live_"))
        try:
            for src, rel, state, key_hex, tag in changed:
                if not key_hex:
                    # macOS: no WCDB key captured for this DB yet. Don't retry
                    # every tick; wait until the file or the key set changes.
                    self._sigs[rel] = state
                    continue
                dst_f = dst_dir / src.name
                before = message_marks(dst_f) if (_MSG_DB_RE.match(src.name) and dst_f.exists()) else None
                res = _refresh.process_db(src, dst_dir=dst_dir, staging=staging,
                                          key_hex=key_hex, pre_derived=pre_derived, lib=lib)
                if res.ok:
                    synced.append(src.name)
                    if res.signature is not None:
                        cache.mark_done(src, res.signature, key_tag=tag)
                        self._sigs[rel] = (res.signature, tag)
                    else:
                        # WeChat kept writing during the snapshot: leave it
                        # unmarked so the next tick picks it up again.
                        cache.forget(src)
                        self._sigs.pop(rel, None)
                    if before is not None:
                        new_msgs += count_new_messages(before, message_marks(dst_f))
                elif res.swap_failed:
                    # Typically a Windows reader lock on the decrypted file —
                    # transient, retry next tick.
                    errors.append(f"{src.name}: {res.error}")
                    cache.forget(src)
                    self._sigs.pop(rel, None)
                else:
                    errors.append(f"{src.name}: {_refresh.friendly_error(res.error or '')}")
                    cache.forget(src)
                    self._sigs[rel] = state  # retry once the source/key changes again
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            try:
                cache.save()
            except Exception:
                pass

        dt_ms = int((time.time() - t0) * 1000)
        with self._state:
            self.last_duration_ms = dt_ms
            self.last_error = "; ".join(errors)[:400] if errors else None
            if synced:
                self.last_sync_ts = time.time()
                self.last_new_messages = new_msgs
                self.last_synced_dbs = list(synced)
                self.total_new_messages += new_msgs
                self.sync_count += 1
        if synced:
            self._log(f"[live-sync] synced {', '.join(synced)} (+{new_msgs} msgs, {dt_ms} ms)")
            if self._on_synced is not None:
                try:
                    self._on_synced(list(synced))
                except Exception as e:
                    self._log(f"[live-sync] cache invalidation failed: {e}")
        if errors:
            self._log(f"[live-sync] errors: {'; '.join(errors)[:400]}")
        return {"changed": [c[0].name for c in changed], "synced": synced,
                "new_messages": new_msgs, "errors": errors}

    # ---------- status ----------

    def status(self) -> dict:
        with self._state:
            return {
                "enabled": self.enabled,
                "interval": self.interval,
                "min_interval": MIN_INTERVAL,
                "max_interval": MAX_INTERVAL,
                "running": self.running,
                "syncing": self._syncing,
                "last_check_ts": self.last_check_ts,
                "last_sync_ts": self.last_sync_ts,
                "last_new_messages": self.last_new_messages,
                "last_synced_dbs": list(self.last_synced_dbs),
                "last_duration_ms": self.last_duration_ms,
                "last_error": self.last_error,
                "total_new_messages": self.total_new_messages,
                "sync_count": self.sync_count,
                "platforms": ["wechat"],
            }
