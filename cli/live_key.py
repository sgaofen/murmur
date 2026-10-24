"""live_key.py — backend orchestration for macOS live key capture (Frida).

WeChat 4.1.9+ no longer keeps its SQLCipher keys resident in memory, so
extract_key_mac.py's memory scan often finds nothing. hook_cc_key_frida.py
instead hooks CommonCrypto inside WeChat and catches each DB key the moment
WeChat uses it. This module runs that script on behalf of the web UI
(`/api/live-key/*` in etcli.py):

  * collects page 1 of every encrypted DB *as the user* (root is blocked by
    TCC from ~/Library/Containers) and skips DBs whose key we already have;
  * runs the capture as the user first, and only if Frida can't attach
    re-runs it as root through the macOS password prompt (osascript);
  * polls the script's progress file so the UI can show a countdown and the
    number of matched DBs;
  * merges the newly found keys into ~/.murmur/decrypted_keys.json (never
    overwriting keys found earlier — several rounds accumulate);
  * can pip-install frida for source checkouts.

Everything that touches processes is injectable so tests can run without
Frida or WeChat.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable, Optional

CLI_DIR = Path(__file__).resolve().parent
FRIDA_REQ = "frida>=17.0"
DEFAULT_SECONDS = 90
MIN_SECONDS = 15
MAX_SECONDS = 600

EXIT_ATTACH_DENIED = 5
EXIT_NO_FRIDA = 6


def parse_version(v: Optional[str]) -> tuple:
    out = []
    for part in str(v or "").split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        if not digits:
            break
        out.append(int(digits))
    return tuple(out)


def version_needs_live_capture(v: Optional[str]) -> bool:
    """WeChat for Mac 4.1.9+ stopped keeping DB keys resident in memory, so
    the memory scan usually finds nothing there."""
    pv = parse_version(v)
    return bool(pv) and pv >= (4, 1, 9)


def keys_path() -> Path:
    return Path.home() / ".murmur" / "decrypted_keys.json"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


# ---------------------------------------------------------------- frida ----

def frida_location() -> Optional[str]:
    """Directory that contains the `frida` package (to put on root's
    PYTHONPATH — `pip install --user` lands in the user's site dir, which a
    root interpreter doesn't look at)."""
    try:
        spec = importlib.util.find_spec("frida")
    except (ImportError, ValueError):
        return None
    if spec is None:
        return None
    locs = list(spec.submodule_search_locations or [])
    if locs:
        return str(Path(locs[0]).parent)
    if spec.origin:
        return str(Path(spec.origin).parent)
    return None


def frida_status() -> dict:
    installed = frida_location() is not None
    version = None
    if installed:
        try:
            from importlib import metadata
            version = metadata.version("frida")
        except Exception:
            version = None
    return {
        "installed": installed,
        "version": version,
        # A packaged app can't pip-install into its own bundle; frida has to
        # ship inside it (see etcli.spec) or the user falls back to the CLI.
        "installable": not is_frozen(),
        "frozen": is_frozen(),
    }


class FridaInstaller:
    """Background `pip install frida` for source checkouts."""

    def __init__(self, runner: Callable = subprocess.run):
        self._runner = runner
        self._lock = threading.Lock()
        self.state = {"running": False, "ok": None, "log": ""}

    def pip_argv(self) -> list[str]:
        argv = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check"]
        in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
        if not in_venv:
            argv.append("--user")
        argv.append(FRIDA_REQ)
        return argv

    def start(self) -> dict:
        if is_frozen():
            return {"ok": False, "error": "打包版 App 不能在线安装 Frida，请用命令行方式（见提示）。"}
        with self._lock:
            if self.state["running"]:
                return {"ok": True, "already_running": True}
            self.state = {"running": True, "ok": None, "log": ""}
        threading.Thread(target=self._run, daemon=True).start()
        return {"ok": True, "started": True}

    def _run(self):
        try:
            r = self._runner(self.pip_argv(), capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=900)
            out = (r.stdout or "") + (r.stderr or "")
            ok = r.returncode == 0
        except Exception as e:  # pip missing, timeout, …
            out, ok = f"{type(e).__name__}: {e}", False
        importlib.invalidate_caches()
        if ok and frida_location() is None:
            # Installed to a user site dir this interpreter didn't have on
            # sys.path yet (first ever --user install).
            import site
            try:
                user_site = site.getusersitepackages()
                if user_site and user_site not in sys.path:
                    site.addsitedir(user_site)
                    importlib.invalidate_caches()
            except Exception:
                pass
        with self._lock:
            self.state = {"running": False, "ok": ok, "log": out[-4000:]}


# ------------------------------------------------------------ DB pages ----

def _verify(page1: bytes, key_hex: str) -> bool:
    sys.path.insert(0, str(CLI_DIR))
    from decrypt_py import verify_candidate_key
    try:
        return verify_candidate_key(page1, bytes.fromhex(key_hex))
    except ValueError:
        return False


def load_keys(path: Optional[Path] = None) -> dict:
    path = path or keys_path()
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def split_pending(salt_map: dict, existing: dict) -> tuple[dict, dict]:
    """Split collect_db_salts() output into (pending pages, known keys).

    salt_map: {salt_hex: {"name": rel, "page1": bytes}}. A DB counts as known
    only if a stored key still verifies against its current page 1 (WeChat
    re-keys DBs after a reinstall / account switch)."""
    by_db = existing.get("keys_by_db") or {}
    by_salt = existing.get("keys_by_salt") or {}
    pending: dict[str, bytes] = {}
    known: dict[str, str] = {}
    for salt_hex, meta in salt_map.items():
        rel, page1 = meta["name"], meta["page1"]
        cand = by_db.get(rel) or by_salt.get(salt_hex)
        if cand and _verify(page1, cand):
            known[rel] = cand
        else:
            pending[rel] = page1
    return pending, known


def merge_keys(new_keys: dict, salt_by_rel: dict, wxid: Optional[str],
               path: Optional[Path] = None) -> dict:
    """Merge {rel: key_hex} into decrypted_keys.json without dropping
    anything found before. Returns the merged payload."""
    path = path or keys_path()
    cur = load_keys(path)
    by_db = dict(cur.get("keys_by_db") or {})
    by_salt = dict(cur.get("keys_by_salt") or {})
    for rel, key_hex in new_keys.items():
        by_db[rel] = key_hex
        salt = salt_by_rel.get(rel)
        if salt:
            by_salt[salt] = key_hex
    payload = {
        "wxid": wxid or cur.get("wxid"),
        "extracted_at": int(time.time()),
        "keys_by_db": by_db,
        "keys_by_salt": by_salt,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return payload


# ----------------------------------------------------------------- job ----

def _runner_argv(tmp_dir: Path, *args: str) -> list[str]:
    """argv for hook_cc_key_frida — frozen etcli subcommand, or a copy of the
    script in /tmp (root Python may be denied the repo path by TCC)."""
    if is_frozen():
        return [sys.executable, "hook-cc-key-frida", *args]
    dst = tmp_dir / "hook_cc_key_frida.py"
    shutil.copy2(CLI_DIR / "hook_cc_key_frida.py", dst)
    try:
        dst.chmod(0o644)
    except OSError:
        pass
    return [sys.executable, "-u", str(dst), *args]


def _elevated_cmd(argv: list[str], pythonpath: Optional[str]) -> list[str]:
    inner = " ".join(shlex.quote(a) for a in argv)
    if pythonpath:
        inner = f"/usr/bin/env PYTHONPATH={shlex.quote(pythonpath)} {inner}"
    inner_as = inner.replace("\\", "\\\\").replace('"', '\\"')
    return ["osascript", "-e", f'do shell script "{inner_as}" with administrator privileges']


class LiveKeyJob:
    """One live-capture round at a time; the UI polls status()."""

    def __init__(self, popen: Callable = subprocess.Popen,
                 discover_profiles: Optional[Callable] = None,
                 collect_salts: Optional[Callable] = None,
                 keys_file: Optional[Path] = None,
                 poll_interval: float = 0.5):
        self._popen = popen
        self._discover = discover_profiles
        self._collect = collect_salts
        self._keys_file = keys_file
        self._poll = poll_interval
        self._lock = threading.Lock()
        self._proc = None
        self._stop_file: Optional[Path] = None
        self._cancelled = False
        self.state = self._idle_state()

    @staticmethod
    def _idle_state() -> dict:
        return {
            "running": False, "phase": "idle", "seconds": 0, "remaining": None,
            "total": 0, "known": 0, "matched_count": 0, "new": [], "hits": 0,
            "elevated": False, "error": None, "log": "", "round": 0,
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

    def _kpath(self) -> Path:
        return self._keys_file or keys_path()

    def coverage(self) -> dict:
        """How many of the current profile's DBs already have a working key."""
        profiles = self._profiles()
        if not profiles:
            return {"total": 0, "known": 0, "pending": []}
        salt_map = self._salts(profiles[0])
        pending, known = split_pending(salt_map, load_keys(self._kpath()))
        return {"total": len(salt_map), "known": len(known), "pending": sorted(pending)}

    def status(self) -> dict:
        with self._lock:
            return dict(self.state, new=list(self.state["new"]))

    # --- control -------------------------------------------------------
    def start(self, seconds: int = DEFAULT_SECONDS) -> dict:
        seconds = max(MIN_SECONDS, min(MAX_SECONDS, int(seconds or DEFAULT_SECONDS)))
        with self._lock:
            if self.state["running"]:
                return {"ok": True, "already_running": True}
        profiles = self._profiles()
        if not profiles:
            return {"ok": False, "error": "未找到 WeChat 账号目录（请先在微信里登录一次）"}
        prof = profiles[0]
        salt_map = self._salts(prof)
        if not salt_map:
            return {"ok": False, "error": "没找到加密数据库 — 让微信完成首次同步后再试"}
        pending, known = split_pending(salt_map, load_keys(self._kpath()))
        with self._lock:
            rnd = self.state.get("round", 0) + 1
            self.state = dict(self._idle_state(), running=True, phase="starting",
                              seconds=seconds, total=len(salt_map), known=len(known),
                              matched_count=len(known), round=rnd)
            self._cancelled = False
        if not pending:
            with self._lock:
                self.state.update(running=False, phase="done")
            return {"ok": True, "started": False, "complete": True}
        salt_by_rel = {meta["name"]: s for s, meta in salt_map.items()}
        threading.Thread(target=self._run, args=(prof, pending, salt_by_rel, seconds),
                         daemon=True).start()
        return {"ok": True, "started": True}

    def cancel(self) -> dict:
        with self._lock:
            self._cancelled = True
            stop, proc = self._stop_file, self._proc
            phase = self.state["phase"]
        if stop is not None:
            try:
                stop.write_text("stop", encoding="utf-8")
            except OSError:
                pass
        # While waiting for the password dialog there is nothing to stop
        # gracefully; kill osascript (the dialog goes away with it).
        if proc is not None and phase in ("auth", "starting", "attaching"):
            try:
                proc.kill()
            except Exception:
                pass
        return {"ok": True}

    # --- worker --------------------------------------------------------
    def _set(self, **kw):
        with self._lock:
            self.state.update(kw)

    def _read_progress(self, path: Path, known: int):
        try:
            p = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        new = list(p.get("new") or [])
        upd = {
            "remaining": p.get("remaining"),
            "hits": p.get("hits", 0),
            "new": new,
            "matched_count": known + len(new),
        }
        ph = p.get("phase")
        if ph in ("attaching", "capturing"):
            upd["phase"] = ph
        self._set(**upd)

    def _run_once(self, argv: list[str], progress: Path, known: int,
                  elevated: bool, pythonpath: Optional[str]) -> tuple[int, str]:
        cmd = _elevated_cmd(argv, pythonpath) if elevated else argv
        env = None
        if not elevated and pythonpath:
            env = dict(os.environ)
            env["PYTHONPATH"] = pythonpath + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        self._set(phase="auth" if elevated else "attaching", elevated=elevated)
        proc = self._popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           text=True, encoding="utf-8", errors="replace", env=env)
        with self._lock:
            self._proc = proc
        out_chunks: list[str] = []
        reader = threading.Thread(target=lambda: out_chunks.append(proc.stdout.read() if proc.stdout else ""),
                                  daemon=True)
        reader.start()
        while proc.poll() is None:
            self._read_progress(progress, known)
            time.sleep(self._poll)
        reader.join(timeout=2)
        self._read_progress(progress, known)
        with self._lock:
            self._proc = None
        return proc.returncode, "".join(out_chunks)

    def _run(self, prof, pending: dict, salt_by_rel: dict, seconds: int):
        tmp_dir = Path(tempfile.mkdtemp(prefix="murmur_live_key_"))
        try:
            os.chmod(tmp_dir, 0o755)
        except OSError:
            pass
        pages = tmp_dir / "pages.json"
        out_keys = tmp_dir / "new_keys.json"
        progress = tmp_dir / "progress.json"
        stop = tmp_dir / "stop"
        with self._lock:
            self._stop_file = stop
            known = self.state["known"]
        log = ""
        try:
            pages.write_text(json.dumps({
                "__wxid__": getattr(prof, "wxid", None),
                "pages": {rel: p1.hex() for rel, p1 in pending.items()},
            }), encoding="utf-8")
            pages.chmod(0o644)
            argv = _runner_argv(tmp_dir, "--seconds", str(seconds), "--pages", str(pages),
                                "--out-keys", str(out_keys), "--progress", str(progress),
                                "--stop-file", str(stop))
            pythonpath = None if is_frozen() else frida_location()
            rc, log = self._run_once(argv, progress, known, False, pythonpath)
            if rc == EXIT_ATTACH_DENIED and not self._cancelled:
                rc, out2 = self._run_once(argv, progress, known, True, pythonpath)
                log += "\n--- 以管理员身份重试 ---\n" + out2
            new = {}
            try:
                new = (json.loads(out_keys.read_text(encoding="utf-8")).get("keys_by_db") or {})
            except (OSError, ValueError):
                pass
            # Only trust keys for DBs we asked about.
            new = {rel: k for rel, k in new.items() if rel in pending}
            if new:
                merge_keys(new, salt_by_rel, getattr(prof, "wxid", None), self._kpath())
            error = None
            if rc == EXIT_NO_FRIDA:
                error = "frida-missing"
            elif rc == EXIT_ATTACH_DENIED:
                error = "attach-denied"
            elif rc not in (0, None) and not self._cancelled:
                error = "auth-cancelled" if "-128" in log else f"exit-{rc}"
            self._set(running=False, phase="done" if error is None else "error",
                      error=error, new=sorted(new.keys()), matched_count=known + len(new),
                      remaining=0, log=log[-4000:])
        except Exception as e:
            self._set(running=False, phase="error", error=f"{type(e).__name__}: {e}",
                      log=log[-4000:])
        finally:
            with self._lock:
                self._stop_file = None
            shutil.rmtree(tmp_dir, ignore_errors=True)
