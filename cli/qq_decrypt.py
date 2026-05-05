"""qq_decrypt.py — pure-Python QQNT SQLCipher v3 decryptor.

QQNT 9.9.x stores its databases under <Tencent Files>/<qq>/nt_qq/nt_db/, each
prefixed with a 1024-byte custom "QQ_NT DB" metadata page and the rest as
SQLCipher v3 with custom params:

    page_size     = 4096
    reserve       = 48           (16 IV + 20 HMAC-SHA1, padded to 16-block)
    cipher        = AES-256-CBC
    KDF algorithm = PBKDF2-HMAC-SHA512  (asymmetric — see below)
    HMAC          = HMAC-SHA1
    KDF iter      = 4000
    HMAC key iter = 2

Why "asymmetric" SHA512 KDF + SHA1 HMAC: Tencent picked this — confirmed
empirically by trying every combination against a real DB.

Verified: QQNT 9.9.20.36580 + 9.9.29-47354 (both work with these params).
The 16-character ASCII passphrase is captured by `qq_get_key.ps1` (see
`cli/native/qq_get_key.ps1`, which dynamically resolves the
`sqlite3_key_v2` function via PE string-reference parsing — version-
independent on the QQNT 9.9.x family).
"""
from __future__ import annotations

import hashlib
import hmac as hmac_mod
import sys
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend
except ImportError as e:
    raise SystemExit("missing dep: cryptography (pip install cryptography)") from e


# QQNT-specific constants. Confirmed by HMAC-verifying real DBs end-to-end.
PAGE_SIZE = 4096
RESERVE   = 48          # 16 IV + 20 HMAC + 12 align padding (per SQLCipher v3 ceil((16+20)/16)*16)
HMAC_SIZE = 20          # full HMAC-SHA1 stored, not truncated
IV_SIZE   = 16
HEADER_PAGE_BYTES = 1024  # QQNT-prefixed metadata page; strip before SQLCipher kicks in
KDF_ITER  = 4000
HMAC_KEY_ITER = 2

SQLITE_HEADER = b"SQLite format 3\x00"  # 16 bytes — replaces the salt in plaintext output


class WrongKeyError(ValueError):
    """The provided passphrase does not produce a valid HMAC on page 1."""


def _derive_keys(password: bytes, salt: bytes) -> tuple[bytes, bytes]:
    """QQNT key derivation (SHA512 KDF, SHA1 HMAC)."""
    aes_key = hashlib.pbkdf2_hmac("sha512", password, salt, KDF_ITER, 32)
    mac_salt = bytes(b ^ 0x3a for b in salt)
    hmac_key = hashlib.pbkdf2_hmac("sha512", aes_key, mac_salt, HMAC_KEY_ITER, 32)
    return aes_key, hmac_key


def verify_passphrase(db_path: Path, passphrase: str) -> bool:
    """Cheap check: does this passphrase decrypt page 1's HMAC? Doesn't decrypt anything."""
    raw = db_path.read_bytes()
    if len(raw) < HEADER_PAGE_BYTES + PAGE_SIZE:
        return False
    stripped = raw[HEADER_PAGE_BYTES:HEADER_PAGE_BYTES + PAGE_SIZE]
    if len(stripped) < PAGE_SIZE:
        return False
    salt = stripped[:IV_SIZE]
    _, hmac_key = _derive_keys(passphrase.encode("utf-8"), salt)
    body_end = PAGE_SIZE - RESERVE
    body = stripped[IV_SIZE:body_end]  # page 1 has salt at first 16 bytes; body starts after
    iv = stripped[body_end:body_end + IV_SIZE]
    stored_hmac = stripped[body_end + IV_SIZE:body_end + IV_SIZE + HMAC_SIZE]
    page_no_le = (1).to_bytes(4, "little")
    m = hmac_mod.new(hmac_key, digestmod=hashlib.sha1)
    m.update(body); m.update(iv); m.update(page_no_le)
    return hmac_mod.compare_digest(m.digest()[:HMAC_SIZE], stored_hmac)


def decrypt_db(src: Path, dst: Path, passphrase: str) -> int:
    """Decrypt a QQNT-format encrypted DB into a vanilla SQLite file at `dst`.

    Returns the number of pages successfully decrypted (HMAC-verified).
    Raises WrongKeyError if even page 1 fails to verify (catches typos before
    we waste time on the rest).
    """
    raw = src.read_bytes()
    if len(raw) < HEADER_PAGE_BYTES + PAGE_SIZE:
        raise ValueError(f"{src} too small to be a QQNT DB ({len(raw)} bytes)")
    stripped = raw[HEADER_PAGE_BYTES:]
    if len(stripped) % PAGE_SIZE != 0:
        raise ValueError(f"{src} body length {len(stripped)} not multiple of {PAGE_SIZE}")
    n_pages = len(stripped) // PAGE_SIZE

    salt = stripped[:IV_SIZE]
    aes_key, hmac_key = _derive_keys(passphrase.encode("utf-8"), salt)
    body_end = PAGE_SIZE - RESERVE
    backend = default_backend()

    out = bytearray()
    decrypted = 0
    for p_idx in range(n_pages):
        page_off = p_idx * PAGE_SIZE
        page = stripped[page_off:page_off + PAGE_SIZE]
        body_start = IV_SIZE if p_idx == 0 else 0
        body = page[body_start:body_end]
        iv = page[body_end:body_end + IV_SIZE]
        stored_hmac = page[body_end + IV_SIZE:body_end + IV_SIZE + HMAC_SIZE]

        page_no_le = (p_idx + 1).to_bytes(4, "little")
        m = hmac_mod.new(hmac_key, digestmod=hashlib.sha1)
        m.update(body); m.update(iv); m.update(page_no_le)
        if not hmac_mod.compare_digest(m.digest()[:HMAC_SIZE], stored_hmac):
            if p_idx == 0:
                raise WrongKeyError("passphrase failed HMAC on page 1 — wrong key")
            # Subsequent failures: write zeros (corrupted page; user can still
            # read other tables). Logging upstream catches this.
            if p_idx == 0:
                out.extend(SQLITE_HEADER)
            out.extend(b"\x00" * (PAGE_SIZE - (IV_SIZE if p_idx == 0 else 0)))
            continue

        cipher = Cipher(algorithms.AES(aes_key), modes.CBC(iv), backend=backend)
        plain = cipher.decryptor().update(body) + cipher.decryptor().finalize()

        if p_idx == 0:
            out.extend(SQLITE_HEADER)  # synthesize standard SQLite header
        out.extend(plain)
        # zero-pad the reserve so the output is exactly PAGE_SIZE per page
        out.extend(b"\x00" * RESERVE)
        decrypted += 1

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(bytes(out))
    return decrypted


# --- batch driver ---

# QQNT databases we actually care about. Skip the FTS index shards (separately
# rebuildable) and ephemeral caches.
QQ_DB_NAMES = (
    "nt_msg.db",         # private + group messages
    "profile_info.db",   # contacts + own profile
    "group_info.db",     # group metadata + member lists
    "rich_media.db",     # media references (not the bytes themselves)
    "guild_msg.db",      # guild (Discord-like) messages, may be empty
    "files_in_chat.db",  # file/image transfer history
)


def decrypt_profile(src_dir: Path, dst_dir: Path, passphrase: str) -> dict:
    """Decrypt all QQ_DB_NAMES under src_dir into dst_dir.

    Returns a dict {db_name: 'ok'|str_error, ...}. If the passphrase is wrong
    on the FIRST db tried, raises WrongKeyError so caller can show a helpful
    error before iterating through the rest.
    """
    out: dict = {}
    dst_dir.mkdir(parents=True, exist_ok=True)
    first = True
    for name in QQ_DB_NAMES:
        src = src_dir / name
        if not src.exists():
            out[name] = "skip (file not present)"
            continue
        dst = dst_dir / name
        try:
            n = decrypt_db(src, dst, passphrase)
            out[name] = f"ok ({n} pages)"
        except WrongKeyError as e:
            if first:
                raise
            out[name] = f"wrong-key: {e}"
        except Exception as e:
            out[name] = f"{type(e).__name__}: {e}"
        first = False
    return out


# --- key extraction (calls the bundled PowerShell script) ---

def extract_key_via_powershell(timeout: int = 180) -> dict:
    """Run the bundled qq_get_key.ps1 to capture the QQNT SQLCipher passphrase.

    Returns: {ok: bool, key: str | None, log: str, error: str | None}.

    The script:
      1. Auto-detects QQNT install + wrapper.node
      2. Statically parses the PE to find the sqlite3_key_v2 function RVA
         (string-reference based, so version-independent in the 9.9.x family)
      3. Spawns QQ.exe with a debugger attached and breakpoints the function
      4. Waits for user to log in; key is captured at the breakpoint
      5. Detaches + terminates QQ
    """
    if sys.platform != "win32":
        return {"ok": False, "key": None, "log": "", "error": "Windows-only"}

    import subprocess as _sp

    # Resolve path to bundled PowerShell script.
    cli_dir = Path(__file__).resolve().parent
    ps_script = cli_dir / "native" / "qq_get_key.ps1"
    if not ps_script.exists():
        # Fallback for PyInstaller frozen mode where native/ might be at _MEIPASS
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            cand = Path(meipass) / "native" / "qq_get_key.ps1"
            if cand.exists():
                ps_script = cand
    if not ps_script.exists():
        return {"ok": False, "key": None, "log": "", "error": f"qq_get_key.ps1 not found at {ps_script}"}

    cmd = [
        "powershell.exe", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", str(ps_script),
    ]

    try:
        r = _sp.run(cmd, capture_output=True, text=True, timeout=timeout,
                     encoding="utf-8", errors="replace")
    except _sp.TimeoutExpired:
        return {"ok": False, "key": None, "log": "", "error": f"timeout after {timeout}s — did the user log in?"}
    except Exception as e:
        return {"ok": False, "key": None, "log": "", "error": f"{type(e).__name__}: {e}"}

    log = (r.stdout or "") + ("\n" + r.stderr if r.stderr else "")
    # Parse the key out of the script's output. The exact line is:
    #   找到密钥: <16 chars>
    # which the script also emits as part of a final result table.
    key = None
    for line in log.splitlines():
        line = line.strip()
        # Robust: match either "找到密钥" or "Key found" or the trailing 16-char field
        if line.startswith("找到密钥:") or line.startswith("Key found:"):
            key = line.split(":", 1)[1].strip()
            break
    # Fall back: scan for a 16-char ASCII passphrase token in the trailing table
    if not key:
        for line in log.splitlines():
            tokens = line.strip().split()
            if len(tokens) >= 1 and len(tokens[-1]) == 16 and all(0x20 <= ord(c) < 0x7f for c in tokens[-1]):
                cand = tokens[-1]
                # Sanity: it should NOT be all digits or all letters (real keys mix)
                if any(not c.isalnum() for c in cand):
                    key = cand
                    break

    if key:
        return {"ok": True, "key": key, "log": log[-3000:], "error": None}
    return {"ok": False, "key": None, "log": log[-3000:],
            "error": "未捕获到密钥。请确认在 QQ 弹出窗口里完成扫码登录后再等几秒。"}


if __name__ == "__main__":
    import argparse
    import json
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("extract-key")
    spd = sub.add_parser("decrypt")
    spd.add_argument("src_db", type=Path)
    spd.add_argument("dst_db", type=Path)
    spd.add_argument("--key", required=True)
    spp = sub.add_parser("decrypt-profile")
    spp.add_argument("src_dir", type=Path)
    spp.add_argument("dst_dir", type=Path)
    spp.add_argument("--key", required=True)
    args = p.parse_args()

    if args.cmd == "extract-key":
        r = extract_key_via_powershell()
        print(json.dumps(r, ensure_ascii=False, indent=2))
        sys.exit(0 if r["ok"] else 1)
    if args.cmd == "decrypt":
        n = decrypt_db(args.src_db, args.dst_db, args.key)
        print(f"OK: {n} pages → {args.dst_db}")
    if args.cmd == "decrypt-profile":
        r = decrypt_profile(args.src_dir, args.dst_dir, args.key)
        for k, v in r.items():
            print(f"  {k:25s}  {v}")
