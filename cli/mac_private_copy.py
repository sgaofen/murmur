"""mac_private_copy.py — Frida-free, root-free macOS key capture.

An alternative to the Frida flow (live_key.py / hook_cc_key_frida.py) that
needs neither Frida nor root. Instead of attaching a debugger to the real
/Applications/WeChat.app, Murmur:

  1. copies WeChat.app into its own directory (~/.murmur/wechat-copy/),
     leaving the original untouched;
  2. ad-hoc re-signs the copy with get-task-allow +
     disable-library-validation + allow-dyld-environment-variables and
     without the hardened runtime, so DYLD_INSERT_LIBRARIES survives;
  3. launches the copy with Murmur's own tiny capture dylib
     (cli/native/murmur_keycap.c) injected. The copy shares WeChat's
     container, so it reuses the current login session — the user signs in
     / uses WeChat once in the copy;
  4. the dylib appends every CommonCrypto candidate (derived DB keys, and
     the PBKDF2 passphrase+params) to a private 0600 file;
  5. this module polls that file, verifies each candidate with the page-1
     HMAC check (hook_cc_key_frida.verify_candidate_key) — deriving the keys
     of every DB offline from the passphrase — and merges the verified keys
     into ~/.murmur/decrypted_keys.json via live_key.merge_keys;
  6. the copy can be deleted when done.

Everything that touches the filesystem or spawns a process is injectable so
the tests never copy or re-sign the user's real WeChat.

This is macOS-only and runs entirely as the current user. Re-signing and
injecting into a WeChat copy may be detected by Tencent (see the UI's risk
notice); Murmur only reads this machine's own data and uploads nothing.
"""
from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Optional

CLI_DIR = Path(__file__).resolve().parent

DEFAULT_SECONDS = 180
MIN_SECONDS = 30
MAX_SECONDS = 900
# Beyond --seconds: copy + re-sign + launch, and time the user spends logging
# in. The copy keeps running (it's a normal WeChat) — we just stop collecting.
WATCHDOG_GRACE = 120

PAGE_SIZE = 4096
SALT_SIZE = 16
KEY_SIZE = 32

_MERGE_LOCK = threading.Lock()


# ---------------------------------------------------------------- paths ----

def copy_root() -> Path:
    """Directory that holds Murmur's private WeChat copy."""
    return Path.home() / ".murmur" / "wechat-copy"


def copy_app_path() -> Path:
    return copy_root() / "WeChat.app"


def keycap_dylib_path() -> Optional[Path]:
    """Locate the compiled capture dylib. Built by cli/native/build_keycap.sh
    (source checkout) or bundled under _internal/native (frozen app). Returns
    None when it hasn't been built — the flow refuses to start without it."""
    candidates = []
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", CLI_DIR))
        candidates.append(base / "native" / "murmur_keycap.dylib")
        candidates.append(Path(sys.executable).resolve().parent / "_internal" / "native" / "murmur_keycap.dylib")
    candidates.append(CLI_DIR / "native" / "murmur_keycap.dylib")
    for c in candidates:
        try:
            if c.is_file():
                return c
        except OSError:
            continue
    return None


# --------------------------------------------------------- entitlements ----

def entitlements_dict() -> dict:
    """Entitlements that let the ad-hoc-signed copy load an injected dylib:
    allow the DYLD_* env vars through, skip library validation, and mark the
    task debuggable. Deliberately minimal — nothing WeChat-specific."""
    return {
        "com.apple.security.get-task-allow": True,
        "com.apple.security.cs.disable-library-validation": True,
        "com.apple.security.cs.allow-dyld-environment-variables": True,
    }


def entitlements_xml() -> bytes:
    return plistlib.dumps(entitlements_dict())


def resign_argv(app: Path, entitlements_file: Path, identity: str = "-") -> list[str]:
    """`codesign` argv to ad-hoc re-sign the copy with our entitlements. Uses
    --deep so nested frameworks/helpers are re-signed too; the hardened
    runtime flag is simply not passed, so the copy drops it."""
    return [
        "codesign", "--force", "--deep",
        "--sign", identity,
        "--entitlements", str(entitlements_file),
        str(app),
    ]


def launch_env(out_file: Path, dylib: Path, base_env: Optional[dict] = None) -> dict:
    """Environment for launching the copy with the capture dylib injected."""
    env = dict(base_env if base_env is not None else os.environ)
    env["DYLD_INSERT_LIBRARIES"] = str(dylib)
    env["MURMUR_KEYCAP_OUT"] = str(out_file)
    return env


def launch_argv(app: Path) -> list[str]:
    """argv to run the copy's main executable directly (so our env survives —
    `open` would not forward DYLD_*)."""
    macos_dir = app / "Contents" / "MacOS"
    exe = None
    for name in ("WeChat", "Weixin"):
        cand = macos_dir / name
        if cand.exists():
            exe = cand
            break
    if exe is None:
        try:
            for cand in sorted(macos_dir.iterdir()):
                if cand.is_file() and os.access(cand, os.X_OK):
                    exe = cand
                    break
        except OSError:
            pass
    if exe is None:
        raise FileNotFoundError(f"no executable in {macos_dir}")
    return [str(exe)]


# --------------------------------------------------- candidate parsing ----

def parse_candidates(text: str) -> dict:
    """Parse the dylib's append-only capture file.

    Lines are either:
      key <hexkey>
      pbkdf <prf> <rounds> <pwhex> <derivedkeyhex>
    Returns {"keys": [bytes...], "pbkdf": [{"pw", "prf", "rounds", "dk"}...]},
    de-duplicated, ignoring malformed lines (the file is written live and the
    last line may be partial)."""
    keys: list[bytes] = []
    seen_keys: set[bytes] = set()
    pbkdf: list[dict] = []
    seen_pb: set[tuple] = set()
    for raw in (text or "").splitlines():
        parts = raw.split()
        if len(parts) == 2 and parts[0] == "key":
            try:
                k = bytes.fromhex(parts[1])
            except ValueError:
                continue
            if len(k) == KEY_SIZE and k not in seen_keys:
                seen_keys.add(k)
                keys.append(k)
        elif len(parts) == 5 and parts[0] == "pbkdf":
            try:
                prf = int(parts[1])
                rounds = int(parts[2])
                pw = bytes.fromhex(parts[3])
                dk = bytes.fromhex(parts[4])
            except ValueError:
                continue
            tag = (prf, rounds, pw)
            if tag in seen_pb:
                continue
            seen_pb.add(tag)
            pbkdf.append({"pw": pw, "prf": prf, "rounds": rounds, "dk": dk})
    return {"keys": keys, "pbkdf": pbkdf}


def _verify(page1: bytes, key: bytes) -> bool:
    sys.path.insert(0, str(CLI_DIR))
    from hook_cc_key_frida import verify_candidate_key
    try:
        return verify_candidate_key(page1, key)
    except ValueError:
        return False


def derive_db_key(passphrase: bytes, page1: bytes, prf: int = 5, rounds: int = 256000) -> Optional[bytes]:
    """Derive one DB's AES key from the account passphrase (salt = page 1's
    first 16 bytes) and return it only if it HMAC-verifies. Same derivation
    as the Frida flow (#32), shared via hook_cc_key_frida."""
    sys.path.insert(0, str(CLI_DIR))
    from hook_cc_key_frida import derive_db_key as _derive
    if len(page1) != PAGE_SIZE:
        return None
    try:
        return _derive(passphrase, page1, prf, rounds)
    except (ValueError, TypeError):
        return None


def match_candidates(candidates: dict, pending: dict) -> dict:
    """Turn parsed candidates into {rel: key_hex} for the still-missing DBs
    in `pending` ({rel: page1}). A verified passphrase derives the key of
    every pending DB at once; a raw 32-byte key matches only the DB it
    belongs to."""
    found: dict[str, str] = {}
    remaining = dict(pending)
    # Passphrases first — one usually unlocks everything.
    for pb in candidates.get("pbkdf", []):
        if not remaining:
            break
        for rel, page1 in list(remaining.items()):
            key = derive_db_key(pb["pw"], page1, pb.get("prf", 5), pb.get("rounds", 256000))
            if key is not None:
                found[rel] = key.hex()
                del remaining[rel]
    # Then any raw keys CCCrypt* revealed directly.
    for k in candidates.get("keys", []):
        if not remaining:
            break
        for rel, page1 in list(remaining.items()):
            if _verify(page1, k):
                found[rel] = k.hex()
                del remaining[rel]
    return found


# ----------------------------------------------------------------- job ----

class _StartError(Exception):
    pass


class PrivateCopyJob:
    """One private-copy capture round at a time; the UI polls status().

    Mirrors live_key.LiveKeyJob: progress, cancel, timeout. All side effects
    (discover profile, collect salts, copy tree, re-sign, launch) are
    injectable for tests."""

    def __init__(self,
                 popen: Callable = subprocess.Popen,
                 run: Callable = subprocess.run,
                 copytree: Callable = shutil.copytree,
                 discover_profiles: Optional[Callable] = None,
                 collect_salts: Optional[Callable] = None,
                 find_app: Optional[Callable] = None,
                 dylib: Optional[Callable] = None,
                 keys_file: Optional[Path] = None,
                 copy_dir: Optional[Path] = None,
                 poll_interval: float = 0.5):
        self._popen = popen
        self._run = run
        self._copytree = copytree
        self._discover = discover_profiles
        self._collect = collect_salts
        self._find_app = find_app
        self._dylib = dylib or keycap_dylib_path
        self._keys_file = keys_file
        self._copy_dir = copy_dir
        self._poll = poll_interval
        self._lock = threading.Lock()
        self._proc = None
        self._cancelled = False
        self._clock = time.time
        self.state = self._idle_state()

    @staticmethod
    def _idle_state() -> dict:
        return {
            "running": False, "phase": "idle", "seconds": 0, "remaining": None,
            "total": 0, "known": 0, "matched_count": 0, "new": [],
            "passphrase_found": False, "error": None, "log": "", "round": 0,
        }

    # --- helpers -------------------------------------------------------
    def _profiles(self):
        if self._discover:
            return self._discover()
        sys.path.insert(0, str(CLI_DIR))
        import paths as _paths
        return _paths.discover_wechat_profiles()

    def _salts(self, profile):
        if self._collect:
            return self._collect(profile)
        sys.path.insert(0, str(CLI_DIR))
        from extract_key_mac import collect_db_salts
        return collect_db_salts(profile)

    def _app(self) -> Optional[Path]:
        if self._find_app:
            return self._find_app()
        sys.path.insert(0, str(CLI_DIR))
        import paths as _paths
        return _paths.find_weixin_exe()

    def _copy_root(self) -> Path:
        return self._copy_dir or copy_root()

    def _copy_app(self) -> Path:
        return self._copy_root() / "WeChat.app"

    def _kpath(self) -> Path:
        if self._keys_file:
            return self._keys_file
        sys.path.insert(0, str(CLI_DIR))
        import live_key as _live_key
        return _live_key.keys_path()

    def _load_keys(self) -> dict:
        sys.path.insert(0, str(CLI_DIR))
        import live_key as _live_key
        return _live_key.load_keys(self._kpath())

    def _split_pending(self, salt_map: dict):
        sys.path.insert(0, str(CLI_DIR))
        import live_key as _live_key
        return _live_key.split_pending(salt_map, self._load_keys())

    def _merge(self, new_keys: dict, salt_by_rel: dict, wxid):
        sys.path.insert(0, str(CLI_DIR))
        import live_key as _live_key
        with _MERGE_LOCK:
            _live_key.merge_keys(new_keys, salt_by_rel, wxid, self._kpath())

    def coverage(self) -> dict:
        profiles = self._profiles()
        if not profiles:
            return {"total": 0, "known": 0, "pending": []}
        salt_map = self._salts(profiles[0])
        pending, known = self._split_pending(salt_map)
        return {"total": len(salt_map), "known": len(known), "pending": sorted(pending)}

    def status(self) -> dict:
        with self._lock:
            st = dict(self.state, new=list(self.state["new"]))
        st["copy_exists"] = self._copy_app().exists()
        st["dylib_available"] = self._dylib() is not None
        return st

    # --- control -------------------------------------------------------
    def start(self, seconds: int = DEFAULT_SECONDS) -> dict:
        seconds = max(MIN_SECONDS, min(MAX_SECONDS, int(seconds or DEFAULT_SECONDS)))
        with self._lock:
            if self.state["running"]:
                return {"ok": True, "already_running": True}
            rnd = self.state.get("round", 0) + 1
            self.state = dict(self._idle_state(), running=True, phase="starting",
                              seconds=seconds, round=rnd)
            self._cancelled = False
        try:
            dylib = self._dylib()
            if dylib is None:
                raise _StartError("缺少捕获组件（murmur_keycap.dylib 未编译）")
            app = self._app()
            if not app:
                raise _StartError("没找到 WeChat.app（请确认微信已安装）")
            profiles = self._profiles()
            if not profiles:
                raise _StartError("未找到 WeChat 账号目录（请先在微信里登录一次）")
            prof = profiles[0]
            salt_map = self._salts(prof)
            if not salt_map:
                raise _StartError("没找到加密数据库 — 让微信完成首次同步后再试")
            pending, known = self._split_pending(salt_map)
        except Exception as e:
            msg = str(e) if isinstance(e, _StartError) else f"{type(e).__name__}: {e}"
            with self._lock:
                self.state.update(running=False, phase="error", error=msg)
            return {"ok": False, "error": msg}
        with self._lock:
            self.state.update(total=len(salt_map), known=len(known), matched_count=len(known))
        if not pending:
            with self._lock:
                self.state.update(running=False, phase="done")
            return {"ok": True, "started": False, "complete": True}
        salt_by_rel = {meta["name"]: s for s, meta in salt_map.items()}
        threading.Thread(target=self._run_job,
                         args=(app, Path(dylib), prof, pending, salt_by_rel, seconds),
                         daemon=True).start()
        return {"ok": True, "started": True}

    def cancel(self) -> dict:
        with self._lock:
            self._cancelled = True
            proc = self._proc
        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass
        return {"ok": True}

    def delete_copy(self) -> dict:
        with self._lock:
            if self.state["running"]:
                return {"ok": False, "error": "running"}
        shutil.rmtree(self._copy_root(), ignore_errors=True)
        return {"ok": True, "deleted": not self._copy_app().exists()}

    # --- worker --------------------------------------------------------
    def _set(self, **kw):
        with self._lock:
            self.state.update(kw)

    def _prepare_copy(self, app: Path) -> Path:
        """Copy WeChat.app into our dir and ad-hoc re-sign the copy. The
        original app is never touched."""
        root = self._copy_root()
        dst = self._copy_app()
        shutil.rmtree(root, ignore_errors=True)
        root.mkdir(parents=True, exist_ok=True)
        self._copytree(str(app), str(dst), symlinks=True)
        ent = root / "entitlements.plist"
        ent.write_bytes(entitlements_xml())
        r = self._run(resign_argv(dst, ent), capture_output=True, text=True,
                      encoding="utf-8", errors="replace", timeout=300)
        if getattr(r, "returncode", 1) != 0:
            raise _StartError(f"重签名失败：{(getattr(r, 'stderr', '') or getattr(r, 'stdout', '') or '').strip()[:400]}")
        return dst

    def _collect_loop(self, out_file: Path, pending: dict, salt_by_rel: dict,
                      wxid, seconds: int):
        """Poll the dylib's capture file, verify + merge newly matched keys,
        until everything is matched, time runs out, or cancelled."""
        deadline = self._clock() + seconds
        found: dict[str, str] = {}
        remaining = dict(pending)
        passphrase_found = False
        while True:
            now = self._clock()
            self._set(remaining=max(0, int(round(deadline - now))))
            try:
                text = out_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = ""
            cands = parse_candidates(text)
            if cands.get("pbkdf"):
                passphrase_found = True
            newly = match_candidates(cands, remaining)
            if newly:
                found.update(newly)
                for rel in newly:
                    remaining.pop(rel, None)
                self._merge(newly, salt_by_rel, wxid)
                self._set(new=sorted(found.keys()),
                          matched_count=self.state["known"] + len(found),
                          passphrase_found=passphrase_found)
            with self._lock:
                cancelled = self._cancelled
            if not remaining or cancelled or now >= deadline:
                break
            time.sleep(self._poll)
        return found, passphrase_found

    def _run_job(self, app: Path, dylib: Path, prof, pending: dict,
                 salt_by_rel: dict, seconds: int):
        log = ""
        out_file = self._copy_root() / "candidates.txt"
        try:
            self._set(phase="copying")
            copy_app = self._prepare_copy(app)
            with self._lock:
                if self._cancelled:
                    raise _StartError("已取消")
            # Fresh, empty 0600 capture file.
            self._copy_root().mkdir(parents=True, exist_ok=True)
            try:
                out_file.unlink()
            except OSError:
                pass
            fd = os.open(str(out_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.close(fd)

            self._set(phase="launching")
            env = launch_env(out_file, dylib)
            proc = self._popen(launch_argv(copy_app), env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with self._lock:
                self._proc = proc

            self._set(phase="capturing")
            wxid = getattr(prof, "wxid", None)
            found, passphrase_found = self._collect_loop(out_file, pending, salt_by_rel, wxid, seconds)

            with self._lock:
                cancelled = self._cancelled
            error = None
            if not found and not cancelled:
                error = "no-keys"
            self._set(running=False, phase="done" if error is None else "error",
                      error=error, new=sorted(found.keys()),
                      matched_count=self.state["known"] + len(found),
                      passphrase_found=passphrase_found, remaining=0, log=log[-4000:])
        except Exception as e:
            msg = str(e) if isinstance(e, _StartError) else f"{type(e).__name__}: {e}"
            self._set(running=False, phase="error", error=msg, log=log[-4000:])
        finally:
            with self._lock:
                proc = self._proc
                self._proc = None
            # Leave the copy running only if it captured nothing yet? No — the
            # user explicitly deletes it later. But stop OUR launched process
            # when cancelled so we don't leave a zombie copy around.
            if proc is not None:
                with self._lock:
                    cancelled = self._cancelled
                if cancelled:
                    try:
                        proc.terminate()
                    except Exception:
                        pass
