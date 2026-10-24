"""qq_paths.py — QQNT data location + key extraction discovery (Windows + macOS).

Mirrors paths.py's WeChat helpers but for QQNT. Each QQNT install on Windows
puts its per-account databases under:

    <Tencent Files root>/<QQ_NUMBER>/nt_qq/nt_db/*.db

The Tencent Files root is configurable per-user during QQNT install. Common
locations:
    D:\\Documents\\Tencent Files\\<QQ>\\nt_qq\\nt_db\\
    C:\\Users\\<user>\\Documents\\Tencent Files\\<QQ>\\nt_qq\\nt_db\\
    <custom path>\\Tencent Files\\<QQ>\\nt_qq\\nt_db\\

On macOS the account folder is named after a hash instead of the QQ number:

    <QQ base>/nt_qq_<hash>/nt_db/*.db

where <QQ base> is one of (probed in order, see _mac_qq_search_paths):
    ~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ
    ~/Library/Application Support/QQ        (QQ NT 6.9.x per QQBackup docs)
The container path is TCC-protected (App Data / Full Disk Access); when it
exists but can't be listed we set `_LAST_QQ_TCC_BLOCKED` so the UI can ask
for Full Disk Access, mirroring paths.discover_wechat_profiles.
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
IS_MAC = sys.platform == "darwin"

MAC_QQ_BUNDLE_ID = "com.tencent.qq"


@dataclass
class QQProfile:
    """One QQ account on this machine."""
    qq_number: str                  # "246813579" (Windows) / nt_qq_<hash> suffix (macOS)
    nt_db_dir: Path                 # …/<qq>/nt_qq/nt_db  or  …/nt_qq_<hash>/nt_db
    tencent_files_root: Path        # parent "Tencent Files" dir / macOS QQ base dir


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


# macOS account folder: nt_qq_<hash>. The hash is opaque, so it doubles as
# our account id there (used for qq_keys.json and decrypted_qq/<id>/).
_MAC_ACCOUNT_RE = re.compile(r"^nt_qq_([0-9A-Za-z]{4,64})$")


def account_for_dir(p: Path) -> Optional[tuple]:
    """(account_id, nt_db_dir) if `p` is a QQ NT account folder of either layout:
    Windows `<qq_number>/nt_qq/nt_db/nt_msg.db` or macOS
    `nt_qq_<hash>/nt_db/nt_msg.db`. None otherwise."""
    try:
        if _is_qq_account_dir(p):
            return p.name, p / "nt_qq" / "nt_db"
        m = _MAC_ACCOUNT_RE.match(p.name)
        if m and p.is_dir() and (p / "nt_db" / "nt_msg.db").exists():
            return m.group(1), p / "nt_db"
    except OSError:
        return None
    return None


def _mac_qq_search_paths(home: Optional[Path] = None) -> list[Path]:
    """QQ NT base dirs on macOS (the dirs that contain nt_qq_<hash> folders).

    Order: user-saved config paths first, then the sandbox container (App
    Store / older builds), then the non-sandboxed location QQBackup documents
    for QQ NT 6.9.x."""
    home = home or Path.home()
    paths: list[Path] = list(_qq_root_config_paths())
    container = home / "Library" / "Containers" / MAC_QQ_BUNDLE_ID / "Data" / "Library"
    paths += [
        container / "Application Support" / "QQ",
        home / "Library" / "Application Support" / "QQ",
        container / "Application Support" / "QQNT",
        home / "Library" / "Application Support" / "QQNT",
    ]
    return _dedupe_paths(paths)


def _listdir_with_timeout(p: Path, timeout_s: float = 1.5) -> Optional[list]:
    """paths._safe_listdir (a TCC consent prompt can hang iterdir) with a
    local fallback so this module stays importable on its own."""
    try:
        from paths import _safe_listdir  # type: ignore
    except Exception:
        try:
            return list(p.iterdir())
        except OSError:
            return None
    return _safe_listdir(p, timeout_s)


_LAST_QQ_TCC_BLOCKED: bool = False  # set by discover_qq_profiles on macOS


def qq_tcc_blocked() -> bool:
    """True if the last macOS discovery hit a QQ dir it was not allowed to list."""
    return _LAST_QQ_TCC_BLOCKED


def _discover_mac_profiles(roots: list) -> list:
    global _LAST_QQ_TCC_BLOCKED
    _LAST_QQ_TCC_BLOCKED = False
    out: list[QQProfile] = []
    seen: set[str] = set()
    for root in roots:
        try:
            if not root.exists():
                continue
        except (PermissionError, OSError):
            _LAST_QQ_TCC_BLOCKED = True
            continue
        if account_for_dir(root) is not None:
            # User pasted an account folder itself.
            entries: Optional[list] = [root]
            base = root.parent
        else:
            entries = _listdir_with_timeout(root)
            base = root
        if entries is None:
            # Exists but can't be listed: TCC (Full Disk Access / App Data)
            # denied, or the consent prompt is hanging.
            _LAST_QQ_TCC_BLOCKED = True
            continue
        for child in sorted(entries, key=lambda x: x.name):
            acc = account_for_dir(child)
            if acc is None:
                continue
            acc_id, nt_db = acc
            key = os.path.normcase(str(nt_db))
            if key in seen:
                continue
            seen.add(key)
            out.append(QQProfile(qq_number=acc_id, nt_db_dir=nt_db, tencent_files_root=base))
    return out


def discover_qq_profiles() -> list[QQProfile]:
    """Return every QQNT account whose nt_msg.db is on disk."""
    if IS_MAC:
        return _discover_mac_profiles(_mac_qq_search_paths())
    if not IS_WINDOWS:
        return []  # Linux QQNT support out of scope
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


def find_mac_qq_app() -> Optional[Path]:
    """Locate QQ.app on macOS (MURMUR_QQ_APP override, /Applications,
    ~/Applications, then Spotlight by bundle id)."""
    if not IS_MAC:
        return None
    env = os.environ.get("MURMUR_QQ_APP", "").strip()
    cands = [Path(env)] if env else []
    cands += [Path("/Applications/QQ.app"), Path.home() / "Applications" / "QQ.app"]
    for c in cands:
        try:
            if (c / "Contents" / "MacOS").is_dir():
                return c
        except OSError:
            continue
    try:
        import subprocess as _sp
        r = _sp.run(["mdfind", f"kMDItemCFBundleIdentifier == '{MAC_QQ_BUNDLE_ID}'"],
                    capture_output=True, text=True, timeout=5)
        for line in (r.stdout or "").splitlines():
            p = Path(line.strip())
            if p.suffix == ".app" and (p / "Contents" / "MacOS").is_dir():
                return p
    except Exception:
        pass
    return None


def mac_qq_main_exec(app: Optional[Path] = None) -> Optional[Path]:
    """QQ.app/Contents/MacOS/QQ — the process lldb attaches to."""
    app = app or find_mac_qq_app()
    if not app:
        return None
    cand = app / "Contents" / "MacOS" / "QQ"
    if cand.exists():
        return cand
    try:
        for c in (app / "Contents" / "MacOS").iterdir():
            if c.is_file() and os.access(c, os.X_OK):
                return c
    except OSError:
        pass
    return None


def find_qq_install_dir() -> Optional[Path]:
    """Locate QQNT install root (where wrapper.node lives)."""
    if IS_MAC:
        return find_mac_qq_app()
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


def parse_mac_qq_ps(ps_output: str) -> list:
    """PIDs of the QQ main process in `ps -axo pid=,args=` output. Helpers
    (`QQ Helper (Renderer)` …) live under Contents/Frameworks and are ignored."""
    out: list[int] = []
    for line in (ps_output or "").splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        args = parts[1]
        if ".app/Contents/MacOS/" not in args or "/Contents/Frameworks/" in args:
            continue
        exe = args.split(".app/Contents/MacOS/", 1)[1]
        if exe == "QQ" or exe.startswith("QQ "):
            out.append(int(parts[0]))
    return sorted(set(out))


def qq_running_pids() -> list[int]:
    """Return PIDs of running QQ.exe (NT version) / the QQ.app main process."""
    if IS_MAC:
        try:
            import subprocess as _sp
            r = _sp.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True, timeout=5)
            return parse_mac_qq_ps(r.stdout or "")
        except Exception:
            return []
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
    if IS_MAC:
        return _mac_qq_search_paths()
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

    macOS layouts too: …/QQ, …/QQ/nt_qq_<hash>, …/QQ/nt_qq_<hash>/nt_db or a
    file inside — we return the dir holding the nt_qq_<hash> folders.

    Walks up until we find a parent named 'Tencent Files' (case-insensitive)
    or a macOS account folder (returning its parent), or returns the input
    unchanged if none found.
    """
    p = p.resolve() if p.exists() else p
    # If it points to a file, start from its parent
    if p.is_file():
        p = p.parent
    cur = p
    for _ in range(8):
        if cur.name.lower() in {"tencent files"}:
            return cur
        if _MAC_ACCOUNT_RE.match(cur.name) and (cur / "nt_db").is_dir():
            return cur.parent
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
