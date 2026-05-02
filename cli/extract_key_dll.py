"""extract_key_dll.py — 通过 wx_key.dll 注入到 Weixin.exe 抓 SQLCipher 密钥。

用法：
    python extract_key_dll.py             # 自动找微信进程，30秒内抓 key
    python extract_key_dll.py --pid 12345 # 指定 pid

默认不重启微信：先把 hook 装到正在运行的 Weixin.exe/WeChat.exe，
然后你手动退出登录再登录一次，hook 才能捕获登录事件里的主密钥。
"""
from __future__ import annotations
import argparse
import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

IS_WINDOWS = sys.platform.startswith("win")

# Win32 process enumeration (same as extract_key.py)
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

if IS_WINDOWS:
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
else:
    psapi = None
    kernel32 = None


def find_weixin_pids() -> list[int]:
    if not IS_WINDOWS or psapi is None or kernel32 is None:
        return []
    arr = (wintypes.DWORD * 4096)()
    needed = wintypes.DWORD()
    if not psapi.EnumProcesses(arr, ctypes.sizeof(arr), ctypes.byref(needed)):
        return []
    count = needed.value // ctypes.sizeof(wintypes.DWORD)
    pids = []
    for i in range(count):
        pid = arr[i]
        if pid == 0:
            continue
        h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
        if not h:
            continue
        try:
            buf = (ctypes.c_wchar * 260)()
            n = psapi.GetModuleBaseNameW(h, None, buf, 260)
            if n > 0 and buf.value.lower() in ("weixin.exe", "wechat.exe"):
                pids.append(pid)
        finally:
            kernel32.CloseHandle(h)
    return pids


def get_executable_path(pid: int) -> str | None:
    if not IS_WINDOWS or psapi is None or kernel32 is None:
        return None
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return None
    try:
        buf = (ctypes.c_wchar * 32768)()
        n = psapi.GetModuleFileNameExW(h, None, buf, 32768)
        return buf.value if n > 0 else None
    finally:
        kernel32.CloseHandle(h)


def find_weixin_path_from_registry() -> str | None:
    """Fallback: look up Weixin install path from registry."""
    if not IS_WINDOWS:
        return None
    import winreg
    candidates = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\Weixin", "InstallPath"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\Weixin", "InstallPath"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\WeChat", "InstallPath"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\WeChat", "InstallPath"),
    ]
    for hive, sub, name in candidates:
        try:
            with winreg.OpenKey(hive, sub) as k:
                v, _ = winreg.QueryValueEx(k, name)
                if v:
                    for exe in ("Weixin.exe", "WeChat.exe"):
                        p = Path(v) / exe
                        if p.exists():
                            return str(p)
        except OSError:
            pass
    # Last resort: hard-coded common paths
    for cand in [r"C:\Program Files\Tencent\Weixin\Weixin.exe",
                 r"C:\Program Files (x86)\Tencent\Weixin\Weixin.exe",
                 r"C:\Program Files\Tencent\WeChat\WeChat.exe",
                 r"C:\Program Files (x86)\Tencent\WeChat\WeChat.exe"]:
        if Path(cand).exists():
            return cand
    return None


def kill_weixin(pids: list[int]) -> bool:
    """Best-effort: kill all Weixin.exe processes, wait until they're gone."""
    for pid in pids:
        # Use taskkill /F so child processes also die
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
    # Also kill helpers (WeChatAppEx etc.) so they don't auto-restart parent
    for helper in ["WeChatAppEx.exe", "Weixin.exe", "WeChat.exe"]:
        subprocess.run(["taskkill", "/F", "/IM", helper, "/T"], capture_output=True)
    # Wait for processes to actually die (up to 6s)
    for _ in range(60):
        if not find_weixin_pids():
            return True
        time.sleep(0.1)
    return False


def launch_weixin(path: str) -> int | None:
    """Spawn Weixin.exe; return its PID once it appears.

    Use CREATE_NEW_PROCESS_GROUP only (0x200) — DETACHED_PROCESS (0x08) caused
    WeChat 4.x to die a few seconds after launch on some Win11 machines.
    """
    subprocess.Popen([path], cwd=str(Path(path).parent),
                     creationflags=0x00000200)
    # Poll for new pid (up to 15s — WeChat is slow to start)
    for _ in range(150):
        pids = find_weixin_pids()
        if pids:
            return pids[0]
        time.sleep(0.1)
    return None


# ---------- wx_key.dll bindings ----------

try:
    from paths import native_dir
    NATIVE_DIR = native_dir()
except Exception:
    NATIVE_DIR = Path(__file__).resolve().parent / "native"


class WxKey:
    def __init__(self):
        self._dll_dir_handle = os.add_dll_directory(str(NATIVE_DIR)) if hasattr(os, "add_dll_directory") else None
        self.dll = ctypes.WinDLL(str(NATIVE_DIR / "wx_key.dll"))

        # InitializeHook(uint32 pid) -> bool
        self.dll.InitializeHook.argtypes = [ctypes.c_uint32]
        self.dll.InitializeHook.restype = ctypes.c_bool

        # PollKeyData(char* buf, int32 size) -> bool
        self.dll.PollKeyData.argtypes = [ctypes.c_char_p, ctypes.c_int32]
        self.dll.PollKeyData.restype = ctypes.c_bool

        # GetStatusMessage(char* buf, int32 size, int32* level) -> bool
        self.dll.GetStatusMessage.argtypes = [ctypes.c_char_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_int32)]
        self.dll.GetStatusMessage.restype = ctypes.c_bool

        # CleanupHook() -> bool
        self.dll.CleanupHook.argtypes = []
        self.dll.CleanupHook.restype = ctypes.c_bool

        # GetLastErrorMsg() -> char*
        self.dll.GetLastErrorMsg.argtypes = []
        self.dll.GetLastErrorMsg.restype = ctypes.c_char_p

    def install(self, pid: int) -> bool:
        return self.dll.InitializeHook(pid)

    def poll_key(self) -> str | None:
        buf = ctypes.create_string_buffer(65)
        if self.dll.PollKeyData(buf, 65):
            return buf.value.decode("utf-8", errors="replace").strip()
        return None

    def poll_status(self) -> tuple[str, int] | None:
        buf = ctypes.create_string_buffer(256)
        level = ctypes.c_int32(0)
        if self.dll.GetStatusMessage(buf, 256, ctypes.byref(level)):
            return buf.value.decode("utf-8", errors="replace").strip(), level.value
        return None

    def cleanup(self) -> bool:
        return self.dll.CleanupHook()

    def last_error(self) -> str:
        ptr = self.dll.GetLastErrorMsg()
        if not ptr:
            return ""
        return ptr.decode("utf-8", errors="replace")


def hook_and_poll(pid: int, timeout: int = 60) -> str | None:
    wxk = WxKey()
    print(f"[*] Installing hook into Weixin.exe (PID {pid})...")
    if not wxk.install(pid):
        print(f"[X] Hook install failed: {wxk.last_error()}")
        return None
    print("[*] Hook installed. Polling for key (waiting for login event)...")

    key = None
    deadline = time.time() + timeout
    last_status_print = 0
    poll_count = 0
    try:
        while time.time() < deadline:
            poll_count += 1
            for _ in range(5):
                st = wxk.poll_status()
                if st is None:
                    break
                msg, level = st
                tag = ["INFO", "OK", "ERR"][min(level, 2)]
                print(f"  [{tag}] {msg}")
                last_status_print = time.time()
            k = wxk.poll_key()
            if k:
                key = k
                break
            time.sleep(0.1)
    finally:
        wxk.cleanup()
    if not key:
        print(f"[X] No key after {timeout}s ({poll_count} polls).")
    return key


def auto_restart_and_extract(timeout: int = 90) -> str | None:
    """Kill Weixin.exe → relaunch → inject hook ASAP → wait for auto-login event."""
    pids = find_weixin_pids()
    if not pids:
        print("[*] No running Weixin.exe — will launch fresh.")
        wechat_path = find_weixin_path_from_registry()
    else:
        wechat_path = get_executable_path(pids[0]) or find_weixin_path_from_registry()
        print(f"[*] Found running Weixin.exe pid={pids[0]} at: {wechat_path}")

    if not wechat_path or not Path(wechat_path).exists():
        print("[X] Could not find Weixin.exe path. Install WeChat or pass --wechat-path.")
        return None

    if pids:
        print(f"[!] Killing {len(pids)} Weixin.exe process(es) to trigger fresh login...")
        if not kill_weixin(pids):
            print("[!] Some processes did not die cleanly; continuing anyway.")

    print(f"[*] Launching Weixin.exe...")
    new_pid = launch_weixin(wechat_path)
    if not new_pid:
        print("[X] Failed to detect new Weixin.exe after launch.")
        return None
    print(f"[*] Initial Weixin.exe pid={new_pid}. Waiting 5s for WeChat 4.x launcher → main transition...")
    time.sleep(5.0)

    # WeChat 4.x spawns: launcher → main app process. The first pid is the launcher;
    # the main app is whichever Weixin.exe pid appears LAST after the launcher dies/forks.
    # Re-scan and pick the newest pid for hooking.
    current_pids = find_weixin_pids()
    if not current_pids:
        print("[X] Weixin.exe disappeared after launch. WeChat 4.x must spawn a child — try again with WeChat already running.")
        return None
    target_pid = max(current_pids)  # newest pid = most recently spawned = main app
    if target_pid != new_pid:
        print(f"[*] Switching to newer pid={target_pid} (was {new_pid}, likely the launcher).")
    else:
        print(f"[*] Hooking pid={target_pid}.")
    return hook_and_poll(target_pid, timeout=timeout)


def validate_key_against_db(key_hex: str, db_path: str) -> bool:
    """Use go_decrypt.dll's ValidateKey to confirm key is correct."""
    try:
        dll_dir_handle = os.add_dll_directory(str(NATIVE_DIR)) if hasattr(os, "add_dll_directory") else None
        lib = ctypes.WinDLL(str(NATIVE_DIR / "go_decrypt.dll"))
        lib.ValidateKey.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        lib.ValidateKey.restype = ctypes.c_int
        ok = lib.ValidateKey(db_path.encode("utf-8"), key_hex.encode("utf-8")) == 1
        _ = dll_dir_handle
        return ok
    except Exception as e:
        print(f"[!] Could not validate (go_decrypt.dll): {e}")
        return False


def find_sample_db() -> str | None:
    base = Path("D:/Documents/xwechat_files")
    if not base.exists():
        for cand in [Path.home() / "Documents/xwechat_files",
                     Path.home() / "OneDrive/Documents/xwechat_files"]:
            if cand.exists():
                base = cand
                break
        else:
            return None
    for wxid in base.iterdir():
        if not wxid.is_dir() or not wxid.name.startswith("wxid_"):
            continue
        sess = wxid / "db_storage" / "session" / "session.db"
        if sess.exists():
            return str(sess)
    return None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pid", type=int, help="Weixin.exe PID (auto-detected if omitted)")
    p.add_argument("--auto-restart", action="store_true",
                   help="Kill and relaunch Weixin.exe to trigger fresh login → hook → key")
    p.add_argument("--timeout", type=int, default=60, help="Max wait seconds (default 60)")
    p.add_argument("--save-to", help="Save key to this JSON file")
    p.add_argument("--validate-against", help="Path to a sample db_storage .db to validate key")
    args = p.parse_args()

    if not IS_WINDOWS:
        print("[X] extract_key_dll.py is Windows-only. On macOS use extract_key_mac.py.")
        return 2

    if args.auto_restart:
        key = auto_restart_and_extract(timeout=args.timeout)
    else:
        pids = [args.pid] if args.pid else find_weixin_pids()
        if not pids:
            print("[X] Weixin.exe not running. Use --auto-restart to launch it.")
            sys.exit(2)
        key = hook_and_poll(pids[0], timeout=args.timeout)

    if not key:
        sys.exit(1)

    print(f"\n[KEY] {key}")
    print(f"  length: {len(key)} chars  (should be 64 hex)")

    db = args.validate_against or find_sample_db()
    if db and Path(db).exists():
        ok = validate_key_against_db(key, db)
        print(f"  validate against {db}: {'✓ KEY IS CORRECT' if ok else '✗ key did NOT decrypt the db'}")

    if args.save_to:
        import json, datetime
        save_path = Path(args.save_to).expanduser()
        save_path.parent.mkdir(parents=True, exist_ok=True)
        save_path.write_text(json.dumps({
            "key": key,
            "decrypt_key": key,
            "extracted_at": datetime.datetime.now().isoformat(),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  saved to: {save_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
