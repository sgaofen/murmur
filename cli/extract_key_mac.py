"""extract_key_mac.py — macOS WCDB key extractor for WeChat 4.x.

How it works (the elegant path that doesn't need SIP off):
  1. Quit WeChat
  2. Re-sign WeChat with ad-hoc signature → drops the hardened-runtime
     restriction so task_for_pid() can attach. ONE command:
         sudo codesign --force --deep --sign - /Applications/WeChat.app
  3. Re-launch WeChat, log in, open a couple of chats so WCDB materialises
     the per-DB derived keys in process memory.
  4. Run this script — it attaches via Mach VM API, scans WeChat's memory
     for the WCDB hex literal `x'<64hex_aes_key><32hex_salt>'`, matches each
     salt to a DB on disk, and writes per-DB AES keys to
     ~/.murmur/decrypted_keys.json (consumed by refresh.py raw-key mode).

Background:
  WCDB (the WeChat SQLCipher wrapper) caches the *derived* AES key for each
  DB it has opened, in the literal format SQLCipher accepts via
  `PRAGMA key = "x'...'"`. The salt is the first 16 bytes of the DB file,
  which makes salt→key matching trivial and false-positive-resistant
  (HMAC verification optional).

Why ad-hoc re-signing works without SIP off:
  Hardened runtime sets a flag in the code-directory that AMFI checks
  before allowing task_for_pid. `codesign --force --deep --sign -` re-signs
  every binary in the bundle WITHOUT that flag (we don't pass --options
  runtime), so AMFI permits debugger attach. SIP doesn't enter the picture.
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import json
import os
import re
import struct
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import discover_wechat_profiles, IS_MAC, murmur_config_path  # noqa: E402

PAGE_SIZE = 4096
SALT_SIZE = 16
KEY_SIZE = 32
HEX_PATTERN = re.compile(rb"x'([0-9a-fA-F]{96})'")  # x'<64 key><32 salt>'


# ---------- Mach VM ctypes bindings ----------

if IS_MAC:
    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)

    mach_port_t = ctypes.c_uint
    vm_map_t = mach_port_t
    mach_vm_address_t = ctypes.c_ulonglong
    mach_vm_size_t = ctypes.c_ulonglong
    vm_region_info_t = ctypes.POINTER(ctypes.c_int)
    mach_msg_type_number_t = ctypes.c_uint
    kern_return_t = ctypes.c_int
    natural_t = ctypes.c_uint

    libc.mach_task_self.restype = mach_port_t
    libc.task_for_pid.argtypes = [mach_port_t, ctypes.c_int, ctypes.POINTER(mach_port_t)]
    libc.task_for_pid.restype = kern_return_t

    # mach_vm_region: enumerate readable regions
    libc.mach_vm_region.argtypes = [
        vm_map_t,
        ctypes.POINTER(mach_vm_address_t),
        ctypes.POINTER(mach_vm_size_t),
        ctypes.c_int,           # flavor
        vm_region_info_t,
        ctypes.POINTER(mach_msg_type_number_t),
        ctypes.POINTER(mach_port_t),  # object_name out
    ]
    libc.mach_vm_region.restype = kern_return_t

    # mach_vm_read: returns allocated buffer
    libc.mach_vm_read.argtypes = [
        vm_map_t,
        mach_vm_address_t,
        mach_vm_size_t,
        ctypes.POINTER(mach_vm_address_t),
        ctypes.POINTER(mach_msg_type_number_t),
    ]
    libc.mach_vm_read.restype = kern_return_t

    libc.mach_vm_deallocate.argtypes = [vm_map_t, mach_vm_address_t, mach_vm_size_t]
    libc.mach_vm_deallocate.restype = kern_return_t


# vm_region_basic_info_64: 11 ints worth of data (per Apple)
class VMRegionBasicInfo64(ctypes.Structure):
    _fields_ = [
        ("protection", ctypes.c_int),
        ("max_protection", ctypes.c_int),
        ("inheritance", ctypes.c_uint),
        ("shared", ctypes.c_uint),
        ("reserved", ctypes.c_uint),
        ("offset", ctypes.c_ulonglong),
        ("behavior", ctypes.c_int),
        ("user_wired_count", ctypes.c_ushort),
    ]

VM_REGION_BASIC_INFO_64 = 9
VM_REGION_BASIC_INFO_COUNT_64 = ctypes.sizeof(VMRegionBasicInfo64) // ctypes.sizeof(ctypes.c_int)
VM_PROT_READ = 0x01
VM_PROT_WRITE = 0x02
CHUNK_SIZE = 2 * 1024 * 1024


# ---------- WeChat process / signature ----------

def find_weixin_pid() -> int | None:
    """Return the main WeChat (or Weixin) GUI process PID."""
    for name in ("WeChat", "Weixin"):
        try:
            out = subprocess.check_output(["pgrep", "-x", name], text=True).strip()
            if out:
                return int(out.splitlines()[0])
        except subprocess.CalledProcessError:
            continue
    return None


def is_wechat_hardened() -> bool | None:
    """
    Returns True if WeChat.app currently has the `runtime` (hardened) flag set,
    False if ad-hoc / unsigned, None on error.
    """
    app = Path("/Applications/WeChat.app")
    if not app.exists():
        return None
    try:
        r = subprocess.run(["codesign", "-d", "-v", str(app)],
                           capture_output=True, text=True)
    except FileNotFoundError:
        return None
    blob = (r.stdout + "\n" + r.stderr).lower()
    # codesign prints e.g. "flags=0x10000(runtime)" when hardened
    return "(runtime)" in blob


# ---------- DB salt collection ----------

def collect_db_salts(profile) -> dict[str, dict]:
    """
    Walk the profile's encrypted db_storage dir, return:
      { salt_hex: { 'name': 'session/session.db', 'path': Path, 'page1': bytes } }
    """
    out: dict[str, dict] = {}
    enc_root = profile.encrypted_root  # .../db_storage
    for db in enc_root.rglob("*.db"):
        # Skip FTS shards / WAL artefacts
        if "_fts" in db.name or db.name.endswith("-shm") or db.name.endswith("-wal"):
            continue
        try:
            with open(db, "rb") as f:
                page1 = f.read(PAGE_SIZE)
        except OSError:
            continue
        if len(page1) < PAGE_SIZE:
            continue
        if page1.startswith(b"SQLite format 3"):
            continue  # already plaintext, skip
        salt_hex = page1[:SALT_SIZE].hex()
        rel = db.relative_to(enc_root)
        out[salt_hex] = {"name": str(rel), "path": db, "page1": page1}
    return out


# ---------- memory scan ----------

def scan_memory_for_keys(task: int, *, deadline: float) -> set[tuple[str, str]]:
    """Scan all RW heap regions for the WCDB `x'<key><salt>'` pattern.
       Returns a set of (key_hex_lower, salt_hex_lower) tuples."""
    found: set[tuple[str, str]] = set()
    addr = mach_vm_address_t(0)
    region_count = 0
    bytes_scanned = 0

    while True:
        if time.time() > deadline:
            sys.stderr.write(f"[scan] timeout — {region_count} regions, {bytes_scanned // (1024*1024)}MB scanned, {len(found)} keys so far\n")
            break

        size = mach_vm_size_t(0)
        info = VMRegionBasicInfo64()
        info_count = mach_msg_type_number_t(VM_REGION_BASIC_INFO_COUNT_64)
        obj_name = mach_port_t(0)
        kr = libc.mach_vm_region(
            task, ctypes.byref(addr), ctypes.byref(size),
            VM_REGION_BASIC_INFO_64,
            ctypes.cast(ctypes.byref(info), vm_region_info_t),
            ctypes.byref(info_count),
            ctypes.byref(obj_name),
        )
        if kr != 0:
            break
        if size.value == 0:
            addr.value += 1
            continue

        if (info.protection & (VM_PROT_READ | VM_PROT_WRITE)) == (VM_PROT_READ | VM_PROT_WRITE):
            region_count += 1
            base = addr.value
            end = base + size.value
            cur = base
            while cur < end:
                chunk = min(CHUNK_SIZE, end - cur)
                data_addr = mach_vm_address_t(0)
                data_count = mach_msg_type_number_t(0)
                kr2 = libc.mach_vm_read(
                    task, mach_vm_address_t(cur), mach_vm_size_t(chunk),
                    ctypes.byref(data_addr), ctypes.byref(data_count),
                )
                if kr2 == 0 and data_count.value > 0:
                    buf = ctypes.string_at(data_addr.value, data_count.value)
                    bytes_scanned += data_count.value
                    for m in HEX_PATTERN.finditer(buf):
                        hex_str = m.group(1).decode("ascii").lower()
                        key_hex = hex_str[:64]
                        salt_hex = hex_str[64:]
                        found.add((key_hex, salt_hex))
                    libc.mach_vm_deallocate(libc.mach_task_self(),
                                            data_addr.value, data_count.value)
                # Overlap by pattern length so we don't miss matches across chunks
                step = chunk - 100 if chunk > 100 else chunk
                cur += step

        addr.value += size.value

    sys.stderr.write(f"[scan] done — {region_count} regions, {bytes_scanned // (1024*1024)}MB, {len(found)} unique candidates\n")
    return found


# ---------- main ----------

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Extract WeChat 4.x SQLCipher keys from a Mac WeChat process")
    p.add_argument("--pid", type=int, help="WeChat PID (auto-detected by default)")
    p.add_argument("--timeout", type=int, default=120, help="seconds to scan before giving up")
    p.add_argument("--auto-restart", action="store_true",
                   help="(no-op on Mac — kept for parity with extract_key_dll.py)")
    p.add_argument("--out", help="output JSON path (default: ~/.murmur/decrypted_keys.json)")
    p.add_argument("--salts",
                   help="path to a JSON file with {salt_hex: db_name} — when given, "
                        "skip walking ~/Library/Containers (which is TCC-protected from root). "
                        "The orchestrator collects salts as the user and passes them in.")
    p.add_argument("--out-keys",
                   help="path to write the keys-by-db JSON (defaults to --out / ~/.murmur/decrypted_keys.json). "
                        "Use this when running as root; the orchestrator copies into the user dir afterwards.")
    args = p.parse_args(argv)

    if not IS_MAC:
        print("[ERR] this script is macOS only — use extract_key_dll.py on Windows")
        return 1

    # --- Step 1: locate WeChat process ---
    pid = args.pid or find_weixin_pid()
    if not pid:
        print("[ERR] no WeChat process found — start WeChat and log in first")
        return 2
    sys.stderr.write(f"[info] target pid: {pid}\n")

    # --- Step 2: warn if hardened runtime still active ---
    hardened = is_wechat_hardened()
    if hardened is True:
        sys.stderr.write(
            "[warn] WeChat.app still has hardened runtime — task_for_pid will fail.\n"
            "[warn] Run this once (you'll be asked for your Mac password):\n"
            "[warn]   sudo codesign --force --deep --sign - /Applications/WeChat.app\n"
            "[warn] Then quit WeChat, re-launch it, log in, and re-run this script.\n"
        )
    elif hardened is False:
        sys.stderr.write("[info] WeChat is ad-hoc signed (hardened runtime cleared).\n")

    # --- Step 3: enumerate encrypted DBs and their salts ---
    if args.salts:
        # Pre-collected by the user-level orchestrator (because root is blocked
        # from listdir-ing ~/Library/Containers by TCC on macOS Sequoia+).
        try:
            with open(args.salts, "r", encoding="utf-8") as f:
                preloaded = json.load(f)
        except Exception as e:
            print(f"[ERR] failed to read --salts {args.salts}: {e}")
            return 2
        # JSON format: {salt_hex: db_name}
        salt_to_db = {salt: {"name": name} for salt, name in preloaded.items()}
        profile_wxid = preloaded.get("__wxid__", "(provided via --salts)") if "__wxid__" in preloaded else "(unknown)"
        sys.stderr.write(f"[info] {len(salt_to_db)} salts loaded from --salts file\n")
    else:
        profiles = discover_wechat_profiles()
        if not profiles:
            print("[ERR] no WeChat profile found on disk")
            return 2
        profile = profiles[0]
        profile_wxid = profile.wxid
        sys.stderr.write(f"[info] profile: {profile.wxid}\n")
        salt_to_db = collect_db_salts(profile)
        sys.stderr.write(f"[info] found {len(salt_to_db)} encrypted DBs\n")
        if not salt_to_db:
            print("[ERR] no encrypted DBs found — make sure WeChat has completed login + initial sync")
            return 2

    # --- Step 4: attach via task_for_pid ---
    self_task = libc.mach_task_self()
    target_task = mach_port_t(0)
    kr = libc.task_for_pid(self_task, pid, ctypes.byref(target_task))
    if kr != 0:
        print("[ERR] task_for_pid denied.")
        print("      Cause: WeChat.app has hardened runtime — AMFI blocks debugger attach.")
        print("      Fix without rebooting / disabling SIP:")
        print("         sudo codesign --force --deep --sign - /Applications/WeChat.app")
        print("      then quit + re-launch WeChat, log in, and re-run this script.")
        print(f"      kern_return_t = {kr}")
        return 3
    sys.stderr.write(f"[info] attached (task port {target_task.value})\n")

    # --- Step 5: scan ---
    deadline = time.time() + args.timeout
    candidates = scan_memory_for_keys(target_task.value, deadline=deadline)

    # --- Step 6: match keys to DBs by salt ---
    matched: dict[str, str] = {}  # db_relative_name → aes_key_hex
    for key_hex, salt_hex in candidates:
        info = salt_to_db.get(salt_hex)
        if not info:
            continue
        matched[info["name"]] = key_hex

    if not matched:
        print("[ERR] no key matched any DB salt. WCDB hadn't materialised the keys yet.")
        print("      Try: open WeChat, click into a few chats so the DBs get opened, then re-run.")
        return 4

    # --- Step 7: emit summary + save JSON ---
    print(f"[OK] matched {len(matched)} of {len(salt_to_db)} encrypted DBs")
    for name, k in sorted(matched.items()):
        print(f"[KEY] {name}: {k}")

    out_path = (
        Path(args.out_keys) if args.out_keys
        else Path(args.out) if args.out
        else (murmur_config_path().parent / "decrypted_keys.json")
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "wxid": profile_wxid,
        "extracted_at": int(time.time()),
        "keys_by_db": matched,
        # Also store by-salt for any later DB whose name we didn't enumerate
        "keys_by_salt": {salt: key for (key, salt) in candidates if salt in salt_to_db},
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    sys.stderr.write(f"[info] wrote {out_path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
