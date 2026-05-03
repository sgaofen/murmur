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
        return json.loads(p.read_text(encoding="utf-8"))
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
        ])
    return variants


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
    for root in _windows_drive_roots():
        paths.extend(_windows_xwechat_variants(root, include_base=False))
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
        for subroot in [
            container / cid / "Data" / "Library" / "Application Support" / cid,
            container / cid / "Data" / "Documents" / "xwechat_files",
        ]:
            paths.append(subroot)
    # Also check Documents fallback (some users redirect)
    paths.append(home / "Documents" / "xwechat_files")
    return paths


def _is_wxid_dir(p: Path) -> bool:
    return p.is_dir() and p.name.startswith("wxid_") and (p / "db_storage").exists()


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
        out.append(Path(os.path.expandvars(os.path.expanduser(part))))
    return out


def wechat_search_paths() -> list[Path]:
    """All candidate WeChat data roots Murmur will inspect."""
    env_candidates = _wechat_root_env_paths()
    if env_candidates and os.environ.get("MURMUR_WECHAT_ROOT_ONLY", "").strip().lower() in {"1", "true", "yes"}:
        return _dedupe_paths(env_candidates)
    raw_candidates = env_candidates + (
        _windows_xwechat_search_paths() if IS_WINDOWS
        else _mac_xwechat_search_paths() if IS_MAC
        else []
    )
    return _dedupe_paths(raw_candidates)


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
    import re as _re
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
        for sub in entries:
            try:
                if not _is_wxid_dir(sub):
                    continue
            except (PermissionError, OSError):
                continue
            wxid_full = sub.name
            profile_key = str(sub)
            if profile_key in seen_profiles:
                continue
            seen_profiles.add(profile_key)
            wxid_short = _re.sub(r"_[0-9a-f]+$", "", wxid_full)
            profiles.append(WeChatProfile(
                wxid=wxid_full,
                wxid_short=wxid_short,
                encrypted_root=sub / "db_storage",
                cache_root=sub,
                platform=plat,
            ))
    return profiles


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
            if p.exists() and (p / "session.db").exists():
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
        for cand in [
            Path("/Applications/WeChat.app"),
            Path("/Applications/Weixin.app"),
        ]:
            if cand.exists():
                return cand
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
    main_exec = Path("/Applications/WeChat.app/Contents/MacOS/WeChat")
    if not main_exec.exists():
        return None
    try:
        import subprocess as _sp
        r = _sp.run(["codesign", "-d", "-v", str(main_exec)],
                    capture_output=True, text=True, timeout=5)
        blob = (r.stdout + "\n" + r.stderr).lower()
        return "(runtime)" in blob
    except Exception:
        return None


def _check_weixin_running() -> Optional[bool]:
    """True if the WeChat/Weixin GUI process is alive."""
    try:
        import subprocess as _sp
        if IS_MAC:
            for name in ("WeChat", "Weixin"):
                r = _sp.run(["pgrep", "-x", name], capture_output=True, text=True)
                if r.returncode == 0 and r.stdout.strip():
                    return True
            return False
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
    hardened = _check_wechat_hardened() if IS_MAC else None

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
    can_extract_img = IS_WINDOWS

    if IS_MAC:
        notes.append("macOS 能直接解密微信数据库（纯 Python 实现）。")
        if _LAST_TCC_BLOCKED:
            notes.append("Murmur 没有「完全磁盘访问」权限 —— 系统已阻止读取微信数据。请在「系统设置 → 隐私与安全性 → 完全磁盘访问」给 Murmur 打勾后重启 Murmur。")
        if hardened is False:
            notes.append("WeChat.app 已是 ad-hoc 签名（hardened runtime 已清掉）—— 可直接抓密钥。")
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
        notes.append("微信未在运行 — Windows 抓密钥前请先打开微信并保持已登录状态。")

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
