"""media.py — Murmur 媒体提取（视频 / 图片 / 表情包）

视频：微信 4.x 的 .mp4 未加密，直接索引。
图片：.dat 文件 V3 (纯 XOR) / V4-V1 (默认 AES key) / V4-V2 (Mac 可从 kvcomm 推导 image AES key)
表情包：缓存里和图片同算法。

用法：
    python media.py index          # 建立 md5→path 索引（视频 + 已解密图片）
    python media.py decrypt-images # 批量解密 V3/V4-V1 图片 → Murmur/images/
    python media.py info           # 统计当前媒体覆盖
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import re
import sqlite3
import struct
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterator

# Cross-platform path discovery
sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import (  # noqa: E402
    discover_wechat_profiles, decrypted_root_for, media_root_for,
    media_index_path, IS_WINDOWS, IS_MAC, load_config, save_config,
)


def _select_profile(wxid: str | None = None):
    profs = discover_wechat_profiles()
    if not profs:
        raise RuntimeError("找不到微信账号数据。请先在微信里登录一次。")
    if wxid:
        for p in profs:
            if p.wxid == wxid or p.wxid_short == wxid:
                return p
        raise RuntimeError(f"找不到账号 {wxid}. 已发现: {[p.wxid for p in profs]}")
    return profs[0]


# Lazy module-level — populated by main()
_PROFILE = None


def _ensure_profile():
    global _PROFILE
    if _PROFILE is None:
        _PROFILE = _select_profile()
    return _PROFILE


def src_root() -> Path:
    return _ensure_profile().cache_root


def decrypted_root() -> Path:
    return decrypted_root_for(_ensure_profile())


def media_out() -> Path:
    return media_root_for(_ensure_profile())


# ---------- Image decryption algorithms ----------

V4_V1_SIG = bytes([0x07, 0x08, 0x56, 0x31, 0x08, 0x07])
V4_V2_SIG = bytes([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
V4_DEFAULT_AES_KEY = b"cfcd208495d565ef"  # 16 bytes, fixed per echotrace


def detect_dat_version(data: bytes) -> str:
    """Returns 'V3' (XOR only), 'V4-V1' (default AES), 'V4-V2' (needs custom AES key)."""
    if len(data) < 6:
        return "V3"
    sig = data[:6]
    if sig == V4_V1_SIG:
        return "V4-V1"
    if sig == V4_V2_SIG:
        return "V4-V2"
    return "V3"


def _detect_format(plain_bytes: bytes) -> str | None:
    if plain_bytes.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if plain_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if plain_bytes.startswith(b"GIF89a") or plain_bytes.startswith(b"GIF87a"):
        return "gif"
    if plain_bytes.startswith(b"RIFF") and len(plain_bytes) >= 12 and plain_bytes[8:12] == b"WEBP":
        return "webp"
    if plain_bytes.startswith(b"BM"):
        return "bmp"
    if plain_bytes.startswith(b"wxgf"):
        return "wxgf"
    return None


WXGF_MAGIC = b"wxgf"  # WeChat 4.x's animated emoji / screenshot wrapper format


def unwrap_wxgf(data: bytes) -> tuple[bytes, str | None]:
    """If `data` is a wxgf wrapper, scan the first 4 KB for an embedded JPEG/PNG
    cover and return (slice, format).

    Many WeChat 4.x emoji + screenshot wrappers carry their static cover image
    as the second segment of the file, after a small header. WeFlow does the
    same (`unwrapWxgf` in their imageDecryptService) before falling through to
    HEVC decoding via ffmpeg. We don't bundle ffmpeg; the JPEG-passthrough still
    catches a meaningful fraction (~30%+ of wxgf in their measurements) without
    any extra dependency.

    Returns (b"", None) when nothing usable is found — the caller can leave the
    file unhandled or surface it as "动图（暂不支持）" in the UI.
    """
    if len(data) < 16 or data[:4] != WXGF_MAGIC:
        return b"", None
    scan_end = min(len(data) - 12, 4096)
    for i in range(4, scan_end):
        nested_fmt = _detect_format(data[i:])
        if nested_fmt and nested_fmt != "wxgf":
            return data[i:], nested_fmt
    return b"", None


def _unwrap_wxgf_if_embedded_image(plain: bytes, fmt: str | None) -> tuple[bytes, str | None]:
    """Some WeChat wxgf payloads contain a normal image after a short wrapper."""
    if fmt != "wxgf" or not plain.startswith(WXGF_MAGIC):
        return plain, fmt
    nested, nested_fmt = unwrap_wxgf(plain)
    if nested_fmt:
        return nested, nested_fmt
    return plain, fmt


def decrypt_v3(data: bytes) -> tuple[bytes, str | None]:
    """Pure XOR. Auto-derive XOR key from common image magic numbers."""
    if not data:
        return b"", None
    first = data[0]
    for sig_byte, fmt, magic in [
        (0xFF, "jpg", b"\xff\xd8\xff"),
        (0x89, "png", b"\x89PNG\r\n\x1a\n"),
        (0x47, "gif", b"GIF"),
        (0x52, "webp", b"RIFF"),
        (0x77, "wxgf", b"wxgf"),
        (0x42, "bmp", b"BM"),
    ]:
        xk = first ^ sig_byte
        head = bytes(b ^ xk for b in data[: len(magic)])
        if head == magic:
            return _unwrap_wxgf_if_embedded_image(bytes(b ^ xk for b in data), fmt)
    return b"", None


def aes_ecb_decrypt(key: bytes, data: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    decryptor = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    return decryptor.update(data) + decryptor.finalize()


def decrypt_v4_v1(data: bytes,
                  aes_key: bytes = V4_DEFAULT_AES_KEY,
                  xor_key: int | None = None) -> tuple[bytes, str | None]:
    """V4-V1: 0xF-byte header + AES portion + raw + XOR portion."""
    if len(data) < 0xF:
        return b"", None
    aes_size = struct.unpack("<I", data[6:10])[0]
    xor_size = struct.unpack("<I", data[10:14])[0]
    aligned = aes_size + (16 - aes_size % 16) if aes_size else 0
    body = data[0xF:]
    if aligned > len(body):
        return b"", None

    plain = b""
    if aligned > 0:
        decrypted = aes_ecb_decrypt(aes_key, body[:aligned])
        if decrypted:
            pad = decrypted[-1]
            if 0 < pad <= 16:
                plain = decrypted[:-pad]

    fmt = _detect_format(plain) if plain else None
    if not fmt:
        return b"", None

    rem = body[aligned:]
    if xor_size == 0:
        return _unwrap_wxgf_if_embedded_image(plain + rem, fmt)

    raw_len = max(0, len(rem) - xor_size)
    raw = rem[:raw_len]
    xored = rem[raw_len:]
    # Prefer the explicit image XOR key when we have one (V4-V2). Fall back to
    # trailer inference for older V4-V1 files where only the fixed AES key is known.
    if isinstance(xor_key, int) and 0 <= xor_key <= 0xFF:
        xk = xor_key
    elif fmt == "jpg" and len(xored) >= 2:
        xk = xored[-1] ^ 0xD9
    elif fmt == "png" and len(xored) >= 1:
        xk = xored[-1] ^ 0x82  # PNG ends with ...IEND<82>
    elif fmt == "gif" and len(xored) >= 1:
        xk = xored[-1] ^ 0x3B  # GIF ends with 0x3B
    else:
        xk = 0
    decoded_xor = bytes(b ^ xk for b in xored) if xk else xored
    return _unwrap_wxgf_if_embedded_image(plain + raw + decoded_xor, fmt)


def _try_v4_aes_only(data: bytes, aes_key: bytes) -> bytes:
    """Decrypt only the V4 AES portion (no XOR-tail handling) and return plain bytes.

    Used when decrypt_v4_v1 bails because _detect_format saw no JPG/PNG/etc magic
    in the leading plain — but the payload might be wxgf, which decrypt_v4_v1
    doesn't recognise. Returns b"" on any failure; caller should treat as "no
    plain available."
    """
    if len(data) < 0xF:
        return b""
    aes_size = struct.unpack("<I", data[6:10])[0]
    aligned = aes_size + (16 - aes_size % 16) if aes_size else 0
    body = data[0xF:]
    if aligned <= 0 or aligned > len(body):
        return b""
    try:
        decrypted = aes_ecb_decrypt(aes_key, body[:aligned])
    except Exception:
        return b""
    if not decrypted:
        return b""
    pad = decrypted[-1]
    if not (0 < pad <= 16):
        return b""
    return decrypted[:-pad]


def decrypt_dat(data: bytes,
                image_aes_key: bytes | None = None,
                image_xor_key: int | None = None) -> tuple[bytes, str | None, str]:
    """
    Returns (plain_bytes, format_or_None, version_label).

    wxgf handling: WeChat 4.x animated stickers / emoji are AES+XOR-encrypted
    just like images, but the *decrypted* payload starts with the magic
    `77 78 67 66`. _detect_format doesn't recognise that magic, so
    decrypt_v4_v1 bails. We re-decrypt JUST the AES portion (no XOR tail),
    look for embedded JPEG/PNG cover in the first 4 KB, and surface that as
    a static thumbnail — same approach WeFlow uses without ffmpeg.
    """
    v = detect_dat_version(data)
    if v == "V3":
        plain, fmt = decrypt_v3(data)
        if fmt:
            return plain, fmt, "V3"
        return b"", None, "V3"
    if v == "V4-V1":
        plain, fmt = decrypt_v4_v1(data)
        if fmt:
            return plain, fmt, "V4-V1"
        # Plain didn't have a recognised image magic — try wxgf on the AES portion.
        aes_only = _try_v4_aes_only(data, V4_DEFAULT_AES_KEY)
        if aes_only:
            wx_plain, wx_fmt = unwrap_wxgf(aes_only)
            if wx_fmt:
                return wx_plain, wx_fmt, "wxgf"
        return b"", None, "V4-V1"
    if v == "V4-V2":
        if image_aes_key:
            plain, fmt = decrypt_v4_v1(data, aes_key=image_aes_key, xor_key=image_xor_key)
            if fmt:
                return plain, fmt, "V4-V2"
            aes_only = _try_v4_aes_only(data, image_aes_key)
            if aes_only:
                wx_plain, wx_fmt = unwrap_wxgf(aes_only)
                if wx_fmt:
                    return wx_plain, wx_fmt, "wxgf"
        return b"", None, "V4-V2-no-key"
    return b"", None, "unknown"


# ---------- Hardlink index ----------

def load_dir2id() -> dict[int, str]:
    db = decrypted_root() / "hardlink.db"
    if not db.exists():
        return {}
    c = sqlite3.connect(db)
    try:
        return {row[0]: row[1] for row in c.execute("SELECT rowid, username FROM dir2id").fetchall()}
    finally:
        c.close()


def index_hardlinks() -> dict[str, dict]:
    """Build a unified index: md5 → {kind, file_name, dir, file_size, source_path}."""
    db = decrypted_root() / "hardlink.db"
    if not db.exists():
        return {}
    dir2id = load_dir2id()
    out: dict[str, dict] = {}
    c = sqlite3.connect(db)
    try:
        # videos
        for md5, fname, d1, d2, sz in c.execute(
            "SELECT md5, file_name, dir1, dir2, file_size FROM video_hardlink_info_v4"
        ):
            month = dir2id.get(d1, "")
            ext = Path(fname).suffix.lower()
            kind = "video" if ext in (".mp4", ".mov", ".avi") else "thumb"
            src = src_root() / "msg" / "video" / month / fname if month else None
            out[md5] = {
                "kind": kind,
                "file_name": fname,
                "month": month,
                "size": sz,
                "source_path": str(src) if src else None,
                "exists": bool(src and src.exists()),
            }
        # images: msg/attach/<dir2id[d1]>/<dir2id[d2]>/Img/<file_name>
        # d1 = chat-room hash (or sender hash);  d2 = month
        for md5, fname, d1, d2, sz in c.execute(
            "SELECT md5, file_name, dir1, dir2, file_size FROM image_hardlink_info_v4"
        ):
            d1_name = dir2id.get(d1, "")  # chat hash
            d2_name = dir2id.get(d2, "")  # month
            src = (src_root() / "msg" / "attach" / d1_name / d2_name / "Img" / fname) if d1_name and d2_name else None
            out[md5] = {
                "kind": "image",
                "file_name": fname,
                "chat_hash": d1_name,
                "month": d2_name,
                "size": sz,
                "source_path": str(src) if src else None,
                "exists": bool(src and src.exists()),
            }
        # files: msg/attach/<dir2id[d1]>/<dir2id[d2]>/File/<file_name>
        for md5, fname, d1, d2, sz in c.execute(
            "SELECT md5, file_name, dir1, dir2, file_size FROM file_hardlink_info_v4"
        ):
            d1_name = dir2id.get(d1, "")
            d2_name = dir2id.get(d2, "")
            src = (src_root() / "msg" / "attach" / d1_name / d2_name / "File" / fname) if d1_name and d2_name else None
            out[md5] = {
                "kind": "file",
                "file_name": fname,
                "chat_hash": d1_name,
                "month": d2_name,
                "size": sz,
                "source_path": str(src) if src else None,
                "exists": bool(src and src.exists()),
            }
    finally:
        c.close()
    return out


# ---------- Bulk image / emoji decryption ----------

def find_dat_files(scope: str = "all") -> Iterator[Path]:
    """Yield all .dat files. scope: 'images' = msg/attach only;  'emojis' = cache emoticon only."""
    if scope in ("all", "images"):
        for p in (src_root() / "msg" / "attach").rglob("*.dat"):
            yield p
    if scope in ("all", "emojis"):
        cache = src_root() / "cache"
        if cache.exists():
            for p in cache.rglob("Emoticon/*"):
                if p.is_file():
                    yield p


def decrypt_one(src: Path, out_dir: Path,
                image_aes_key: bytes | None = None,
                image_xor_key: int | None = None) -> dict:
    try:
        data = src.read_bytes()
    except OSError as e:
        return {"src": str(src), "ok": False, "error": str(e)}
    if not data:
        return {"src": str(src), "ok": False, "error": "empty"}
    plain, fmt, ver = decrypt_dat(data, image_aes_key=image_aes_key, image_xor_key=image_xor_key)
    if not fmt or not plain:
        return {"src": str(src), "ok": False, "version": ver, "error": "no-magic"}
    # Stable output filename: keep original base + use detected extension
    base = src.stem  # without .dat
    out = out_dir / f"{base}.{fmt}"
    if not out.exists():
        out_dir.mkdir(parents=True, exist_ok=True)
        out.write_bytes(plain)
    return {"src": str(src), "ok": True, "version": ver, "format": fmt, "out": str(out)}


def bulk_decrypt(scope: str = "all", *, image_aes_key: bytes | None = None,
                 image_xor_key: int | None = None,
                 max_files: int | None = None, log_every: int = 200) -> dict:
    """Multi-threaded bulk decryption."""
    if image_aes_key is None or image_xor_key is None:
        resolved_aes, resolved_xor = resolve_image_keys(auto=True, save=True)
        image_aes_key = image_aes_key or resolved_aes
        if image_xor_key is None:
            image_xor_key = resolved_xor
    out_root = media_out() / scope
    out_root.mkdir(parents=True, exist_ok=True)
    all_dats = list(find_dat_files(scope))
    if max_files:
        all_dats = all_dats[:max_files]
    n_total = len(all_dats)
    print(f"[*] Found {n_total} .dat files, decrypting → {out_root}")
    counts = Counter()
    by_version = Counter()
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(decrypt_one, p, out_root, image_aes_key, image_xor_key): p for p in all_dats}
        for i, fut in enumerate(as_completed(futures), 1):
            r = fut.result()
            if r.get("ok"):
                counts[r.get("format", "?")] += 1
            else:
                counts["fail"] += 1
            by_version[r.get("version", "?")] += 1
            if i % log_every == 0:
                elapsed = time.time() - t0
                rate = i / max(0.01, elapsed)
                print(f"  [{i:>5}/{n_total}] {elapsed:.1f}s, {rate:.0f}/s, "
                      f"counts: {dict(counts)}")
    elapsed = time.time() - t0
    print(f"[OK] done in {elapsed:.1f}s")
    print(f"  formats: {dict(counts)}")
    print(f"  versions: {dict(by_version)}")
    return {
        "total": n_total,
        "elapsed_sec": round(elapsed, 1),
        "by_format": dict(counts),
        "by_version": dict(by_version),
        "out_dir": str(out_root),
    }


# ---------- Image AES key extraction (pure memory scan, no DLL injection) ----------

def _is_ascii_alnum_32(data: bytes, start: int) -> bool:
    """Echotrace's filter: 32 chars in [0-9 A-Z a-z] consecutively."""
    if start + 32 > len(data):
        return False
    for i in range(32):
        b = data[start + i]
        if not ((48 <= b <= 57) or (65 <= b <= 90) or (97 <= b <= 122)):
            return False
    return True


def _is_utf16_ascii_alnum_32(data: bytes, start: int) -> bool:
    """UTF-16 LE wide ASCII: each char is 2 bytes, low byte ASCII alnum, high byte 0."""
    if start + 64 > len(data):
        return False
    for i in range(32):
        lo = data[start + i * 2]
        hi = data[start + i * 2 + 1]
        if hi != 0:
            return False
        if not ((48 <= lo <= 57) or (65 <= lo <= 90) or (97 <= lo <= 122)):
            return False
    return True


def _verify_image_aes_key(ciphertext_first_block: bytes, key: bytes) -> bool:
    """Decrypt the first AES block of an encrypted image and check for image magic."""
    if len(ciphertext_first_block) < 16 or len(key) != 16:
        return False
    try:
        plain = aes_ecb_decrypt(key, ciphertext_first_block[:16])
    except Exception:
        return False
    return _detect_format(plain) is not None


def find_v4v2_sample_ciphertexts(profile=None, *, limit: int = 32) -> list[bytes]:
    """Find V4-V2 .dat samples and return encrypted first AES blocks."""
    root = (profile.cache_root if profile is not None else src_root()) / "msg" / "attach"
    if not root.exists():
        return []
    samples: list[bytes] = []
    try:
        paths = sorted(
            root.rglob("*.dat"),
            key=lambda p: p.stat().st_mtime if p.exists() else 0,
            reverse=True,
        )
    except (OSError, PermissionError):
        paths = list(root.rglob("*.dat"))
    for p in paths:
        try:
            data = p.read_bytes()
        except OSError:
            continue
        if len(data) < 0xF + 16:
            continue
        if data[:6] != V4_V2_SIG:
            continue
        # AES portion starts at offset 0xF
        block = data[0xF: 0xF + 16]
        if block not in samples:
            samples.append(block)
        if len(samples) >= max(1, limit):
            break
    return samples


def find_v4v2_sample_ciphertext(profile=None) -> bytes | None:
    samples = find_v4v2_sample_ciphertexts(profile, limit=1)
    return samples[0] if samples else None


def _clean_account_id(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw.lower().startswith("wxid_"):
        m = re.match(r"^(wxid_[^_]+)", raw, flags=re.IGNORECASE)
        return m.group(1) if m else raw
    m = re.match(r"^(.+)_([0-9a-zA-Z]{4})$", raw)
    return m.group(1) if m else raw


def _push_unique(out: list[str], value: str | None) -> None:
    raw = str(value or "").strip()
    if not raw:
        return
    for item in (raw, _clean_account_id(raw)):
        if item and item not in out:
            out.append(item)


def _is_account_like_dir(path: Path) -> bool:
    name = path.name.lower()
    if name in {"all_users", "backup", "old_backup", "app_data", "applet", "wmpf"}:
        return False
    try:
        return path.is_dir() and (
            (path / "db_storage").is_dir()
            or (path / "msg").is_dir()
            or (path / "FileStorage" / "Image").is_dir()
            or (path / "FileStorage" / "Image2").is_dir()
        )
    except (OSError, PermissionError):
        return False


def _account_id_candidates(profile=None) -> list[str]:
    prof = profile or _ensure_profile()
    out: list[str] = []
    _push_unique(out, getattr(prof, "wxid", ""))
    _push_unique(out, getattr(prof, "wxid_short", ""))
    _push_unique(out, getattr(prof, "cache_root", Path()).name)
    root = getattr(prof, "cache_root", Path()).parent
    try:
        if root.is_dir():
            for entry in root.iterdir():
                if _is_account_like_dir(entry):
                    _push_unique(out, entry.name)
    except (OSError, PermissionError):
        pass
    return out


def _kvcomm_candidate_dirs(profile=None) -> list[Path]:
    prof = profile or _ensure_profile()
    home = Path.home()
    out: list[Path] = [
        home / "Library" / "Containers" / "com.tencent.xinWeChat" / "Data" / "Documents" / "app_data" / "net" / "kvcomm",
        home / "Library" / "Containers" / "com.tencent.xinWeChat" / "Data" / "Library" / "Application Support" / "com.tencent.xinWeChat" / "xwechat" / "net" / "kvcomm",
        home / "Library" / "Containers" / "com.tencent.xinWeChat" / "Data" / "Library" / "Application Support" / "com.tencent.xinWeChat" / "net" / "kvcomm",
        home / "Library" / "Containers" / "com.tencent.xinWeChat" / "Data" / "Documents" / "xwechat" / "net" / "kvcomm",
    ]
    account_path = getattr(prof, "cache_root", None)
    if account_path:
        normalized = str(account_path).replace("\\", "/").rstrip("/")
        marker = "/xwechat_files"
        idx = normalized.find(marker)
        if idx >= 0:
            out.append(Path(normalized[:idx]) / "app_data" / "net" / "kvcomm")
        m = re.match(r"^(.*?/com\.tencent\.xinWeChat/(?:\d+\.\d+b\d+\.\d+|\d+\.\d+\.\d+))(/|$)", normalized)
        if m:
            version_base = Path(m.group(1))
            out.append(version_base / "net" / "kvcomm")
            out.append(version_base.parent / "net" / "kvcomm")
        cursor = Path(account_path)
        for _ in range(6):
            out.append(cursor / "net" / "kvcomm")
            if cursor.parent == cursor:
                break
            cursor = cursor.parent
    deduped: list[Path] = []
    seen: set[str] = set()
    for p in out:
        key = str(p)
        if key not in seen:
            seen.add(key)
            deduped.append(p)
    return deduped


def _collect_kvcomm_codes(profile=None) -> list[int]:
    codes: set[int] = set()
    pattern = re.compile(r"^key_(\d+)_.+\.statistic$", re.IGNORECASE)
    for kvdir in _kvcomm_candidate_dirs(profile):
        try:
            if not kvdir.is_dir():
                continue
            for item in kvdir.iterdir():
                m = pattern.match(item.name)
                if not m:
                    continue
                code = int(m.group(1))
                if 0 < code <= 0xFFFFFFFF:
                    codes.add(code)
        except (OSError, PermissionError, ValueError):
            continue
    return sorted(codes)


def _derive_mac_image_key(code: int, account_id: str) -> tuple[int, bytes]:
    cleaned = _clean_account_id(account_id)
    xor_key = code & 0xFF
    aes_key = hashlib.md5((str(code) + cleaned).encode("utf-8")).hexdigest()[:16].encode("ascii")
    return xor_key, aes_key


def extract_image_aes_key_from_kvcomm(profile=None, *, save: bool = False, log=print) -> tuple[bytes, dict] | None:
    """Derive Mac V4-V2 image AES key from kvcomm key_<code> cache and verify it."""
    if not IS_MAC:
        return None
    prof = profile or _ensure_profile()
    samples = find_v4v2_sample_ciphertexts(prof, limit=32)
    if not samples:
        log("[image-key] No V4-V2 .dat sample found; open a few images in WeChat first.")
        return None
    codes = _collect_kvcomm_codes(prof)
    if not codes:
        log("[image-key] No kvcomm key_<code> statistic files found.")
        return None
    accounts = _account_id_candidates(prof)
    if not accounts:
        log("[image-key] No account id candidates found.")
        return None

    for account_id in accounts:
        for code in codes:
            xor_key, aes_key = _derive_mac_image_key(code, account_id)
            if not any(_verify_image_aes_key(sample, aes_key) for sample in samples):
                continue
            meta = {
                "source": "mac-kvcomm",
                "account_id": account_id,
                "code": code,
                "xor_key": xor_key,
                "verified": True,
            }
            if save:
                cfg = load_config()
                cfg["image_aes_key"] = aes_key.decode("ascii")
                cfg["image_xor_key"] = xor_key
                cfg["image_key_source"] = "mac-kvcomm"
                cfg["image_key_account"] = account_id
                save_config(cfg)
            log(f"[image-key] Derived verified V4-V2 key from kvcomm (account={account_id}, code={code}).")
            return aes_key, meta
    log(f"[image-key] Tried {len(accounts)} account ids × {len(codes)} kvcomm codes against {len(samples)} samples; no verified key.")
    return None


def _configured_image_aes_key() -> bytes | None:
    raw = load_config().get("image_aes_key")
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if len(value) == 16:
        return value.encode("utf-8")
    if re.fullmatch(r"[0-9a-fA-F]{32}", value):
        try:
            return bytes.fromhex(value)
        except ValueError:
            return None
    return None


def _configured_image_xor_key() -> int | None:
    raw = load_config().get("image_xor_key")
    if isinstance(raw, int) and 0 <= raw <= 0xFF:
        return raw
    if isinstance(raw, str):
        value = raw.strip().lower()
        if value.startswith("0x"):
            value = value[2:]
            base = 16
        else:
            base = 10
        try:
            parsed = int(value, base)
        except ValueError:
            return None
        if 0 <= parsed <= 0xFF:
            return parsed
    return None


def resolve_image_keys(profile=None, *, auto: bool = True, save: bool = True, log=print) -> tuple[bytes | None, int | None]:
    configured_aes = _configured_image_aes_key()
    configured_xor = _configured_image_xor_key()
    if configured_aes and configured_xor is not None:
        return configured_aes, configured_xor
    if auto and IS_MAC:
        result = extract_image_aes_key_from_kvcomm(profile, save=save, log=log)
        if result:
            key, meta = result
            xor = meta.get("xor_key")
            return key, int(xor) if isinstance(xor, int) else configured_xor
    return configured_aes, configured_xor


def resolve_image_aes_key(*, auto: bool = True, save: bool = True, log=print) -> bytes | None:
    key, _xor = resolve_image_keys(auto=auto, save=save, log=log)
    return key


def extract_image_aes_key(pid: int | None = None,
                          ciphertext_block: bytes | None = None,
                          *, log=print) -> tuple[bytes, str] | None:
    """
    Memory-scan Weixin.exe for a 32-byte ASCII alphanumeric string that, when used
    as AES key, decrypts a known V4-V2 image's first block to start with FF D8.
    Returns (16-byte key, encoding) or None.

    Optimization: uses regex to find ALL [0-9A-Za-z]{32} substrings in each chunk
    in C-speed, then only AES-tries those candidates.
    """
    if not IS_WINDOWS:
        log("[X] Image AES key extraction is Windows-only for now.")
        return None

    import ctypes
    from ctypes import wintypes
    if ciphertext_block is None:
        ciphertext_block = find_v4v2_sample_ciphertext()
        if ciphertext_block is None:
            log("[X] No V4-V2 .dat found for validation. Cannot extract image key.")
            return None
        log(f"[*] Got validation block from a V4-V2 .dat (16 bytes)")

    if pid is None:
        from extract_key_dll import find_weixin_pids
        pids = find_weixin_pids()
        if not pids:
            log("[X] Weixin.exe not running.")
            return None
        pid = pids[0]
    log(f"[*] Scanning Weixin.exe pid={pid} memory for image AES key...")

    PROCESS_QUERY_INFORMATION = 0x0400
    PROCESS_VM_READ = 0x0010
    MEM_COMMIT = 0x1000
    PAGE_READWRITE = 0x04
    PAGE_READONLY = 0x02
    PAGE_WRITECOPY = 0x08
    PAGE_GUARD = 0x100

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
        log("[X] OpenProcess failed.")
        return None

    # Compile regex once: 32 ASCII alnum chars (key candidate)
    pat_ascii = re.compile(rb"[0-9A-Za-z]{32}")
    # UTF-16 LE wide ASCII alnum: 32 chars, each char is `[0-9A-Za-z]\x00`
    # Pattern: ([0-9A-Za-z]\x00){32}
    pat_utf16 = re.compile(rb"(?:[0-9A-Za-z]\x00){32}")

    addr = 0
    mbi = MBI()
    scanned_mb = 0.0
    cand_count = 0
    last_log_mb = -50.0
    t0 = time.time()

    try:
        while addr < 0x7FFFFFFFFFFF:
            if not k32.VirtualQueryEx(h, addr, ctypes.byref(mbi), ctypes.sizeof(mbi)):
                addr += 0x100000
                continue
            base = int(mbi.BaseAddress or 0)
            region_size = int(mbi.RegionSize)
            if (mbi.State == MEM_COMMIT
                    and not (mbi.Protect & PAGE_GUARD)
                    and (mbi.Protect & (PAGE_READWRITE | PAGE_READONLY | PAGE_WRITECOPY))):
                # Cap individual region read to 10 MB (matches echotrace's strategy)
                size = min(region_size, 10 * 1024 * 1024)
                buf = (ctypes.c_ubyte * size)()
                nread = ctypes.c_size_t(0)
                if k32.ReadProcessMemory(h, base, buf, size, ctypes.byref(nread)) and nread.value > 0:
                    data = bytes(buf[: nread.value])
                    scanned_mb += nread.value / 1e6

                    # ASCII pass
                    for m in pat_ascii.finditer(data):
                        cand_count += 1
                        cand = m.group()
                        if _verify_image_aes_key(ciphertext_block, cand[:16]):
                            elapsed = time.time() - t0
                            log(f"[OK] Image AES key found in {elapsed:.1f}s after scanning "
                                f"{scanned_mb:.0f} MB / {cand_count} candidates.")
                            log(f"  ASCII string : {cand.decode()}")
                            log(f"  AES key (16) : {cand[:16].decode()}")
                            return (cand[:16], "ascii")
                    # UTF-16 pass
                    for m in pat_utf16.finditer(data):
                        cand_count += 1
                        # Take low byte of each pair
                        wide = m.group()
                        cand = bytes(wide[i * 2] for i in range(32))
                        if _verify_image_aes_key(ciphertext_block, cand[:16]):
                            elapsed = time.time() - t0
                            log(f"[OK] Image AES key found in {elapsed:.1f}s after scanning "
                                f"{scanned_mb:.0f} MB / {cand_count} candidates (utf16).")
                            log(f"  UTF16 string : {cand.decode()}")
                            log(f"  AES key (16) : {cand[:16].decode()}")
                            return (cand[:16], "utf16")

                    if scanned_mb - last_log_mb >= 200:
                        log(f"  scanned {scanned_mb:.0f} MB, {cand_count} candidates, {time.time() - t0:.1f}s")
                        last_log_mb = scanned_mb
            addr = base + region_size
            if addr <= 0:
                addr = base + 0x1000
    finally:
        k32.CloseHandle(h)

    log(f"[X] No image AES key found after {scanned_mb:.0f} MB, {cand_count} candidates, {time.time() - t0:.1f}s")
    return None


# ---------- CLI ----------

def cmd_index(args):
    print(f"[*] Indexing hardlinks from {decrypted_root() / 'hardlink.db'}...")
    idx = index_hardlinks()
    by_kind = Counter(r["kind"] for r in idx.values())
    by_exists = Counter("found" if r["exists"] else "missing" for r in idx.values())
    print(f"  total: {len(idx)} entries")
    print(f"  by kind: {dict(by_kind)}")
    print(f"  source files: {dict(by_exists)}")
    out_path = media_index_path()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    existing = {}
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
        except Exception:
            existing = {}
    merged = {**existing, **idx}
    out_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  saved index → {out_path}")
    print(f"  merged: {len(idx)} hardlink entries, preserved {len(merged) - len(idx)} existing entries")


def cmd_decrypt_images(args):
    image_aes_key, image_xor_key = resolve_image_keys(auto=True, save=True)
    bulk_decrypt(
        scope=args.scope,
        max_files=args.limit,
        image_aes_key=image_aes_key,
        image_xor_key=image_xor_key,
    )


def cmd_extract_image_key(args):
    if IS_MAC:
        print("[*] Deriving Mac image AES key from kvcomm cache...")
        result = extract_image_aes_key_from_kvcomm(save=not args.save_to)
        if result is None:
            sys.exit(1)
        key, meta = result
        print(f"\n[KEY] {key.decode()}  (source={meta.get('source')}, account={meta.get('account_id')})")
        if args.save_to:
            Path(args.save_to).write_text(json.dumps({
                "image_aes_key": key.decode(),
                "image_xor_key": meta.get("xor_key"),
                "source": meta.get("source"),
                "account_id": meta.get("account_id"),
                "code": meta.get("code"),
                "verified": True,
                "extracted_at": datetime.datetime.now().isoformat(),
            }, indent=2), encoding="utf-8")
            print(f"  saved → {args.save_to}")
        return
    print("[*] Extracting image AES key from Weixin.exe (no restart needed)...")
    result = extract_image_aes_key()
    if result is None:
        sys.exit(1)
    key, encoding = result
    print(f"\n[KEY] {key.decode()}  (encoding={encoding})")
    if args.save_to:
        Path(args.save_to).write_text(json.dumps({
            "image_aes_key": key.decode(),
            "encoding": encoding,
            "extracted_at": datetime.datetime.now().isoformat(),
        }, indent=2), encoding="utf-8")
        print(f"  saved → {args.save_to}")


def cmd_info(args):
    print(f"=== Media coverage at {media_out().parent} ===")
    if not media_out().parent.exists():
        print("  (no media directory yet — run `media.py index` and `media.py decrypt-images`)")
        return
    idx_path = media_index_path()
    if idx_path.exists():
        try:
            idx = json.loads(idx_path.read_text(encoding="utf-8"))
        except Exception:
            idx = {}
        by_kind = Counter((r.get("kind") or "?") for r in idx.values() if isinstance(r, dict))
        exists = sum(1 for r in idx.values() if isinstance(r, dict) and r.get("exists"))
        decrypted = sum(1 for r in idx.values() if isinstance(r, dict) and r.get("decrypted"))
        print(f"  media-index.json: {len(idx)} entries, {exists} source files available, {decrypted} pre-decrypted")
        print(f"  by kind: {dict(by_kind)}")
    for sub in sorted(media_out().iterdir()) if media_out().exists() else []:
        if sub.is_dir():
            n = sum(1 for _ in sub.iterdir())
            sz_mb = sum(f.stat().st_size for f in sub.iterdir() if f.is_file()) / 1e6
            print(f"  {sub.name}/: {n} files, {sz_mb:.1f} MB")
    src_videos = list((src_root() / "msg" / "video").rglob("*.mp4")) if (src_root() / "msg" / "video").exists() else []
    src_dats = list((src_root() / "msg" / "attach").rglob("*.dat")) if (src_root() / "msg" / "attach").exists() else []
    print(f"\n=== Source counts ===")
    print(f"  videos (.mp4) in msg/video/: {len(src_videos)}")
    print(f"  images (.dat) in msg/attach/: {len(src_dats)}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("index", help="Build hardlink index (md5 → file path)")
    sp = sub.add_parser("decrypt-images", help="Bulk-decrypt all .dat files (V3 + V4-V1 + V4-V2 when image key is available)")
    sp.add_argument("--scope", choices=["all", "images", "emojis"], default="all")
    sp.add_argument("--limit", type=int, help="Max files to process (debug)")
    sp = sub.add_parser("info", help="Show current media coverage")
    sp = sub.add_parser("extract-image-key", help="Extract image AES key (Mac kvcomm derivation; Windows memory scan)")
    sp.add_argument("--save-to", help="Also save key details to a JSON file")
    args = p.parse_args()
    funcs = {
        "index": cmd_index, "decrypt-images": cmd_decrypt_images,
        "info": cmd_info, "extract-image-key": cmd_extract_image_key,
    }
    funcs[args.cmd](args)


if __name__ == "__main__":
    main()
