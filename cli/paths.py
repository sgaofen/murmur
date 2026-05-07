"""paths.py — 平台无关的微信目录发现 + Murmur 自身目录管理。

支持：
- Windows: D:/Documents/xwechat_files, ~/Documents/xwechat_files, ~/OneDrive/Documents/...
- macOS:   ~/Library/Containers/com.tencent.xinWeChat/Data/...
- Linux:   (微信不原生支持，跳过)

Murmur 自己的产物（解密 db、媒体、配置）放：
- Windows: ~/Documents/Murmur/   (跨盘安全)
- macOS/Linux: ~/Documents/Murmur/
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


IS_WINDOWS = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")


def murmur_home() -> Path:
    """User-writable directory for Murmur's own data (decrypted DBs, media, config)."""
    base = Path.home() / "Documents" / "Murmur"
    base.mkdir(parents=True, exist_ok=True)
    return base


def murmur_config_path() -> Path:
    """Persistent config (saved keys, user prefs)."""
    cfg_dir = Path.home() / ".murmur"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    return cfg_dir / "config.json"


def load_config() -> dict:
    p = murmur_config_path()
    if not p.exists():
        return {}
    try:
        # utf-8-sig strips BOM if present — PowerShell 5.1's
        # Set-Content -Encoding UTF8 writes a BOM by default, which makes
        # plain utf-8 json.loads silently return {} and refresh.py decide
        # there's no decrypt_key. utf-8-sig handles both BOM-prefixed and
        # plain UTF-8 files transparently.
        return json.loads(p.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


def save_config(cfg: dict) -> None:
    p = murmur_config_path()
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------- WeChat data discovery ----------

@dataclass
class WeChatProfile:
    """One WeChat account on this machine."""
    wxid: str                # wxid_xxx (long form, with suffix)
    wxid_short: str          # without suffix (used as decrypted-dir name)
    encrypted_root: Path     # path to db_storage/ root (the encrypted source)
    cache_root: Path         # the parent xwechat_files/<wxid>/ dir
    platform: str            # "windows" | "macos"


def _dedupe_paths(paths: list[Path]) -> list[Path]:
    out: list[Path] = []
    seen: set[str] = set()
    for p in paths:
        key = os.path.normcase(str(p.expanduser()))
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def _windows_drive_roots() -> list[Path]:
    """Existing Windows drive roots. Falls back to C:..Z: if WinAPI is unavailable."""
    roots: list[Path] = []
    if IS_WINDOWS:
        try:
            import ctypes
            mask = int(ctypes.windll.kernel32.GetLogicalDrives())
            for idx in range(26):
                if mask & (1 << idx):
                    roots.append(Path(f"{chr(ord('A') + idx)}:/"))
        except Exception:
            pass
    if not roots:
        roots = [Path(f"{letter}:/") for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ"]
    return roots


def _windows_xwechat_variants(base: Path, *, include_base: bool = True) -> list[Path]:
    """Expand a user/registry/drive base into plausible WeChat data roots."""
    name = base.name.lower()
    variants = [base] if include_base else []
    if name not in {"xwechat_files", "wechat files"}:
        variants.extend([
            base / "xwechat_files",
            base / "Documents" / "xwechat_files",
            base / "WeChat Files",
            base / "Documents" / "WeChat Files",
            # Some Windows installs save under a Tencent wrapper directory, e.g.
            # E:\Tencent\Weixin\xwechat_files or ~/Documents/Tencent/WeChat/...
            base / "Tencent" / "xwechat_files",
            base / "Tencent" / "Weixin" / "xwechat_files",
            base / "Tencent" / "WeChat" / "xwechat_files",
            base / "Tencent" / "WeChat Files",
            base / "Tencent Files" / "xwechat_files",
            base / "Documents" / "Tencent" / "xwechat_files",
            base / "Documents" / "Tencent" / "Weixin" / "xwechat_files",
            base / "Documents" / "Tencent" / "WeChat" / "xwechat_files",
            base / "Documents" / "Tencent Files" / "xwechat_files",
        ])
    return variants


def _windows_tencent_nested_xwechat_paths() -> list[Path]:
    """Shallow scan Tencent wrapper folders for xwechat_files.

    Users often move WeChat storage to a custom directory whose visible parent
    is just "Tencent" or "Tencent Files"; the actual xwechat_files folder can
    sit one level below a product/account folder. Keep this bounded so startup
    never walks a whole drive.
    """
    if not IS_WINDOWS:
        return []
    home = Path.home()
    seeds: list[Path] = []
    for base in [
        home,
        home / "Documents",
        home / "OneDrive" / "Documents",
        home / "OneDrive - Personal" / "Documents",
        *_windows_drive_roots(),
    ]:
        seeds.extend([
            base / "Tencent",
            base / "Tencent Files",
            base / "Weixin",
            base / "WeChat",
        ])

    out: list[Path] = []
    for seed in _dedupe_paths(seeds):
        try:
            if not seed.exists():
                continue
        except (PermissionError, OSError):
            continue
        out.extend(_windows_xwechat_variants(seed, include_base=False))
        entries = _safe_listdir(seed, timeout_s=0.4)
        if not entries:
            continue
        for child in entries[:80]:
            try:
                if not child.is_dir():
                    continue
            except (PermissionError, OSError):
                continue
            out.extend(_windows_xwechat_variants(child, include_base=False))
    return out


def _windows_anyname_parent_xwechat_paths() -> list[Path]:
    """Catch-all for users with WeChat data under a non-English parent folder
    name (e.g. `D:\\我的微信\\xwechat_files`, `C:\\Users\\YY\\资料\\xwechat_files`).

    The hard-coded seed list in `_windows_tencent_nested_xwechat_paths` only
    covers `Tencent / Tencent Files / Weixin / WeChat`, so a user who moved
    their data to a Chinese-named parent silently dropped out of auto-discovery
    (issue #1 follow-up from `jwc19890114`).

    Strategy: list every direct child of `home`, `home/Documents`, OneDrive
    Documents, and each drive root. For each child that's a directory, single
    `stat()` to check whether `child/xwechat_files` exists. Skip the noisy
    system folders so we don't burn 100ms on `C:/Windows`.

    Bounded so startup stays snappy: each base's child enumeration goes through
    `_safe_listdir` (0.6s timeout, drops network drives / TCC-blocked dirs),
    capped at 200 entries per base. Total cost on a typical Win10 box: ~150ms.
    """
    if not IS_WINDOWS:
        return []
    home = Path.home()
    bases = _dedupe_paths([
        home,
        home / "Documents",
        home / "OneDrive" / "Documents",
        home / "OneDrive - Personal" / "Documents",
        *_windows_drive_roots(),
    ])
    skip_low = {
        "windows", "program files", "program files (x86)",
        "programdata", "system volume information",
        "recovery", "perflogs", "$recycle.bin",
        "appdata", "msocache", "intel", "amd",
    }
    out: list[Path] = []
    for base in bases:
        try:
            if not base.exists():
                continue
        except (PermissionError, OSError):
            continue
        entries = _safe_listdir(base, timeout_s=0.6)
        if not entries:
            continue
        for child in entries[:200]:
            try:
                if not child.is_dir():
                    continue
                low = child.name.lower()
                if low.startswith("$") or low in skip_low:
                    continue
                xwf = child / "xwechat_files"
                if xwf.exists() and xwf.is_dir():
                    out.append(xwf)
            except (PermissionError, OSError):
                continue
    return _dedupe_paths(out)


def _windows_everything_cli_candidates() -> list[Path]:
    """Best-effort Everything ES locations.

    Everything itself is fast because it indexes filesystem metadata instead of
    walking directories. The optional ES command-line helper lets us reuse that
    index when a user already has it installed, without making Murmur depend on
    Everything or reading NTFS internals ourselves.
    """
    if not IS_WINDOWS:
        return []
    out: list[Path] = []
    for name in ("es.exe", "es"):
        found = shutil.which(name)
        if found:
            out.append(Path(found))
    for env in ("ProgramFiles", "ProgramFiles(x86)", "LocalAppData"):
        base = os.environ.get(env)
        if not base:
            continue
        out.extend([
            Path(base) / "Everything" / "es.exe",
            Path(base) / "voidtools" / "Everything" / "es.exe",
            Path(base) / "Programs" / "Everything" / "es.exe",
        ])
    return _dedupe_paths(out)


def _run_everything_es(es_path: Path, search: str, *, timeout_s: float = 1.8) -> list[Path]:
    """Query Everything's optional ES CLI and return path-like output lines."""
    try:
        if not es_path.exists():
            return []
    except (PermissionError, OSError):
        return []
    flags = 0
    if IS_WINDOWS:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = None
    # Newer ES builds support forcing UTF-8 console output. Fall back to the
    # oldest common syntax if an older build rejects -cp.
    for args in (["-cp", "65001", "-n", "120", search], ["-n", "120", search]):
        try:
            proc = subprocess.run(
                [str(es_path), *args],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_s,
                creationflags=flags,
            )
        except (OSError, subprocess.TimeoutExpired):
            return []
        # Return code 8 means the Everything search client is not running.
        # Treat it as "not available" and fall back to our normal bounded scan.
        if proc.returncode in (0, 1):
            break
        proc = None
    if proc is None:
        return []
    out: list[Path] = []
    for raw in proc.stdout.splitlines():
        line = raw.strip().strip('"')
        if not line or line.lower().startswith("filename,"):
            continue
        p = Path(line)
        # ES can emit relative-looking text if a user has custom columns saved;
        # only trust absolute Windows paths here.
        if len(str(p)) >= 3 and str(p)[1:3] in (":\\", ":/"):
            out.append(p)
    return _dedupe_paths(out)


def _windows_everything_xwechat_search_paths() -> list[Path]:
    """Use Everything/ES if present to find moved WeChat data instantly."""
    if not IS_WINDOWS:
        return []
    out: list[Path] = []
    for es_path in _windows_everything_cli_candidates()[:4]:
        # Search both the data root name and the account marker directory. Some
        # users paste/share screenshots where only db_storage is visible.
        for p in _run_everything_es(es_path, "xwechat_files"):
            if p.name.lower() == "xwechat_files":
                out.append(p)
        for p in _run_everything_es(es_path, "db_storage"):
            parent = p.parent
            if parent.name.startswith("wxid_"):
                out.append(parent)
                out.append(parent.parent)
        if out:
            break
    return _dedupe_paths(out)


def _windows_registry_xwechat_search_paths() -> list[Path]:
    """Read WeChat's saved data directory hints from the registry when present."""
    if not IS_WINDOWS:
        return []
    out: list[Path] = []
    try:
        import winreg
        keys = [
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\Weixin"),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\WeChat"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\Weixin"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\WeChat"),
        ]
        value_names = (
            "FileSavePath",
            "DataSavePath",
            "PersonalDataPath",
            "UserDataPath",
            "SavePath",
        )
        for hive, subkey in keys:
            try:
                with winreg.OpenKey(hive, subkey) as k:
                    for value_name in value_names:
                        try:
                            value, _ = winreg.QueryValueEx(k, value_name)
                        except OSError:
                            continue
                        if not isinstance(value, str) or not value.strip():
                            continue
                        base = Path(os.path.expandvars(value.strip().strip('"')))
                        out.extend(_windows_xwechat_variants(base))
            except OSError:
                continue
    except ImportError:
        pass
    return out


def _windows_xwechat_search_paths() -> list[Path]:
    """Common locations for xwechat_files on Windows.

    WeChat 4.x often stores data directly at a drive root, e.g.
    E:/xwechat_files, while older guides tend to mention
    D:/Documents/xwechat_files. Cover both so first-run diagnosis does not
    falsely say the user has never logged in.
    """
    paths: list[Path] = []
    home = Path.home()
    paths.extend(_windows_registry_xwechat_search_paths())
    paths.extend(_windows_everything_xwechat_search_paths())
    for root in _windows_drive_roots():
        paths.extend(_windows_xwechat_variants(root, include_base=False))
    paths.extend(_windows_xwechat_variants(home, include_base=False))
    paths.extend(_windows_xwechat_variants(home / "Documents", include_base=False))
    paths.extend(_windows_tencent_nested_xwechat_paths())
    paths.extend(_windows_anyname_parent_xwechat_paths())
    paths += [
        home / "Documents" / "xwechat_files",
        home / "OneDrive" / "Documents" / "xwechat_files",
        home / "OneDrive - Personal" / "Documents" / "xwechat_files",
    ]
    return _dedupe_paths(paths)


def _mac_xwechat_search_paths() -> list[Path]:
    """Common locations for Mac WeChat 4.x data."""
    home = Path.home()
    container = home / "Library" / "Containers"
    paths = []
    # Mac WeChat 4.x ("Weixin") container ID
    for cid in ["com.tencent.xinWeChat", "com.tencent.WeChat", "com.tencent.Weixin"]:
        app_support = container / cid / "Data" / "Library" / "Application Support" / cid
        paths.append(app_support)
        # WeChat 4.0.5+ often stores accounts under a version directory like
        # .../Application Support/com.tencent.xinWeChat/2.0b4.0.9/<account>/.
        try:
            if app_support.is_dir():
                for entry in app_support.iterdir():
                    if not entry.is_dir():
                        continue
                    name = entry.name
                    if re.match(r"^\d+\.\d+b\d+\.\d+", name) or re.match(r"^\d+\.\d+\.\d+", name):
                        paths.append(entry)
        except (PermissionError, OSError):
            pass
        for subroot in [
            container / cid / "Data" / "Documents" / "xwechat_files",
        ]:
            paths.append(subroot)
    # Also check Documents fallback (some users redirect)
    paths.append(home / "Documents" / "xwechat_files")
    return paths


_IGNORED_WECHAT_ACCOUNT_DIRS = {
    "xwechat_files",
    "wechat files",
    "all_users",
    "backup",
    "old_backup",
    "app_data",
    "applet",
    "wmpf",
}


def _looks_like_account_dir(p: Path) -> bool:
    try:
        if not p.is_dir():
            return False
    except (PermissionError, OSError):
        return False
    name = p.name.lower()
    if name in _IGNORED_WECHAT_ACCOUNT_DIRS or name.startswith("all"):
        return False
    try:
        return (p / "db_storage").is_dir()
    except (PermissionError, OSError):
        return False


def _is_wxid_dir(p: Path) -> bool:
    return _looks_like_account_dir(p)


def _wechat_account_short(name: str) -> str:
    """Normalize account directory names while preserving real wxid values."""
    raw = str(name or "").strip()
    if not raw:
        return raw
    if raw.lower().startswith("wxid_"):
        # wxid_xxx_abcd stores media under a suffixed account directory, but the
        # stable account id is the first wxid_* segment.
        m = re.match(r"^(wxid_[^_]+)", raw, flags=re.IGNORECASE)
        return m.group(1) if m else raw
    # Non-wxid Mac account dirs have also been observed with a 4-char suffix.
    m = re.match(r"^(.+)_([0-9a-zA-Z]{4})$", raw)
    return m.group(1) if m else raw


def _normalize_user_root(p: Path) -> Path:
    """
    Best-effort canonicalisation of a user-pasted path.

    Users copy WeChat data paths from many places (Win Explorer, "open folder"
    button, error messages, etc.) and rarely give the exact level Murmur wants.
    Accept any of these forms and return a candidate root that
    `discover_wechat_profiles` will recognise:

        ─ ends with a file (e.g. `…/db_storage/session/session.db`)
            → walk up until a wxid_* ancestor or stop at filesystem root
        ─ ends with `db_storage`
            → return parent (= the wxid_* dir)
        ─ ends with `wxid_xxx`
            → return as-is
        ─ ends with `xwechat_files`
            → return as-is (caller will list children for wxid_*)
        ─ ends inside any wxid_* subtree
            → return the wxid_* ancestor
        ─ is a parent dir that contains an `xwechat_files` child
            → return that `xwechat_files`

    The returned Path is NOT required to exist (we don't validate here). The
    caller's discover_wechat_profiles will skip dead paths gracefully. This is
    purely about *intent* normalisation — guess what the user meant.
    """
    try:
        # If the path points at a file, peel files off until we hit a directory.
        # Don't follow symlinks aggressively — just resolve once for cleanup.
        if p.exists() and not p.is_dir():
            p = p.parent
    except (OSError, PermissionError):
        # If we can't stat (e.g. permission), trust the string as-is.
        pass

    # 1) Walk UP: find the nearest wxid_* ancestor whose direct child is `db_storage`.
    #    This catches `…/wxid_xxx/db_storage`, `…/wxid_xxx/db_storage/session`,
    #    `…/wxid_xxx/db_storage/session/session.db`, etc.
    cur = p
    for _ in range(8):  # depth budget — don't ascend past 8 levels
        try:
            if _looks_like_account_dir(cur):
                return cur
        except (OSError, PermissionError):
            pass
        if cur.parent == cur:  # filesystem root
            break
        cur = cur.parent

    # 2) Walk DOWN: if the path itself contains an `xwechat_files` subdir, prefer that.
    #    Catches users pasting `D:\Tencent\Weixin` (the parent of xwechat_files).
    try:
        if p.is_dir():
            xwf = p / "xwechat_files"
            if xwf.is_dir():
                return xwf
    except (OSError, PermissionError):
        pass

    # 3) If the leaf is `db_storage` regardless of ancestor matching, walk up one level
    #    (covers the case where a non-wxid_* ancestor — e.g. the wxid was already
    #    truncated — and we still want to recover the wxid level).
    if p.name.lower() == "db_storage":
        return p.parent

    # 4) Default: trust the user. Returns the path as given.
    return p


def _wechat_root_env_paths() -> list[Path]:
    """Optional override for users with non-standard WeChat data locations.

    MURMUR_WECHAT_ROOT may point at an xwechat_files directory or directly at a
    wxid_*/ account directory. Multiple roots are separated by os.pathsep.
    """
    raw = os.environ.get("MURMUR_WECHAT_ROOT", "").strip()
    if not raw:
        return []
    out: list[Path] = []
    for part in raw.split(os.pathsep):
        part = part.strip().strip('"')
        if not part:
            continue
        # Normalize so users can set MURMUR_WECHAT_ROOT to any level — including
        # the common mistake of pointing at `…/db_storage` directly.
        p = Path(os.path.expandvars(os.path.expanduser(part)))
        out.append(_normalize_user_root(p))
    return out


def _wechat_root_config_paths() -> list[Path]:
    """User-saved WeChat data roots from Murmur's UI.

    Unlike MURMUR_WECHAT_ROOT, this works for non-technical users because the
    onboarding screen can save the path into ~/.murmur/config.json.
    """
    cfg = load_config()
    raw = cfg.get("wechat_roots", [])
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    out: list[Path] = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            continue
        p = Path(os.path.expandvars(os.path.expanduser(item.strip().strip('"'))))
        # Normalize legacy / user-pasted entries on read too — covers the case
        # where save_wechat_root from a previous version stored an unnormalized
        # `…/db_storage` style path. Then expand to xwechat_files variants.
        p = _normalize_user_root(p)
        if IS_WINDOWS:
            out.extend(_windows_xwechat_variants(p))
        else:
            out.append(p)
    return _dedupe_paths(out)


def wechat_search_paths() -> list[Path]:
    """All candidate WeChat data roots Murmur will inspect."""
    env_candidates = _wechat_root_env_paths()
    config_candidates = _wechat_root_config_paths()
    if env_candidates and os.environ.get("MURMUR_WECHAT_ROOT_ONLY", "").strip().lower() in {"1", "true", "yes"}:
        # ROOT_ONLY is mainly for testing/support: do not scan default system
        # locations, but still honor paths saved from the UI in this session.
        # Otherwise a user could paste the correct path and still be trapped by
        # a stale environment override.
        return _dedupe_paths(env_candidates + config_candidates)
    raw_candidates = env_candidates + config_candidates + (
        _windows_xwechat_search_paths() if IS_WINDOWS
        else _mac_xwechat_search_paths() if IS_MAC
        else []
    )
    return _dedupe_paths(raw_candidates)


_SCAN_STATE: dict = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "drives_total": 0,
    "drives_done": 0,
    "current_path": "",
    "dirs_scanned": 0,
    "found": [],            # list of {path, kind: 'xwechat_files' | 'wxid'}
    "error": None,
    "cancelled": False,
}
_SCAN_LOCK = None  # lazy


def get_scan_state() -> dict:
    """Snapshot the current background scan progress (safe to read concurrently)."""
    return {
        "running": _SCAN_STATE["running"],
        "started_at": _SCAN_STATE["started_at"],
        "finished_at": _SCAN_STATE["finished_at"],
        "drives_total": _SCAN_STATE["drives_total"],
        "drives_done": _SCAN_STATE["drives_done"],
        "current_path": _SCAN_STATE["current_path"],
        "dirs_scanned": _SCAN_STATE["dirs_scanned"],
        "found": list(_SCAN_STATE["found"]),
        "error": _SCAN_STATE["error"],
        "cancelled": _SCAN_STATE["cancelled"],
    }


def cancel_scan() -> None:
    _SCAN_STATE["cancelled"] = True


# Top-level dirs that are guaranteed not to host WeChat data and would
# otherwise burn lots of time. Exact match (case-insensitive). Note that we
# DON'T blindly skip "AppData" — WeChat 4.x has shipped builds that store data
# in `%LOCALAPPDATA%\Tencent\xwechat`, so we keep that branch alive.
def _xwechat_has_account(xwf: Path) -> bool:
    """Quick test: does this `xwechat_files` candidate actually contain a
    usable account/db_storage somewhere in the next 1-2 levels?

    Without this, the scan reports any directory that happens to be NAMED
    `xwechat_files` — including empty leftover dirs from earlier moves /
    uninstalls (e.g. `D:\\Documents\\xwechat_files\\` after the user moved
    their data to a new disk). Those would clutter the candidate list and
    make the user hesitate. Cheap because we only listdir 1-2 dirs.
    """
    try:
        with os.scandir(xwf) as it:
            for entry in it:
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    entry_path = Path(entry.path)
                    if _looks_like_account_dir(entry_path):
                        return True
                    # Handle the WeChat 4.x double-nested layout
                    # (xwechat_files/xwechat_files/<account>/...).
                    if entry.name.lower() in {"xwechat_files", "wechat files"}:
                        try:
                            with os.scandir(entry.path) as inner:
                                for sub in inner:
                                    try:
                                        if (sub.is_dir(follow_symlinks=False)
                                                and _looks_like_account_dir(Path(sub.path))):
                                            return True
                                    except OSError:
                                        continue
                        except (PermissionError, OSError):
                            continue
                    # Older Windows layouts can still use strict wxid_* names
                    # without passing the broader account-dir heuristics yet.
                    if entry.name.startswith("wxid_"):
                        if (entry_path / "db_storage").exists():
                            return True
                        continue
                except OSError:
                    continue
    except (PermissionError, OSError, FileNotFoundError):
        return False
    return False


_SCAN_SKIP_NAMES = {
    "$recycle.bin",
    "system volume information",
    "windows",
    "winsxs",
    "windowsapps",
    "program files",
    "program files (x86)",
    "programdata",
    "msocache",
    "perflogs",
    "boot",
    "recovery",
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".idea",
    ".vscode",
    "target",        # Rust build output
    "build",
    "dist",
    "out",
    "cache",
    "caches",
    "tmp",
    "temp",
    "logs",
}


def scan_for_wechat_data_async(
    *,
    drives: list[Path] | None = None,
    max_depth: int = 8,
    on_progress: callable | None = None,
) -> None:
    """Run a non-admin file-name walk to find xwechat_files / wxid_* roots.

    Updates `_SCAN_STATE` in-place. Designed to be called from a background
    thread by the HTTP endpoint. NOT instant like Everything (which reads NTFS
    MFT raw with admin), but with aggressive pruning typically 10–60s.

    Found targets:
      - any directory named `xwechat_files` (case-insensitive)
      - any directory named `wxid_*` whose direct child `db_storage` exists

    Skips: known-junk top-level dirs (Windows, Program Files, $Recycle.Bin),
    common dev junk (node_modules, .git), cache dirs. Hidden + system attrs
    on Win prune any dir below the candidate roots.
    """
    if not IS_WINDOWS:
        # Linux / Mac branch is left for a separate implementation; the bug
        # the user is hitting is Windows-only.
        _SCAN_STATE["error"] = "scan_for_wechat_data is Windows-only"
        return

    drives = drives or _windows_drive_roots()
    _SCAN_STATE.update({
        "running": True,
        "started_at": int(__import__("time").time()),
        "finished_at": None,
        "drives_total": len(drives),
        "drives_done": 0,
        "current_path": "",
        "dirs_scanned": 0,
        "found": [],
        "error": None,
        "cancelled": False,
    })

    def _maybe_progress():
        if on_progress is not None:
            try:
                on_progress(get_scan_state())
            except Exception:
                pass

    def _walk(start: Path, depth_left: int) -> None:
        if _SCAN_STATE["cancelled"]:
            return
        try:
            with os.scandir(start) as it:
                children = list(it)
        except (PermissionError, OSError, FileNotFoundError):
            return
        _SCAN_STATE["dirs_scanned"] += 1
        if _SCAN_STATE["dirs_scanned"] % 50 == 0:
            _SCAN_STATE["current_path"] = str(start)
            _maybe_progress()

        for entry in children:
            if _SCAN_STATE["cancelled"]:
                return
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            name = entry.name
            name_l = name.lower()
            # Match before pruning so xwechat_files isn't accidentally skipped.
            if name_l in {"xwechat_files", "wechat files"}:
                # Only report this candidate if it actually has a usable
                # account/db_storage somewhere inside (1–2 levels deep).
                # Filters out empty shells from old moves / uninstalls.
                if _xwechat_has_account(Path(entry.path)):
                    _SCAN_STATE["found"].append({
                        "path": entry.path,
                        "kind": "xwechat_files",
                        "via_drive": str(start.anchor) if hasattr(start, "anchor") else "",
                    })
                # Continue WITHOUT descending — wxid_* live one level below
                # but discover_wechat_profiles will pick them up from this candidate.
                continue
            if name.startswith("wxid_") or _looks_like_account_dir(Path(entry.path)):
                # Cheap check: does it have db_storage? Avoid descending to
                # confirm — discover_wechat_profiles validates anyway.
                try:
                    if (Path(entry.path) / "db_storage").exists():
                        _SCAN_STATE["found"].append({
                            "path": entry.path,
                            "kind": "wxid" if name.startswith("wxid_") else "account",
                        })
                except (OSError, PermissionError):
                    pass
                continue  # never descend into a wxid_*; nothing useful for us inside
            # Prune at top level only by exact-name match. We keep this list
            # short on purpose — false-positive pruning is much worse than
            # scanning a few extra dirs.
            if depth_left <= 0:
                continue
            if name_l in _SCAN_SKIP_NAMES:
                continue
            if name.startswith("."):  # hidden / dotted (.git, .venv, .cache, …)
                continue
            _walk(Path(entry.path), depth_left - 1)

    try:
        for d in drives:
            if _SCAN_STATE["cancelled"]:
                break
            _SCAN_STATE["current_path"] = str(d)
            _maybe_progress()
            _walk(d, max_depth)
            _SCAN_STATE["drives_done"] += 1
            _maybe_progress()
    except Exception as e:
        _SCAN_STATE["error"] = f"{type(e).__name__}: {e}"
    finally:
        _SCAN_STATE["running"] = False
        _SCAN_STATE["finished_at"] = int(__import__("time").time())
        _maybe_progress()


def save_wechat_root(path: str) -> Path:
    """Persist a manually selected xwechat_files or wxid_* directory.

    Normalises the user input so that pasting any of these forms works:
    - …/xwechat_files
    - …/xwechat_files/wxid_xxx
    - …/xwechat_files/wxid_xxx/db_storage          (← common: user pasted too deep)
    - …/xwechat_files/wxid_xxx/db_storage/session/session.db (file)
    - parent of an xwechat_files dir
    """
    raw = Path(os.path.expandvars(os.path.expanduser(path.strip().strip('"'))))
    p = _normalize_user_root(raw)
    cfg = load_config()
    roots = cfg.get("wechat_roots", [])
    if isinstance(roots, str):
        roots = [roots]
    if not isinstance(roots, list):
        roots = []
    roots_s = [str(Path(os.path.expandvars(os.path.expanduser(str(x).strip().strip('"'))))) for x in roots if str(x).strip()]
    p_s = str(p)
    if p_s not in roots_s:
        roots_s.insert(0, p_s)
    cfg["wechat_roots"] = roots_s[:8]
    save_config(cfg)
    return p


def _safe_listdir(p: Path, timeout_s: float = 1.5) -> Optional[list[Path]]:
    """Listdir with a thread-based timeout. macOS TCC can BLOCK iterdir on
    ~/Library/Containers/<other-app> while waiting for user consent — without
    ever raising. We run in a daemon thread and bail out on timeout."""
    import threading
    result: dict = {"entries": None, "err": None}
    def worker():
        try:
            result["entries"] = list(p.iterdir())
        except Exception as e:
            result["err"] = e
    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout_s)
    if t.is_alive():
        # Hung on TCC — return None so caller knows to skip
        return None
    if result["err"] is not None:
        return None
    return result["entries"]


_LAST_TCC_BLOCKED: bool = False  # set by discover_wechat_profiles


def discover_wechat_profiles() -> list[WeChatProfile]:
    """Find all WeChat accounts whose data is on disk.

    Returns a list of profiles. ALSO sets module-level `_LAST_TCC_BLOCKED`
    when at least one candidate hit a TCC consent block — detect_capabilities
    surfaces this so the UI can prompt the user for Full Disk Access.
    """
    global _LAST_TCC_BLOCKED
    _LAST_TCC_BLOCKED = False
    candidates = wechat_search_paths()
    profiles: list[WeChatProfile] = []
    seen_profiles: set[str] = set()
    plat = "windows" if IS_WINDOWS else "macos" if IS_MAC else "linux"
    for root in candidates:
        try:
            if not root.exists():
                continue
        except (PermissionError, OSError):
            _LAST_TCC_BLOCKED = True
            continue
        if _is_wxid_dir(root):
            entries = [root]
        else:
            entries = _safe_listdir(root)
        if entries is None:
            _LAST_TCC_BLOCKED = True
            continue  # TCC-blocked or hung

        # Two-pass walk: first look for wxid_* at the candidate level. If we
        # find nothing AND the candidate has another `xwechat_files` (or any
        # other xwechat_files-named) subdirectory, descend ONE more level.
        # This covers WeChat 4.x installs that nest as
        #     <root>/xwechat_files/xwechat_files/wxid_<id>/
        # rather than the documented
        #     <root>/xwechat_files/wxid_<id>/.
        # Capped at depth 2 — we explicitly do NOT recurse arbitrary deep
        # because that's the "scan everything" job and belongs in /api/scan-disks.
        wxid_subs: list[Path] = []
        nested_candidates: list[Path] = []
        for sub in entries:
            try:
                if _is_wxid_dir(sub):
                    wxid_subs.append(sub)
                elif sub.is_dir() and sub.name.lower() in {"xwechat_files", "wechat files"}:
                    nested_candidates.append(sub)
            except (PermissionError, OSError):
                continue
        # Always also descend into a nested xwechat_files/ if present — some
        # WeChat 4.x installs (OneDrive migration etc.) end up with BOTH:
        #   <root>/wxid_xxx/                       ← empty 89 MB shell
        #   <root>/xwechat_files/wxid_xxx/         ← the real 11 GB data
        # If we only checked the outer level we'd silently pick the shell.
        # Collect both, then dedupe by wxid name preferring the bigger db_storage.
        for nested in nested_candidates:
            inner = _safe_listdir(nested)
            if inner is None:
                continue
            for sub in inner:
                try:
                    if _is_wxid_dir(sub):
                        wxid_subs.append(sub)
                except (PermissionError, OSError):
                    continue

        # When the same account appears at multiple depths or with a short
        # suffix (wxid_xxx and wxid_xxx_abcd), prefer the one with larger total
        # db_storage size — that's the real data dir.
        if wxid_subs:
            by_name: dict[str, list[Path]] = {}
            for s in wxid_subs:
                by_name.setdefault(_wechat_account_short(s.name), []).append(s)

            def _db_storage_size(d: Path) -> int:
                ds = d / "db_storage"
                if not ds.exists():
                    return 0
                total = 0
                for p in ds.rglob("*"):
                    try:
                        if p.is_file():
                            total += p.stat().st_size
                    except (PermissionError, OSError):
                        continue
                return total

            picked: list[Path] = []
            for name, dirs in by_name.items():
                if len(dirs) == 1:
                    picked.append(dirs[0])
                else:
                    picked.append(max(dirs, key=_db_storage_size))
            wxid_subs = picked

        for sub in wxid_subs:
            wxid_full = sub.name
            profile_key = str(sub)
            if profile_key in seen_profiles:
                continue
            # Require the wxid dir to actually contain decryptable data.
            # Without this guard, a `wxid_*/` directory whose `db_storage/` is
            # empty (or missing entirely) gets reported as a valid profile —
            # diagnose then says "微信数据 已找到 ✓", refresh.py iterates 0 DBs
            # and exits 0, the post-decrypt promote finds no session.db, and
            # the user sees "decrypt subprocess returned 0 but no decrypted
            # directory found". Filter such empty shells out at discovery.
            db_storage = sub / "db_storage"
            try:
                if not db_storage.is_dir():
                    continue
                if not any(db_storage.rglob("*.db")):
                    continue
            except (PermissionError, OSError):
                continue
            seen_profiles.add(profile_key)
            wxid_short = _wechat_account_short(wxid_full)
            profiles.append(WeChatProfile(
                wxid=wxid_full,
                wxid_short=wxid_short,
                encrypted_root=db_storage,
                cache_root=sub,
                platform=plat,
            ))
    return profiles


# (db_filename, sentinel_table) pairs we expect under a healthy decrypted dir.
# session.db is *required* — without it Murmur cannot list any sessions. The
# rest are *advisory*: if any of them is present but its sentinel table is
# missing, that's a strong signal the decrypt produced a half-baked file even
# though the schema validator on session.db passed. detect_partial_decrypt()
# returns the list of broken pairs so the UI can surface a "请重新解密" prompt.
_REQUIRED_DB_SENTINEL = ("session.db", "SessionTable")
_ADVISORY_DB_SENTINELS = (
    ("contact.db",  "contact"),
    ("biz.db",      "BizContactInfo"),
    ("emoticon.db", "CustomEmotion"),
    ("sns.db",      "Feed"),
)


def _table_exists(db_path: Path, table: str) -> bool:
    """Best-effort: True iff `db_path` opens and has `table` in sqlite_master."""
    if not db_path.exists() or db_path.stat().st_size < 4096:
        return False
    import sqlite3 as _sqlite3
    try:
        c = _sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
        try:
            row = c.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
                (table,),
            ).fetchone()
            return bool(row)
        finally:
            c.close()
    except _sqlite3.Error:
        return False


def _is_real_decrypted_dir(p: Path) -> bool:
    """A decrypted dir is "ready" only if session.db has at least one user table.

    Without this guard a 4 KB empty SQLite stub (which has been observed sneaking
    into the dir between extract-key and refresh) would pass the existence check
    and lock EchoStore into a permanently empty state — frontend then shows
    "后端没起来" forever even though etcli is fine.
    """
    sess_name, sess_table = _REQUIRED_DB_SENTINEL
    return _table_exists(p / sess_name, sess_table)


def detect_partial_decrypt(p: Path) -> list[str]:
    """Returns the list of advisory DBs that exist but lack their sentinel table.

    A non-empty list means the directory passed `_is_real_decrypted_dir` (so
    session.db is fine) but at least one secondary DB looks broken — typical
    when WeChat updated its schema and only some files re-decrypted cleanly.
    Empty list = everything looks healthy. Use this to drive a "建议重新解密"
    UI banner instead of waiting for the user to notice missing data.
    """
    broken: list[str] = []
    for db_name, table in _ADVISORY_DB_SENTINELS:
        db_path = p / db_name
        if not db_path.exists():
            # Missing entirely is fine — not every WeChat install has all DBs.
            continue
        if not _table_exists(db_path, table):
            broken.append(db_name)
    return broken


def decrypted_root_for(profile: WeChatProfile, *, must_exist: bool = False) -> Path:
    """
    Resolve the decrypted DB directory for a profile.

    Search order:
      1. Config override `decrypted_root_<wxid_short>`
      2. ~/Documents/Murmur/decrypted/<wxid_short>     (new Murmur layout)
      3. ~/Documents/EchoTrace/<wxid_short>            (legacy echotrace, ~)
      4. D:/Documents/EchoTrace/<wxid_short>           (legacy echotrace, D:)
    If `must_exist=True`, returns the first existing one or None.
    If False, returns the preferred (new Murmur) location regardless.
    """
    cfg = load_config()
    override = cfg.get(f"decrypted_root_{profile.wxid_short}")
    if override:
        op = Path(override)
        if not must_exist or op.exists():
            return op
    candidates = [
        murmur_home() / "decrypted" / profile.wxid_short,
        Path.home() / "Documents" / "EchoTrace" / profile.wxid_short,
        Path("D:/Documents/EchoTrace") / profile.wxid_short,
        Path.home() / "OneDrive" / "Documents" / "EchoTrace" / profile.wxid_short,
    ]
    if must_exist:
        for p in candidates:
            if p.exists() and _is_real_decrypted_dir(p):
                return p
        return None  # type: ignore[return-value]
    # For new writes, prefer first existing if any (continuity), else default Murmur location
    for p in candidates:
        if p.exists() and (p / "session.db").exists():
            return p
    return candidates[0]


def media_root_for(profile: WeChatProfile) -> Path:
    """Where Murmur stores extracted media for this profile."""
    return murmur_home() / "media" / profile.wxid_short


def media_index_path(profile: WeChatProfile | None = None) -> Path:
    """Where the unified hardlink-md5 → file-path index is stored."""
    base = murmur_home()
    if profile:
        return base / "media" / profile.wxid_short / "media-index.json"
    return base / "media-index.json"


# ---------- WeChat process / executable discovery ----------

_WECHAT_EXE_NAMES = ("Weixin.exe", "WeChat.exe")


def _windows_running_weixin_paths() -> list[Path]:
    """Return full paths for running Weixin/WeChat processes when Windows allows it."""
    if not IS_WINDOWS:
        return []
    out: list[Path] = []
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)

        enum_processes = psapi.EnumProcesses
        enum_processes.argtypes = [
            ctypes.POINTER(wintypes.DWORD),
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        enum_processes.restype = wintypes.BOOL

        open_process = kernel32.OpenProcess
        open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        open_process.restype = wintypes.HANDLE

        query_full_process_image_name = kernel32.QueryFullProcessImageNameW
        query_full_process_image_name.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD),
        ]
        query_full_process_image_name.restype = wintypes.BOOL

        close_handle = kernel32.CloseHandle
        close_handle.argtypes = [wintypes.HANDLE]
        close_handle.restype = wintypes.BOOL

        max_count = 4096
        pids = (wintypes.DWORD * max_count)()
        needed = wintypes.DWORD()
        if not enum_processes(pids, ctypes.sizeof(pids), ctypes.byref(needed)):
            return []

        process_query_limited_information = 0x1000
        count = min(needed.value // ctypes.sizeof(wintypes.DWORD), max_count)
        wanted = {name.lower() for name in _WECHAT_EXE_NAMES}
        seen: set[str] = set()

        for pid in pids[:count]:
            if not pid:
                continue
            handle = open_process(process_query_limited_information, False, int(pid))
            if not handle:
                continue
            try:
                size = wintypes.DWORD(32768)
                buf = ctypes.create_unicode_buffer(size.value)
                if not query_full_process_image_name(handle, 0, buf, ctypes.byref(size)):
                    continue
                path = Path(buf.value)
                if path.name.lower() not in wanted:
                    continue
                key = os.path.normcase(str(path))
                if key in seen:
                    continue
                seen.add(key)
                out.append(path)
            finally:
                close_handle(handle)
    except Exception:
        return []
    return out


def find_weixin_exe() -> Path | None:
    """Find the Weixin/WeChat executable for relaunching after kill."""
    if IS_WINDOWS:
        env_roots = [
            Path(v) for k in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")
            if (v := os.environ.get(k))
        ]
        candidates = [
            Path(r"C:\Program Files\Tencent\Weixin\Weixin.exe"),
            Path(r"C:\Program Files (x86)\Tencent\Weixin\Weixin.exe"),
            Path(r"C:\Program Files\Tencent\WeChat\WeChat.exe"),
            Path(r"C:\Program Files (x86)\Tencent\WeChat\WeChat.exe"),
        ]
        for root in env_roots:
            candidates.extend([
                root / "Tencent" / "Weixin" / "Weixin.exe",
                root / "Tencent" / "WeChat" / "WeChat.exe",
            ])
        for cand in _dedupe_paths(candidates):
            if cand.exists():
                return cand
        # Registry lookup
        try:
            import winreg
            for hive, sub in [
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\Weixin"),
                (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\Weixin"),
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\WeChat"),
                (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\WeChat"),
            ]:
                try:
                    with winreg.OpenKey(hive, sub) as k:
                        v, _ = winreg.QueryValueEx(k, "InstallPath")
                        for exe in ("Weixin.exe", "WeChat.exe"):
                            p = Path(v) / exe
                            if p.exists():
                                return p
                except OSError:
                    pass
        except ImportError:
            pass
        for cand in _windows_running_weixin_paths():
            if cand.exists():
                return cand
    elif IS_MAC:
        env_app = os.environ.get("MURMUR_WECHAT_APP", "").strip()
        candidates: list[Path] = []
        if env_app:
            candidates.append(Path(os.path.expanduser(env_app.strip('"'))))
        for root in [Path("/Applications"), Path.home() / "Applications"]:
            for name in ["WeChat.app", "Weixin.app", "微信.app"]:
                candidates.append(root / name)
        candidates.extend(_mac_running_wechat_apps())
        for cand in _dedupe_paths(candidates):
            if cand.exists():
                return cand
    return None


def _mac_app_bundle_for_executable(exe: Path) -> Path | None:
    """Return the outer enclosing .app bundle for a macOS executable path.

    Mac App Store WeChat nests the real executable inside
    `WeChat.app/Contents/MacOS/WeChatAppEx.app/...`. For launching and data
    ownership we want the outer `WeChat.app`, while the inner executable is
    handled by `wechat_main_exec()`.
    """
    apps = [parent for parent in [exe, *exe.parents] if parent.name.endswith(".app")]
    return apps[-1] if apps else None


def _mac_running_wechat_apps() -> list[Path]:
    """Locate the running WeChat/Weixin .app bundle from process argv."""
    if not IS_MAC:
        return []
    out: list[Path] = []
    try:
        import subprocess as _sp
        for name in ("WeChat", "Weixin", "微信", "WeChatAppEx"):
            r = _sp.run(["pgrep", "-x", name], capture_output=True, text=True, timeout=3)
            if r.returncode != 0:
                continue
            for pid in r.stdout.split():
                ps = _sp.run(["ps", "-p", pid, "-o", "args="],
                             capture_output=True, text=True, timeout=3)
                argv0 = (ps.stdout or "").strip().split(" ", 1)[0]
                if not argv0:
                    continue
                app = _mac_app_bundle_for_executable(Path(argv0))
                if app:
                    out.append(app)
    except Exception:
        return out
    return _dedupe_paths(out)


def _mac_bundle_executable_name(app: Path) -> str | None:
    """Read CFBundleExecutable without shelling out."""
    try:
        import plistlib
        info = app / "Contents" / "Info.plist"
        if not info.exists():
            return None
        with info.open("rb") as f:
            val = plistlib.load(f).get("CFBundleExecutable")
        return str(val) if val else None
    except Exception:
        return None


def wechat_main_exec(app: Path | None = None) -> Path | None:
    """Return the main macOS WeChat executable inside a .app bundle."""
    if not IS_MAC:
        return None
    app = app or find_weixin_exe()
    if not app:
        return None
    if app.is_file():
        return app
    macos_dir = app / "Contents" / "MacOS"
    candidates: list[Path] = []

    bundle_exe = _mac_bundle_executable_name(app)
    if bundle_exe:
        candidates.append(macos_dir / bundle_exe)
    for name in ("WeChat", "Weixin", "微信", "WeChatAppEx"):
        candidates.append(macos_dir / name)

    # App Store WeChat 4.x can place the real app at:
    # WeChat.app/Contents/MacOS/WeChatAppEx.app/Contents/MacOS/WeChatAppEx
    try:
        for nested_app in macos_dir.glob("*.app"):
            nested_name = _mac_bundle_executable_name(nested_app)
            if nested_name:
                candidates.append(nested_app / "Contents" / "MacOS" / nested_name)
            for name in ("WeChatAppEx", "WeChat", "Weixin", "微信"):
                candidates.append(nested_app / "Contents" / "MacOS" / name)
    except OSError:
        pass

    for cand in _dedupe_paths(candidates):
        if cand.is_file() and os.access(cand, os.X_OK):
            return cand
    try:
        for cand in macos_dir.iterdir():
            if cand.is_file() and os.access(cand, os.X_OK):
                return cand
    except OSError:
        pass
    return None


# ---------- Capability matrix ----------

@dataclass
class Capabilities:
    can_decrypt_db: bool
    can_extract_key: bool
    can_extract_image_key: bool
    can_open_native_folder: bool
    has_wechat_installed: bool
    has_wechat_data: bool
    notes: list[str]
    sip_enabled: Optional[bool] = None  # macOS only: None on Win, True/False on Mac
    weixin_running: Optional[bool] = None  # whether the GUI process is alive
    wechat_hardened: Optional[bool] = None  # macOS only: True if hardened runtime still set
    wechat_app_store: Optional[bool] = None  # macOS only: True for Mac App Store WeChat
    tcc_blocked: Optional[bool] = None  # macOS only: True if ~/Library/Containers/<wechat> listdir blocks/fails
                                         # — common for ad-hoc-signed .app without Full Disk Access


def _check_sip_enabled() -> Optional[bool]:
    """Mac only: True if SIP enabled, False if disabled, None on error/non-Mac."""
    if not IS_MAC:
        return None
    try:
        import subprocess as _sp
        out = _sp.check_output(["csrutil", "status"], text=True, stderr=_sp.DEVNULL)
        if "disabled" in out.lower():
            return False
        if "enabled" in out.lower():
            return True
    except Exception:
        pass
    return None


def _check_wechat_hardened() -> Optional[bool]:
    """Mac only: True if WeChat's main executable has the hardened-runtime flag
    (which AMFI uses to gate task_for_pid), False if cleared, None on error.

    We check the main exec (`Contents/MacOS/WeChat`), not the bundle wrapper —
    that's what AMFI looks at when deciding whether to permit debugger attach.
    """
    if not IS_MAC:
        return None
    main_exec = wechat_main_exec()
    if not main_exec or not main_exec.exists():
        return None
    try:
        import subprocess as _sp
        r = _sp.run(["codesign", "-d", "-v", str(main_exec)],
                    capture_output=True, text=True, timeout=5)
        blob = r.stdout + "\n" + r.stderr
        return codesign_has_runtime_flag(blob)
    except Exception:
        return None


def is_mac_app_store_wechat(app: Path | None = None) -> bool:
    """Return True for Mac App Store WeChat builds.

    MAS WeChat 4.x uses a nested `WeChatAppEx.app` launcher and is protected
    differently from the official Tencent DMG build. We deliberately do not
    auto-resign it because failed write-back can damage the app bundle.
    """
    if not IS_MAC:
        return False
    app = app or find_weixin_exe()
    if not app or app.is_file():
        return False
    try:
        if (app / "Contents" / "_MASReceipt" / "receipt").exists():
            return True
        if (app / "Contents" / "MacOS" / "WeChatAppEx.app").exists():
            return True
    except OSError:
        return False
    return False


def codesign_has_runtime_flag(blob: str) -> bool:
    """Return True when `codesign -d -v` reports the hardened runtime flag.

    Apple prints multiple flag shapes across macOS/codesign versions, for
    example `flags=0x10000(runtime)` and `flags=0x10002(adhoc,runtime)`.
    Matching only the literal `(runtime)` misses the second form.
    """
    text = (blob or "").lower()
    for match in re.finditer(r"flags=[^\n()]*\(([^)]*)\)", text):
        flags = {part.strip() for part in match.group(1).split(",")}
        if "runtime" in flags:
            return True
    return False


def mac_running_weixin_processes() -> list[str]:
    """Return visible macOS WeChat/Weixin process hints.

    `pgrep -x WeChat` catches the normal case, but App Store / localized builds
    can also leave helper processes whose exact executable names differ. The
    ps fallback avoids silently signing while a WeChat binary is still mapped.
    """
    if not IS_MAC:
        return []
    found: dict[str, str] = {}
    try:
        import subprocess as _sp
        for name in ("WeChat", "Weixin", "微信", "WeChatAppEx"):
            r = _sp.run(["pgrep", "-x", name], capture_output=True, text=True, timeout=5)
            for pid in (r.stdout or "").splitlines():
                pid = pid.strip()
                if pid:
                    found[pid] = name
        ps = _sp.run(["ps", "-axo", "pid=,comm=,args="], capture_output=True, text=True, timeout=5)
        needles = (
            ".app/Contents/MacOS/WeChat",
            ".app/Contents/MacOS/Weixin",
            ".app/Contents/MacOS/微信",
            "com.tencent.xinWeChat",
            "com.tencent.xinweixin",
            "/WeChat.app/",
            "/Weixin.app/",
            "/微信.app/",
        )
        for line in (ps.stdout or "").splitlines():
            if not any(n in line for n in needles):
                continue
            parts = line.strip().split(None, 1)
            if not parts:
                continue
            pid = parts[0]
            found.setdefault(pid, line.strip())
    except Exception:
        pass
    return [f"{label} (pid {pid})" for pid, label in sorted(found.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0)]


def _check_weixin_running() -> Optional[bool]:
    """True if the WeChat/Weixin GUI process is alive."""
    try:
        import subprocess as _sp
        if IS_MAC:
            return bool(mac_running_weixin_processes())
        if IS_WINDOWS:
            if _windows_running_weixin_paths():
                return True
            for exe in _WECHAT_EXE_NAMES:
                r = _sp.run(["tasklist", "/fi", f"imagename eq {exe}"], capture_output=True, text=True)
                if exe.lower() in (r.stdout or "").lower():
                    return True
            return False
    except Exception:
        return None
    return None


def detect_capabilities() -> Capabilities:
    profiles = discover_wechat_profiles()
    has_data = bool(profiles)
    wechat_exe = find_weixin_exe()
    notes: list[str] = []

    # Decryption uses pure-Python (decrypt_py.py) when go_decrypt.dll is unavailable,
    # so it works on every platform — as long as the user has a SQLCipher key.
    can_decrypt = True

    sip = _check_sip_enabled()
    weixin_running = _check_weixin_running()
    has_install = wechat_exe is not None or (IS_WINDOWS and bool(weixin_running))
    mac_main_exec = wechat_main_exec(wechat_exe) if IS_MAC and wechat_exe else None
    hardened = _check_wechat_hardened() if IS_MAC else None
    app_store = is_mac_app_store_wechat(wechat_exe) if IS_MAC and wechat_exe else None

    # Memory scan to extract the key:
    #   - Windows: always works via wx_key.dll
    #   - macOS:
    #       (a) ad-hoc-signed WeChat (hardened runtime cleared): task_for_pid permitted
    #           regardless of SIP — this is the recommended path
    #       (b) hardened-runtime WeChat: only works with SIP off (rare, requires reboot)
    #   - Linux: WeChat has no Linux client
    if IS_WINDOWS:
        can_extract = bool(weixin_running)
    elif IS_MAC:
        # Either: WeChat is already ad-hoc signed → can attach right now
        # Or:     SIP is off → can attach even with hardened runtime (after sudo)
        can_extract = bool(weixin_running) and (hardened is False or sip is False)
    else:
        can_extract = False
    can_extract_img = IS_WINDOWS or (IS_MAC and has_data)

    if IS_MAC:
        notes.append("macOS 能直接解密微信数据库（纯 Python 实现）。")
        if has_data:
            notes.append("macOS 图片 V4-V2 key 可从 kvcomm 缓存推导；如果还没有缓存，请先在微信里点开几张图片再重试。")
        if _LAST_TCC_BLOCKED:
            notes.append("Murmur 没有「完全磁盘访问」权限 —— 系统已阻止读取微信数据。请在「系统设置 → 隐私与安全性 → 完全磁盘访问」给 Murmur 打勾后重启 Murmur。")
        if hardened is False:
            notes.append("WeChat.app 已是 ad-hoc 签名（hardened runtime 已清掉）—— 可直接抓密钥。")
        elif app_store is True and mac_main_exec is None:
            notes.append("检测到 Mac App Store 版 WeChat，但主程序文件缺失。请先重新安装 WeChat，再换腾讯官网版或手动粘贴密钥。")
        elif app_store is True:
            notes.append("检测到 Mac App Store 版 WeChat。这个版本不再自动重签名，建议换腾讯官网版 WeChat 或手动粘贴密钥。")
        elif hardened is True:
            notes.append("WeChat.app 还带 hardened runtime — 点「重签名」按钮后即可自动抓（不需要关 SIP）。")
        if not weixin_running:
            notes.append("微信未在运行 — 抓密钥需要先打开微信并登录、点开几个对话让 WCDB 派生 key。")
    if IS_LINUX:
        notes.append("Linux 不在当前支持范围（微信本身没有原生 Linux 客户端）")
    if not has_data:
        notes.append("还没找到微信数据文件夹 — 你可能需要先在 Windows/Mac 上登录一次微信")
    if IS_WINDOWS and has_install and weixin_running and wechat_exe is None:
        notes.append("检测到微信正在运行，但安装路径不在默认目录/注册表里；抓密钥可以继续，自动打开或重启微信可能不可用。")
    if not has_install and IS_WINDOWS:
        notes.append("没找到 Weixin.exe / WeChat.exe，也没检测到正在运行的微信进程 — 请确保微信已安装并打开")
    if IS_WINDOWS and has_install and not weixin_running:
        notes.append("微信未在运行 — Windows 抓密钥前请先打开微信，退出到登录页但不要关闭程序。")

    return Capabilities(
        can_decrypt_db=can_decrypt and has_data,
        can_extract_key=can_extract,
        can_extract_image_key=can_extract_img and has_install,
        can_open_native_folder=True,
        has_wechat_installed=has_install,
        has_wechat_data=has_data,
        notes=notes,
        sip_enabled=sip,
        weixin_running=weixin_running,
        wechat_hardened=hardened,
        wechat_app_store=app_store,
        tcc_blocked=_LAST_TCC_BLOCKED if IS_MAC else None,
    )


# ---------- Native lib bundle directory ----------

def native_dir() -> Path:
    """Directory containing wx_key.dll, go_decrypt.dll, etc. (or .dylib on Mac).

    PyInstaller-aware: when frozen, looks under sys._MEIPASS/native first.
    """
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            cand = Path(meipass) / "native"
            if cand.exists():
                return cand
    return Path(__file__).resolve().parent / "native"


if __name__ == "__main__":
    # Diagnostic command
    print(f"Platform   : {platform.system()} {platform.release()}")
    print(f"Python     : {sys.version.split()[0]}")
    print(f"Murmur home: {murmur_home()}")
    print(f"Config     : {murmur_config_path()}")
    print(f"WeChat exe : {find_weixin_exe()}")
    print(f"\nWeChat profiles found:")
    for p in discover_wechat_profiles():
        print(f"  {p.wxid}  ({p.wxid_short})")
        print(f"    encrypted: {p.encrypted_root}")
    caps = detect_capabilities()
    print(f"\nCapabilities:")
    for f in caps.__dataclass_fields__:
        if f == "notes":
            continue
        print(f"  {f:30s}: {getattr(caps, f)}")
    print(f"\nNotes:")
    for n in caps.notes:
        print(f"  - {n}")
