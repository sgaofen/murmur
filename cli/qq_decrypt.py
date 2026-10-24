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
import re
import sys
from pathlib import Path


def _load_aes():
    """Import the AES primitives lazily so key verification (pure hashlib/hmac)
    works — and is testable — without the `cryptography` package installed."""
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend
    except ImportError as e:
        raise SystemExit("missing dep: cryptography (pip install cryptography)") from e
    return Cipher, algorithms, modes, default_backend


# QQNT cipher constants. Both SHA1 and SHA512 HMAC variants exist in the wild:
# - 9.9.x ≤ 9.9.16: HMAC-SHA1, RESERVE=48 (16 IV + 20 HMAC + 12 pad to 16-block)
# - 9.9.x ≥ 9.9.17 (per QQBackup/qq-win-db-key issue #50): HMAC-SHA512, RESERVE=64
# We trial-decrypt page 1 with each variant and pick the one that verifies —
# kills the wrong-key false-positive that issue #5 hit on QQ NT 9.9.29.
PAGE_SIZE = 4096
IV_SIZE   = 16
HEADER_PAGE_BYTES = 1024  # QQNT-prefixed metadata page; strip before SQLCipher kicks in
KDF_ITER  = 4000
HMAC_KEY_ITER = 2

# Back-compat aliases (referenced elsewhere in the code base — keep symbols stable).
RESERVE   = 48          # default to SHA1 variant
HMAC_SIZE = 20

SQLITE_HEADER = b"SQLite format 3\x00"  # 16 bytes — replaces the salt in plaintext output


class WrongKeyError(ValueError):
    """The provided passphrase does not produce a valid HMAC on page 1."""


# Each variant: (label, hmac_hash_name, hmac_size_bytes, reserve)
_QQNT_CIPHER_VARIANTS = [
    ("sha1",   "sha1",   20, 48),   # 9.9.x ≤ 9.9.16
    ("sha512", "sha512", 32, 64),   # 9.9.17+ — QQBackup/qq-win-db-key issue #50
]


def _derive_keys(password: bytes, salt: bytes) -> tuple[bytes, bytes]:
    """QQNT key derivation (SHA512 KDF — that part hasn't changed across QQNT
    versions; only the HMAC algorithm differs)."""
    aes_key = hashlib.pbkdf2_hmac("sha512", password, salt, KDF_ITER, 32)
    mac_salt = bytes(b ^ 0x3a for b in salt)
    hmac_key = hashlib.pbkdf2_hmac("sha512", aes_key, mac_salt, HMAC_KEY_ITER, 32)
    return aes_key, hmac_key


def _verify_with_variant(stripped: bytes, passphrase: bytes,
                          hmac_hash: str, hmac_size: int, reserve: int) -> bool:
    """Try a single (hmac_hash, reserve) combination. Returns True iff page 1 HMAC verifies."""
    salt = stripped[:IV_SIZE]
    _, hmac_key = _derive_keys(passphrase, salt)
    body_end = PAGE_SIZE - reserve
    body = stripped[IV_SIZE:body_end]
    iv = stripped[body_end:body_end + IV_SIZE]
    stored_hmac = stripped[body_end + IV_SIZE:body_end + IV_SIZE + hmac_size]
    page_no_le = (1).to_bytes(4, "little")
    m = hmac_mod.new(hmac_key, digestmod=getattr(hashlib, hmac_hash))
    m.update(body); m.update(iv); m.update(page_no_le)
    return hmac_mod.compare_digest(m.digest()[:hmac_size], stored_hmac)


def read_first_page(db_path: Path) -> bytes | None:
    """Return page 1 (after stripping the 1024-byte QQNT header), or None if
    the file is too small. Reads only the bytes we need, not the whole DB."""
    with open(db_path, "rb") as f:
        head = f.read(HEADER_PAGE_BYTES + PAGE_SIZE)
    if len(head) < HEADER_PAGE_BYTES + PAGE_SIZE:
        return None
    return head[HEADER_PAGE_BYTES:]


def detect_variant_on_page(stripped: bytes, passphrase: str) -> tuple[str, int, int] | None:
    """Same as detect_cipher_variant but on an already-read page 1, so callers
    trying many candidate keys don't re-read the file each time."""
    pp = passphrase.encode("utf-8")
    for label, hmac_hash, hmac_size, reserve in _QQNT_CIPHER_VARIANTS:
        try:
            if _verify_with_variant(stripped, pp, hmac_hash, hmac_size, reserve):
                return (hmac_hash, hmac_size, reserve)
        except Exception:
            continue
    return None


def detect_cipher_variant(db_path: Path, passphrase: str) -> tuple[str, int, int] | None:
    """Identify which QQNT cipher variant this DB uses with this passphrase.
    Returns (hmac_hash, hmac_size, reserve) or None if no variant matches."""
    stripped = read_first_page(db_path)
    if stripped is None:
        return None
    return detect_variant_on_page(stripped, passphrase)


def verify_passphrase(db_path: Path, passphrase: str) -> bool:
    """Cheap check: does this passphrase decrypt page 1's HMAC under any known
    QQNT variant (SHA1 or SHA512)? Doesn't decrypt anything."""
    return detect_cipher_variant(db_path, passphrase) is not None


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

    # Variant detection — try SHA1 first (legacy), then SHA512 (QQ NT 9.9.17+).
    variant = detect_cipher_variant(src, passphrase)
    if variant is None:
        raise WrongKeyError("passphrase failed HMAC on page 1 — wrong key")
    hmac_hash, hmac_size, reserve = variant

    Cipher, algorithms, modes, default_backend = _load_aes()
    salt = stripped[:IV_SIZE]
    aes_key, hmac_key = _derive_keys(passphrase.encode("utf-8"), salt)
    body_end = PAGE_SIZE - reserve
    backend = default_backend()

    out = bytearray()
    decrypted = 0
    for p_idx in range(n_pages):
        page_off = p_idx * PAGE_SIZE
        page = stripped[page_off:page_off + PAGE_SIZE]
        body_start = IV_SIZE if p_idx == 0 else 0
        body = page[body_start:body_end]
        iv = page[body_end:body_end + IV_SIZE]
        stored_hmac = page[body_end + IV_SIZE:body_end + IV_SIZE + hmac_size]

        page_no_le = (p_idx + 1).to_bytes(4, "little")
        m = hmac_mod.new(hmac_key, digestmod=getattr(hashlib, hmac_hash))
        m.update(body); m.update(iv); m.update(page_no_le)
        if not hmac_mod.compare_digest(m.digest()[:hmac_size], stored_hmac):
            # Subsequent failures: write zeros (corrupted page; user can still
            # read other tables). Logging upstream catches this. Page 1 already
            # checked above by detect_cipher_variant; if we got here, p_idx>=1.
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
        out.extend(b"\x00" * reserve)
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


# --- key candidates: filtering + HMAC verification ---
#
# qq_get_key.ps1 breakpoints the function that references the
# "nt_sqlite3_key_v2: db=%p zDb=%s" log string. On some wrapper.node builds that
# function is the real sqlite3_key_v2 (pKey in R8), on others it is a logging
# wrapper where R8 is just a leftover (often zDb or the login.db key) — see
# issue #5. So the script no longer trusts one register: it reports every
# plausible ASCII string it sees (RCX/RDX/R8/R9 + stack args) across many hits,
# and we keep only the candidate that passes the page-1 HMAC of nt_msg.db.

# login.db is encrypted with this global constant; it is hit first on startup
# and is never the message-DB key (QQBackup's qq_key_extractor.py skips it too).
LOGIN_DB_FIXED_KEY = "BD156D6710D54D8782F4"
QQ_KEY_LEN = 16
MAX_CANDIDATE_LEN = 64
CANDIDATE_MARKER = "MURMUR_KEY_CANDIDATE"
_HEX20_RE = re.compile(r"^[0-9A-Fa-f]{20}$")


def candidate_skip_reason(value: str) -> str | None:
    """Why a captured string can't be the message-DB passphrase, or None if it
    is worth an HMAC check."""
    if not value:
        return "空字符串"
    if value == LOGIN_DB_FIXED_KEY or (len(value) >= 8 and LOGIN_DB_FIXED_KEY.startswith(value)):
        return "login.db 的全局固定 key"
    if _HEX20_RE.match(value):
        return "20 位十六进制（数据库名 zDb）"
    if any(not (0x20 <= ord(c) < 0x7F) for c in value):
        return "含不可打印字符"
    if len(value) > MAX_CANDIDATE_LEN:
        return "长度不合理"
    return None


def _parse_marker_line(line: str) -> dict | None:
    """Parse `MURMUR_KEY_CANDIDATE source=R8 len=16 hex=4142...` -> {source, value}."""
    idx = line.find(CANDIDATE_MARKER)
    if idx < 0:
        return None
    fields = {}
    for tok in line[idx + len(CANDIDATE_MARKER):].split():
        if "=" in tok:
            k, v = tok.split("=", 1)
            fields[k] = v
    hx = fields.get("hex", "")
    try:
        value = bytes.fromhex(hx).decode("ascii")
    except (ValueError, UnicodeDecodeError):
        return None
    return {"source": fields.get("source", "?"), "value": value}


def parse_key_candidates(log: str) -> list[dict]:
    """Extract all key candidates the PowerShell script printed, de-duplicated
    in first-seen order. Also accepts the legacy `找到密钥: <key>` line from
    older copies of the script."""
    out: list[dict] = []
    seen: set = set()
    for raw in (log or "").splitlines():
        line = raw.strip()
        cand = _parse_marker_line(line)
        if cand is None:
            for prefix in ("找到密钥:", "Key found:"):
                if line.startswith(prefix):
                    cand = {"source": "legacy", "value": line[len(prefix):].strip()}
                    break
        if cand is None or cand["value"] in seen:
            continue
        seen.add(cand["value"])
        out.append(cand)
    return out


def filter_key_candidates(cands: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split raw candidates into (to_try, skipped). Strings longer than 16 chars
    also contribute their first 16 chars (the passphrase is 16 bytes and the
    script may have read past it when nKey was unknown). 16-char candidates
    are tried first."""
    to_try: list[dict] = []
    skipped: list[dict] = []
    seen: set = set()

    def _add(source: str, value: str) -> str | None:
        if value in seen:
            return None
        seen.add(value)
        reason = candidate_skip_reason(value)
        if reason:
            skipped.append({"source": source, "value": value, "reason": reason})
        else:
            to_try.append({"source": source, "value": value})
        return reason

    for c in cands:
        reason = _add(c["source"], c["value"])
        # Prefixes of known non-keys (login.db constant, zDb hex names) are
        # never tried; overly long strings still get their 16-char prefix.
        if len(c["value"]) > QQ_KEY_LEN and reason in (None, "长度不合理"):
            _add(c["source"] + "[:16]", c["value"][:QQ_KEY_LEN])
    to_try.sort(key=lambda c: 0 if len(c["value"]) == QQ_KEY_LEN else 1)
    return to_try, skipped


def _mask(value: str) -> str:
    return (value[:3] + "…") if len(value) > 3 else "…"


def summarize_candidates(to_try: list[dict], skipped: list[dict]) -> list[dict]:
    """Masked candidate list, safe to return to the UI / paste into an issue."""
    rows = [{"source": c["source"], "len": len(c["value"]), "preview": _mask(c["value"]),
             "status": "hmac-failed"} for c in to_try]
    rows += [{"source": c["source"], "len": len(c["value"]), "preview": _mask(c["value"]),
              "status": "skipped", "reason": c["reason"]} for c in skipped]
    return rows


def select_verified_key(cands: list[dict], dbs: list) -> dict:
    """Try every plausible candidate against page 1 of each DB in `dbs`
    (a list of (tag, Path) — tag is usually the QQ number).

    Returns {ok, key, tag, db, variant, candidates, error}. ok is True only
    when some candidate passes HMAC verification."""
    to_try, skipped = filter_key_candidates(cands)
    pages = []
    for tag, path in dbs:
        try:
            page = read_first_page(Path(path))
        except OSError:
            page = None
        if page is not None:
            pages.append((tag, Path(path), page))

    for c in to_try:
        for tag, path, page in pages:
            variant = detect_variant_on_page(page, c["value"])
            if variant is not None:
                rows = summarize_candidates([x for x in to_try if x is not c], skipped)
                rows.insert(0, {"source": c["source"], "len": len(c["value"]),
                                "preview": _mask(c["value"]), "status": "verified"})
                return {"ok": True, "key": c["value"], "tag": tag, "db": str(path),
                        "variant": variant[0], "candidates": rows, "error": None}

    return {"ok": False, "key": None, "tag": None, "db": None, "variant": None,
            "candidates": summarize_candidates(to_try, skipped),
            "error": _no_match_error(len(cands), to_try, skipped, len(pages))}


def _no_match_error(n_raw: int, to_try: list[dict], skipped: list[dict], n_dbs: int) -> str:
    next_steps = (
        "下一步：① 重新点「抓 key」，在弹出的 QQ 窗口里登录你要导入的那个 QQ 号，"
        "等聊天列表完全加载出来后再等 20 秒左右，脚本会自动结束；"
        "② 如果还是失败，请到 https://github.com/sgaofen/murmur/issues/5 反馈 QQ 版本号和日志"
        "（日志里的候选值可能就是密钥，贴之前请打码）。"
    )
    if n_dbs == 0:
        return ("没有找到可读的 nt_msg.db，无法验证抓到的 key。"
                "请先确认 QQ 数据目录（<QQ号>/nt_qq/nt_db/nt_msg.db）能被找到。")
    if n_raw == 0:
        return ("抓 key 脚本没有输出任何候选值：断点可能没有命中（QQ 没有登录完成就超时，"
                "或者这个版本的 wrapper.node 结构变了）。" + next_steps)
    reasons: dict = {}
    for s in skipped:
        reasons[s["reason"]] = reasons.get(s["reason"], 0) + 1
    parts = [f"抓到 {n_raw} 个候选值，但没有一个能解开 nt_msg.db。"]
    if skipped:
        detail = "、".join(f"{r} ×{n}" for r, n in reasons.items())
        parts.append(f"其中 {len(skipped)} 个是已知的非消息库字符串，直接跳过（{detail}）。")
    if to_try:
        parts.append(f"另外 {len(to_try)} 个在 nt_msg.db 第 1 页做 HMAC 校验都没通过"
                     "（已试 HMAC-SHA1 reserve=48 和 HMAC-SHA512 reserve=64）。")
    parts.append("这通常说明脚本结束时 QQ 还没打开消息库，或者登录的不是这个 QQ 号。")
    return "".join(parts) + next_steps


def verify_key_for_db(db_path: Path, key: str) -> tuple[bool, str | None]:
    """Check a user-supplied / captured key against page 1 of `db_path`.
    Returns (ok, chinese_error_or_None). Used by /api/qq/save-key so we never
    persist a key that would fail at decrypt time."""
    key = (key or "").strip()
    reason = candidate_skip_reason(key)
    if reason:
        return False, f"这个 key 不是消息库密钥（{reason}）。"
    try:
        page = read_first_page(Path(db_path))
    except OSError as e:
        return False, f"读不了 {db_path}：{e}"
    if page is None:
        return False, f"{db_path} 太小，不像 QQ NT 数据库。"
    if detect_variant_on_page(page, key) is None:
        return False, ("key 校验失败：用它对 nt_msg.db 第 1 页做 HMAC 校验不通过"
                       "（已试 HMAC-SHA1 reserve=48 和 HMAC-SHA512 reserve=64）。"
                       "请确认这个 key 属于这个 QQ 号，或者重新抓 key。")
    return True, None


# --- key extraction (calls the bundled PowerShell script) ---

def _find_ps_script() -> Path:
    cli_dir = Path(__file__).resolve().parent
    ps_script = cli_dir / "native" / "qq_get_key.ps1"
    if not ps_script.exists():
        # Fallback for PyInstaller frozen mode where native/ might be at _MEIPASS
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            cand = Path(meipass) / "native" / "qq_get_key.ps1"
            if cand.exists():
                ps_script = cand
    return ps_script


def _as_text(x) -> str:
    if x is None:
        return ""
    if isinstance(x, bytes):
        return x.decode("utf-8", errors="replace")
    return x


def extract_key_via_powershell(timeout: int = 240, verify_dbs: list | None = None) -> dict:
    """Run the bundled qq_get_key.ps1, collect every key candidate it reports,
    and return the one that passes HMAC verification against `verify_dbs`
    (list of (tag, nt_msg.db Path)).

    Returns: {ok, key, qq, variant, candidates, log, error}.

    The script launches QQ under a debugger, breakpoints the
    nt_sqlite3_key_v2-referencing function, and keeps collecting candidates
    after the first hit (the first hits are login.db's fixed key) until a
    settle window or its own timeout elapses, then terminates QQ.
    """
    def _fail(error: str, log: str = "", candidates=None) -> dict:
        return {"ok": False, "key": None, "qq": None, "variant": None,
                "candidates": candidates or [], "log": log[-3000:], "error": error}

    if sys.platform != "win32":
        return _fail("Windows-only")

    import subprocess as _sp

    ps_script = _find_ps_script()
    if not ps_script.exists():
        return _fail(f"qq_get_key.ps1 not found at {ps_script}")

    # Leave the script headroom to terminate QQ and print its candidates before
    # our own subprocess timeout fires.
    script_timeout = max(30, int(timeout) - 30)
    cmd = [
        "powershell.exe", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", str(ps_script),
        "-TimeoutSeconds", str(script_timeout),
    ]

    timed_out = False
    try:
        r = _sp.run(cmd, capture_output=True, text=True, timeout=timeout,
                    encoding="utf-8", errors="replace")
        out, err = r.stdout, r.stderr
    except _sp.TimeoutExpired as e:
        # Candidates are printed as they are found, so partial output is still useful.
        timed_out = True
        out, err = e.stdout, e.stderr
    except Exception as e:
        return _fail(f"{type(e).__name__}: {e}")

    out, err = _as_text(out), _as_text(err)
    log = out + ("\n" + err if err else "")
    return finish_extraction(log, list(verify_dbs or []), timed_out=timed_out, timeout=timeout)


def verify_dbs_for_profiles(profiles, prefer_qq: str | None = None) -> list:
    """[(qq_number, nt_msg.db path)] for every discovered profile whose
    nt_msg.db exists, with `prefer_qq` first so its match wins."""
    out = []
    for p in profiles:
        db = Path(p.nt_db_dir) / "nt_msg.db"
        if db.exists():
            out.append((p.qq_number, db))
    if prefer_qq:
        out.sort(key=lambda t: 0 if t[0] == prefer_qq else 1)
    return out


def finish_extraction(log: str, verify_dbs: list, *, timed_out: bool = False,
                      timeout: int = 0) -> dict:
    """Parse the script output and HMAC-verify the candidates. Split out of
    extract_key_via_powershell so it is testable off Windows."""
    cands = parse_key_candidates(log)
    res = select_verified_key(cands, verify_dbs)
    if res["ok"]:
        return {"ok": True, "key": res["key"], "qq": res["tag"], "variant": res["variant"],
                "candidates": res["candidates"], "log": log[-3000:], "error": None}
    error = res["error"]
    if timed_out:
        error = f"抓 key 超时（{timeout} 秒）。" + error
    return {"ok": False, "key": None, "qq": None, "variant": None,
            "candidates": res["candidates"], "log": log[-3000:], "error": error}


if __name__ == "__main__":
    import argparse
    import json
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    spk = sub.add_parser("extract-key")
    spk.add_argument("--db", type=Path, action="append", default=[],
                     help="nt_msg.db to verify candidates against (default: all discovered profiles)")
    spk.add_argument("--qq", default=None, help="prefer this QQ number's nt_msg.db")
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
        if args.db:
            dbs = [(str(d), d) for d in args.db]
        else:
            import qq_paths as _qpaths
            dbs = verify_dbs_for_profiles(_qpaths.discover_qq_profiles(), args.qq)
        r = extract_key_via_powershell(verify_dbs=dbs)
        print(json.dumps(r, ensure_ascii=False, indent=2))
        sys.exit(0 if r["ok"] else 1)
    if args.cmd == "decrypt":
        n = decrypt_db(args.src_db, args.dst_db, args.key)
        print(f"OK: {n} pages → {args.dst_db}")
    if args.cmd == "decrypt-profile":
        r = decrypt_profile(args.src_dir, args.dst_dir, args.key)
        for k, v in r.items():
            print(f"  {k:25s}  {v}")
