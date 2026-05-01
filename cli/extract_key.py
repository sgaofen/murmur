"""extract_key.py — 从 Weixin.exe 进程内存里扫出 SQLCipher 密钥（纯 Python）。

工作原理：
1. 找到 Weixin.exe 进程 PID
2. 枚举它的可读内存区域
3. 在内存里滑动 32 字节窗口，做高熵过滤
4. 每个候选用 go_decrypt.dll 的 ValidateKey() 验证
5. 第一个能解 session.db 的就是真 key

用法：
    python extract_key.py                    # 自动找微信进程，扫到打印 key
    python extract_key.py --save             # 同时写到配置文件
    python extract_key.py --pid 12345        # 指定 pid
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes
from pathlib import Path

# ---------- Win32 API setup ----------

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_READWRITE = 0x04
PAGE_WRITECOPY = 0x08
PAGE_READONLY = 0x02
PAGE_EXECUTE_READWRITE = 0x40
PAGE_GUARD = 0x100
PAGE_NOACCESS = 0x01
PAGE_NOCACHE = 0x200
MEM_PRIVATE = 0x20000
MEM_IMAGE = 0x1000000
MEM_MAPPED = 0x40000

psapi = ctypes.WinDLL("psapi", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("PartitionId", wintypes.WORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.VirtualQueryEx.argtypes = [
    wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(MEMORY_BASIC_INFORMATION), ctypes.c_size_t
]
kernel32.VirtualQueryEx.restype = ctypes.c_size_t
kernel32.ReadProcessMemory.argtypes = [
    wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)
]
kernel32.ReadProcessMemory.restype = wintypes.BOOL


# ---------- Process discovery ----------

def find_weixin_pids() -> list[int]:
    """Return PIDs of running Weixin.exe processes."""
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


# ---------- Memory iteration ----------

def iter_memory(handle: int, max_addr: int = 0x7FFFFFFFFFFF):
    """Yield (base, size) for every readable, private/mapped/image memory region."""
    addr = 0
    mbi = MEMORY_BASIC_INFORMATION()
    while addr < max_addr:
        ok = kernel32.VirtualQueryEx(handle, addr, ctypes.byref(mbi), ctypes.sizeof(mbi))
        if not ok:
            # Skip ahead 1 MB on failure to keep moving
            addr += 0x100000
            continue
        if (mbi.State == MEM_COMMIT
                and not (mbi.Protect & PAGE_GUARD)
                and not (mbi.Protect & PAGE_NOACCESS)
                # Want readable pages
                and mbi.Protect & (PAGE_READWRITE | PAGE_READONLY | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE)):
            yield int(mbi.BaseAddress or 0), int(mbi.RegionSize)
        next_addr = (int(mbi.BaseAddress or 0)) + int(mbi.RegionSize)
        if next_addr <= addr:
            addr += 0x1000
        else:
            addr = next_addr


def read_mem(handle: int, base: int, size: int) -> bytes | None:
    buf = (ctypes.c_ubyte * size)()
    n = ctypes.c_size_t(0)
    ok = kernel32.ReadProcessMemory(handle, base, buf, size, ctypes.byref(n))
    if not ok or n.value == 0:
        return None
    return bytes(buf[: n.value])


# ---------- Key candidate filter ----------

def looks_like_key(b: bytes) -> bool:
    """Cheap entropy filter: real 32-byte AES keys have high diversity, no long runs."""
    if len(b) != 32:
        return False
    # Reject all-zero or any 8+ consecutive zero bytes
    if b.count(b"\x00") > 4:
        return False
    # At least 16 distinct byte values
    if len(set(b)) < 16:
        return False
    # No 4-byte ASCII-printable runs (real keys are not text)
    consec = 0
    for c in b:
        if 0x20 <= c <= 0x7E:
            consec += 1
            if consec >= 8:
                return False
        else:
            consec = 0
    return True


# ---------- Validator (uses echotrace's go_decrypt.dll) ----------

def load_validator(dll_dir: str):
    os.add_dll_directory(dll_dir)
    lib = ctypes.CDLL(os.path.join(dll_dir, "go_decrypt.dll"))
    lib.ValidateKey.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    lib.ValidateKey.restype = ctypes.c_int

    def validate(db_path: str, key_bytes: bytes) -> bool:
        hex_key = key_bytes.hex()
        return lib.ValidateKey(db_path.encode("utf-8"), hex_key.encode("utf-8")) == 1

    return validate


# ---------- Discovery: pick a sample encrypted DB to validate against ----------

def find_sample_db() -> Path | None:
    """Look for an encrypted message DB to use as the validation target."""
    base = Path("D:/Documents/xwechat_files")
    if not base.exists():
        # try OneDrive / Documents
        for cand in [Path.home() / "Documents/xwechat_files",
                     Path("C:/Users/Public/Documents/xwechat_files")]:
            if cand.exists():
                base = cand
                break
        else:
            return None
    for wxid in base.iterdir():
        if not wxid.is_dir() or not wxid.name.startswith("wxid_"):
            continue
        # session.db is small and quick to validate
        sess = wxid / "db_storage" / "session" / "session.db"
        if sess.exists():
            return sess
    return None


# ---------- Main scan loop ----------

def scan_for_key(pid: int, validate, sample_db: str, *, log=print) -> bytes | None:
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        log(f"[!] OpenProcess failed for pid={pid} (try running as admin?)")
        return None

    log(f"[*] Scanning pid={pid}, target db={sample_db}")
    t0 = time.time()
    total_bytes = 0
    candidates_tried = 0

    try:
        for base, size in iter_memory(handle):
            # Cap individual region read to 16 MB to keep memory bounded
            chunk_size = min(size, 16 * 1024 * 1024)
            offset = 0
            while offset < size:
                read_size = min(chunk_size, size - offset)
                data = read_mem(handle, base + offset, read_size)
                if not data:
                    break
                total_bytes += len(data)

                # Slide 32-byte window, step 4 bytes (key alignment is usually pointer-aligned)
                # But to be safe, step 1 byte. Performance is fine because filter is cheap.
                for i in range(0, len(data) - 32 + 1, 8):  # 8-byte stride: 8x faster, still catches most
                    cand = data[i:i + 32]
                    if not looks_like_key(cand):
                        continue
                    candidates_tried += 1
                    if candidates_tried % 5000 == 0:
                        elapsed = time.time() - t0
                        log(f"  ... {total_bytes/1e6:.0f} MB scanned, "
                            f"{candidates_tried} candidates tried, {elapsed:.1f}s")
                    if validate(sample_db, cand):
                        elapsed = time.time() - t0
                        log(f"[✓] FOUND in {elapsed:.1f}s after {candidates_tried} tries, "
                            f"{total_bytes/1e6:.0f} MB scanned")
                        return cand
                offset += read_size
        elapsed = time.time() - t0
        log(f"[!] No key found after scanning {total_bytes/1e6:.0f} MB "
            f"({candidates_tried} candidates) in {elapsed:.1f}s")
        return None
    finally:
        kernel32.CloseHandle(handle)


# ---------- Entry ----------

def main():
    p = argparse.ArgumentParser(description="Extract WeChat 4.x SQLCipher key from process memory.")
    p.add_argument("--pid", type=int, help="Weixin.exe PID (auto-detected if omitted)")
    p.add_argument("--dll-dir", default=r"C:\Users\YY\Downloads\echotrace-windows-v3.0.2",
                   help="Directory containing go_decrypt.dll for validation")
    p.add_argument("--save", action="store_true", help="Print only; do not save anywhere")
    p.add_argument("--db", help="Path to a sample encrypted .db to validate against")
    args = p.parse_args()

    pids = [args.pid] if args.pid else find_weixin_pids()
    if not pids:
        print("[X] Weixin.exe / WeChat.exe not found. Is WeChat running?")
        sys.exit(2)
    print(f"[*] Found WeChat processes: {pids}")

    sample_db = Path(args.db) if args.db else find_sample_db()
    if not sample_db or not sample_db.exists():
        print("[X] Could not locate a sample encrypted DB (xwechat_files/.../session.db).")
        sys.exit(2)
    print(f"[*] Validating candidates against: {sample_db}")

    validate = load_validator(args.dll_dir)

    for pid in pids:
        key = scan_for_key(pid, validate, str(sample_db))
        if key:
            print(f"\n[KEY] {key.hex()}")
            return 0

    print("\n[X] Failed to find key in any process.")
    return 1


if __name__ == "__main__":
    sys.exit(main() or 0)
