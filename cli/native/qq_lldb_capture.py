"""qq_lldb_capture.py — capture the QQ NT (macOS) SQLCipher passphrase with lldb.

Loaded INSIDE lldb (Xcode Command Line Tools' embedded Python, 3.9):

    lldb --batch --no-lldbinit \
        -o 'command script import "/path/to/qq_lldb_capture.py"' \
        -o 'murmur_qq_capture'

Options come from environment variables (avoids lldb's command-line quoting):

    MURMUR_QQ_APP          path to QQ.app (launched with `open` once we wait)
    MURMUR_QQ_PROCESS      process name to wait for (default "QQ")
    MURMUR_QQ_TIMEOUT      total seconds before giving up (default 200)
    MURMUR_QQ_SETTLE       seconds to keep collecting once the same plausible
                           16-byte value was seen in 2 different breakpoint
                           hits (default 15; same rule as qq_get_key.ps1)
    MURMUR_QQ_MAX_HITS     stop after this many breakpoint hits (default 200)
    MURMUR_QQ_CANCEL_FILE  if this file appears, detach and stop
    MURMUR_QQ_NO_LAUNCH    "1" = don't `open` QQ, wait for the user to start it

How it works: QQ NT's `wrapper.node` statically links SQLCipher. Its
`nt_sqlite3_key_v2(db, zDb, pKey, nKey)` is not exported, but the function
logs "nt_sqlite3_key_v2: db=%p zDb=%s", so we locate it by finding the code
that references that string (ADRP+ADD on arm64, RIP-relative LEA on x86_64)
and walking back to the containing function's entry (LC_FUNCTION_STARTS when
present, a prologue heuristic otherwise). On every hit we read the key
argument (arm64: x2 = pKey, x3 = nKey; x86_64: rdx/rcx) plus a few other
argument registers, and print each distinct printable string as

    MURMUR_KEY_CANDIDATE source=x2 len=16 hex=...

The Murmur backend (cli/qq_decrypt.py) filters those candidates (login.db's
fixed key, zDb names, ...) and keeps only one that HMAC-verifies against
page 1 of nt_msg.db, so a wrong register guess can never produce a wrong key.

At the end we DETACH (QQ keeps running, the user stays logged in).

The binary-analysis half is pure Python with no lldb dependency so it can be
unit tested (tests/test_qq_mac.py). This file is an independent
implementation; the general approach (breakpoint nt_sqlite3_key_v2 in
wrapper.node, read x2/x3, skip login.db's fixed key) follows the public
QQBackup/QQDecrypt macOS documentation.
"""
from __future__ import annotations

import mmap
import os
import re
import struct
import sys
import time

# ---------------------------------------------------------------------------
# Mach-O constants
# ---------------------------------------------------------------------------

FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF
MH_MAGIC_64 = 0xFEEDFACF
CPU_TYPE_X86_64 = 0x01000007
CPU_TYPE_ARM64 = 0x0100000C
LC_SEGMENT_64 = 0x19
LC_FUNCTION_STARTS = 0x26

KEY_FUNC_STRINGS = (
    b"nt_sqlite3_key_v2: db=",
    b"nt_sqlite3_key_v2: no key",
)
KEY_FUNC_SYMBOLS = ("nt_sqlite3_key_v2", "sqlite3_key_v2")

LOGIN_DB_FIXED_KEY = "BD156D6710D54D8782F4"
MARKER = "MURMUR_KEY_CANDIDATE"
STATUS = "MURMUR_STATUS"
MAX_READ = 64


class MachOError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Mach-O parsing (works on bytes, bytearray or mmap)
# ---------------------------------------------------------------------------

def macho_slices(buf) -> list:
    """[(cputype, offset, size)] for a thin 64-bit Mach-O or a fat binary."""
    if len(buf) < 8:
        raise MachOError("file too small")
    be_magic = struct.unpack_from(">I", buf, 0)[0]
    if be_magic in (FAT_MAGIC, FAT_MAGIC_64):
        narch = struct.unpack_from(">I", buf, 4)[0]
        out = []
        off = 8
        for _ in range(narch):
            if be_magic == FAT_MAGIC:
                cputype, _sub, offset, size, _align = struct.unpack_from(">iiIII", buf, off)
                off += 20
            else:
                cputype, _sub, offset, size, _align, _res = struct.unpack_from(">iiQQII", buf, off)
                off += 32
            out.append((cputype & 0xFFFFFFFF, offset, size))
        return out
    le_magic, cputype = struct.unpack_from("<II", buf, 0)
    if le_magic == MH_MAGIC_64:
        return [(cputype, 0, len(buf))]
    raise MachOError("not a 64-bit Mach-O")


def pick_slice(buf, cputype: int) -> tuple:
    for ct, off, size in macho_slices(buf):
        if ct == cputype:
            return off, size
    raise MachOError("no slice for cputype 0x%x" % cputype)


def parse_load_commands(buf, base: int) -> dict:
    """Segments, sections and function starts of the Mach-O at `base`.
    Offsets in the result are relative to `base` (the slice start)."""
    magic, cputype, _sub, _ftype, ncmds, _sizeofcmds = struct.unpack_from("<IIIIII", buf, base)
    if magic != MH_MAGIC_64:
        raise MachOError("slice is not MH_MAGIC_64")
    segments = []
    func_starts_cmd = None
    off = base + 32
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", buf, off)
        if cmd == LC_SEGMENT_64:
            segname = bytes(buf[off + 8:off + 24]).rstrip(b"\x00").decode("ascii", "replace")
            vmaddr, vmsize, fileoff, filesize = struct.unpack_from("<QQQQ", buf, off + 24)
            nsects = struct.unpack_from("<I", buf, off + 64)[0]
            sects = []
            s = off + 72
            for _ in range(nsects):
                sectname = bytes(buf[s:s + 16]).rstrip(b"\x00").decode("ascii", "replace")
                sseg = bytes(buf[s + 16:s + 32]).rstrip(b"\x00").decode("ascii", "replace")
                addr, size = struct.unpack_from("<QQ", buf, s + 32)
                foff = struct.unpack_from("<I", buf, s + 48)[0]
                sects.append({"sect": sectname, "seg": sseg, "addr": addr,
                              "size": size, "offset": foff})
                s += 80
            segments.append({"name": segname, "vmaddr": vmaddr, "vmsize": vmsize,
                             "fileoff": fileoff, "filesize": filesize, "sections": sects})
        elif cmd == LC_FUNCTION_STARTS:
            func_starts_cmd = struct.unpack_from("<II", buf, off + 8)
        if cmdsize <= 0:
            raise MachOError("bad load command size")
        off += cmdsize
    text_seg = next((s for s in segments if s["name"] == "__TEXT"), None)
    func_starts = []
    if func_starts_cmd and text_seg is not None:
        dataoff, datasize = func_starts_cmd
        func_starts = decode_function_starts(
            bytes(buf[base + dataoff:base + dataoff + datasize]), text_seg["vmaddr"])
    unwind_starts = []
    uw = find_section(segments, "__TEXT", "__unwind_info")
    if uw is not None and text_seg is not None:
        try:
            unwind_starts = decode_unwind_starts(buf, base, uw, text_seg["vmaddr"])
        except struct.error:
            unwind_starts = []
    return {"cputype": cputype, "segments": segments, "function_starts": func_starts,
            "unwind_starts": unwind_starts}


def decode_function_starts(data: bytes, text_vmaddr: int) -> list:
    """LC_FUNCTION_STARTS payload: ULEB128 deltas, first one from __TEXT."""
    out = []
    addr = text_vmaddr
    i = 0
    n = len(data)
    while i < n:
        val = 0
        shift = 0
        while i < n:
            b = data[i]
            i += 1
            val |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        if val == 0:
            break
        addr += val
        out.append(addr)
    return out


def find_section(segments: list, segname: str, sectname: str):
    for s in segments:
        for sec in s["sections"]:
            if sec["sect"] == sectname and sec["seg"] == segname:
                return sec
    return None


def decode_unwind_starts(buf, base: int, sec: dict, text_vmaddr: int) -> list:
    """Function starts listed in __TEXT,__unwind_info (compact unwind).

    The linker folds consecutive functions that share an encoding into one
    entry, so this list can MISS functions: an entry is only a lower bound
    for the real start of the function containing an address. Still, it
    survives `strip` (unlike LC_FUNCTION_STARTS in some builds) and keeps
    the prologue heuristic from walking into the previous function."""
    off = base + sec["offset"]
    size = sec["size"]
    if size < 28:
        return []
    version, _ceo, _cec, _po, _pc, idx_off, idx_count = struct.unpack_from("<7I", buf, off)
    if version != 1 or idx_off + 12 * idx_count > size:
        return []
    starts = set()
    for i in range(idx_count):
        func_off, page_off, _lsda = struct.unpack_from("<III", buf, off + idx_off + 12 * i)
        if i == idx_count - 1:
            break  # sentinel entry marks the end of the covered range
        starts.add(func_off)
        if not page_off or page_off + 8 > size:
            continue
        p = off + page_off
        kind = struct.unpack_from("<I", buf, p)[0]
        if kind == 2:  # UNWIND_SECOND_LEVEL_REGULAR
            entry_off, count = struct.unpack_from("<HH", buf, p + 4)
            for j in range(count):
                starts.add(struct.unpack_from("<I", buf, p + entry_off + 8 * j)[0])
        elif kind == 3:  # UNWIND_SECOND_LEVEL_COMPRESSED
            entry_off, count = struct.unpack_from("<HH", buf, p + 4)
            for j in range(count):
                e = struct.unpack_from("<I", buf, p + entry_off + 4 * j)[0]
                starts.add(func_off + (e & 0x00FFFFFF))
    return sorted(text_vmaddr + s for s in starts)


def encode_uleb128(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def fileoff_to_vmaddr(segments: list, fileoff: int):
    for s in segments:
        if s["filesize"] and s["fileoff"] <= fileoff < s["fileoff"] + s["filesize"]:
            return s["vmaddr"] + (fileoff - s["fileoff"])
    return None


def find_text_section(segments: list):
    for s in segments:
        for sec in s["sections"]:
            if sec["sect"] == "__text" and sec["seg"] == "__TEXT":
                return sec
    return None


def find_string_vmaddrs(buf, base: int, size: int, segments: list, needle: bytes) -> list:
    """vmaddr of the start of every C string containing `needle` in the slice."""
    out = []
    end = base + size
    pos = base
    while True:
        idx = buf.find(needle, pos, end)
        if idx < 0:
            break
        start = idx
        # Walk back to the start of the C string (the needle may be a suffix
        # of a longer literal, and the code references the literal's start).
        lim = max(base, idx - 256)
        while start > lim and buf[start - 1] != 0:
            start -= 1
        va = fileoff_to_vmaddr(segments, start - base)
        if va is not None and va not in out:
            out.append(va)
        pos = idx + 1
    return out


# ---------------------------------------------------------------------------
# arm64: ADRP + ADD string references
# ---------------------------------------------------------------------------

def _sign_extend(v: int, bits: int) -> int:
    if v & (1 << (bits - 1)):
        v -= 1 << bits
    return v


def decode_adrp(ins: int, pc: int):
    """(rd, page) if `ins` is ADRP, else None."""
    if ins & 0x9F000000 != 0x90000000:
        return None
    rd = ins & 0x1F
    immlo = (ins >> 29) & 0x3
    immhi = (ins >> 5) & 0x7FFFF
    imm = _sign_extend((immhi << 2) | immlo, 21) << 12
    return rd, (pc & ~0xFFF) + imm


def decode_add_imm(ins: int):
    """(rd, rn, imm) for 64-bit ADD (immediate), else None."""
    if ins & 0xFF800000 != 0x91000000:
        return None
    sh = (ins >> 22) & 1
    imm = (ins >> 10) & 0xFFF
    return ins & 0x1F, (ins >> 5) & 0x1F, imm << (12 * sh)


def encode_adrp(rd: int, pc: int, target: int) -> int:
    delta = ((target & ~0xFFF) - (pc & ~0xFFF)) >> 12
    delta &= (1 << 21) - 1
    return 0x90000000 | ((delta & 0x3) << 29) | ((delta >> 2) << 5) | rd


def encode_add_imm(rd: int, rn: int, imm: int) -> int:
    return 0x91000000 | ((imm & 0xFFF) << 10) | (rn << 5) | rd


def arm64_string_xrefs(buf, text: dict, slice_base: int, target_va: int,
                       lookback: int = 16) -> list:
    """vmaddrs of `ADD xd, xn, #lo` instructions that, together with an earlier
    `ADRP xn, page` (within `lookback` instructions), materialize target_va.

    Instead of decoding every instruction of a 100+ MB __text we regex for the
    ADD encoding with the right low-12 bits, then confirm the ADRP."""
    lo = target_va & 0xFFF
    page = target_va & ~0xFFF
    b1_lo = (lo & 0x3F) << 2
    pat = re.compile(
        b"(?s)." + b"[" + re.escape(bytes([b1_lo])) + b"-" + re.escape(bytes([b1_lo + 3])) + b"]"
        + re.escape(bytes([lo >> 6])) + b"\x91")
    start = slice_base + text["offset"]
    end = start + text["size"]
    out = []
    for m in pat.finditer(buf, start, end):
        p = m.start()
        if (p - start) % 4:
            continue
        ins = struct.unpack_from("<I", buf, p)[0]
        dec = decode_add_imm(ins)
        if dec is None:
            continue
        _rd, rn, imm = dec
        if imm != lo:
            continue
        pc = text["addr"] + (p - start)
        q = p - 4
        steps = 0
        while q >= start and steps < lookback:
            prev = struct.unpack_from("<I", buf, q)[0]
            adrp = decode_adrp(prev, text["addr"] + (q - start))
            if adrp is not None and adrp[0] == rn:
                if adrp[1] == page:
                    out.append(pc)
                break
            q -= 4
            steps += 1
    return out


# Prologue / terminator encodings used by the fallback function-entry search.
_PACIBSP = 0xD503237F
_NOP = 0xD503201F
_RET = 0xD65F03C0
_RETAB = 0xD65F0FFF


def _arm64_is_prologue(ins: int) -> bool:
    if ins == _PACIBSP:
        return True
    if ins & 0xFF8003FF == 0xD10003FF:                 # sub sp, sp, #imm
        return True
    if ins & 0xFFC003E0 == 0xA98003E0:                 # stp xA, xB, [sp, #-n]!
        rt, rt2 = ins & 0x1F, (ins >> 10) & 0x1F
        return 19 <= rt <= 29 and rt2 == rt + 1        # callee-saved pair / fp,lr
    return False


def _arm64_is_terminator(ins: int) -> bool:
    return (ins in (_RET, _RETAB, _NOP, 0)
            or ins & 0xFC000000 == 0x14000000          # b <imm>
            or ins & 0xFFFFFC1F == 0xD61F0000          # br xn
            or ins & 0xFFE0001F == 0xD4200000)         # brk #imm


def arm64_function_entry_heuristic(buf, text: dict, slice_base: int, pc: int,
                                   max_back: int = 0x4000, floor=None):
    """Walk back from `pc` to the first prologue instruction that directly
    follows a terminator (ret/b/br/brk/nop padding).

    `floor` is a known lower bound for the function start (from
    __unwind_info): with it we search back to the floor (no max_back cap)
    and fall back to the floor itself if nothing in between looks like an
    entry."""
    start = slice_base + text["offset"]
    p = start + (pc - text["addr"])
    if floor is not None and text["addr"] <= floor <= pc:
        lim = start + (floor - text["addr"])
    else:
        floor = None
        lim = p - max_back
    lim = max(lim, start + 4)
    while p >= lim:
        ins = struct.unpack_from("<I", buf, p)[0]
        if _arm64_is_prologue(ins):
            prev = struct.unpack_from("<I", buf, p - 4)[0]
            if _arm64_is_terminator(prev):
                return text["addr"] + (p - start)
        p -= 4
    return floor


# ---------------------------------------------------------------------------
# x86_64: RIP-relative LEA string references
# ---------------------------------------------------------------------------

_LEA_RIP = re.compile(b"(?s)[\x48\x4c]\x8d[\x05\x0d\x15\x1d\x25\x2d\x35\x3d]")


def x86_64_string_xrefs(buf, text: dict, slice_base: int, target_vas) -> dict:
    """{target_va: [lea_vmaddr, ...]} for `lea reg, [rip+disp32]`."""
    targets = set(target_vas)
    out = {t: [] for t in targets}
    start = slice_base + text["offset"]
    end = start + text["size"]
    for m in _LEA_RIP.finditer(buf, start, end - 7):
        p = m.start()
        disp = struct.unpack_from("<i", buf, p + 3)[0]
        va = text["addr"] + (p - start)
        tgt = va + 7 + disp
        if tgt in targets:
            out[tgt].append(va)
    return out


def x86_64_function_entry_heuristic(buf, text: dict, slice_base: int, pc: int,
                                    max_back: int = 0x4000, floor=None):
    """`push rbp; mov rbp, rsp` preceded by ret / int3 / nop padding.
    `floor` works like in arm64_function_entry_heuristic."""
    start = slice_base + text["offset"]
    p = start + (pc - text["addr"])
    if floor is not None and text["addr"] <= floor <= pc:
        lim = start + (floor - text["addr"])
    else:
        floor = None
        lim = p - max_back
    lim = max(lim, start + 1)
    while p >= lim:
        if bytes(buf[p:p + 4]) == b"\x55\x48\x89\xe5" and buf[p - 1] in (0xC3, 0xCC, 0x90, 0x00):
            return text["addr"] + (p - start)
        p -= 1
    return floor


# ---------------------------------------------------------------------------
# Function lookup
# ---------------------------------------------------------------------------

def containing_function(func_starts: list, pc: int):
    """Greatest function start <= pc (func_starts is sorted)."""
    lo, hi = 0, len(func_starts) - 1
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        if func_starts[mid] <= pc:
            best = func_starts[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def find_key_functions(buf, cputype: int = CPU_TYPE_ARM64) -> dict:
    """Locate nt_sqlite3_key_v2 candidates in a wrapper.node image.

    Returns {"funcs": [vmaddr, ...], "error": str|None, "detail": {...}}.
    Functions that reference BOTH log strings are listed first."""
    try:
        base, size = pick_slice(buf, cputype)
        info = parse_load_commands(buf, base)
    except (MachOError, struct.error) as e:
        return {"funcs": [], "error": str(e), "detail": {}}
    segments = info["segments"]
    text = find_text_section(segments)
    if text is None:
        return {"funcs": [], "error": "no __TEXT,__text section", "detail": {}}

    str_vas = {}
    for needle in KEY_FUNC_STRINGS:
        str_vas[needle] = find_string_vmaddrs(buf, base, size, segments, needle)
    primary = str_vas[KEY_FUNC_STRINGS[0]]
    if not primary:
        return {"funcs": [], "error": "log string 'nt_sqlite3_key_v2: db=' not found "
                                      "(incompatible wrapper.node?)", "detail": {}}

    xrefs = {}
    if cputype == CPU_TYPE_ARM64:
        for needle, vas in str_vas.items():
            xrefs[needle] = [x for va in vas for x in arm64_string_xrefs(buf, text, base, va)]
    else:
        all_vas = [va for vas in str_vas.values() for va in vas]
        hits = x86_64_string_xrefs(buf, text, base, all_vas)
        for needle, vas in str_vas.items():
            xrefs[needle] = [x for va in vas for x in hits.get(va, [])]

    starts = info["function_starts"]
    unwind = info["unwind_starts"]

    def entry_for(pc):
        # 1. LC_FUNCTION_STARTS is exact. 2. Otherwise walk back from the
        # xref to a prologue, never past the __unwind_info lower bound.
        if starts:
            f = containing_function(starts, pc)
            if f is not None:
                return f
        floor = containing_function(unwind, pc) if unwind else None
        if cputype == CPU_TYPE_ARM64:
            return arm64_function_entry_heuristic(buf, text, base, pc, floor=floor)
        return x86_64_function_entry_heuristic(buf, text, base, pc, floor=floor)

    primary_funcs = []
    for pc in xrefs[KEY_FUNC_STRINGS[0]]:
        f = entry_for(pc)
        if f is not None and f not in primary_funcs:
            primary_funcs.append(f)
    secondary = set()
    for pc in xrefs.get(KEY_FUNC_STRINGS[1], []):
        f = entry_for(pc)
        if f is not None:
            secondary.add(f)
    funcs = sorted(primary_funcs, key=lambda f: 0 if f in secondary else 1)
    detail = {"xrefs": {k.decode(): [hex(x) for x in v] for k, v in xrefs.items()},
              "used_function_starts": bool(starts),
              "unwind_entries": len(unwind)}
    if not funcs:
        return {"funcs": [], "error": "no code references the log string "
                                      "(function entry not found)", "detail": detail}
    return {"funcs": funcs[:4], "error": None, "detail": detail}


def find_key_functions_in_file(path: str, cputype: int = CPU_TYPE_ARM64) -> dict:
    with open(path, "rb") as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            return find_key_functions(mm, cputype)
        finally:
            mm.close()


# ---------------------------------------------------------------------------
# Candidate formatting (shared with the backend parser in qq_decrypt.py)
# ---------------------------------------------------------------------------

def candidate_strings(raw_by_source: list) -> list:
    """[(source, bytes)] -> [(source, text)] for printable ASCII values.
    Values are cut at the first NUL; empty / non-printable values dropped."""
    out = []
    for source, raw in raw_by_source:
        if raw is None:
            continue
        raw = bytes(raw).split(b"\x00", 1)[0]
        if not raw or len(raw) > MAX_READ:
            continue
        if any(b < 0x20 or b >= 0x7F for b in raw):
            continue
        out.append((source, raw.decode("ascii")))
    return out


def format_candidate(source: str, value: str) -> str:
    raw = value.encode("ascii")
    return "%s source=%s len=%d hex=%s" % (MARKER, source, len(raw), raw.hex())


def format_status(stage: str, **fields) -> str:
    extra = "".join(" %s=%s" % (k, str(v).replace(" ", "_")) for k, v in fields.items())
    return "%s stage=%s%s" % (STATUS, stage, extra)


def is_plausible_key(value: str) -> bool:
    return len(value) == 16 and value != LOGIN_DB_FIXED_KEY and not LOGIN_DB_FIXED_KEY.startswith(value)


class SettleTracker:
    """Decides when to start the settle countdown, same rule as the Windows
    script (qq_get_key.ps1): after login QQ opens several DBs with the same
    key, so a plausible 16-char value that shows up in TWO DIFFERENT
    breakpoint hits means the key has been seen. A single stray string
    before login must not end the session early."""

    def __init__(self, needed: int = 2):
        self.needed = needed
        self.counts: dict = {}
        self.last_hit: dict = {}
        self.triggered = False

    def observe(self, hit_no: int, value: str) -> bool:
        """Record `value` seen at breakpoint hit `hit_no`. Returns True exactly
        once: when the countdown should start."""
        if self.triggered or not is_plausible_key(value):
            return False
        if self.last_hit.get(value) == hit_no:
            return False  # same value in two registers of one hit counts once
        self.last_hit[value] = hit_no
        self.counts[value] = self.counts.get(value, 0) + 1
        if self.counts[value] >= self.needed:
            self.triggered = True
            return True
        return False


# ---------------------------------------------------------------------------
# lldb driver (only runs inside lldb)
# ---------------------------------------------------------------------------

def _emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _read_c_string(process, addr: int, n: int = MAX_READ):
    import lldb  # type: ignore
    if not addr:
        return None
    err = lldb.SBError()
    raw = process.ReadMemory(addr, n, err)
    if not err.Success() or raw is None:
        # Maybe crosses into an unmapped page — retry shorter.
        err = lldb.SBError()
        raw = process.ReadMemory(addr, 16, err)
        if not err.Success() or raw is None:
            return None
    return raw


def _read_exact(process, addr: int, n: int):
    import lldb  # type: ignore
    if not addr or n <= 0 or n > MAX_READ:
        return None
    err = lldb.SBError()
    raw = process.ReadMemory(addr, n, err)
    return raw if err.Success() else None


def _register(frame, name: str) -> int:
    v = frame.FindRegister(name)
    if not v or not v.IsValid():
        return 0
    return v.GetValueAsUnsigned()


def _hit_candidates(process, frame, is_arm: bool) -> list:
    if is_arm:
        key_ptr, key_len = _register(frame, "x2"), _register(frame, "x3")
        others = ("x1", "x2", "x3", "x4")
        exact_src = "x2"
    else:
        key_ptr, key_len = _register(frame, "rdx"), _register(frame, "rcx")
        others = ("rsi", "rdx", "rcx", "r8")
        exact_src = "rdx"
    raw = [(exact_src, _read_exact(process, key_ptr, key_len))]
    for reg in others:
        raw.append((reg + "*", _read_c_string(process, _register(frame, reg))))
    return candidate_strings(raw)


def _find_wrapper_module(target):
    for i in range(target.GetNumModules()):
        mod = target.GetModuleAtIndex(i)
        if mod.GetFileSpec().GetFilename() == "wrapper.node":
            return mod
    return None


def _set_key_breakpoints(target, module, is_arm: bool) -> list:
    import lldb  # type: ignore
    path = module.GetFileSpec().fullpath
    bp_ids = []
    # 1. Symbols (in case a build ships them).
    for name in KEY_FUNC_SYMBOLS:
        for ctx in module.FindFunctions(name):
            addr = ctx.GetSymbol().GetStartAddress()
            load = addr.GetLoadAddress(target)
            if load != lldb.LLDB_INVALID_ADDRESS:
                bp = target.BreakpointCreateByAddress(load)
                if bp.IsValid():
                    bp_ids.append(bp.GetID())
    if bp_ids:
        _emit(format_status("bp_set", via="symbol", count=len(bp_ids)))
        return bp_ids
    # 2. String cross-reference in the file actually loaded (after a QQ hot
    #    update this lives under .../QQ/versions/<ver>/, not /Applications).
    t0 = time.time()
    res = find_key_functions_in_file(path, CPU_TYPE_ARM64 if is_arm else CPU_TYPE_X86_64)
    if res["error"]:
        _emit(format_status("analyze_failed", error=res["error"]))
        return []
    for va in res["funcs"]:
        addr = module.ResolveFileAddress(va)
        load = addr.GetLoadAddress(target)
        if load == lldb.LLDB_INVALID_ADDRESS:
            continue
        bp = target.BreakpointCreateByAddress(load)
        if bp.IsValid():
            bp_ids.append(bp.GetID())
            _emit(format_status("bp_addr", va=hex(va), load=hex(load)))
    _emit(format_status("bp_set", via="xref", count=len(bp_ids),
                        ms=int((time.time() - t0) * 1000)))
    return bp_ids


def murmur_qq_capture(debugger, command, result, internal_dict):
    """lldb command: wait for QQ, breakpoint nt_sqlite3_key_v2, print candidates."""
    import lldb  # type: ignore
    import subprocess
    import threading

    app = os.environ.get("MURMUR_QQ_APP", "/Applications/QQ.app")
    pname = os.environ.get("MURMUR_QQ_PROCESS", "QQ")
    timeout = _env_int("MURMUR_QQ_TIMEOUT", 200)
    settle = _env_int("MURMUR_QQ_SETTLE", 15)
    max_hits = _env_int("MURMUR_QQ_MAX_HITS", 200)
    cancel_file = os.environ.get("MURMUR_QQ_CANCEL_FILE", "")
    t_start = time.time()

    def cancelled() -> bool:
        return bool(cancel_file) and os.path.exists(cancel_file)

    # Watchdog: a waitfor attach blocks with no timeout of its own.
    attached = {"v": False}

    def watchdog():
        while True:
            time.sleep(0.5)
            if attached["v"]:
                return
            if time.time() - t_start > min(timeout, 90) or cancelled():
                _emit(format_status("attach_timeout"))
                os._exit(3)
    threading.Thread(target=watchdog, daemon=True).start()

    def launch():
        time.sleep(1.0)
        try:
            subprocess.Popen(["open", app])
            _emit(format_status("launched", app=app))
        except Exception as e:  # noqa: BLE001
            _emit(format_status("launch_failed", error=e))
    if os.environ.get("MURMUR_QQ_NO_LAUNCH") != "1":
        threading.Thread(target=launch, daemon=True).start()

    _emit(format_status("waiting", process=pname))
    debugger.SetAsync(False)
    target = debugger.CreateTarget("")
    info = lldb.SBAttachInfo(pname, True)
    err = lldb.SBError()
    process = target.Attach(info, err)
    attached["v"] = True
    if not err.Success() or not process or not process.IsValid():
        _emit(format_status("attach_failed", error=err.GetCString() or "unknown"))
        return
    _emit(format_status("attached", pid=process.GetProcessID()))
    is_arm = "arm64" in (target.GetTriple() or "") or "aarch64" in (target.GetTriple() or "")

    bp_ids = []
    mod = _find_wrapper_module(target)
    if mod is not None:
        bp_ids = _set_key_breakpoints(target, mod, is_arm)
    else:
        debugger.HandleCommand("settings set target.process.stop-on-sharedlibrary-events true")

    debugger.SetAsync(True)
    listener = debugger.GetListener()
    seen = set()
    tracker = SettleTracker()
    hits = 0
    first_key_at = None
    reason = "timeout"
    process.Continue()

    while True:
        now = time.time()
        if cancelled():
            reason = "cancelled"
            break
        if now - t_start > timeout:
            reason = "timeout"
            break
        if first_key_at is not None and now - first_key_at > settle:
            reason = "settled"
            break
        if hits >= max_hits:
            reason = "max_hits"
            break
        ev = lldb.SBEvent()
        if not listener.WaitForEvent(1, ev):
            continue
        if not lldb.SBProcess.EventIsProcessEvent(ev):
            continue
        state = lldb.SBProcess.GetStateFromEvent(ev)
        if state in (lldb.eStateExited, lldb.eStateCrashed, lldb.eStateDetached):
            reason = "process_gone"
            break
        if state != lldb.eStateStopped or lldb.SBProcess.GetRestartedFromEvent(ev):
            continue

        if not bp_ids:
            mod = _find_wrapper_module(target)
            if mod is not None:
                debugger.HandleCommand("settings set target.process.stop-on-sharedlibrary-events false")
                _emit(format_status("module", path=mod.GetFileSpec().fullpath))
                bp_ids = _set_key_breakpoints(target, mod, is_arm)
                if not bp_ids:
                    reason = "no_breakpoint"
                    break
                _emit(format_status("ready"))

        for thread in process:
            if thread.GetStopReason() != lldb.eStopReasonBreakpoint:
                continue
            if thread.GetStopReasonDataAtIndex(0) not in bp_ids:
                continue
            hits += 1
            for source, value in _hit_candidates(process, thread.GetFrameAtIndex(0), is_arm):
                if value not in seen:
                    seen.add(value)
                    _emit(format_candidate(source, value))
                if tracker.observe(hits, value) and first_key_at is None:
                    first_key_at = time.time()
                    _emit(format_status("key_seen", settle=settle))
            _emit(format_status("hit", n=hits))
        process.Continue()

    _emit(format_status("finishing", reason=reason, hits=hits))
    for bid in bp_ids:
        target.BreakpointDelete(bid)
    if process.IsValid() and process.GetState() not in (lldb.eStateExited, lldb.eStateDetached):
        derr = process.Detach()
        if not derr.Success():
            process.Stop()
            process.Detach()
    _emit(format_status("done", reason=reason, hits=hits))


def __lldb_init_module(debugger, internal_dict):  # pragma: no cover - lldb only
    debugger.HandleCommand(
        "command script add -f %s.murmur_qq_capture murmur_qq_capture" % __name__)
