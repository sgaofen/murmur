"""qq_key_diag.py — diagnose QQ NT decrypt parameter mismatch.

For users on newer QQ NT versions (9.9.29+) where Murmur's hardcoded
SQLCipher params no longer match. Tries every known QQNT/SQLCipher param
combination against a captured 16-char key + encrypted nt_msg.db. Prints
the combination that successfully verifies HMAC + decrypts page 1.

Usage:
    python qq_key_diag.py <16-char-key> <path-to-encrypted-nt_msg.db>
or, picking up the key Murmur saved last time:
    python qq_key_diag.py auto

Output: copy-paste this into the GitHub issue so we know which params to add.
"""
from __future__ import annotations
import hashlib, hmac, json, os, sys
from pathlib import Path

QQNT_HEADER_BYTES = 1024  # bytes prepended to encrypted DB by QQNT


def derive_key(passphrase: bytes, salt: bytes, kdf_iter: int, kdf_hash: str, key_len: int = 32) -> bytes:
    return hashlib.pbkdf2_hmac(kdf_hash, passphrase, salt, kdf_iter, dklen=key_len)


def derive_hmac_key(enc_key: bytes, salt: bytes, hmac_kdf_iter: int, kdf_hash: str, key_len: int = 32) -> bytes:
    """SQLCipher derives the HMAC key by PBKDF2(enc_key, salt^0x3a, hmac_kdf_iter, kdf_hash)."""
    hmac_salt = bytes(b ^ 0x3a for b in salt)
    return hashlib.pbkdf2_hmac(kdf_hash, enc_key, hmac_salt, hmac_kdf_iter, dklen=key_len)


def try_combo(passphrase: bytes, db_bytes: bytes,
               page_size: int, reserve: int,
               kdf_iter: int, hmac_kdf_iter: int,
               kdf_hash: str, hmac_hash: str,
               header_strip: int) -> bool:
    """Try one SQLCipher param combo. Return True if HMAC of page 1 verifies."""
    raw = db_bytes[header_strip:] if header_strip > 0 else db_bytes
    if len(raw) < page_size:
        return False
    salt = raw[:16]
    page = raw[:page_size]
    enc_key = derive_key(passphrase, salt, kdf_iter, kdf_hash)
    hmac_key = derive_hmac_key(enc_key, salt, hmac_kdf_iter, kdf_hash)
    # SQLCipher v3+: per-page HMAC stored at end of page (in `reserve` bytes).
    # HMAC is computed over the page body (excluding the trailing HMAC + 4-byte page-num suffix).
    hmac_size = 20 if hmac_hash == "sha1" else 32
    body_end = page_size - reserve
    body = page[16:body_end]  # skip the salt prefix on page 1
    iv = page[body_end:body_end + 16]
    stored_hmac = page[body_end + 16:body_end + 16 + hmac_size]
    page_num = (1).to_bytes(4, "little")
    actual_hmac = hmac.new(hmac_key, body + iv + page_num, hmac_hash).digest()
    return hmac.compare_digest(stored_hmac, actual_hmac)


# Known/plausible SQLCipher param combinations for QQNT/WeChat/SQLCipher variants.
COMBOS = [
    # name,                   page, reserve, kdf_iter, hmac_kdf_iter, kdf_hash, hmac_hash, header_strip
    ("QQNT 9.9.x (Murmur ships)", 4096, 48,    4000,    2,            "sha512", "sha1",   1024),
    ("QQNT 9.9.x without header",  4096, 48,    4000,    2,            "sha512", "sha1",   0),
    ("QQNT 9.9.x HMAC-SHA512",     4096, 64,    4000,    2,            "sha512", "sha512", 1024),
    ("QQNT alt page 1024",         1024, 48,    4000,    2,            "sha512", "sha1",   1024),
    ("QQNT alt kdf 64000",         4096, 48,    64000,   2,            "sha512", "sha1",   1024),
    ("QQNT alt kdf 256000",        4096, 48,    256000,  2,            "sha512", "sha1",   1024),
    ("QQNT all-SHA1 SQLCipher v3", 1024, 16,    64000,   2,            "sha1",   "sha1",   1024),
    ("WeChat 4.x (PBKDF2 master)", 4096, 80,    256000,  2,            "sha512", "sha512", 0),
    ("Plain SQLCipher v4 default", 4096, 16,    256000,  2,            "sha512", "sha512", 0),
    ("Plain SQLCipher v3 default", 1024, 16,    64000,   2,            "sha1",   "sha1",   0),
    ("QQNT reserve 32",            4096, 32,    4000,    2,            "sha512", "sha1",   1024),
    ("QQNT large kdf 600k",        4096, 48,    600000,  2,            "sha512", "sha1",   1024),
]


def auto_pick():
    keys_path = Path.home() / ".murmur" / "qq_keys.json"
    if not keys_path.exists():
        sys.exit("no ~/.murmur/qq_keys.json — run extract-key in Murmur first")
    keys = json.loads(keys_path.read_text(encoding="utf-8-sig"))
    if not keys:
        sys.exit("qq_keys.json is empty")
    qq, key = next(iter(keys.items()))
    home = Path.home() / "Documents" / "Tencent Files"
    candidates = list(home.rglob(f"{qq}/nt_qq/nt_db/nt_msg.db"))
    if not candidates:
        for d in (Path("D:/"), Path("E:/"), Path("F:/")):
            if d.exists():
                candidates += list(d.rglob(f"Tencent Files/{qq}/nt_qq/nt_db/nt_msg.db"))
    if not candidates:
        sys.exit(f"could not locate nt_msg.db for qq {qq}; pass it explicitly")
    return key, candidates[0]


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "auto":
        key, db = auto_pick()
    elif len(sys.argv) == 3:
        key, db = sys.argv[1], Path(sys.argv[2])
    else:
        print(__doc__); sys.exit(1)

    print(f"key length: {len(key)} chars")
    print(f"db: {db}")
    print(f"db size: {db.stat().st_size} bytes")
    db_bytes = db.read_bytes()
    pp = key.encode()

    winners = []
    for label, page, reserve, kdf_iter, hkdf_iter, kdf, hmac_h, strip in COMBOS:
        try:
            ok = try_combo(pp, db_bytes, page, reserve, kdf_iter, hkdf_iter, kdf, hmac_h, strip)
        except Exception as e:
            ok = False
            err = f"  ({type(e).__name__}: {e})"
        else:
            err = ""
        flag = "✓✓✓ MATCH" if ok else "       no"
        print(f"  {flag}   {label:38s}  page={page:5d} reserve={reserve:3d} kdf={kdf_iter:6d} kdf_hash={kdf_hash_short(kdf)} hmac={hmac_h}{err}")
        if ok:
            winners.append(label)

    print()
    if winners:
        print(f"WORKS: {winners}")
        print("→ paste this whole output into the GitHub issue so the maintainer can hardcode this combo for your QQ build")
    else:
        print("NO COMBO WORKS — your captured 16-char key likely isn't the real DB key.")
        print("Possible: the PS hook captured a placeholder before the real key arrives.")
        print("Try modifying cli/native/qq_get_key.ps1 to NOT TerminateProcess after first hit;")
        print("collect ALL 16-char strings observed at the breakpoint, then re-run this with each.")


def kdf_hash_short(name: str) -> str:
    return {"sha512": "sha512", "sha1": "sha1  "}.get(name, name)


if __name__ == "__main__":
    main()
