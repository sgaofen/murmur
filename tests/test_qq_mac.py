"""macOS QQ NT support: data-dir discovery, wrapper.node analysis for the lldb
capture script, lldb output parsing → candidate verification, and the
re-sign / lldb command builders.

None of this needs lldb, codesign or a real QQ install: Mach-O images are
synthesized in memory and the "lldb output" is the text the capture script
would print.
"""
import importlib.util
import os
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))
sys.path.insert(0, str(ROOT / "tests"))

import qq_decrypt  # noqa: E402
import qq_mac_key  # noqa: E402
import qq_paths  # noqa: E402

from test_qq_key_candidates import REAL_KEY, make_fake_nt_msg_db  # noqa: E402


def _load_capture_module():
    path = ROOT / "cli" / "native" / "qq_lldb_capture.py"
    spec = importlib.util.spec_from_file_location("qq_lldb_capture", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # must import without lldb
    return mod


cap = _load_capture_module()


def make_mac_account(base: Path, acc: str, with_db: bool = True) -> Path:
    nt_db = base / f"nt_qq_{acc}" / "nt_db"
    nt_db.mkdir(parents=True, exist_ok=True)
    if with_db:
        (nt_db / "nt_msg.db").write_bytes(b"\x00" * 16)
    return nt_db


# ---------------------------------------------------------------------------
# 1. Data-directory discovery
# ---------------------------------------------------------------------------

class MacPathDiscoveryTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self.container = (self.home / "Library" / "Containers" / "com.tencent.qq" / "Data"
                          / "Library" / "Application Support" / "QQ")
        self.appsupport = self.home / "Library" / "Application Support" / "QQ"
        p = mock.patch.object(qq_paths, "_qq_root_config_paths", return_value=[])
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self):
        self._tmp.cleanup()

    def test_search_paths_cover_container_and_app_support(self):
        roots = qq_paths._mac_qq_search_paths(self.home)
        self.assertIn(self.container, roots)
        self.assertIn(self.appsupport, roots)
        self.assertLess(roots.index(self.container), roots.index(self.appsupport))

    def test_finds_multiple_accounts_across_roots(self):
        make_mac_account(self.container, "a1b2c3d4e5f60718293a4b5c6d7e8f90")
        make_mac_account(self.container, "ffff0000ffff0000ffff0000ffff0000")
        make_mac_account(self.appsupport, "0123456789abcdef0123456789abcdef")
        # noise: no nt_msg.db yet, unrelated folders, global data dir
        make_mac_account(self.appsupport, "deadbeefdeadbeef", with_db=False)
        (self.appsupport / "global" / "nt_data").mkdir(parents=True)
        (self.appsupport / "versions" / "6.9.96").mkdir(parents=True)

        profs = qq_paths._discover_mac_profiles(qq_paths._mac_qq_search_paths(self.home))
        ids = [p.qq_number for p in profs]
        self.assertEqual(ids, ["a1b2c3d4e5f60718293a4b5c6d7e8f90",
                               "ffff0000ffff0000ffff0000ffff0000",
                               "0123456789abcdef0123456789abcdef"])
        first = profs[0]
        self.assertEqual(first.nt_db_dir, self.container / f"nt_qq_{ids[0]}" / "nt_db")
        self.assertEqual(first.tencent_files_root, self.container)
        self.assertFalse(qq_paths.qq_tcc_blocked())

    def test_windows_style_layout_under_custom_root(self):
        acct = self.home / "Backup" / "123456789" / "nt_qq" / "nt_db"
        acct.mkdir(parents=True)
        (acct / "nt_msg.db").write_bytes(b"x")
        profs = qq_paths._discover_mac_profiles([self.home / "Backup"])
        self.assertEqual([p.qq_number for p in profs], ["123456789"])
        self.assertEqual(profs[0].nt_db_dir, acct)

    def test_root_pointing_at_account_folder(self):
        nt_db = make_mac_account(self.appsupport, "abcdef012345")
        profs = qq_paths._discover_mac_profiles([nt_db.parent])
        self.assertEqual([p.qq_number for p in profs], ["abcdef012345"])
        self.assertEqual(profs[0].tencent_files_root, self.appsupport)

    def test_dedupes_same_account_seen_twice(self):
        nt_db = make_mac_account(self.appsupport, "abcdef012345")
        profs = qq_paths._discover_mac_profiles([self.appsupport, nt_db.parent, self.appsupport])
        self.assertEqual(len(profs), 1)

    def test_tcc_blocked_container_is_reported(self):
        make_mac_account(self.container, "a1b2c3d4e5f6")
        make_mac_account(self.appsupport, "0f0f0f0f0f0f")
        real = qq_paths._listdir_with_timeout

        def fake_listdir(p, timeout_s=1.5):
            if p == self.container:
                return None  # what paths._safe_listdir returns on EPERM / hang
            return real(p, timeout_s)

        with mock.patch.object(qq_paths, "_listdir_with_timeout", side_effect=fake_listdir):
            profs = qq_paths._discover_mac_profiles(qq_paths._mac_qq_search_paths(self.home))
        self.assertTrue(qq_paths.qq_tcc_blocked())
        self.assertEqual([p.qq_number for p in profs], ["0f0f0f0f0f0f"])

    def test_missing_dirs_are_not_tcc_blocked(self):
        profs = qq_paths._discover_mac_profiles(qq_paths._mac_qq_search_paths(self.home))
        self.assertEqual(profs, [])
        self.assertFalse(qq_paths.qq_tcc_blocked())

    def test_discover_qq_profiles_dispatches_to_mac(self):
        make_mac_account(self.appsupport, "abcdef012345")
        with mock.patch.object(qq_paths, "IS_MAC", True), \
                mock.patch.object(qq_paths, "IS_WINDOWS", False), \
                mock.patch.object(qq_paths, "_mac_qq_search_paths",
                                  return_value=[self.container, self.appsupport]):
            profs = qq_paths.discover_qq_profiles()
            roots = qq_paths.qq_search_paths()
        self.assertEqual([p.qq_number for p in profs], ["abcdef012345"])
        self.assertEqual(roots, [self.container, self.appsupport])

    def test_normalize_mac_pasted_paths(self):
        nt_db = make_mac_account(self.appsupport, "abcdef012345")
        for pasted in (self.appsupport, nt_db.parent, nt_db, nt_db / "nt_msg.db"):
            got = qq_paths._normalize_qq_root(pasted)
            self.assertEqual(Path(os.path.realpath(got)), Path(os.path.realpath(self.appsupport)),
                             msg=str(pasted))

    def test_account_regex_rejects_non_account_names(self):
        for name in ("nt_qq_", "nt_qq_ab", "nt_qq_abc/def", "nt_qq", "global"):
            self.assertIsNone(qq_paths._MAC_ACCOUNT_RE.match(name), msg=name)
        self.assertIsNotNone(qq_paths._MAC_ACCOUNT_RE.match("nt_qq_ABCdef0123"))

    def test_parse_mac_qq_ps(self):
        out = "\n".join([
            "  501 /Applications/QQ.app/Contents/MacOS/QQ",
            "  502 /Applications/QQ.app/Contents/Frameworks/QQ Helper (Renderer).app/Contents/MacOS/QQ Helper (Renderer) --type=renderer",
            "  503 /Applications/QQ.app/Contents/MacOS/QQ --some-flag",
            "  504 /Applications/QQMusic.app/Contents/MacOS/QQMusic",
            "  505 /Applications/WeChat.app/Contents/MacOS/WeChat",
            "garbage line",
        ])
        self.assertEqual(qq_paths.parse_mac_qq_ps(out), [501, 503])


# ---------------------------------------------------------------------------
# 2. wrapper.node analysis (synthetic Mach-O)
# ---------------------------------------------------------------------------

TEXT_ADDR = 0x1000
CSTR_ADDR = 0x3000
LINKEDIT_OFF = 0x4000
STR_DB = b"nt_sqlite3_key_v2: db=%p zDb=%s\x00"
STR_NOKEY = b"nt_sqlite3_key_v2: no key\x00"

ARM_RET = 0xD65F03C0
ARM_NOP = 0xD503201F
ARM_PACIBSP = 0xD503237F
ARM_STP_FP_LR = 0xA9BF7BFD   # stp x29, x30, [sp, #-16]!
ARM_MOV_FP = 0x910003FD      # mov x29, sp
ARM_SUB_SP = 0xD10083FF      # sub sp, sp, #0x20
ARM_LDP_FP_LR = 0xA8C17BFD   # ldp x29, x30, [sp], #16


UNWIND_ADDR = 0x3800


def build_unwind_info(starts, compressed_starts=()) -> bytes:
    """__unwind_info with one regular second-level page listing `starts` and
    (optionally) one compressed page listing `compressed_starts`."""
    header_len = 28
    idx_count = 1 + (1 if compressed_starts else 0) + 1  # + sentinel
    idx_off = header_len
    page1 = header_len + 12 * idx_count
    reg = struct.pack("<IHH", 2, 8, len(starts)) + b"".join(
        struct.pack("<II", s, 0x04000000) for s in starts)
    page2 = page1 + len(reg)
    comp = b""
    if compressed_starts:
        first = compressed_starts[0]
        comp = struct.pack("<IHHHH", 3, 12, len(compressed_starts), 0, 0) + b"".join(
            struct.pack("<I", s - first) for s in compressed_starts)
    entries = struct.pack("<III", starts[0], page1, 0)
    if compressed_starts:
        entries += struct.pack("<III", compressed_starts[0], page2, 0)
    entries += struct.pack("<III", 0x3000, 0, 0)
    head = struct.pack("<7I", 1, header_len, 0, header_len, 0, idx_off, idx_count)
    return head + entries + reg + comp


def build_macho(cputype, text: bytes, cstrings: bytes, func_starts=None, unwind=None) -> bytes:
    """Thin 64-bit Mach-O: __TEXT (vmaddr 0, fileoff 0) with __text at 0x1000
    and __cstring at 0x3000, optional __unwind_info at 0x3800 and optional
    __LINKEDIT + LC_FUNCTION_STARTS."""
    assert len(text) <= CSTR_ADDR - TEXT_ADDR
    assert len(cstrings) <= UNWIND_ADDR - CSTR_ADDR
    cmds = b""
    nsects = 3 if unwind else 2
    seg_size = 72 + 80 * nsects
    seg = struct.pack("<II16sQQQQiiII", 0x19, seg_size, b"__TEXT", 0, LINKEDIT_OFF,
                      0, LINKEDIT_OFF, 5, 5, nsects, 0)
    sect_text = struct.pack("<16s16sQQIIIIIIII", b"__text", b"__TEXT", TEXT_ADDR, len(text),
                            TEXT_ADDR, 2, 0, 0, 0x80000400, 0, 0, 0)
    sect_cstr = struct.pack("<16s16sQQIIIIIIII", b"__cstring", b"__TEXT", CSTR_ADDR,
                            len(cstrings), CSTR_ADDR, 0, 0, 0, 2, 0, 0, 0)
    cmds += seg + sect_text + sect_cstr
    if unwind:
        cmds += struct.pack("<16s16sQQIIIIIIII", b"__unwind_info", b"__TEXT", UNWIND_ADDR,
                            len(unwind), UNWIND_ADDR, 2, 0, 0, 0, 0, 0, 0)
    fs_blob = b""
    if func_starts:
        prev = 0
        for a in func_starts:
            fs_blob += cap.encode_uleb128(a - prev)
            prev = a
        fs_blob += b"\x00"
        fs_blob += b"\x00" * (-len(fs_blob) % 8)
        cmds += struct.pack("<II16sQQQQiiII", 0x19, 72, b"__LINKEDIT", LINKEDIT_OFF, 0x1000,
                            LINKEDIT_OFF, len(fs_blob), 1, 1, 0, 0)
        cmds += struct.pack("<IIII", 0x26, 16, LINKEDIT_OFF, len(fs_blob))
    ncmds = 1 + (2 if func_starts else 0)
    header = struct.pack("<IIIIIIII", 0xFEEDFACF, cputype, 0, 8, ncmds, len(cmds), 0, 0)
    img = bytearray(LINKEDIT_OFF + len(fs_blob))
    img[0:len(header) + len(cmds)] = header + cmds
    img[TEXT_ADDR:TEXT_ADDR + len(text)] = text
    img[CSTR_ADDR:CSTR_ADDR + len(cstrings)] = cstrings
    if unwind:
        img[UNWIND_ADDR:UNWIND_ADDR + len(unwind)] = unwind
    img[LINKEDIT_OFF:LINKEDIT_OFF + len(fs_blob)] = fs_blob
    return bytes(img)


def build_fat(slices) -> bytes:
    """Fat binary from [(cputype, thin_bytes)], slices aligned to 0x4000."""
    hdr = struct.pack(">II", 0xCAFEBABE, len(slices))
    off = 0x4000
    entries = b""
    body = b""
    for ct, data in slices:
        entries += struct.pack(">iiIII", ct, 0, off, len(data), 14)
        pad = (off - 0x4000) - len(body)
        body += b"\x00" * pad + data
        off += len(data) + (-len(data) % 0x4000)
    out = bytearray(0x4000)
    out[:len(hdr) + len(entries)] = hdr + entries
    return bytes(out) + body


def arm_words(words) -> bytes:
    return b"".join(struct.pack("<I", w) for w in words)


def build_arm64_wrapper(with_function_starts: bool, unwind_starts=None, odd_prologue=False):
    """func A @0x1000 (unrelated), func B @0x1040 = nt_sqlite3_key_v2
    (references both log strings deep inside), func C @0x1200 (decoy ADD
    with the same low 12 bits but a different ADRP page).

    odd_prologue: func B starts with `mov x8, x0` (no recognizable prologue),
    so only __unwind_info can pin its entry."""
    cstr = b"\x00junk\x00" + STR_DB + b"other\x00" + STR_NOKEY
    db_va = CSTR_ADDR + cstr.index(STR_DB)
    nk_va = CSTR_ADDR + cstr.index(STR_NOKEY)

    words = {}
    # func A
    a = [ARM_PACIBSP, ARM_SUB_SP] + [ARM_NOP] * 12 + [ARM_LDP_FP_LR, ARM_RET]
    for i, w in enumerate(a):
        words[0x1000 + 4 * i] = w
    # func B
    b_start = 0x1040
    body = [0xAA0003E8 if odd_prologue else ARM_STP_FP_LR, ARM_MOV_FP] + [ARM_NOP] * 20
    pc_adrp1 = b_start + 4 * len(body)
    body += [cap.encode_adrp(8, pc_adrp1, db_va), ARM_NOP, cap.encode_add_imm(1, 8, db_va & 0xFFF)]
    body += [ARM_NOP] * 10
    pc_adrp2 = b_start + 4 * len(body)
    body += [cap.encode_adrp(9, pc_adrp2, nk_va), cap.encode_add_imm(0, 9, nk_va & 0xFFF)]
    body += [ARM_LDP_FP_LR, ARM_RET]
    for i, w in enumerate(body):
        words[b_start + 4 * i] = w
    xref_pc = pc_adrp1 + 8
    # func C — decoy: ADRP to a page 0x10000 away, same low bits.
    c_start = 0x1200
    pc_c = c_start + 8
    decoy = [ARM_STP_FP_LR, ARM_MOV_FP, cap.encode_adrp(2, pc_c, db_va + 0x10000),
             cap.encode_add_imm(2, 2, db_va & 0xFFF), ARM_LDP_FP_LR, ARM_RET]
    for i, w in enumerate(decoy):
        words[c_start + 4 * i] = w
    end = max(words) + 4
    text = arm_words(words.get(a_, 0) for a_ in range(TEXT_ADDR, end, 4))
    starts = [0x1000, b_start, c_start] if with_function_starts else None
    unwind = build_unwind_info(unwind_starts) if unwind_starts else None
    return (build_macho(cap.CPU_TYPE_ARM64, text, cstr, starts, unwind),
            b_start, xref_pc, db_va)


class Arm64EncodingTest(unittest.TestCase):
    def test_adrp_roundtrip_forward_and_backward(self):
        for pc, target in ((0x1000, 0x3123), (0x7F000, 0x1234), (0x100000, 0x100FFF)):
            rd, page = cap.decode_adrp(cap.encode_adrp(5, pc, target), pc)
            self.assertEqual(rd, 5)
            self.assertEqual(page, target & ~0xFFF)

    def test_add_imm_decode(self):
        self.assertEqual(cap.decode_add_imm(cap.encode_add_imm(1, 8, 0x123)), (1, 8, 0x123))
        self.assertIsNone(cap.decode_add_imm(ARM_NOP))

    def test_uleb128_roundtrip(self):
        blob = b"".join(cap.encode_uleb128(v) for v in (0x1000, 0x40, 0x1C0)) + b"\x00"
        self.assertEqual(cap.decode_function_starts(blob, 0), [0x1000, 0x1040, 0x1200])


class WrapperAnalysisTest(unittest.TestCase):
    def test_arm64_with_function_starts(self):
        img, func_b, xref_pc, db_va = build_arm64_wrapper(True)
        res = cap.find_key_functions(img, cap.CPU_TYPE_ARM64)
        self.assertIsNone(res["error"])
        self.assertEqual(res["funcs"], [func_b])
        self.assertTrue(res["detail"]["used_function_starts"])
        self.assertEqual(res["detail"]["xrefs"]["nt_sqlite3_key_v2: db="], [hex(xref_pc)])

    def test_arm64_prologue_heuristic_without_function_starts(self):
        img, func_b, _xref, _db = build_arm64_wrapper(False)
        res = cap.find_key_functions(img, cap.CPU_TYPE_ARM64)
        self.assertIsNone(res["error"])
        self.assertEqual(res["funcs"], [func_b])
        self.assertFalse(res["detail"]["used_function_starts"])

    def test_unwind_info_regular_and_compressed_pages(self):
        unwind = build_unwind_info([0x1000, 0x1040], [0x1200, 0x1230])
        img = build_macho(cap.CPU_TYPE_ARM64, arm_words([ARM_RET] * 4), b"\x00", unwind=unwind)
        info = cap.parse_load_commands(img, 0)
        self.assertEqual(info["unwind_starts"], [0x1000, 0x1040, 0x1200, 0x1230])

    def test_unwind_floor_with_merged_entry(self):
        # The linker folded func B into func A's unwind entry: the floor is
        # A's start, but the prologue walk still finds B above it.
        img, func_b, _x, _db = build_arm64_wrapper(False, unwind_starts=[0x1000, 0x1200])
        res = cap.find_key_functions(img, cap.CPU_TYPE_ARM64)
        self.assertEqual(res["funcs"], [func_b])
        self.assertEqual(res["detail"]["unwind_entries"], 2)

    def test_unwind_floor_rescues_unrecognized_prologue(self):
        img, func_b, _x, _db = build_arm64_wrapper(False, odd_prologue=True)
        self.assertNotEqual(cap.find_key_functions(img, cap.CPU_TYPE_ARM64)["funcs"], [func_b])
        img, func_b, _x, _db = build_arm64_wrapper(
            False, unwind_starts=[0x1000, 0x1040, 0x1200], odd_prologue=True)
        self.assertEqual(cap.find_key_functions(img, cap.CPU_TYPE_ARM64)["funcs"], [func_b])

    def test_string_vmaddr_points_at_c_string_start(self):
        img, _f, _x, db_va = build_arm64_wrapper(True)
        base, size = cap.pick_slice(img, cap.CPU_TYPE_ARM64)
        segs = cap.parse_load_commands(img, base)["segments"]
        # searching for a suffix still yields the literal's first byte
        self.assertEqual(cap.find_string_vmaddrs(img, base, size, segs, b"zDb=%s"), [db_va])

    def test_fat_binary_picks_requested_slice(self):
        arm, func_b, _x, _db = build_arm64_wrapper(True)
        x86 = build_macho(cap.CPU_TYPE_X86_64, b"\xcc" * 64, b"\x00nothing here\x00")
        fat = build_fat([(cap.CPU_TYPE_X86_64, x86), (cap.CPU_TYPE_ARM64, arm)])
        res = cap.find_key_functions(fat, cap.CPU_TYPE_ARM64)
        self.assertEqual(res["funcs"], [func_b])
        # the x86_64 slice has no log string
        self.assertIn("not found", cap.find_key_functions(fat, cap.CPU_TYPE_X86_64)["error"])

    def test_x86_64_lea_xref(self):
        cstr = b"\x00" + STR_DB + STR_NOKEY
        db_va = CSTR_ADDR + 1
        text = bytearray()
        text += b"\x55\x48\x89\xe5" + b"\x90" * 8 + b"\x5d\xc3"        # func A @0x1000
        text += b"\xcc" * (0x20 - len(text))
        func_b = TEXT_ADDR + len(text)                                  # func B @0x1020
        text += b"\x55\x48\x89\xe5" + b"\x90" * 16
        lea_va = TEXT_ADDR + len(text)
        disp = db_va - (lea_va + 7)
        text += b"\x48\x8d\x3d" + struct.pack("<i", disp)               # lea rdi, [rip+str]
        text += b"\x90" * 4 + b"\x5d\xc3"
        img = build_macho(cap.CPU_TYPE_X86_64, bytes(text), cstr)
        res = cap.find_key_functions(img, cap.CPU_TYPE_X86_64)
        self.assertIsNone(res["error"])
        self.assertEqual(res["funcs"], [func_b])

    def test_missing_string_and_garbage(self):
        img = build_macho(cap.CPU_TYPE_ARM64, arm_words([ARM_RET]), b"\x00hello\x00")
        self.assertIn("not found", cap.find_key_functions(img)["error"])
        self.assertIsNotNone(cap.find_key_functions(b"not a mach-o at all")["error"])

    def test_find_in_file_uses_mmap(self):
        img, func_b, _x, _db = build_arm64_wrapper(True)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "wrapper.node"
            p.write_bytes(img)
            self.assertEqual(cap.find_key_functions_in_file(str(p))["funcs"], [func_b])


# ---------------------------------------------------------------------------
# 3. lldb output parsing → #30 candidate filter + HMAC verification
# ---------------------------------------------------------------------------

class CaptureOutputTest(unittest.TestCase):
    def test_candidate_strings_cut_and_filter(self):
        got = cap.candidate_strings([
            ("x2", REAL_KEY.encode() + b"\x00garbage"),
            ("x1*", b"main\x00"),
            ("x3*", b"\x01\x02binary"),
            ("x4*", None),
            ("x0*", b""),
        ])
        self.assertEqual(got, [("x2", REAL_KEY), ("x1*", "main")])

    def test_format_candidate_roundtrips_through_backend_parser(self):
        line = cap.format_candidate("x2", REAL_KEY)
        self.assertEqual(qq_decrypt.parse_key_candidates(line),
                         [{"source": "x2", "value": REAL_KEY}])

    def test_status_line_roundtrip(self):
        line = cap.format_status("bp_set", via="xref", count=1, error="a b")
        self.assertEqual(qq_mac_key.parse_status_line("(lldb) " + line),
                         {"stage": "bp_set", "via": "xref", "count": "1", "error": "a_b"})
        self.assertIsNone(qq_mac_key.parse_status_line("MURMUR_STATUS nothing"))
        self.assertIsNone(qq_mac_key.parse_status_line("random"))

    def test_plausible_key(self):
        self.assertTrue(cap.is_plausible_key(REAL_KEY))
        self.assertFalse(cap.is_plausible_key("BD156D6710D54D87"))  # login.db key prefix
        self.assertFalse(cap.is_plausible_key("short"))

    def test_simulated_lldb_session_verifies_real_key(self):
        log = "\n".join([
            "(lldb) command script import \"/x/qq_lldb_capture.py\"",
            cap.format_status("waiting", process="QQ"),
            cap.format_status("attached", pid=4242),
            cap.format_status("bp_set", via="xref", count=1),
            cap.format_candidate("x2", "BD156D6710D54D8782F4"),   # login.db first
            cap.format_candidate("x1*", "main"),
            cap.format_status("hit", n=1),
            cap.format_candidate("x2", "0123456789abcdefABCD"),   # zDb-like hex
            cap.format_candidate("x2", "wrongwrongwrong!"),
            cap.format_candidate("x2", REAL_KEY),
            cap.format_status("done", reason="settled", hits=3),
        ])
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "nt_msg.db"
            make_fake_nt_msg_db(db, REAL_KEY)
            res = qq_decrypt.finish_extraction(log, [("abcdef012345", db)])
        self.assertTrue(res["ok"], res["error"])
        self.assertEqual(res["key"], REAL_KEY)
        self.assertEqual(res["qq"], "abcdef012345")
        statuses = [s for s in res["candidates"] if s["status"] == "skipped"]
        self.assertEqual(len(statuses), 2)  # login key + hex zDb

    def test_wrong_candidates_never_returned(self):
        log = cap.format_candidate("x2", "wrongwrongwrong!")
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "nt_msg.db"
            make_fake_nt_msg_db(db, REAL_KEY, hmac_hash="sha512")
            res = qq_decrypt.finish_extraction(log, [("abc", db)])
        self.assertFalse(res["ok"])
        self.assertIsNone(res["key"])

    def test_failure_hints(self):
        st = qq_mac_key.parse_status_line
        self.assertIn("没能附加", qq_mac_key.failure_hint(
            [st(cap.format_status("waiting")), st(cap.format_status("attach_failed", error="denied"))]))
        self.assertIn("没找到 nt_sqlite3_key_v2", qq_mac_key.failure_hint(
            [st(cap.format_status("attached")), st(cap.format_status("analyze_failed", error="x"))]))
        self.assertIn("退出账号", qq_mac_key.failure_hint(
            [st(cap.format_status("attached")), st(cap.format_status("bp_set", count=1))]))
        self.assertIn("没有启动", qq_mac_key.failure_hint([st(cap.format_status("attach_timeout"))]))
        self.assertIsNone(qq_mac_key.failure_hint([]))


# ---------------------------------------------------------------------------
# 3b. The lldb driver loop, against a fake `lldb` module
# ---------------------------------------------------------------------------

class _FakeLLDB:
    """Just enough of the SB API for murmur_qq_capture's control flow."""
    eStateStopped, eStateRunning, eStateCrashed, eStateDetached, eStateExited = 5, 6, 8, 9, 10
    eStopReasonNone, eStopReasonBreakpoint = 0, 3
    LLDB_INVALID_ADDRESS = 0xFFFFFFFFFFFFFFFF

    class SBError:
        def __init__(self, ok=True):
            self.ok = ok

        def Success(self):
            return self.ok

        def GetCString(self):
            return None if self.ok else "denied"

    class SBAttachInfo:
        def __init__(self, name, wait):
            self.name, self.wait = name, wait

    class SBEvent:
        def __init__(self):
            self.payload = None

    class SBProcess:
        @staticmethod
        def EventIsProcessEvent(ev):
            return ev.payload is not None

        @staticmethod
        def GetStateFromEvent(ev):
            return ev.payload[0]

        @staticmethod
        def GetRestartedFromEvent(ev):
            return False


class _Val:
    def __init__(self, v):
        self.v = v

    def IsValid(self):
        return True

    def GetValueAsUnsigned(self):
        return self.v


class _Frame:
    def __init__(self, regs):
        self.regs = regs

    def FindRegister(self, name):
        return _Val(self.regs.get(name, 0))


class _Thread:
    def __init__(self, reason, bp_id=0, regs=None):
        self.reason, self.bp_id, self.regs = reason, bp_id, regs or {}

    def GetStopReason(self):
        return self.reason

    def GetStopReasonDataAtIndex(self, i):
        return self.bp_id

    def GetFrameAtIndex(self, i):
        return _Frame(self.regs)


class _FileSpec:
    def __init__(self, path):
        self.fullpath = path

    def GetFilename(self):
        return os.path.basename(self.fullpath)


class _Addr:
    def __init__(self, va):
        self.va = va

    def GetLoadAddress(self, target):
        return 0x100000000 + self.va


class _Module:
    def __init__(self, path):
        self.spec = _FileSpec(path)

    def GetFileSpec(self):
        return self.spec

    def FindFunctions(self, name):
        return []

    def ResolveFileAddress(self, va):
        return _Addr(va)


class _Process:
    def __init__(self, target, script, memory):
        self.target, self.script, self.memory = target, list(script), memory
        self.threads = []
        self.detached = False
        self.listener = None

    def IsValid(self):
        return True

    def GetProcessID(self):
        return 4242

    def GetState(self):
        return _FakeLLDB.eStateDetached if self.detached else _FakeLLDB.eStateStopped

    def __iter__(self):
        return iter(self.threads)

    def Continue(self):
        if not self.script:
            return
        step = self.script.pop(0)
        if step.get("load_module"):
            self.target.modules.append(_Module(step["load_module"]))
        self.threads = step.get("threads", [])
        self.listener.queue.append((step.get("state", _FakeLLDB.eStateStopped),))

    def ReadMemory(self, addr, n, err):
        data = self.memory.get(addr)
        if data is None:
            err.ok = False
            return None
        return data[:n]

    def Detach(self):
        self.detached = True
        return _FakeLLDB.SBError(True)

    def Stop(self):
        pass


class _Target:
    def __init__(self, script, memory):
        self.modules = []
        self.bps = []
        self.deleted = []
        self.process = _Process(self, script, memory)

    def Attach(self, info, err):
        return self.process

    def GetTriple(self):
        return "arm64-apple-macosx"

    def GetNumModules(self):
        return len(self.modules)

    def GetModuleAtIndex(self, i):
        return self.modules[i]

    def BreakpointCreateByAddress(self, addr):
        self.bps.append(addr)
        bp = mock.Mock()
        bp.IsValid.return_value = True
        bp.GetID.return_value = len(self.bps)
        return bp

    def BreakpointDelete(self, bid):
        self.deleted.append(bid)


class _Listener:
    def __init__(self):
        self.queue = []

    def WaitForEvent(self, secs, ev):
        if not self.queue:
            return False
        ev.payload = self.queue.pop(0)
        return True


class _Debugger:
    def __init__(self, target):
        self.target = target
        self.listener = _Listener()
        target.process.listener = self.listener
        self.commands = []

    def SetAsync(self, v):
        pass

    def CreateTarget(self, path):
        return self.target

    def HandleCommand(self, cmd):
        self.commands.append(cmd)

    def GetListener(self):
        return self.listener


class LLDBDriverTest(unittest.TestCase):
    KEY_PTR, LOGIN_PTR, ZDB_PTR = 0x5000, 0x6000, 0x7000

    def _run(self, script, memory, env_extra=None):
        target = _Target(script, memory)
        dbg = _Debugger(target)
        env = {"MURMUR_QQ_NO_LAUNCH": "1", "MURMUR_QQ_SETTLE": "0", "MURMUR_QQ_TIMEOUT": "20"}
        env.update(env_extra or {})
        out = []
        with mock.patch.dict(sys.modules, {"lldb": _FakeLLDB}), \
                mock.patch.dict(os.environ, env), \
                mock.patch.object(cap, "find_key_functions_in_file",
                                  return_value={"funcs": [0x1040], "error": None}), \
                mock.patch.object(cap, "_emit", side_effect=out.append):
            cap.murmur_qq_capture(dbg, "", None, {})
        return "\n".join(out), target, dbg

    def test_module_load_breakpoint_hits_and_detach(self):
        bp = _FakeLLDB.eStopReasonBreakpoint
        memory = {
            self.LOGIN_PTR: b"BD156D6710D54D8782F4\x00",
            self.KEY_PTR: REAL_KEY.encode() + b"\x00\xff\xff",
            self.ZDB_PTR: b"main\x00",
        }
        script = [
            {"threads": []},                                         # unrelated stop
            {"load_module": "/x/QQ.app/Contents/Resources/app/wrapper.node", "threads": []},
            {"threads": [_Thread(bp, 1, {"x1": self.ZDB_PTR, "x2": self.LOGIN_PTR, "x3": 20})]},
            {"threads": [_Thread(bp, 1, {"x1": self.ZDB_PTR, "x2": self.KEY_PTR, "x3": 16})]},
            {"threads": [_Thread(bp, 1, {"x2": self.KEY_PTR, "x3": 16})]},
        ]
        log, target, dbg = self._run(script, memory)
        self.assertIn("settings set target.process.stop-on-sharedlibrary-events true", dbg.commands)
        self.assertIn("settings set target.process.stop-on-sharedlibrary-events false", dbg.commands)
        self.assertEqual(target.bps, [0x100000000 + 0x1040])
        self.assertTrue(target.process.detached)
        self.assertEqual(target.deleted, [1])
        self.assertIn("stage=done reason=settled", log)
        cands = qq_decrypt.parse_key_candidates(log)
        values = [c["value"] for c in cands]
        self.assertEqual(values.count(REAL_KEY), 1)  # de-duplicated across hits
        self.assertIn("BD156D6710D54D8782F4", values)
        self.assertEqual(cands[values.index(REAL_KEY)]["source"], "x2")
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "nt_msg.db"
            make_fake_nt_msg_db(db, REAL_KEY)
            res = qq_decrypt.finish_extraction(log, [("acc", db)])
        self.assertTrue(res["ok"], res["error"])
        self.assertEqual(res["key"], REAL_KEY)

    def test_module_already_loaded_at_attach(self):
        target = _Target([], {})
        target.modules.append(_Module("/x/versions/9.9.9/wrapper.node"))
        dbg = _Debugger(target)
        out = []
        with mock.patch.dict(sys.modules, {"lldb": _FakeLLDB}), \
                mock.patch.dict(os.environ, {"MURMUR_QQ_NO_LAUNCH": "1", "MURMUR_QQ_TIMEOUT": "1"}), \
                mock.patch.object(cap, "find_key_functions_in_file",
                                  return_value={"funcs": [0x2000], "error": None}), \
                mock.patch.object(cap, "_emit", side_effect=out.append):
            cap.murmur_qq_capture(dbg, "", None, {})
        log = "\n".join(out)
        self.assertEqual(target.bps, [0x100002000])
        self.assertNotIn("settings set target.process.stop-on-sharedlibrary-events true", dbg.commands)
        self.assertIn("stage=done reason=timeout", log)
        self.assertTrue(target.process.detached)

    def test_analysis_failure_is_reported(self):
        script = [{"load_module": "/x/wrapper.node", "threads": []}]
        target = _Target(script, {})
        dbg = _Debugger(target)
        out = []
        with mock.patch.dict(sys.modules, {"lldb": _FakeLLDB}), \
                mock.patch.dict(os.environ, {"MURMUR_QQ_NO_LAUNCH": "1", "MURMUR_QQ_TIMEOUT": "5"}), \
                mock.patch.object(cap, "find_key_functions_in_file",
                                  return_value={"funcs": [], "error": "log string not found"}), \
                mock.patch.object(cap, "_emit", side_effect=out.append):
            cap.murmur_qq_capture(dbg, "", None, {})
        log = "\n".join(out)
        self.assertIn("stage=analyze_failed", log)
        self.assertIn("reason=no_breakpoint", log)
        statuses = [qq_mac_key.parse_status_line(l) for l in out if "MURMUR_STATUS" in l]
        self.assertIn("wrapper.node", qq_mac_key.failure_hint(statuses))

    def test_cancel_file_stops_capture(self):
        with tempfile.TemporaryDirectory() as d:
            cancel = Path(d) / "cancel"
            cancel.write_text("x")
            log, target, _dbg = self._run([], {}, {"MURMUR_QQ_CANCEL_FILE": str(cancel)})
        self.assertIn("reason=cancelled", log)
        self.assertTrue(target.process.detached)


# ---------------------------------------------------------------------------
# 4. Re-sign + lldb command construction
# ---------------------------------------------------------------------------

class CommandBuilderTest(unittest.TestCase):
    MAIN = PurePosixPath("/Applications/QQ.app/Contents/MacOS/QQ")

    def test_resign_shell_signs_only_main_exec_with_entitlements(self):
        sh = qq_mac_key.build_resign_shell(self.MAIN, PurePosixPath("/tmp/my ents.plist"))
        self.assertIn("target=/Applications/QQ.app/Contents/MacOS/QQ\n", sh)
        self.assertIn("ents='/tmp/my ents.plist'\n", sh)
        self.assertIn('/usr/bin/codesign --force --sign - --entitlements "$ents" '
                      '--preserve-metadata=identifier,requirements "$target"', sh)
        self.assertNotIn("--deep", sh)
        self.assertNotIn("runtime", sh)  # hardened runtime must NOT be re-applied
        self.assertIn('/usr/bin/ditto "$target" "$backup"', sh)
        self.assertTrue(sh.startswith("set -e\n"))

    def test_resign_shell_quotes_hostile_paths(self):
        weird = PurePosixPath("/Applications/QQ's copy.app/Contents/MacOS/QQ")
        sh = qq_mac_key.build_resign_shell(weird, PurePosixPath("/tmp/e.plist"))
        self.assertIn("target='/Applications/QQ'\"'\"'s copy.app/Contents/MacOS/QQ'", sh)

    @unittest.skipUnless(shutil.which("sh") and os.name == "posix", "needs POSIX sh")
    def test_resign_shell_is_valid_sh(self):
        sh = qq_mac_key.build_resign_shell(self.MAIN, PurePosixPath("/tmp/e.plist"))
        r = subprocess.run(["sh", "-n"], input=sh, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_osascript_escaping(self):
        cmd = qq_mac_key.build_osascript_admin('echo "a\\b"\nls')
        self.assertEqual(cmd, 'do shell script "echo \\"a\\\\b\\"\nls" with administrator privileges')

    def test_lldb_argv(self):
        argv = qq_mac_key.build_lldb_argv("/usr/bin/lldb", PurePosixPath('/x/未命名 "dir"/qq_lldb_capture.py'))
        self.assertEqual(argv[:3], ["/usr/bin/lldb", "--batch", "--no-lldbinit"])
        self.assertEqual(argv[3:5], ["-o", 'command script import "/x/未命名 \\"dir\\"/qq_lldb_capture.py"'])
        self.assertEqual(argv[5:], ["-o", "murmur_qq_capture"])

    def test_capture_env(self):
        env = qq_mac_key.build_capture_env(
            PurePosixPath("/Applications/QQ.app"), timeout=200, settle=10,
            cancel_file=PurePosixPath("/tmp/cancel"),
            base_env={"PATH": "/usr/bin", "PYTHONHOME": "/bad", "DYLD_LIBRARY_PATH": "/bad"})
        self.assertEqual(env["MURMUR_QQ_APP"], "/Applications/QQ.app")
        self.assertEqual(env["MURMUR_QQ_TIMEOUT"], "200")
        self.assertEqual(env["MURMUR_QQ_SETTLE"], "10")
        self.assertEqual(env["MURMUR_QQ_CANCEL_FILE"], str(PurePosixPath("/tmp/cancel")))
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertNotIn("PYTHONHOME", env)
        self.assertNotIn("DYLD_LIBRARY_PATH", env)

    def test_entitlements_merge_keeps_originals(self):
        orig = {"com.apple.security.app-sandbox": True,
                "com.apple.security.device.camera": True}
        raw = b"\xfa\xde\x71\x71junk" + plistlib.dumps(orig)
        parsed = qq_mac_key.parse_entitlements(raw)
        self.assertEqual(parsed, orig)
        merged = plistlib.loads(qq_mac_key.build_debug_entitlements(parsed))
        self.assertTrue(merged["com.apple.security.get-task-allow"])
        self.assertTrue(merged["com.apple.security.app-sandbox"])
        self.assertTrue(plistlib.loads(qq_mac_key.build_debug_entitlements(None))
                        ["com.apple.security.get-task-allow"])
        self.assertIsNone(qq_mac_key.parse_entitlements(b"Executable=/x\n"))

    def test_signature_status(self):
        tencent = ("Executable=/Applications/QQ.app/Contents/MacOS/QQ\n"
                   "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded\n")
        st = qq_mac_key.signature_status(tencent, {"com.apple.security.app-sandbox": True})
        self.assertEqual((st["hardened"], st["get_task_allow"], st["debuggable"]), (True, False, False))
        resigned = ("CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+7 location=embedded\n"
                    "Signature=adhoc\n")
        st = qq_mac_key.signature_status(resigned, {"com.apple.security.get-task-allow": True})
        self.assertEqual((st["hardened"], st["adhoc"], st["get_task_allow"], st["debuggable"]),
                         (False, True, True, True))

    def test_resign_error_messages(self):
        self.assertIn("取消", qq_mac_key.resign_error_message(1, "execution error: User canceled. (-128)"))
        self.assertIn("App 管理", qq_mac_key.resign_error_message(1, "QQ: Operation not permitted"))
        self.assertIn("codesign", qq_mac_key.resign_error_message(1, "something else"))


# ---------------------------------------------------------------------------
# 5. HTTP endpoints route to the Mac implementation
# ---------------------------------------------------------------------------

class _Prof:
    def __init__(self, qq, nt_db_dir):
        self.qq_number = qq
        self.nt_db_dir = Path(nt_db_dir)
        self.tencent_files_root = Path(nt_db_dir).parent.parent


class MacEndpointTest(unittest.TestCase):
    def setUp(self):
        import etcli
        self.etcli = etcli
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        nt_db = make_mac_account(self.tmp, "abcdef012345")
        make_fake_nt_msg_db(nt_db / "nt_msg.db", REAL_KEY)
        self.profiles = [_Prof("abcdef012345", nt_db)]
        patches = [
            mock.patch("qq_paths.IS_MAC", True),
            mock.patch("qq_paths.IS_WINDOWS", False),
            mock.patch("qq_paths.discover_qq_profiles", return_value=self.profiles),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self._tmp.cleanup()

    def _handler(self, body=b"{}"):
        cls = self.etcli._MurmurAPIHandler
        h = cls.__new__(cls)
        h.headers = {"Content-Length": str(len(body))}
        h.rfile = __import__("io").BytesIO(body)
        sent = {}

        def fake_send(payload, status=200):
            sent["payload"], sent["status"] = payload, status
        h._send_json = fake_send
        return h, sent

    def _post(self, path, payload):
        import json
        h, sent = self._handler(json.dumps(payload).encode("utf-8"))
        with mock.patch.object(type(h), "_qq_keys_cfg_path", self.tmp / "qq_keys.json"):
            h._dispatch_qq_post(path)
        return sent["payload"], sent["status"]

    def test_profiles_payload_on_mac(self):
        h, sent = self._handler()
        with mock.patch("qq_paths.find_qq_install_dir", return_value=PurePosixPath("/Applications/QQ.app")), \
                mock.patch("qq_paths.mac_qq_main_exec",
                           return_value=PurePosixPath("/Applications/QQ.app/Contents/MacOS/QQ")), \
                mock.patch("qq_paths.qq_running_pids", return_value=[]), \
                mock.patch("qq_paths.qq_search_paths", return_value=[self.tmp]), \
                mock.patch("qq_paths.qq_tcc_blocked", return_value=True), \
                mock.patch.object(qq_mac_key, "inspect_signature",
                                  return_value={"debuggable": False, "hardened": True,
                                                "get_task_allow": False}), \
                mock.patch.object(qq_mac_key, "find_lldb", return_value=("/usr/bin/lldb", None)), \
                mock.patch.object(type(h), "_qq_keys_cfg_path", self.tmp / "qq_keys.json"):
            h._dispatch_qq_get("/api/qq/profiles", {})
        p = sent["payload"]
        self.assertEqual(p["os"], "macos")
        self.assertNotEqual(p.get("supported"), False)
        self.assertEqual([x["qq_number"] for x in p["profiles"]], ["abcdef012345"])
        self.assertTrue(p["tcc_blocked"])
        self.assertEqual(p["mac"]["qq_app"], "/Applications/QQ.app")
        self.assertFalse(p["mac"]["debuggable"])
        self.assertEqual(p["mac"]["lldb"], "/usr/bin/lldb")

    def test_extract_key_async_starts_mac_job_with_verify_dbs(self):
        captured = {}

        def fake_start(dbs, timeout=240):
            captured["dbs"], captured["timeout"] = dbs, timeout
            return {"ok": True, "started": True}
        with mock.patch.object(qq_mac_key, "start_capture", side_effect=fake_start), \
                mock.patch.object(qq_decrypt, "extract_key_via_powershell",
                                  side_effect=AssertionError("Windows path on Mac")):
            payload, status = self._post("/api/qq/extract-key",
                                         {"timeout": 200, "qq": "abcdef012345", "async": True})
        self.assertEqual((status, payload), (200, {"ok": True, "started": True}))
        self.assertEqual(captured["timeout"], 200)
        self.assertEqual([t[0] for t in captured["dbs"]], ["abcdef012345"])

    def test_status_cancel_and_resign_routes(self):
        h, sent = self._handler()
        with mock.patch.object(qq_mac_key, "capture_state",
                               return_value={"running": True, "stage": "bp_set"}):
            h._dispatch_qq_get("/api/qq/extract-key/status", {})
        self.assertEqual(sent["payload"]["stage"], "bp_set")
        with mock.patch.object(qq_mac_key, "cancel_capture",
                               return_value={"ok": True, "cancelled": True}):
            payload, _ = self._post("/api/qq/extract-key/cancel", {})
        self.assertTrue(payload["cancelled"])
        with mock.patch.object(qq_mac_key, "resign_qq", return_value={"ok": True, "log": []}) as rs:
            payload, _ = self._post("/api/qq/resign", {})
        self.assertTrue(payload["ok"])
        rs.assert_called_once()

    def test_save_key_verifies_mac_profile(self):
        payload, _ = self._post("/api/qq/save-key", {"qq": "abcdef012345", "key": REAL_KEY})
        self.assertTrue(payload["ok"], payload)
        payload, _ = self._post("/api/qq/save-key", {"qq": "abcdef012345", "key": "wrongwrongwrong!"})
        self.assertFalse(payload["ok"])


class JobStateTest(unittest.TestCase):
    def test_background_job_reports_result(self):
        done = {"ok": True, "key": REAL_KEY, "error": None}
        with mock.patch.object(qq_mac_key, "run_capture", return_value=done) as rc:
            self.assertTrue(qq_mac_key.start_capture([], timeout=10)["started"])
            for _ in range(100):
                st = qq_mac_key.capture_state()
                if not st["running"]:
                    break
                import time
                time.sleep(0.02)
        self.assertFalse(st["running"])
        self.assertEqual(st["result"]["key"], REAL_KEY)
        self.assertNotIn("cancel_file", st)
        self.assertEqual(rc.call_args.kwargs["timeout"], 10)

    def test_on_status_updates_stage_and_hits(self):
        qq_mac_key._on_status({"stage": "hit", "n": "4"})
        st = qq_mac_key.capture_state()
        self.assertEqual((st["stage"], st["hits"]), ("hit", 4))


if __name__ == "__main__":
    unittest.main()
