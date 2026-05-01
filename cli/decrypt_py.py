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
    """Returns (aes_key, hmac_key)."""
    aes_key = hashlib.pbkdf2_hmac("sha512", key_bytes, salt, KEY_ITER, KEY_SIZE)
    mac_salt = bytes(b ^ 0x3a for b in salt)
    hmac_key = hashlib.pbkdf2_hmac("sha512", aes_key, mac_salt, HMAC_KEY_ITER, KEY_SIZE)
    return aes_key, hmac_key


def decrypt_db(src_path: Path, dst_path: Path, key_hex: str) -> None:
    """Decrypt one .db file. Raises ValueError on bad key / corruption."""
    if len(key_hex) != 64:
        raise ValueError(f"key must be 64 hex chars, got {len(key_hex)}")
    try:
        key_bytes = bytes.fromhex(key_hex)
    except ValueError as e:
        raise ValueError(f"key is not valid hex: {e}") from e

    raw = src_path.read_bytes()
    if len(raw) < PAGE_SIZE:
        raise ValueError(f"{src_path} too small to be a SQLCipher db")
    if len(raw) % PAGE_SIZE != 0:
        raise ValueError(f"{src_path} size {len(raw)} not a multiple of {PAGE_SIZE}")

    salt = raw[:SALT_SIZE]
    aes_key, hmac_key = _derive_keys(key_bytes, salt)

    n_pages = len(raw) // PAGE_SIZE
    out = bytearray()

    # Pre-create AES backend
    backend = default_backend()

    for page_idx in range(n_pages):
        offset = page_idx * PAGE_SIZE
        page = raw[offset:offset + PAGE_SIZE]

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
            out.extend(SQLITE_HEADER)
        out.extend(plain)
        out.extend(b"\x00" * RESERVE)

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    dst_path.write_bytes(bytes(out))


def decrypt_directory(src_root: Path, dst_root: Path, key_hex: str,
                       db_glob: str = "*.db") -> dict:
    """Decrypt every .db under src_root, mirroring layout into dst_root."""
    src_root = src_root.resolve()
    dst_root = dst_root.resolve()
    decrypted = []
    failed = []
    for src in src_root.rglob(db_glob):
        if "_fts" in src.name or src.suffix == "-shm" or src.suffix == "-wal":
            continue
        rel = src.relative_to(src_root)
        # Flatten: many WeChat dbs sit in subdirs (session/session.db). We move them all
        # under dst_root flat (matches existing Murmur layout).
        dst = dst_root / src.name
        try:
            decrypt_db(src, dst, key_hex)
            decrypted.append({"src": str(rel), "dst": dst.name, "size": dst.stat().st_size})
        except Exception as e:
            failed.append({"src": str(rel), "error": str(e)})
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
