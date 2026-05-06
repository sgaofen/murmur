"""refresh.py — 调 go_decrypt.dll 批量解密最新微信数据。

用法：
    python refresh.py                         # 自动发现 wxid 和路径
    python refresh.py --wxid wxid_xxx         # 指定账号（多账号时）
    python refresh.py --key da31...           # 跳过从 ~/.murmur/config.json 读 key
"""
from __future__ import annotations

import argparse
import ctypes
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

# Force utf-8 stdio so multi-account auto-detect's `print("✓ 匹配")` doesn't
# UnicodeEncodeError on Chinese Windows (PyInstaller etcli.exe ignores
# PYTHONIOENCODING; sys.stdout defaults to gbk; ✓ U+2713 has no gbk mapping).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

# Cross-platform path discovery
sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import (
    IS_WINDOWS, IS_MAC, native_dir, load_config,
    discover_wechat_profiles, decrypted_root_for, WeChatProfile,
)
from decrypt_cache import DecryptCache

SKIP = {'message_fts.db', 'contact_fts.db', 'favorite_fts.db', 'message_resource.db'}

# NOTE: removed the v0.4.0 "WeChat must not be running" pre-flight gate.
# Decrypting while WeChat is open works fine in practice — peers like
# PyWxDump and LC044/WeChatMsg do the same, and Murmur's WAL-frame merge
# (decrypt_py.decrypt_wal) already covers the in-flight write boundary.
# The gate was causing friction without buying us anything users couldn't
# already get from atomic swap + WAL replay.


# Maps cryptic go_decrypt.dll / decrypt_py messages to a Chinese hint that names
# the actual root cause + a fix. Without this every error surfaces as raw English
# and produces near-identical "解不开" support tickets — see WeFlow's
# formatInitProtectionError for the same pattern.
_ERROR_HINTS = (
    ("wrong key", "密钥不属于这个账号 — 多账号情况下可能抓错了号；请回到密钥页重抓（确认抓时微信登录的就是这个号）"),
    ("hmac", "密钥不属于这个账号 — 多账号情况下可能抓错了号；请回到密钥页重抓"),
    ("incorrect", "密钥校验失败 — 请重新抓密钥"),
    ("no such file", "数据库文件不存在 — 请确认微信目录完整，或重启微信再点开几个聊天"),
    ("permission denied", "没有读取权限 — 请关闭微信后重试，或检查文件夹权限"),
    ("being used by another process", "文件被微信占用 — 请关闭微信后重试"),
    ("unexpected eof", "数据库文件损坏或微信正在写入 — 请关闭微信再重试"),
    ("invalid argument", "数据库格式无法识别 — 可能微信刚升级且更换了 schema；建议重抓密钥并清空 ~/Documents/Murmur/decrypted/"),
    ("disk i/o error", "磁盘读写错误 — 检查目标盘是否还有空间，或换个盘"),
    ("encrypted database is malformed", "解密后 schema 异常 — 微信可能升级了；请清掉 ~/Documents/Murmur/decrypted/<wxid_short>/ 后重抓密钥重试"),
)


def friendly_error(raw: str) -> str:
    """Pretty-print a decrypt error: original message + a Chinese hint when we recognise it.

    Returning the raw text alone is fine for debugging but hostile for end users
    who'll just see English jargon. Always include the raw so power users still
    have something to grep against.
    """
    if not raw:
        return ""
    low = raw.lower()
    for needle, hint in _ERROR_HINTS:
        if needle in low:
            return f"{raw}  →  {hint}"
    return raw


def load_dll():
    """Win-only: load the bundled go_decrypt.dll. Returns None on non-Windows."""
    if not IS_WINDOWS:
        return None
    nd = native_dir()
    dll = nd / 'go_decrypt.dll'
    if not dll.exists():
        return None
    os.add_dll_directory(str(nd))
    lib = ctypes.CDLL(str(dll))
    lib.DecryptDatabase.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p]
    lib.DecryptDatabase.restype = ctypes.c_void_p
    lib.FreeString.argtypes = [ctypes.c_void_p]
    lib.FreeString.restype = None
    return lib


def decrypt(lib, src: Path, dst: Path, key: bytes) -> str | None:
    """Decrypt one .db file. Uses Win DLL when available, else pure-Python.

    Returns None on success, or an error string. The caller should set lib=None
    on Mac/Linux to force the Python implementation.
    """
    if lib is not None:
        ret = lib.DecryptDatabase(str(src).encode('utf-8'), str(dst).encode('utf-8'), key)
        if ret is None or ret == 0:
            return None
        err = ctypes.string_at(ret).decode('utf-8', errors='replace')
        lib.FreeString(ctypes.c_void_p(ret))
        return err
    # Pure-Python fallback (cross-platform, including macOS / Linux)
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from decrypt_py import decrypt_db
        decrypt_db(src, dst, key.decode('ascii') if isinstance(key, bytes) else key)
        return None
    except Exception as e:
        return f"{type(e).__name__}: {e}"


def find_decrypt_key(profile: WeChatProfile, override: str | None = None) -> str | None:
    """Resolve the decryption key from override / config / legacy echotrace prefs."""
    if override:
        return override.strip().lower()
    cfg = load_config()
    if cfg.get("decrypt_key"):
        return cfg["decrypt_key"].strip().lower()
    if cfg.get("key"):
        return cfg["key"].strip().lower()
    # Legacy: read from echotrace's shared_preferences.json
    if IS_WINDOWS:
        legacy = Path(os.environ.get("APPDATA") or "") / "com.example/echotrace/shared_preferences.json"
        if legacy.exists():
            try:
                import json
                d = json.loads(legacy.read_text(encoding="utf-8"))
                return d.get("flutter.decrypt_key", "").strip().lower() or None
            except Exception:
                pass
    return None


def verify_passphrase(profile: WeChatProfile, key_hex: str) -> bool:
    """Try to decrypt the first page of profile's session.db with key_hex.
    Returns True iff HMAC verifies — i.e. the key is for THIS profile.

    Used to auto-pick the right wxid when the user has multiple WeChat
    accounts and we don't know which one the saved key belongs to.
    """
    sess = profile.encrypted_root / "session" / "session.db"
    if not sess.exists():
        return False
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from decrypt_py import decrypt_db as _decrypt_one
    except Exception:
        return False
    tmp = Path(tempfile.mkdtemp(prefix="murmur_verify_"))
    try:
        out = tmp / "session.db"
        try:
            _decrypt_one(sess, out, key_hex)
        except Exception:
            return False
        return out.exists() and out.stat().st_size > 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def select_profile(args) -> WeChatProfile:
    profiles = discover_wechat_profiles()
    if not profiles:
        raise SystemExit("找不到微信账号数据。请先在微信里登录一次。")
    if args.wxid:
        for p in profiles:
            if p.wxid == args.wxid or p.wxid_short == args.wxid:
                return p
        raise SystemExit(f"找不到账号 {args.wxid}. 已发现: {[p.wxid for p in profiles]}")
    if len(profiles) == 1:
        return profiles[0]
    # Multi-account: try the saved key against each profile's session.db
    # to auto-pick the one the key actually belongs to. This kills the
    # GitHub issues #4 #6 #7 class where refresh.py blindly picked
    # profiles[0], failed HMAC against the wrong account, and looped.
    saved_key = find_decrypt_key(profiles[0], override=args.key)
    if saved_key:
        print(f"[!] 发现 {len(profiles)} 个账号，自动验证保存的 key 属于哪一个...")
        for p in profiles:
            try:
                ok = verify_passphrase(p, saved_key)
            except Exception as e:
                print(f"    {p.wxid}: 验证抛异常 {type(e).__name__}: {e}")
                continue
            mark = "✓ 匹配" if ok else "× 不匹配"
            print(f"    {p.wxid}: {mark}")
            if ok:
                print(f"[+] 自动选中 {p.wxid}（保存的 key 验证通过）")
                return p
        raise SystemExit(
            f"保存的 key 在 {len(profiles)} 个账号上都验证失败。"
            f"请用 --wxid 指定，或者重新抓 key（确保抓的时候微信登录的是想分析的那个号）。"
        )
    # No key saved → can't auto-detect; ask user to pick explicitly
    print(f"[!] 发现 {len(profiles)} 个账号，但未找到保存的 key 来自动选择：")
    for p in profiles:
        print(f"    - {p.wxid}")
    print("[!] 默认使用第一个 (--wxid 可指定):")
    return profiles[0]


def _load_per_db_keys() -> dict | None:
    """Mac path: ~/.murmur/decrypted_keys.json (written by extract_key_mac.py).
    Returns the dict if present and well-formed, else None."""
    p = Path.home() / ".murmur" / "decrypted_keys.json"
    if not p.exists():
        return None
    try:
        d = __import__("json").loads(p.read_text(encoding="utf-8"))
        if isinstance(d, dict) and (d.get("keys_by_db") or d.get("keys_by_salt")):
            return d
    except Exception:
        pass
    return None


def _decrypt_per_db(profile: WeChatProfile, per_db: dict) -> int:
    """Mac fast-path: each DB has its own pre-derived AES key, no PBKDF2."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from decrypt_py import decrypt_db as _decrypt_one  # noqa: E402

    keys_by_name: dict[str, str] = per_db.get("keys_by_db") or {}
    keys_by_salt: dict[str, str] = per_db.get("keys_by_salt") or {}

    dst_dir = decrypted_root_for(profile)
    dst_dir.mkdir(parents=True, exist_ok=True)
    print(f"[INFO] 解密目标: {dst_dir}")
    print(f"[INFO] 模式: 每库独立 AES key（macOS WCDB 路径，跳过 PBKDF2）")

    src_dbs = sorted(p for p in profile.encrypted_root.rglob("*.db") if p.name not in SKIP)
    staging = Path(tempfile.mkdtemp(prefix='murmur_refresh_'))
    print(f"[INFO] 临时目录: {staging}")
    print(f"[INFO] 共 {len(src_dbs)} 个加密 DB 待处理\n")

    results = []
    t_total = time.time()
    for i, src in enumerate(src_dbs, 1):
        out = staging / src.name
        size_mb = src.stat().st_size / 1e6
        rel = str(src.relative_to(profile.encrypted_root)).replace("\\", "/")
        # Try by name, then by salt
        key_hex = keys_by_name.get(rel)
        if not key_hex:
            try:
                with open(src, "rb") as f:
                    salt_hex = f.read(16).hex()
                key_hex = keys_by_salt.get(salt_hex)
            except OSError:
                pass
        if not key_hex:
            print(f"  [{i:2d}/{len(src_dbs)}] SKIP ({size_mb:6.1f} MB) {rel}: 这个 DB 在 WCDB 缓存里没找到，请在微信里点开它对应的对话/页面后重抓 key")
            results.append((src.name, False, "no key in WCDB cache"))
            continue
        t0 = time.time()
        try:
            _decrypt_one(src, out, key_hex, pre_derived=True)
            dt = time.time() - t0
            print(f"  [{i:2d}/{len(src_dbs)}] OK   ({size_mb:6.1f} MB, {dt:5.2f}s) {src.name}")
            results.append((src.name, True, None))
        except Exception as e:
            dt = time.time() - t0
            print(f"  [{i:2d}/{len(src_dbs)}] FAIL ({size_mb:6.1f} MB, {dt:5.2f}s) {rel}: {friendly_error(str(e))}")
            results.append((src.name, False, str(e)))

    print(f"\n[INFO] 解密耗时 {time.time() - t_total:.2f}s")
    print("\n[INFO] swap 到目标目录...")
    moved = 0
    for fname, ok, _ in results:
        if not ok:
            continue
        src_f = staging / fname
        dst_f = dst_dir / fname
        try:
            for ext in ('-wal', '-shm', '-journal'):
                sc = dst_dir / (fname + ext)
                if sc.exists():
                    sc.unlink()
            if dst_f.exists():
                dst_f.unlink()
            shutil.move(src_f, dst_f)
            moved += 1
        except OSError as e:
            print(f"  [SWAP-FAIL] {fname}: {e}")
    shutil.rmtree(staging, ignore_errors=True)
    n_ok = sum(1 for _, ok, _ in results if ok)
    n_fail = len(results) - n_ok
    print(f"\n[DONE] 解密 {n_ok} 个，swap {moved} 个，失败 {n_fail} 个")
    core = {"session.db", "contact.db"}
    moved_names = {fname for fname, ok, _ in results if ok}
    missing_core = sorted(core - moved_names)
    if missing_core:
        print(f"[ERR] 核心数据库未解密: {', '.join(missing_core)}")
        return 1
    if n_fail:
        print(
            f"[WARN] 部分数据库未解密: {n_fail} 个。"
            "已保留可用核心数据；如果缺消息或朋友圈，请回微信多点开几个聊天/朋友圈后重新抓密钥。"
        )
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wxid", help="WeChat account (auto-detected if omitted)")
    parser.add_argument("--key", help="64-hex SQLCipher key (omits config lookup)")
    # WeFlow's `forceReopen` analog: when WeChat upgrades and changes its DB schema,
    # the previously-swapped session.db becomes unreadable to the new etcli code path.
    # `--force` nukes the per-account decrypted dir up front so next decrypt is clean.
    parser.add_argument("--force", action="store_true",
                        help="清空目标解密目录后再解密（schema 异常 / 微信升级后用）")
    # --allow-running kept as a no-op for back-compat with already-shipped
    # frontend builds that still POST {force_running: true}. The WeChat-running
    # gate has been removed — decryption while WeChat is open is safe per WAL
    # frame merge + atomic swap.
    parser.add_argument("--allow-running", action="store_true",
                        help=argparse.SUPPRESS)
    args = parser.parse_args()

    profile = select_profile(args)
    print(f"[INFO] 账号: {profile.wxid}")
    print(f"[INFO] 加密源: {profile.encrypted_root}")

    # Mac WCDB path: if extract_key_mac.py left per-DB keys, use them
    # (skips PBKDF2 — much faster and works with the AES keys WCDB caches).
    per_db = _load_per_db_keys()
    if per_db and not args.key:
        return _decrypt_per_db(profile, per_db)

    key_hex = find_decrypt_key(profile, override=args.key)
    if not key_hex:
        if IS_MAC:
            raise SystemExit(
                "找不到 Mac 解密密钥。\n"
                "请先回到 Murmur 点「密钥」→「开始自动抓取」，按提示在微信里点开几个聊天/朋友圈后再抓取。\n"
                "抓到后会生成 ~/.murmur/decrypted_keys.json，然后再点「更新数据」。\n"
                "已有解密数据仍可继续浏览；只有更新最新微信数据时才需要这个密钥。"
            )
        raise SystemExit(
            "找不到密钥。请先运行：\n"
            "    python extract_key_dll.py --auto-restart --save-to ~/.murmur/key.json\n"
            "或者用 --key <64位hex> 直接传入。"
        )
    if len(key_hex) != 64:
        raise SystemExit(f"密钥长度不对：{len(key_hex)} 字符 (应为 64).")
    key_bytes = key_hex.encode("utf-8")

    dst_dir = decrypted_root_for(profile)
    dst_dir.mkdir(parents=True, exist_ok=True)
    if args.force and dst_dir.exists():
        print(f"[INFO] --force 清空 {dst_dir}")
        for entry in dst_dir.iterdir():
            try:
                if entry.is_file() or entry.is_symlink():
                    entry.unlink()
                elif entry.is_dir():
                    shutil.rmtree(entry, ignore_errors=True)
            except OSError as e:
                print(f"[WARN] 无法删除 {entry}: {e}")
    print(f"[INFO] 解密目标: {dst_dir}")

    lib = load_dll()
    src_dbs = sorted(p for p in profile.encrypted_root.rglob("*.db") if p.name not in SKIP)

    # Incremental cache: skip files whose source mtime + size + WAL mtime are
    # unchanged since the last successful decrypt with the same key. --force
    # bypasses the cache entirely (and the destination is already nuked above).
    cache = DecryptCache(dst_dir, key_bytes, src_root=profile.encrypted_root)
    bypass_cache = bool(args.force)

    staging = Path(tempfile.mkdtemp(prefix='murmur_refresh_'))
    print(f"[INFO] 临时目录: {staging}")
    print(f"[INFO] 共 {len(src_dbs)} 个加密 DB 待处理（缓存命中将跳过）\n")

    results = []
    t_total = time.time()
    swap_failed = 0
    skipped_cached = 0
    try:
        for i, src in enumerate(src_dbs, 1):
            size_mb = src.stat().st_size / 1e6
            if not bypass_cache and cache.is_fresh(src):
                # Output is still valid — don't re-decrypt, don't queue for swap.
                print(f"  [{i:2d}/{len(src_dbs)}] CACHE ({size_mb:6.1f} MB) {src.name}")
                skipped_cached += 1
                continue
            out = staging / src.name
            t0 = time.time()
            err = decrypt(lib, src, out, key_bytes)
            dt = time.time() - t0
            if err:
                print(f"  [{i:2d}/{len(src_dbs)}] FAIL ({size_mb:6.1f} MB, {dt:5.2f}s) {src.relative_to(profile.encrypted_root)}: {friendly_error(err)}")
                results.append((src.name, False, err, src))
                # Cache may now be lying about this file — drop it so the next
                # refresh actually retries instead of marking it as fresh.
                cache.forget(src)
            else:
                print(f"  [{i:2d}/{len(src_dbs)}] OK   ({size_mb:6.1f} MB, {dt:5.2f}s) {src.name}")
                results.append((src.name, True, None, src))

        print(f"\n[INFO] 解密耗时 {time.time() - t_total:.2f}s")

        # Atomic per-file swap: copy into a sibling .tmp on the destination
        # filesystem (so os.replace is atomic), then rename. Avoids the brief
        # window where dst doesn't exist that `unlink → shutil.move` opens, and
        # eliminates the corrupt-half-decrypted-DB case if Murmur is killed
        # between unlink and move.
        print("\n[INFO] swap 到目标目录...")
        moved = 0
        for fname, ok, _, src_path in results:
            if not ok:
                continue
            src_f = staging / fname
            dst_f = dst_dir / fname
            tmp_f = dst_dir / (fname + ".swap-tmp")
            try:
                # Clean up companion files left from the previous decrypt.
                for ext in ('-wal', '-shm', '-journal'):
                    sc = dst_dir / (fname + ext)
                    if sc.exists():
                        sc.unlink()
                if tmp_f.exists():
                    tmp_f.unlink()
                shutil.copy2(src_f, tmp_f)  # cross-filesystem-safe write
                os.replace(tmp_f, dst_f)    # atomic same-fs rename
                src_f.unlink(missing_ok=True)
                moved += 1
                # Replay any pending WAL frames into the freshly-swapped DB so
                # the user sees post-checkpoint messages. WAL is encrypted with
                # the same key+salt as the main DB; failure to apply is silent
                # (best-effort) since plain SQLite would just open without WAL.
                try:
                    from decrypt_py import decrypt_wal
                    wal_path = src_path.with_suffix(src_path.suffix + "-wal")
                    if wal_path.exists():
                        applied = decrypt_wal(src_path, wal_path, dst_f, key_hex)
                        if applied:
                            print(f"      WAL: 合并 {applied} 帧")
                except Exception as e:
                    print(f"      WAL: 合并失败 {e}")
                # Only mark cache after the swap actually landed — otherwise a
                # crash between decrypt and swap would leave the cache thinking
                # this file is fresh while the dst is still the old version.
                cache.mark_done(src_path)
            except OSError as e:
                print(f"  [SWAP-FAIL] {fname}: {e}")
                if tmp_f.exists():
                    try:
                        tmp_f.unlink()
                    except OSError:
                        pass
                swap_failed += 1
    finally:
        # Always clean staging — even on Ctrl-C — so we don't leak GBs of
        # decrypted scratch data into TMPDIR.
        shutil.rmtree(staging, ignore_errors=True)
        # Persist cache state best-effort — failure here is not fatal.
        try:
            cache.save()
        except Exception as e:
            print(f"[WARN] 缓存写入失败: {e}")

    n_ok = sum(1 for _, ok, _, _ in results if ok)
    n_fail = len(results) - n_ok
    summary = (
        f"\n[DONE] 新解密 {n_ok}，缓存命中 {skipped_cached}，swap {moved}，失败 {n_fail}"
        + (f"，swap 失败 {swap_failed}" if swap_failed else "")
    )
    print(summary)

    # Multi-DB schema sentinel — warn (don't fail) when secondary DBs landed
    # but their sentinel tables are missing. Catches the "schema drift"
    # category of bugs that a session.db-only check misses.
    try:
        from paths import detect_partial_decrypt
        broken = detect_partial_decrypt(dst_dir)
        if broken:
            print(f"[WARN] 这些 DB 缺少预期的表：{', '.join(broken)} —— "
                  f"微信可能升级了 schema，建议 refresh.py --force 重新解密")
    except Exception:
        pass
    return 0 if (n_fail == 0 and swap_failed == 0) else 1


if __name__ == '__main__':
    sys.exit(main())
