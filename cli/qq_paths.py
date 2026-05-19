"""qq_paths.py — QQNT data location + key extraction discovery (Win-only for now).

Mirrors paths.py's WeChat helpers but for QQNT. Each QQNT install on Windows
puts its per-account databases under:

    <Tencent Files root>/<QQ_NUMBER>/nt_qq/nt_db/*.db

The Tencent Files root is configurable per-user during QQNT install. Common
locations:
    D:\\Documents\\Tencent Files\\<QQ>\\nt_qq\\nt_db\\
    C:\\Users\\<user>\\Documents\\Tencent Files\\<QQ>\\nt_qq\\nt_db\\
    <custom path>\\Tencent Files\\<QQ>\\nt_qq\\nt_db\\
"""
from __future__ import annotations

import os
import re
import sys
import time as _time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


IS_WINDOWS = sys.platform.startswith("win")


@dataclass
class QQProfile:
    """One QQ account on this machine."""
    qq_number: str                  # "939919010"
    nt_db_dir: Path                 # …/<qq>/nt_qq/nt_db
    tencent_files_root: Path        # the parent "Tencent Files" dir


# Reuse the 1024-byte-strip + decrypted output convention.
QQ_DECRYPTED_NAME_SUFFIX = ".dec.db"


def _qq_root_config_paths() -> list[Path]:
    """User-saved Tencent Files roots from Murmur's UI (config.json `qq_roots`)."""
    try:
        from paths import load_config  # type: ignore
    except Exception:
        return []
    cfg = load_config()
    raw = cfg.get("qq_roots", [])
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    out: list[Path] = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            continue
        p = Path(os.path.expandvars(os.path.expanduser(item.strip().strip('"'))))
        out.append(p)
    return out


def _windows_qq_search_paths() -> list[Path]:
    """Common locations of the 'Tencent Files' root on Windows.

    Order: user-saved config paths first (highest priority), then defaults.
    """
    home = Path.home()
    paths: list[Path] = list(_qq_root_config_paths())

    # User profile defaults
    paths += [
        home / "Documents" / "Tencent Files",
        home / "OneDrive" / "Documents" / "Tencent Files",
        home / "OneDrive - Personal" / "Documents" / "Tencent Files",
    ]

    # Drive roots (D-J), checked at root and under <drive>/Documents
    for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
        drive = Path(f"{letter}:/")
        try:
            if not drive.exists():
                continue
        except OSError:
            continue
        for sub in (
            drive / "Tencent Files",
            drive / "Documents" / "Tencent Files",
            drive / "QQ" / "Tencent Files",
        ):
            paths.append(sub)

    # Registry hint for QQNT data path
    if IS_WINDOWS:
        try:
            import winreg
            for hive, sub in [
                (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\QQNT"),
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\QQNT"),
            ]:
                try:
                    with winreg.OpenKey(hive, sub) as k:
                        for vname in ("DataPath", "FileSavePath", "PersonalDataPath"):
                            try:
                                v, _ = winreg.QueryValueEx(k, vname)
                                if isinstance(v, str) and v.strip():
                                    p = Path(os.path.expandvars(v.strip()))
                                    paths.append(p)
                            except OSError:
                                continue
                except OSError:
                    continue
        except ImportError:
            pass

    return _dedupe_paths(paths)


def _dedupe_paths(paths: list[Path]) -> list[Path]:
    seen: set[str] = set()
    out: list[Path] = []
    for p in paths:
        try:
            key = os.path.normcase(str(p))
        except (OSError, ValueError):
            continue
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


_QQ_NUMBER_RE = re.compile(r"^\d{5,12}$")


def _is_qq_account_dir(p: Path) -> bool:
    """Detect a QQ account folder: <num>/nt_qq/nt_db with at least nt_msg.db."""
    try:
        if not p.is_dir():
            return False
        if not _QQ_NUMBER_RE.match(p.name):
            return False
        return (p / "nt_qq" / "nt_db" / "nt_msg.db").exists()
    except OSError:
        return False


def discover_qq_profiles() -> list[QQProfile]:
    """Return every QQNT account whose nt_msg.db is on disk."""
    if not IS_WINDOWS:
        return []  # Linux/Mac QQNT support out of scope for v0.3.0
    out: list[QQProfile] = []
    seen: set[str] = set()
    for tf_root in _windows_qq_search_paths():
        try:
            if not tf_root.exists():
                continue
        except OSError:
            continue
        try:
            for child in tf_root.iterdir():
                if _is_qq_account_dir(child):
                    nt_db = child / "nt_qq" / "nt_db"
                    key = os.path.normcase(str(nt_db))
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append(QQProfile(
                        qq_number=child.name,
                        nt_db_dir=nt_db,
                        tencent_files_root=tf_root,
                    ))
        except (PermissionError, OSError):
            continue
    return out


def qq_decrypted_root_for(profile: QQProfile, *, must_exist: bool = False) -> Path:
    """Where Murmur stores the decrypted QQNT databases for an account.

    Layout: ~/Documents/Murmur/decrypted_qq/<qq_number>/{nt_msg.db, profile_info.db, …}
    Mirrors decrypted_root_for() for WeChat.
    """
    base = Path.home() / "Documents" / "Murmur" / "decrypted_qq" / profile.qq_number
    if must_exist and not (base / "nt_msg.db").exists():
        return None  # type: ignore[return-value]
    return base


def find_qq_install_dir() -> Optional[Path]:
    """Locate QQNT install root (where wrapper.node lives)."""
    if not IS_WINDOWS:
        return None
    for cand in [
        Path(r"C:\Program Files\Tencent\QQNT"),
        Path(r"C:\Program Files (x86)\Tencent\QQNT"),
    ]:
        if cand.exists():
            return cand
    # Registry fallback
    try:
        import winreg
        for hive, sub in [
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\QQNT"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\QQNT"),
        ]:
            try:
                with winreg.OpenKey(hive, sub) as k:
                    for vname in ("InstallPath", "Install_Dir"):
                        try:
                            v, _ = winreg.QueryValueEx(k, vname)
                            if isinstance(v, str):
                                p = Path(v)
                                if p.exists():
                                    return p
                        except OSError:
                            continue
            except OSError:
                continue
    except ImportError:
        pass
    return None


def qq_running_pids() -> list[int]:
    """Return PIDs of running QQ.exe (NT version)."""
    if not IS_WINDOWS:
        return []
    try:
        import subprocess as _sp
        r = _sp.run(["tasklist", "/FI", "IMAGENAME eq QQ.exe", "/FO", "CSV", "/NH"],
                    capture_output=True, text=True, encoding="utf-8", errors="replace")
        out: list[int] = []
        for line in (r.stdout or "").splitlines():
            parts = [x.strip().strip('"') for x in line.split('","')]
            if len(parts) >= 2 and parts[0].lower() == "qq.exe":
                try:
                    out.append(int(parts[1]))
                except ValueError:
                    pass
        return sorted(set(out))
    except Exception:
        return []


def qq_search_paths() -> list[Path]:
    """All candidate Tencent Files roots Murmur will inspect (UI also displays these)."""
    if not IS_WINDOWS:
        return []
    return _windows_qq_search_paths()


def _normalize_qq_root(p: Path) -> Path:
    """Normalize user-pasted QQ path to a 'Tencent Files' directory.

    Accepts any of:
    - …/Tencent Files
    - …/Tencent Files/<qq>
    - …/Tencent Files/<qq>/nt_qq
    - …/Tencent Files/<qq>/nt_qq/nt_db
    - any file inside the above (walks up from parent)

    Walks up until we find a parent named 'Tencent Files' (case-insensitive),
    or returns the input unchanged if none found.
    """
    p = p.resolve() if p.exists() else p
    # If it points to a file, start from its parent
    if p.is_file():
        p = p.parent
    cur = p
    for _ in range(8):
        if cur.name.lower() in {"tencent files"}:
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return p


def save_qq_root(path: str) -> Path:
    """Persist a manually selected Tencent Files root into config.json `qq_roots`."""
    try:
        from paths import load_config, save_config  # type: ignore
    except Exception:
        raise RuntimeError("config helpers unavailable (running outside Murmur env?)")
    raw = Path(os.path.expandvars(os.path.expanduser(path.strip().strip('"'))))
    p = _normalize_qq_root(raw)
    cfg = load_config()
    roots = cfg.get("qq_roots", [])
    if isinstance(roots, str):
        roots = [roots]
    if not isinstance(roots, list):
        roots = []
    roots_s = [
        str(Path(os.path.expandvars(os.path.expanduser(str(x).strip().strip('"')))))
        for x in roots if str(x).strip()
    ]
    p_s = str(p)
    if p_s not in roots_s:
        roots_s.insert(0, p_s)
    cfg["qq_roots"] = roots_s[:8]
    save_config(cfg)
    return p


# --- background full-disk scan (mirrors paths.scan_for_wechat_data_async) ---

_QQ_SCAN_STATE: dict = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "drives_total": 0,
    "drives_done": 0,
    "current_path": "",
    "dirs_scanned": 0,
    "found": [],            # list of {path: tencent_files_root, qq_numbers: [...]}
    "error": None,
    "cancelled": False,
}

_QQ_SCAN_SKIP_NAMES = {
    "windows", "program files", "program files (x86)", "programdata",
    "$recycle.bin", "system volume information", "node_modules",
    "appdata", ".git", ".cache", "winsxs", "drivers", "perflogs",
}


def get_qq_scan_state() -> dict:
    return {k: v if k != "found" else list(v) for k, v in _QQ_SCAN_STATE.items()}


def cancel_qq_scan() -> None:
    _QQ_SCAN_STATE["cancelled"] = True


def _windows_drive_roots() -> list[Path]:
    out = []
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        d = Path(f"{letter}:/")
        try:
            if d.exists():
                out.append(d)
        except OSError:
            continue
    return out


def scan_for_qq_data_async(*, max_depth: int = 8) -> None:
    """Walk all drives looking for Tencent Files roots that contain QQ accounts.

    A 'hit' is any directory containing one or more children that pass
    _is_qq_account_dir (i.e. a numeric QQ folder with nt_qq/nt_db/nt_msg.db).

    Updates _QQ_SCAN_STATE.found with {path, qq_numbers} entries.
    """
    if not IS_WINDOWS:
        _QQ_SCAN_STATE["error"] = "scan_for_qq_data is Windows-only"
        return

    drives = _windows_drive_roots()
    _QQ_SCAN_STATE.update({
        "running": True,
        "started_at": int(_time.time()),
        "finished_at": None,
        "drives_total": len(drives),
        "drives_done": 0,
        "current_path": "",
        "dirs_scanned": 0,
        "found": [],
        "error": None,
        "cancelled": False,
    })

    def _walk(start: Path, depth_left: int) -> None:
        if _QQ_SCAN_STATE["cancelled"]:
            return
        try:
            with os.scandir(start) as it:
                children = list(it)
        except (PermissionError, OSError, FileNotFoundError):
            return
        _QQ_SCAN_STATE["dirs_scanned"] += 1
        if _QQ_SCAN_STATE["dirs_scanned"] % 50 == 0:
            _QQ_SCAN_STATE["current_path"] = str(start)

        # Structural detection: any directory whose immediate children include
        # at least one valid QQ account folder is a candidate, regardless of
        # the directory's own name. Catches users who renamed 'Tencent Files',
        # moved data into a custom layout, or have multiple Tencent Files-like
        # parents on the same drive.
        qqs: list[str] = []
        for entry in children:
            if _QQ_SCAN_STATE["cancelled"]:
                return
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            if _QQ_NUMBER_RE.match(entry.name):
                try:
                    if (Path(entry.path) / "nt_qq" / "nt_db" / "nt_msg.db").exists():
                        qqs.append(entry.name)
                except OSError:
                    continue
        if qqs:
            _QQ_SCAN_STATE["found"].append({
                "path": str(start),
                "qq_numbers": sorted(qqs),
            })
            return  # don't descend further — children are account folders

        for entry in children:
            if _QQ_SCAN_STATE["cancelled"]:
                return
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            name = entry.name
            name_l = name.lower()
            if depth_left <= 0:
                continue
            if name_l in _QQ_SCAN_SKIP_NAMES:
                continue
            if name.startswith("."):
                continue
            _walk(Path(entry.path), depth_left - 1)

    try:
        for d in drives:
            if _QQ_SCAN_STATE["cancelled"]:
                break
            _QQ_SCAN_STATE["current_path"] = str(d)
            _walk(d, max_depth)
            _QQ_SCAN_STATE["drives_done"] += 1
    except Exception as e:
        _QQ_SCAN_STATE["error"] = f"{type(e).__name__}: {e}"
    finally:
        _QQ_SCAN_STATE["running"] = False
        _QQ_SCAN_STATE["finished_at"] = int(_time.time())


if __name__ == "__main__":
    print("=== QQ profiles ===")
    for p in discover_qq_profiles():
        print(f"  {p.qq_number}  nt_db={p.nt_db_dir}")
    print(f"\n=== QQNT install ===")
    print(f"  {find_qq_install_dir()}")
    print(f"\n=== running QQ pids: {qq_running_pids()}")
