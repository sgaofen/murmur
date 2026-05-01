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


def _windows_xwechat_search_paths() -> list[Path]:
    """Common locations for xwechat_files on Windows."""
    paths = []
    home = Path.home()
    # Drive letters D:, E:, F:, ... in addition to default Documents
    for letter in "DEFGHIJ":
        paths.append(Path(f"{letter}:/Documents/xwechat_files"))
    paths += [
        home / "Documents" / "xwechat_files",
        home / "OneDrive" / "Documents" / "xwechat_files",
        home / "OneDrive - Personal" / "Documents" / "xwechat_files",
    ]
    return paths


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


def discover_wechat_profiles() -> list[WeChatProfile]:
    """Find all WeChat accounts whose data is on disk."""
    candidates = (_windows_xwechat_search_paths() if IS_WINDOWS
                  else _mac_xwechat_search_paths() if IS_MAC
                  else [])
    profiles: list[WeChatProfile] = []
    plat = "windows" if IS_WINDOWS else "macos" if IS_MAC else "linux"
    for root in candidates:
        if not root.exists():
            continue
        # On Windows: root contains wxid_xxx subdirs
        # On Mac: similar layout under the container
        for sub in root.iterdir():
            if _is_wxid_dir(sub):
                wxid_full = sub.name
                # Strip trailing _xxxx hex suffix (echotrace convention)
                import re
                wxid_short = re.sub(r"_[0-9a-f]+$", "", wxid_full)
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

def find_weixin_exe() -> Path | None:
    """Find the Weixin/WeChat executable for relaunching after kill."""
    if IS_WINDOWS:
        for cand in [
            Path(r"C:\Program Files\Tencent\Weixin\Weixin.exe"),
            Path(r"C:\Program Files (x86)\Tencent\Weixin\Weixin.exe"),
            Path(r"C:\Program Files\Tencent\WeChat\WeChat.exe"),
        ]:
            if cand.exists():
                return cand
        # Registry lookup
        try:
            import winreg
            for hive, sub in [
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\Weixin"),
                (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\Weixin"),
            ]:
                try:
                    with winreg.OpenKey(hive, sub) as k:
                        v, _ = winreg.QueryValueEx(k, "InstallPath")
                        p = Path(v) / "Weixin.exe"
                        if p.exists():
                            return p
                except OSError:
                    pass
        except ImportError:
            pass
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


def detect_capabilities() -> Capabilities:
    profiles = discover_wechat_profiles()
    has_data = bool(profiles)
    has_install = find_weixin_exe() is not None
    notes: list[str] = []

    # Decryption uses pure-Python (decrypt_py.py) when go_decrypt.dll is unavailable,
    # so it works on every platform — as long as the user has a SQLCipher key.
    can_decrypt = True
    # Memory scan to extract the key automatically still needs Windows API (wx_key.dll).
    # On Mac/Linux the user has to paste the key in manually for now.
    can_extract = IS_WINDOWS
    can_extract_img = IS_WINDOWS

    if IS_MAC:
        notes.append("macOS 现在能直接解密微信数据库（纯 Python 实现）—— 但需要你手动提供 SQLCipher 密钥（64 位 hex）")
        notes.append("自动抓密钥仍需 Windows DLL；在 Mac 上你可以走 lldb 或在另一台 Win 机器抓出来粘进来")
    if IS_LINUX:
        notes.append("Linux 不在当前支持范围（微信本身没有原生 Linux 客户端）")
    if not has_data:
        notes.append("还没找到微信数据文件夹 — 你可能需要先在 Windows/Mac 上登录一次微信")
    if not has_install and IS_WINDOWS:
        notes.append("没找到 Weixin.exe，「抓密钥」会失败 — 请确保微信已安装")

    return Capabilities(
        can_decrypt_db=can_decrypt and has_data,
        can_extract_key=can_extract and has_install,
        can_extract_image_key=can_extract_img and has_install,
        can_open_native_folder=True,
        has_wechat_installed=has_install,
        has_wechat_data=has_data,
        notes=notes,
    )


# ---------- Native lib bundle directory ----------

def native_dir() -> Path:
    """Directory containing wx_key.dll, go_decrypt.dll, etc. (or .dylib on Mac)."""
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
