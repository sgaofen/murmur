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
     (cli/native/murmur_keycap.c) injected, after making sure the original
     WeChat is not running (see "Data directory" below); the user signs in /
     uses WeChat once in the copy;
  4. the dylib appends every CommonCrypto candidate (derived DB keys, and
     the PBKDF2 passphrase+params) to a private 0600 file;
  5. this module polls that file, verifies each candidate with the page-1
     HMAC check (hook_cc_key_frida.verify_candidate_key) — deriving the keys
     of every DB offline from the passphrase — and merges the verified keys
     into ~/.murmur/decrypted_keys.json via live_key.merge_keys;
  6. every round ends by stopping the copy (SIGTERM, then SIGKILL, for every
     process running out of the copy dir) and deleting candidates.txt; the
     copy itself can be deleted when done.

Data directory (UNVERIFIED on a real Mac — must be confirmed before merge):
the original WeChat 4.x is sandboxed (com.apple.security.app-sandbox) and
keeps its data in ~/Library/Containers/com.tencent.xinWeChat/Data/
Documents/xwechat_files. The re-signed copy has no app-sandbox entitlement,
so macOS gives it no container: NSHomeDirectory() is the real home. Static
strings in WeChat 4.1.15's wechat.dylib ("Library/Containers", "Data/
Documents", "Data/Library/Application Support" next to their non-"Data/"
twins) suggest WeChat rebuilds the container path itself when unsandboxed —
i.e. the copy would open the SAME xwechat_files (possibly behind a macOS 14+
"access data from other apps" prompt, since the signature differs). If it
falls back to ~/Documents/xwechat_files instead, the copy needs a fresh login
and creates a second data set. Either way, two WeChats writing the same
SQLCipher DBs concurrently must never happen, so start() refuses while the
original is running.

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
import signal
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
# in. When a round ends (done / timeout / cancel / error) the copy is always
# stopped: while alive, its injected dylib keeps appending every key and the
# account passphrase to candidates.txt in plaintext.
WATCHDOG_GRACE = 120
# How long to wait after SIGTERM before SIGKILL, and after SIGKILL before
# giving up on a process.
STOP_TIMEOUT = 3.0

_SIGTERM = signal.SIGTERM
# Windows has no SIGKILL; this module is macOS-only but must import anywhere.
_SIGKILL = getattr(signal, "SIGKILL", signal.SIGTERM)

ERR_COPY_RUNNING = "copy-running"
ERR_ORIGINAL_RUNNING = "original-running"

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


# ------------------------------------------------------------ processes ----

def list_processes(run: Callable = subprocess.run) -> list[tuple[int, str]]:
    """[(pid, full command line)] for every process on the machine, via
    `ps`. Best effort: returns [] when ps is unavailable or fails."""
    try:
        r = run(["ps", "-axww", "-o", "pid=,command="], capture_output=True,
                text=True, encoding="utf-8", errors="replace", timeout=10)
    except Exception:
        return []
    if getattr(r, "returncode", 1) != 0:
        return []
    out: list[tuple[int, str]] = []
    for line in (getattr(r, "stdout", "") or "").splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        out.append((pid, parts[1]))
    return out


def _runs_from(cmd: str, root: Path) -> bool:
    """True when command line `cmd` executes a binary inside directory `root`
    (prefix match on a path boundary, so `WeChat.app.bak` != `WeChat.app`)."""
    prefix = str(root).rstrip("/\\")
    if not cmd.startswith(prefix):
        return False
    rest = cmd[len(prefix):]
    return rest[:1] in ("/", "\\")


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
                 poll_interval: float = 0.5,
                 list_procs: Optional[Callable] = None,
                 kill: Callable = os.kill,
                 stop_timeout: float = STOP_TIMEOUT):
        self._list_procs = list_procs or (lambda: list_processes(self._run))
        self._kill = kill
        self._stop_timeout = stop_timeout
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

    # --- processes -----------------------------------------------------
    def _procs(self) -> list:
        try:
            return list(self._list_procs() or [])
        except Exception:
            return []

    def copy_pids(self) -> list[int]:
        """PIDs of every process running out of the copy dir (the copy's main
        process and any helper it spawned) — including copies left over from
        an earlier Murmur session that we no longer hold a handle to."""
        root = self._copy_root()
        me = os.getpid()
        return [pid for pid, cmd in self._procs()
                if pid != me and _runs_from(cmd, root)]

    def original_pids(self, app: Optional[Path]) -> list[int]:
        """PIDs of processes running out of the ORIGINAL WeChat.app."""
        if not app:
            return []
        app = Path(app)
        root = self._copy_root()
        return [pid for pid, cmd in self._procs()
                if _runs_from(cmd, app) and not _runs_from(cmd, root)]

    def _pid_alive(self, pid: int) -> bool:
        return pid in {p for p, _ in self._procs()}

    def _signal_and_wait(self, pids: list, sig) -> list:
        """Send `sig` to `pids`, wait up to stop_timeout, return survivors."""
        for pid in pids:
            try:
                self._kill(pid, sig)
            except (ProcessLookupError, PermissionError, OSError):
                pass
        end = time.time() + self._stop_timeout
        alive = list(pids)
        while True:
            current = set(self.copy_pids())
            alive = [p for p in alive if p in current]
            if not alive or time.time() >= end:
                return alive
            time.sleep(min(0.05, self._stop_timeout))

    def _stop_proc(self, proc) -> None:
        """terminate() then kill() the Popen handle we launched."""
        if proc is None:
            return
        try:
            if proc.poll() is not None:
                return
        except Exception:
            pass
        for step in ("terminate", "kill"):
            try:
                getattr(proc, step)()
            except Exception:
                pass
            try:
                proc.wait(timeout=self._stop_timeout)
                return
            except subprocess.TimeoutExpired:
                continue
            except Exception:
                return

    def stop_copy(self) -> list[int]:
        """Stop our launched process and every other process running out of
        the copy dir: SIGTERM, then SIGKILL. Returns the PIDs still alive."""
        with self._lock:
            proc = self._proc
            self._proc = None
        self._stop_proc(proc)
        pids = self.copy_pids()
        if not pids:
            return []
        alive = self._signal_and_wait(pids, _SIGTERM)
        if alive:
            alive = self._signal_and_wait(alive, _SIGKILL)
        return alive

    def _scrub_candidates(self) -> None:
        """Delete the plaintext capture file (keys + passphrase)."""
        out_file = self._copy_root() / "candidates.txt"
        try:
            if out_file.is_file() and not out_file.is_symlink():
                with open(out_file, "r+b") as f:
                    size = f.seek(0, os.SEEK_END)
                    f.seek(0)
                    f.write(b"\0" * size)
        except OSError:
            pass
        try:
            out_file.unlink()
        except OSError:
            pass

    # --- control -------------------------------------------------------
    def _fail_start(self, msg: str, code: Optional[str] = None) -> dict:
        with self._lock:
            self.state.update(running=False, phase="error", error=msg)
        out = {"ok": False, "error": msg}
        if code:
            out["code"] = code
        return out

    def start(self, seconds: int = DEFAULT_SECONDS) -> dict:
        seconds = max(MIN_SECONDS, min(MAX_SECONDS, int(seconds or DEFAULT_SECONDS)))
        with self._lock:
            if self.state["running"]:
                return {"ok": True, "already_running": True}
            rnd = self.state.get("round", 0) + 1
            self.state = dict(self._idle_state(), running=True, phase="starting",
                              seconds=seconds, round=rnd)
            self._cancelled = False
        # A copy from an earlier round / Murmur session may still be running
        # (and still dumping keys). Stop it before anything gets rmtree'd.
        leftover = self.stop_copy()
        self._scrub_candidates()
        if leftover:
            return self._fail_start(
                "上一轮的微信副本还在运行且无法自动结束（pid "
                + ", ".join(str(p) for p in leftover)
                + "），请先在程序坞里退出它再试",
                ERR_COPY_RUNNING)
        try:
            dylib = self._dylib()
            if dylib is None:
                raise _StartError("缺少捕获组件（murmur_keycap.dylib 未编译）")
            app = self._app()
            if not app:
                raise _StartError("没找到 WeChat.app（请确认微信已安装）")
            # The unsandboxed copy may open the very same xwechat_files as the
            # original (unverified, see module docstring): never let both run.
            if self.original_pids(Path(app)):
                return self._fail_start(
                    "请先完全退出微信（菜单栏 微信 → 退出微信）再开始：副本可能和原版共用同一份聊天数据，"
                    "两个同时运行会同时写同一个数据库",
                    ERR_ORIGINAL_RUNNING)
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
        # Only flag it: the worker's collect loop notices within one poll and
        # its finally-block stops the copy (terminate → kill, helpers too).
        with self._lock:
            self._cancelled = True
        return {"ok": True}

    def delete_copy(self) -> dict:
        with self._lock:
            if self.state["running"]:
                return {"ok": False, "error": "running"}
        alive = self.stop_copy()
        self._scrub_candidates()
        if alive:
            # Never rmtree an app that is still executing.
            return {"ok": False, "error": ERR_COPY_RUNNING, "pids": alive}
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
        # start() already stopped any running copy; re-check right before the
        # rmtree in case one was relaunched in between.
        if self.copy_pids() and self.stop_copy():
            raise _StartError("微信副本还在运行，无法覆盖，请先退出副本再试")
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

            if self.original_pids(app):
                raise _StartError("请先完全退出微信（菜单栏 微信 → 退出微信）再开始：副本可能和原版共用同一份聊天数据")
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
            self._set(phase="done" if error is None else "error",
                      error=error, new=sorted(found.keys()),
                      matched_count=self.state["known"] + len(found),
                      passphrase_found=passphrase_found, remaining=0, log=log[-4000:])
        except Exception as e:
            msg = str(e) if isinstance(e, _StartError) else f"{type(e).__name__}: {e}"
            self._set(phase="error", error=msg, log=log[-4000:])
        finally:
            # Always stop the copy (done, timeout, cancel or error): while it
            # runs, the injected dylib keeps appending keys + passphrase to
            # candidates.txt. Then scrub that file.
            alive = []
            try:
                alive = self.stop_copy()
            except Exception:
                pass
            self._scrub_candidates()
            if alive:
                with self._lock:
                    self.state["log"] = (self.state.get("log") or "") + (
                        "\n微信副本未能自动结束（pid %s），请手动退出它。"
                        % ", ".join(str(p) for p in alive)).strip()
            with self._lock:
                self.state["running"] = False
