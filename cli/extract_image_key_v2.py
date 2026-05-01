"""extract_image_key_v2.py — brute-force every 16-byte aligned window in WeChat memory.

Drops echotrace's strict ASCII filter (which doesn't work on WeChat 4.1.8+).
Instead: try EVERY 16-byte aligned position as an AES key. Validate by decrypting a
known V4-V2 image's first AES block and checking for FF D8 (JPEG) magic.

Performance budget:
- Scan only MEM_PRIVATE pages (rules out file-backed code/data).
- Stride 16 (key alignment).
- Pure-Python AES is slow; use pycryptodome ECB which uses native code.
- ~1 GB MEM_PRIVATE / 16 = 67M trials × ~10µs = ~700 sec worst case.
- But the key is usually in the heap of the WCDB module, found within 100 MB.

Usage:
    python extract_image_key_v2.py
    python extract_image_key_v2.py --pid 12345
    python extract_image_key_v2.py --max-mb 500
"""
from __future__ import annotations
import argparse
import ctypes
import os
import re
import sys
import time
from ctypes import wintypes
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))
from media import find_v4v2_sample_ciphertext, V4_V2_SIG  # noqa: E402
from extract_key_dll import find_weixin_pids  # noqa: E402


def find_distinct_samples(n: int = 5) -> list[bytes]:
    """Get N V4-V2 sample blocks with DISTINCT first-16-byte ciphertexts.

    Ensures we have actually independent samples (thumbnails share encrypted-header
    blocks because they all share the same JPG-header plaintext under ECB).
    Each returned block is the FULL aes_size=1024 portion (we'll AES decrypt all of it
    and check PKCS7 padding for stronger validation).
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from paths import discover_wechat_profiles
    profs = discover_wechat_profiles()
    if not profs:
        return []
    src = profs[0].cache_root
    samples: list[bytes] = []
    seen_first16 = set()
    for p in (src / "msg" / "attach").rglob("*.dat"):
        if len(samples) >= n:
            break
        try:
            data = p.read_bytes()
        except OSError:
            continue
        if len(data) < 0xF + 1024:
            continue
        if data[:6] != V4_V2_SIG:
            continue
        block_1024 = data[0xF: 0xF + 1024]
        head16 = block_1024[:16]
        if head16 in seen_first16:
            continue
        seen_first16.add(head16)
        samples.append(block_1024)
    return samples

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
MEM_PRIVATE = 0x20000
MEM_MAPPED = 0x40000
MEM_IMAGE = 0x1000000
PAGE_READWRITE = 0x04
PAGE_READONLY = 0x02
PAGE_WRITECOPY = 0x08
PAGE_GUARD = 0x100
PAGE_EXECUTE_READ = 0x20
PAGE_EXECUTE_READWRITE = 0x40
PAGE_EXECUTE_WRITECOPY = 0x80


class MBI(ctypes.Structure):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int)
    ap.add_argument("--max-mb", type=int, default=2000, help="Cap total scan in MB")
    ap.add_argument("--save-to", help="Save key to JSON")
    args = ap.parse_args()

    pids = [args.pid] if args.pid else find_weixin_pids()
    if not pids:
        print("[X] Weixin.exe not running.")
        sys.exit(2)
    pid = pids[0]
    print(f"[*] Target pid: {pid}")

    samples = find_distinct_samples(n=4)
    if not samples:
        print("[X] No V4-V2 sample to validate against.")
        sys.exit(2)
    print(f"[*] Multi-sample validation: {len(samples)} DISTINCT 1024-byte AES portions")
    for i, s in enumerate(samples):
        print(f"    sample {i} first 16 bytes: {s[:16].hex()}")

    from Crypto.Cipher import AES

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(MBI), ctypes.c_size_t]
    k32.VirtualQueryEx.restype = ctypes.c_size_t
    k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k32.ReadProcessMemory.restype = wintypes.BOOL
    k32.CloseHandle.argtypes = [wintypes.HANDLE]

    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        print("[X] OpenProcess failed.")
        sys.exit(1)

    addr = 0
    mbi = MBI()
    scanned_mb = 0.0
    last_log_mb = -100.0
    tries = 0
    t0 = time.time()
    found = None
    target_first2 = b"\xff\xd8"  # JPG magic

    try:
        while addr < 0x7FFFFFFFFFFF and scanned_mb < args.max_mb:
            if not k32.VirtualQueryEx(h, addr, ctypes.byref(mbi), ctypes.sizeof(mbi)):
                addr += 0x100000
                continue
            base = int(mbi.BaseAddress or 0)
            region_size = int(mbi.RegionSize)
            # Filter: MEM_COMMIT, PRIVATE memory, readable, no GUARD
            # Apply research-based filter: scan MEM_PRIVATE + MEM_MAPPED + MEM_IMAGE
            # (echotrace's MEM_PRIVATE-only filter is why my earlier scans missed the key)
            valid_type = mbi.Type in (MEM_PRIVATE, MEM_MAPPED, MEM_IMAGE)
            valid_protect = bool(mbi.Protect & (PAGE_READWRITE | PAGE_READONLY | PAGE_WRITECOPY |
                                                  PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY))
            if (mbi.State == MEM_COMMIT
                    and valid_type
                    and not (mbi.Protect & PAGE_GUARD)
                    and valid_protect):
                size = min(region_size, 16 * 1024 * 1024)
                buf = (ctypes.c_ubyte * size)()
                nread = ctypes.c_size_t(0)
                if k32.ReadProcessMemory(h, base, buf, size, ctypes.byref(nread)) and nread.value > 0:
                    data = bytes(buf[: nread.value])
                    scanned_mb += nread.value / 1e6

                    def validate_full(cand: bytes) -> bool:
                        """Decrypt full 1024-byte AES portion of each sample, check FF D8 + PKCS7."""
                        cipher_ = AES.new(cand, AES.MODE_ECB)
                        # Stage-1: quick first-block check on sample 0
                        if cipher_.decrypt(samples[0][:16])[:2] != target_first2:
                            return False
                        # Stage-2: full decryption + PKCS7 padding validation
                        for s in samples:
                            full = cipher_.decrypt(s)
                            if full[:2] != target_first2:
                                return False
                            pad = full[-1]
                            if pad < 1 or pad > 16 or full[-pad:] != bytes([pad]) * pad:
                                return False
                        return True

                    # Pass 1: ASCII alphanumeric — wx_key's primary algorithm
                    for m in re.finditer(rb"[0-9A-Za-z]{32}", data):
                        cand_full = m.group()
                        cand = cand_full[:16]  # only first 16 bytes are AES key
                        tries += 1
                        if validate_full(cand):
                            elapsed = time.time() - t0
                            print(f"\n[OK] FOUND ascii after {elapsed:.1f}s / {scanned_mb:.0f} MB / {tries} trials")
                            print(f"  ascii: {cand_full.decode()}")
                            print(f"  AES key (first 16): {cand.decode()}")
                            return _save_and_print(cand, args.save_to)
                    # Pass 2: UTF-16LE wide ASCII — wx_key's secondary
                    for m in re.finditer(rb"(?:[0-9A-Za-z]\x00){32}", data):
                        wide = m.group()
                        cand_full = bytes(wide[i * 2] for i in range(32))
                        cand = cand_full[:16]
                        tries += 1
                        if validate_full(cand):
                            elapsed = time.time() - t0
                            print(f"\n[OK] FOUND utf16 after {elapsed:.1f}s / {scanned_mb:.0f} MB / {tries} trials")
                            print(f"  utf16 ascii: {cand_full.decode()}")
                            print(f"  AES key (first 16): {cand.decode()}")
                            return _save_and_print(cand, args.save_to)
                    # Pass 3 (fallback): raw 16-byte alignment with low entropy filter — only if pass 1+2 yield nothing
                    n = len(data) - 16
                    for off in range(0, n, 16):
                        cand = data[off:off + 16]
                        if cand.count(b"\x00") > 6: continue
                        if len(set(cand)) < 6: continue
                        # Skip if matches an ASCII pattern we already tried
                        if all(48 <= b <= 122 for b in cand): continue
                        tries += 1
                        if validate_full(cand):
                            elapsed = time.time() - t0
                            print(f"\n[OK] FOUND binary after {elapsed:.1f}s / {scanned_mb:.0f} MB / {tries} trials")
                            print(f"  hex: {cand.hex()}")
                            return _save_and_print(cand, args.save_to)

                    if scanned_mb - last_log_mb >= 200:
                        rate = tries / max(0.01, time.time() - t0)
                        print(f"  ... {scanned_mb:.0f} MB, {tries} AES trials, "
                              f"{(time.time() - t0):.0f}s ({rate:.0f} trials/s)")
                        last_log_mb = scanned_mb
            addr = base + region_size
            if addr <= 0:
                addr = base + 0x1000
    finally:
        k32.CloseHandle(h)

    elapsed = time.time() - t0
    print(f"[X] No key after {scanned_mb:.0f} MB, {tries} trials, {elapsed:.0f}s")
    sys.exit(1)


def _save_and_print(key: bytes, save_to: str | None) -> int:
    if save_to:
        import json, datetime
        Path(save_to).write_text(json.dumps({
            "image_aes_key_hex": key.hex(),
            "image_aes_key_b64": __import__("base64").b64encode(key).decode(),
            "extracted_at": datetime.datetime.now().isoformat(),
        }, indent=2), encoding="utf-8")
        print(f"  saved to: {save_to}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
