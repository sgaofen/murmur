"""decrypt_py.py — Pure-Python WCDB v4 decryption (cross-platform replacement for go_decrypt.dll).

WeChat 4.x uses SQLCipher v4-style page encryption with these params:
  - Page size: 4096 bytes
  - Salt: first 16 bytes of file (kept as-is in encrypted form)
  - KDF: PBKDF2-HMAC-SHA512, 256000 iterations → 32-byte AES key
  - HMAC key: PBKDF2-HMAC-SHA512(aes_key, salt^0x3a, 2 iters, 32 bytes)
  - Cipher: AES-256-CBC, IV embedded per page (last 16 bytes before HMAC)
  - HMAC: HMAC-SHA512 over (encrypted_body + IV + page_no_le32), 64 bytes
  - Reserve at end of each encrypted page: 16-byte IV + 64-byte HMAC = 80 bytes

Decrypted page format:
  - Page 1: SQLite header "SQLite format 3\\x00" (16 bytes) + decrypted_body + zero-padded reserve
  - Page 2+: decrypted_body + zero-padded reserve

Why pure-Python: lets Mac/Linux users decrypt without compiling go_decrypt as .dylib/.so.
Speed: ~3-4 sec per 200MB DB on a modern CPU. Slow start due to PBKDF2 (256k iters once).
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import sys
from pathlib import Path
from typing import Iterable

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend
except ImportError as e:
    raise SystemExit(
        "Missing dependency: cryptography. Install with: pip install cryptography"
    ) from e


PAGE_SIZE = 4096
SALT_SIZE = 16
KEY_SIZE = 32
AES_BLOCK = 16
HMAC_HASH_SIZE = 64        # SHA-512 = 64 bytes
RESERVE = 80               # IV (16) + HMAC (64) at end of each page
KEY_ITER = 256000          # SQLCipher v4 default
HMAC_KEY_ITER = 2

SQLITE_HEADER = b"SQLite format 3\x00"  # 16 bytes


def _derive_keys(key_bytes: bytes, salt: bytes) -> tuple[bytes, bytes]:
    """Password mode: PBKDF2 the password to get AES key, then derive HMAC key."""
    aes_key = hashlib.pbkdf2_hmac("sha512", key_bytes, salt, KEY_ITER, KEY_SIZE)
    mac_salt = bytes(b ^ 0x3a for b in salt)
    hmac_key = hashlib.pbkdf2_hmac("sha512", aes_key, mac_salt, HMAC_KEY_ITER, KEY_SIZE)
    return aes_key, hmac_key


def _hmac_key_from_aes(aes_key: bytes, salt: bytes) -> bytes:
    """Raw-AES-key mode: skip PBKDF2 on aes_key (it's already the AES key);
    derive only the HMAC key from it."""
    mac_salt = bytes(b ^ 0x3a for b in salt)
    return hashlib.pbkdf2_hmac("sha512", aes_key, mac_salt, HMAC_KEY_ITER, KEY_SIZE)


def verify_candidate_key(page1: bytes, candidate_key: bytes) -> bool:
    """Cheap, near-zero-false-positive check: does `candidate_key` (32 raw bytes)
    HMAC-verify against page 1 of a SQLCipher v4 DB? No AES decrypt needed —
    just 2 fast PBKDF2 rounds (HMAC-key derivation) + one HMAC-SHA512 over the
    page body. Used to brute-force-verify AES key candidates found in memory.
    """
    if len(candidate_key) != KEY_SIZE or len(page1) != PAGE_SIZE:
        return False
    salt = page1[:SALT_SIZE]
    body_end = PAGE_SIZE - RESERVE
    body = page1[SALT_SIZE:body_end]
    iv = page1[body_end:body_end + AES_BLOCK]
    stored_hmac = page1[body_end + AES_BLOCK:body_end + AES_BLOCK + HMAC_HASH_SIZE]
    hmac_key = _hmac_key_from_aes(candidate_key, salt)
    mac = hmac.new(hmac_key, digestmod=hashlib.sha512)
    mac.update(body)
    mac.update(iv)
    mac.update((1).to_bytes(4, "little"))
    return hmac.compare_digest(mac.digest(), stored_hmac)


def decrypt_db(src_path: Path, dst_path: Path, key_hex: str, *, pre_derived: bool = False) -> None:
    """Decrypt one .db file. Raises ValueError on bad key / corruption.

    Args:
        pre_derived: If False (default), `key_hex` is a password — apply PBKDF2.
                     If True, `key_hex` is already the per-DB derived AES key
                     (e.g., extracted from WCDB memory cache on macOS).
    """
    if len(key_hex) != 64:
        raise ValueError(f"key must be 64 hex chars, got {len(key_hex)}")
    try:
        key_bytes = bytes.fromhex(key_hex)
    except ValueError as e:
        raise ValueError(f"key is not valid hex: {e}") from e

    src_size = src_path.stat().st_size
    if src_size < PAGE_SIZE:
        raise ValueError(f"{src_path} too small to be a SQLCipher db")
    if src_size % PAGE_SIZE != 0:
        raise ValueError(f"{src_path} size {src_size} not a multiple of {PAGE_SIZE}")

    with src_path.open("rb") as src_f:
        salt = src_f.read(SALT_SIZE)
    if len(salt) != SALT_SIZE:
        raise ValueError(f"{src_path} cannot read SQLCipher salt")
    if pre_derived:
        aes_key = key_bytes
        hmac_key = _hmac_key_from_aes(aes_key, salt)
    else:
        aes_key, hmac_key = _derive_keys(key_bytes, salt)

    n_pages = src_size // PAGE_SIZE

    # Pre-create AES backend
    backend = default_backend()

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dst_path.with_name(dst_path.name + ".tmp")
    try:
        with src_path.open("rb") as src_f, tmp_path.open("wb") as dst_f:
            for page_idx in range(n_pages):
                page = src_f.read(PAGE_SIZE)
                if len(page) != PAGE_SIZE:
                    raise ValueError(f"{src_path} ended unexpectedly on page {page_idx + 1}")

                # Page 1 has the salt as its first 16 bytes; body starts at byte 16.
                # All other pages: body starts at byte 0.
                body_start = SALT_SIZE if page_idx == 0 else 0
                body_end = PAGE_SIZE - RESERVE
                body = page[body_start:body_end]

                # Reserve area: [IV (16) | HMAC (64)]
                iv = page[body_end:body_end + AES_BLOCK]
                stored_hmac = page[body_end + AES_BLOCK:body_end + AES_BLOCK + HMAC_HASH_SIZE]

                # Verify HMAC: HMAC-SHA512 over (body + iv + page_no_le32)
                page_no_bytes = (page_idx + 1).to_bytes(4, "little")
                mac = hmac.new(hmac_key, digestmod=hashlib.sha512)
                mac.update(body)
                mac.update(iv)
                mac.update(page_no_bytes)
                if not hmac.compare_digest(mac.digest(), stored_hmac):
                    raise ValueError(
                        f"HMAC mismatch on page {page_idx + 1} of {src_path.name} "
                        f"— wrong key, or DB is corrupted"
                    )

                # Decrypt
                cipher = Cipher(algorithms.AES(aes_key), modes.CBC(iv), backend=backend)
                dec = cipher.decryptor()
                plain = dec.update(body) + dec.finalize()

                # Page 1: prepend the standard SQLite header, then decrypted body + zero reserve
                if page_idx == 0:
                    dst_f.write(SQLITE_HEADER)
                dst_f.write(plain)
                dst_f.write(b"\x00" * RESERVE)
        tmp_path.replace(dst_path)
    except Exception:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise


_WAL_HEADER_SIZE = 32
_WAL_FRAME_HEADER_SIZE = 24
_WAL_MAGIC_LE = 0x377F0682
_WAL_MAGIC_BE = 0x377F0683


def decrypt_wal(src_db: Path, src_wal: Path, dst_db: Path, key_hex: str,
                *, pre_derived: bool = False) -> int:
    """Decrypt WAL frames sitting next to an encrypted DB and patch them into
    the already-decrypted output DB.

    SQLCipher encrypts WAL frame data with the same per-page scheme as the main
    DB. WeChat 4.x consistently leaves WAL files non-empty between checkpoints,
    holding the most recent messages. Without WAL replay Murmur shows the user
    a stale snapshot — exactly the gap huohuoer/wechat-cli's crypto.decrypt_wal
    fills upstream.

    Returns the number of frames successfully patched. Tolerant of partial
    files: HMAC mismatch on a frame just stops the walk (per SQLite's own WAL
    recovery semantics — first-failed-frame ends the valid prefix).

    src_db must still exist (we read the 16-byte salt from page 1).
    src_wal is the SQLCipher-encrypted .db-wal file.
    dst_db must already be the plain decrypted output of decrypt_db() — we
    overwrite specific pages in place.
    """
    if not src_wal.exists() or src_wal.stat().st_size < _WAL_HEADER_SIZE + _WAL_FRAME_HEADER_SIZE + PAGE_SIZE:
        return 0
    if not dst_db.exists():
        return 0
    if not src_db.exists():
        return 0

    with src_db.open("rb") as f:
        salt = f.read(SALT_SIZE)
    if len(salt) != SALT_SIZE:
        return 0
    if pre_derived:
        if isinstance(key_hex, str):
            try:
                aes_key = bytes.fromhex(key_hex)
            except ValueError:
                return 0
        else:
            aes_key = key_hex
        if len(aes_key) != KEY_SIZE:
            return 0
        hmac_key = _hmac_key_from_aes(aes_key, salt)
    else:
        if len(key_hex) != 64:
            return 0
        try:
            key_bytes = key_hex.encode("utf-8") if isinstance(key_hex, str) else key_hex
            aes_key, hmac_key = _derive_keys(key_bytes, salt)
        except Exception:
            return 0

    with src_wal.open("rb") as wf:
        wal = wf.read()
    if len(wal) < _WAL_HEADER_SIZE:
        return 0

    import struct
    magic = struct.unpack(">I", wal[0:4])[0]
    if magic not in (_WAL_MAGIC_LE, _WAL_MAGIC_BE):
        return 0
    page_size = struct.unpack(">I", wal[8:12])[0]
    if page_size != PAGE_SIZE:
        return 0

    backend = default_backend()
    frame_total = _WAL_FRAME_HEADER_SIZE + PAGE_SIZE
    n_frames = (len(wal) - _WAL_HEADER_SIZE) // frame_total

    applied = 0
    with dst_db.open("r+b") as df:
        for fi in range(n_frames):
            offset = _WAL_HEADER_SIZE + fi * frame_total
            page_no = struct.unpack(">I", wal[offset:offset + 4])[0]
            if page_no <= 0:
                break
            page_data = wal[offset + _WAL_FRAME_HEADER_SIZE: offset + frame_total]
            if len(page_data) != PAGE_SIZE:
                break

            # Page 1 in WAL still carries the salt prefix in its body region —
            # the encrypted-body offset shifts the same way it does in main DB.
            body_start = SALT_SIZE if page_no == 1 else 0
            body_end = PAGE_SIZE - RESERVE
            body = page_data[body_start:body_end]
            iv = page_data[body_end:body_end + AES_BLOCK]
            stored_hmac = page_data[body_end + AES_BLOCK:body_end + AES_BLOCK + HMAC_HASH_SIZE]

            page_no_bytes = page_no.to_bytes(4, "little")
            mac = hmac.new(hmac_key, digestmod=hashlib.sha512)
            mac.update(body)
            mac.update(iv)
            mac.update(page_no_bytes)
            if not hmac.compare_digest(mac.digest(), stored_hmac):
                # First HMAC mismatch ends the recoverable WAL prefix — stop here.
                break

            try:
                cipher = Cipher(algorithms.AES(aes_key), modes.CBC(iv), backend=backend)
                dec = cipher.decryptor()
                plain = dec.update(body) + dec.finalize()
            except Exception:
                break

            # Patch the page into the dst .db. Layout matches what decrypt_db
            # writes: page 1 = SQLITE_HEADER + plain + zero-reserve; other pages
            # = plain + zero-reserve. We seek to the page slot by index.
            df.seek((page_no - 1) * PAGE_SIZE)
            if page_no == 1:
                df.write(SQLITE_HEADER)
            df.write(plain)
            df.write(b"\x00" * RESERVE)
            applied += 1
    return applied


def decrypt_directory(src_root: Path, dst_root: Path, key_hex: str,
                       db_glob: str = "*.db", *, pre_derived: bool = False) -> dict:
    """Decrypt every .db under src_root, mirroring layout into dst_root.
    `pre_derived` forwarded to decrypt_db()."""
    src_root = src_root.resolve()
    dst_root = dst_root.resolve()
    decrypted = []
    failed = []
    for src in src_root.rglob(db_glob):
        if "_fts" in src.name or src.suffix == "-shm" or src.suffix == "-wal":
            continue
        rel = src.relative_to(src_root)
        dst = dst_root / src.name
        try:
            decrypt_db(src, dst, key_hex, pre_derived=pre_derived)
            decrypted.append({"src": str(rel), "dst": dst.name, "size": dst.stat().st_size})
        except Exception as e:
            failed.append({"src": str(rel), "error": str(e)})
    return {"decrypted": decrypted, "failed": failed,
            "total": len(decrypted), "errors": len(failed)}


def decrypt_directory_per_db(src_root: Path, dst_root: Path, *,
                              keys_by_name: dict[str, str] | None = None,
                              keys_by_salt: dict[str, str] | None = None) -> dict:
    """Decrypt every .db under src_root using per-DB raw AES keys.

    `keys_by_name` maps relative db path (e.g. "session/session.db") to a
    64-hex AES key. `keys_by_salt` maps the 32-hex salt of page-1 to a key
    (used as fallback when the relative-path key isn't in the map).
    """
    keys_by_name = keys_by_name or {}
    keys_by_salt = keys_by_salt or {}
    src_root = src_root.resolve()
    dst_root = dst_root.resolve()
    decrypted = []
    failed = []
    for src in src_root.rglob("*.db"):
        if "_fts" in src.name or src.suffix == "-shm" or src.suffix == "-wal":
            continue
        rel = src.relative_to(src_root)
        rel_str = str(rel).replace("\\", "/")
        # Look up: by name first, then by salt
        key_hex = keys_by_name.get(rel_str)
        if not key_hex:
            try:
                with open(src, "rb") as f:
                    salt_hex = f.read(SALT_SIZE).hex()
                key_hex = keys_by_salt.get(salt_hex)
            except OSError:
                pass
        if not key_hex:
            failed.append({"src": rel_str, "error": "no key for this DB (run extract_key_mac.py with WeChat fully loaded)"})
            continue
        dst = dst_root / src.name
        try:
            decrypt_db(src, dst, key_hex, pre_derived=True)
            decrypted.append({"src": rel_str, "dst": dst.name, "size": dst.stat().st_size})
        except Exception as e:
            failed.append({"src": rel_str, "error": str(e)})
    return {"decrypted": decrypted, "failed": failed,
            "total": len(decrypted), "errors": len(failed)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--key", required=True, help="64-hex SQLCipher key")
    p.add_argument("--src", required=True, help="encrypted db file or directory")
    p.add_argument("--dst", required=True, help="output file or directory")
    args = p.parse_args()
    src = Path(args.src)
    dst = Path(args.dst)
    if src.is_dir():
        r = decrypt_directory(src, dst, args.key)
        print(f"[decrypt-py] {r['total']} OK, {r['errors']} failed")
        for f in r["failed"]:
            print(f"  FAIL {f['src']}: {f['error']}")
    else:
        decrypt_db(src, dst, args.key)
        print(f"[decrypt-py] OK: {src} -> {dst}")


if __name__ == "__main__":
    main()
