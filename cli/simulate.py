#!/usr/bin/env python3
"""simulate.py — Stage Murmur failure scenarios for manual verification.

Why this exists:
  Many bugs in GitHub issues only reproduce with specific user setups —
  multi-account WeChat, Chinese-named paths, partial decrypt residue, encoding
  edge cases. Murmur's developer machine usually has just one clean profile, so
  these never fire locally. This tool stages each known failure mode so you can
  click through your own Murmur install and verify the fix actually works.

How it works:
  Each scenario stages fake `xwechat_files` data under
  `~/.murmur/simulator_data/<scenario>/` and rewrites `~/.murmur/config.json` to
  point Murmur at it (via `wechat_roots`). Your real WeChat data is untouched —
  Murmur will simply discover BOTH your real profiles AND the simulated ones.
  The scenarios use distinctive `wxid_simulated_*` names so you can tell them
  apart.

  `reset` restores your original config.json + scrubs the simulator dir.

Usage:
    python cli/simulate.py list
    python cli/simulate.py status
    python cli/simulate.py <scenario>
    python cli/simulate.py reset
"""
from __future__ import annotations

import argparse
import hashlib
import hmac as hmac_mod
import json
import os
import secrets
import shutil
import sys
from pathlib import Path
from typing import Callable, NamedTuple

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass


# ---------- paths ----------

CFG_PATH = Path.home() / ".murmur" / "config.json"
QQ_KEYS_PATH = Path.home() / ".murmur" / "qq_keys.json"
STATE_PATH = Path.home() / ".murmur" / ".simulator_state.json"
SIM_ROOT = Path.home() / ".murmur" / "simulator_data"
MURMUR_HOME = Path.home() / "Documents" / "Murmur"
DECRYPTED_ROOT = MURMUR_HOME / "decrypted"
DECRYPTED_QQ_ROOT = MURMUR_HOME / "decrypted_qq"
DECRYPTED_BACKUP = MURMUR_HOME / "decrypted__sim_real_backup__"
DECRYPTED_QQ_BACKUP = MURMUR_HOME / "decrypted_qq__sim_real_backup__"
MURMUR_EXE = Path.home() / "AppData" / "Local" / "Murmur" / "Murmur.exe"
MURMUR_MAC_APPS = [
    Path("/Applications/Murmur.app"),
    Path.home() / "Applications" / "Murmur.app",
]


# ---------- SQLCipher v4 page encryption (mirror of decrypt_py.py reversed) ----------

PAGE_SIZE = 4096
SALT_SIZE = 16
KEY_SIZE = 32
AES_BLOCK = 16
HMAC_HASH_SIZE = 64
RESERVE = 80
KEY_ITER = 256000
HMAC_KEY_ITER = 2


def _derive_keys(password_bytes: bytes, salt: bytes) -> tuple[bytes, bytes]:
    aes_key = hashlib.pbkdf2_hmac("sha512", password_bytes, salt, KEY_ITER, KEY_SIZE)
    mac_salt = bytes(b ^ 0x3a for b in salt)
    hmac_key = hashlib.pbkdf2_hmac("sha512", aes_key, mac_salt, HMAC_KEY_ITER, KEY_SIZE)
    return aes_key, hmac_key


def _encrypt_one_page_session_db(out_path: Path, password_hex: str) -> None:
    """Write a 1-page SQLCipher v4 encrypted file that verify_passphrase can
    decrypt cleanly with the given password. The body is zeroed plaintext
    (since verify_passphrase only checks HMAC, not SQLite structure)."""
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend
    except ImportError:
        raise SystemExit(
            "cryptography 没装。装一下：python -m pip install cryptography"
        )

    password = bytes.fromhex(password_hex)
    salt = secrets.token_bytes(SALT_SIZE)
    aes_key, hmac_key = _derive_keys(password, salt)

    body_size = PAGE_SIZE - SALT_SIZE - RESERVE
    body_plain = b"\x00" * body_size
    iv = secrets.token_bytes(AES_BLOCK)
    cipher = Cipher(algorithms.AES(aes_key), modes.CBC(iv), backend=default_backend())
    enc = cipher.encryptor()
    cipher_body = enc.update(body_plain) + enc.finalize()

    page_no_le = (1).to_bytes(4, "little")
    mac = hmac_mod.new(hmac_key, digestmod=hashlib.sha512)
    mac.update(cipher_body)
    mac.update(iv)
    mac.update(page_no_le)
    digest = mac.digest()

    page = salt + cipher_body + iv + digest
    assert len(page) == PAGE_SIZE, f"got {len(page)}, expected {PAGE_SIZE}"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(page)


def _make_garbage_session_db(out_path: Path) -> None:
    """Write a session.db that LOOKS plausible but won't decrypt with any key."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(secrets.token_bytes(PAGE_SIZE))


# ---------- state ----------

def load_state() -> dict:
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def load_cfg() -> dict:
    if not CFG_PATH.exists():
        return {}
    try:
        return json.loads(CFG_PATH.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


def save_cfg(cfg: dict) -> None:
    CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CFG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------- scenarios ----------

class Scenario(NamedTuple):
    name: str
    title: str
    failure_symptom: str
    expected_after_fix: str
    setup: Callable[[], dict]


def _stage_xwechat_dir(scenario: str, subdir: str = "xwechat_files") -> Path:
    """Create a fresh xwechat_files dir for the scenario."""
    root = SIM_ROOT / scenario / subdir
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True)
    return root


def _stage_wxid(xwf: Path, wxid: str, *, with_session_db: bool = True,
                  password_hex: str | None = None) -> Path:
    """Create a wxid_*/db_storage/session/session.db structure under xwf.
    If password_hex given, encrypts session.db so verify_passphrase passes for that key.
    If password_hex is None and with_session_db, writes garbage (verify always fails)."""
    profile = xwf / wxid
    sess_dir = profile / "db_storage" / "session"
    sess_dir.mkdir(parents=True)
    sess_db = sess_dir / "session.db"
    if with_session_db:
        if password_hex:
            _encrypt_one_page_session_db(sess_db, password_hex)
        else:
            _make_garbage_session_db(sess_db)
    # Also touch a couple of expected sub-dirs so paths.py considers it a real profile
    (profile / "db_storage" / "message").mkdir(parents=True)
    return profile


def setup_multi_account_correct_key() -> dict:
    """2 wxids. Saved key DECRYPTS one of them (alpha). Auto-detect should pick alpha."""
    xwf = _stage_xwechat_dir("multi-account-correct-key")
    # The KEY MUST be 64 hex chars (= 32 bytes) — refresh.py validates this
    test_key = secrets.token_hex(32)
    _stage_wxid(xwf, "wxid_simulated_alpha_aaaaaaaa", password_hex=test_key)
    _stage_wxid(xwf, "wxid_simulated_beta_bbbbbbbb", password_hex=secrets.token_hex(32))
    return {"xwf": str(xwf), "saved_key": test_key,
            "match": "wxid_simulated_alpha_aaaaaaaa"}


def setup_multi_account_wrong_key() -> dict:
    """2 wxids. Saved key matches NEITHER. Expected: error 'all profiles failed'."""
    xwf = _stage_xwechat_dir("multi-account-wrong-key")
    _stage_wxid(xwf, "wxid_simulated_alpha_aaaaaaaa", password_hex=secrets.token_hex(32))
    _stage_wxid(xwf, "wxid_simulated_beta_bbbbbbbb", password_hex=secrets.token_hex(32))
    return {"xwf": str(xwf), "saved_key": secrets.token_hex(32), "match": None}


def setup_multi_account_no_key() -> dict:
    """2 wxids. No saved key. Should prompt to extract key first."""
    xwf = _stage_xwechat_dir("multi-account-no-key")
    _stage_wxid(xwf, "wxid_simulated_alpha_aaaaaaaa")
    _stage_wxid(xwf, "wxid_simulated_beta_bbbbbbbb")
    return {"xwf": str(xwf), "saved_key": None, "match": None}


def setup_chinese_path() -> dict:
    """xwechat_files at a path with Chinese characters. Verify discovery handles unicode."""
    sim_dir = SIM_ROOT / "chinese-path" / "我的微信测试"
    if sim_dir.exists():
        shutil.rmtree(sim_dir, ignore_errors=True)
    sim_dir.mkdir(parents=True)
    xwf = sim_dir / "xwechat_files"
    xwf.mkdir()
    test_key = secrets.token_hex(32)
    _stage_wxid(xwf, "wxid_simulated_china_path", password_hex=test_key)
    return {"xwf": str(xwf), "saved_key": test_key,
            "match": "wxid_simulated_china_path"}


def setup_bootstrap_empty() -> dict:
    """xwechat_files exists but has no wxid_* children. Murmur should say 'no profiles'."""
    xwf = _stage_xwechat_dir("bootstrap-empty")
    return {"xwf": str(xwf), "saved_key": None, "match": None}


def setup_empty_db_storage() -> dict:
    """1 wxid, but db_storage is completely empty. Should be filtered as 'shell only' profile."""
    xwf = _stage_xwechat_dir("empty-db-storage")
    profile = xwf / "wxid_simulated_shell_only"
    (profile / "db_storage").mkdir(parents=True)  # empty dir, no session.db
    return {"xwf": str(xwf), "saved_key": None, "match": None}


def setup_unicode_print_stress() -> dict:
    """5 wxids — auto-detect prints × 4 times, then ✓ once. Stresses the encoding fix."""
    xwf = _stage_xwechat_dir("unicode-print-stress")
    test_key = secrets.token_hex(32)
    # Create 4 profiles with WRONG keys + 1 with the saved key — last to be tried.
    # Order on disk depends on listdir sorting; for predictability, give the
    # match-profile a name that sorts LAST so we trigger 4 × prints before the ✓.
    for i, marker in enumerate(["aaaa", "bbbb", "cccc", "dddd"]):
        _stage_wxid(xwf, f"wxid_simulated_wrong_{marker}",
                       password_hex=secrets.token_hex(32))
    _stage_wxid(xwf, "wxid_simulated_zzzz_correct", password_hex=test_key)
    return {"xwf": str(xwf), "saved_key": test_key,
            "match": "wxid_simulated_zzzz_correct"}


SCENARIOS: dict[str, Scenario] = {
    "multi-account-correct-key": Scenario(
        name="multi-account-correct-key",
        title="多账号 + 保存的 key 匹配其中一个 (issue #4 #6 #7 #8 #9 主路径)",
        failure_symptom=(
            "v0.3.16 之前: refresh.py 默认取 profiles[0]，如果 key 是另一个号的就 HMAC 失败 → 一直 bootstrap loop。\n"
            "  v0.3.16 修复后但 Chinese Windows: print('✓ 匹配') UnicodeEncodeError → refresh 崩溃 → ok=false。"
        ),
        expected_after_fix=(
            "v0.3.17: refresh.py 自动验证两个账号的 session.db，挑能解开的 (alpha)。\n"
            "  /api/refresh 返回 ok=true, details 包含「自动选中 wxid_simulated_alpha」。"
        ),
        setup=setup_multi_account_correct_key,
    ),
    "multi-account-wrong-key": Scenario(
        name="multi-account-wrong-key",
        title="多账号 + 保存的 key 全都不匹配",
        failure_symptom="老版本: 一直 bootstrap loop，没有错误信息。",
        expected_after_fix=(
            "v0.3.17: 报「保存的 key 在 2 个账号上都验证失败」明确错误。\n"
            "  serve.log 里能看到 [refresh] rc=1 + 完整子进程输出（新加的日志 tee）。"
        ),
        setup=setup_multi_account_wrong_key,
    ),
    "multi-account-no-key": Scenario(
        name="multi-account-no-key",
        title="多账号 + 还没抓 key (新装的用户)",
        failure_symptom="老版本: 默认取 profiles[0] 无 key 失败，提示无 key 但没说有几个号。",
        expected_after_fix=(
            "v0.3.17: 引导用户去抓 key (extract-key 流程)。\n"
            "  /api/refresh 返回 ok=false, details=「找不到密钥」。"
        ),
        setup=setup_multi_account_no_key,
    ),
    "chinese-path": Scenario(
        name="chinese-path",
        title="中文路径 (issue #1 followup)",
        failure_symptom="老版本: 默认扫描列表里没有「我的微信测试」这种自定义中文路径名 → 完全找不到数据。",
        expected_after_fix=(
            "v0.3.17: 中文路径写到 config.json 的 wechat_roots 后能正常 discover。\n"
            "  /api/profiles 应该包含 wxid_simulated_china_path。"
        ),
        setup=setup_chinese_path,
    ),
    "bootstrap-empty": Scenario(
        name="bootstrap-empty",
        title="xwechat_files 存在但没有 wxid_*",
        failure_symptom="刚装好微信但还没登录，或者数据被清干净。",
        expected_after_fix=(
            "Murmur 进入 bootstrap mode 而不是崩溃；引导窗提示「找不到任何账号，请先在微信里登录」。"
        ),
        setup=setup_bootstrap_empty,
    ),
    "empty-db-storage": Scenario(
        name="empty-db-storage",
        title="wxid_*/db_storage 是空的 (issue #3)",
        failure_symptom="老版本: 把空 wxid_*/db_storage 当成有效 profile 选中 → 后续解密 0 个文件 → 无声失败。",
        expected_after_fix=(
            "v0.3.14+: 空 db_storage 在 discover 时被过滤；与 bootstrap-empty 等价。"
        ),
        setup=setup_empty_db_storage,
    ),
    "unicode-print-stress": Scenario(
        name="unicode-print-stress",
        title="编码压力测试: 5 个 wxid，匹配的排最后",
        failure_symptom=(
            "Chinese Windows + 老版本: 第一个 print('× 不匹配') 用 ×（在 cp936 里）OK，\n"
            "  但走到 print('✓ 匹配') 时 cp936 没 U+2713 → UnicodeEncodeError → 崩溃。"
        ),
        expected_after_fix=(
            "v0.3.17 sys.stdout.reconfigure(utf-8) 后所有 unicode chars 都能 print。\n"
            "  /api/refresh 返回 ok=true，details 应该包含 4 个「× 不匹配」+ 1 个「✓ 匹配」。"
        ),
        setup=setup_unicode_print_stress,
    ),
}


# ---------- activation / reset ----------

def activate(scenario_name: str, *, replace_real: bool = False) -> None:
    if scenario_name not in SCENARIOS:
        print(f"未知场景: {scenario_name}\n可用: {list(SCENARIOS)}", file=sys.stderr)
        sys.exit(2)

    state = load_state()
    if state.get("active"):
        print(f"已经有场景在跑: {state['active']}。先 reset 再激活新的。",
              file=sys.stderr)
        sys.exit(2)

    # Backup real config.json
    backup_cfg = None
    if CFG_PATH.exists():
        backup_cfg = CFG_PATH.read_text(encoding="utf-8-sig")

    sc = SCENARIOS[scenario_name]
    print(f"[setup] 激活场景: {sc.name}")
    print(f"        {sc.title}")
    info = sc.setup()
    xwf = info["xwf"]
    saved_key = info.get("saved_key")
    match = info.get("match")

    # Build the new config: keep user's existing fields, but rewrite
    # wechat_roots + decrypt_key for this scenario.
    cfg = {}
    if backup_cfg:
        try:
            cfg = json.loads(backup_cfg)
        except Exception:
            cfg = {}
    cfg["wechat_roots"] = [xwf]
    if saved_key:
        cfg["decrypt_key"] = saved_key
    else:
        cfg.pop("decrypt_key", None)
    save_cfg(cfg)

    new_state = {
        "active": scenario_name,
        "xwf": xwf,
        "match": match,
        "backup_cfg": backup_cfg,  # None if user had no config before
    }
    save_state(new_state)

    print()
    print("=" * 70)
    print(f"场景已激活: {sc.name}")
    print("=" * 70)
    print()
    print("【期望（修复后）】")
    print(f"  {sc.expected_after_fix}")
    print()
    print("【失败症状（修复前）】")
    print(f"  {sc.failure_symptom}")
    print()
    print("【操作步骤】")
    print("  1. 重启 Murmur (完全退出再打开 — 否则等 5 秒让 etcli 重新读 config)")
    print(f"  2. 在 PowerShell 跑下面命令看 /api/refresh 实际返回：")
    print(f"     (Invoke-WebRequest -UseBasicParsing -Method POST http://127.0.0.1:9100/api/refresh -Body '{{}}' -ContentType 'application/json').Content")
    if match:
        print(f"  3. 在返回的 details 字段里应该看到「自动选中 {match}」")
    else:
        print("  3. 在返回的 details 字段里应该看到对应的错误提示（不是空白 / loop）")
    print()
    print("【验证完做这个】")
    print("  python cli/simulate.py reset")
    print()


def reset() -> None:
    state = load_state()
    if not state:
        print("没有激活的场景。")
        return

    sc = state.get("active", "(unknown)")
    print(f"[reset] 关闭场景: {sc}")

    # Restore config
    backup_cfg = state.get("backup_cfg")
    if backup_cfg is None:
        # User had no config originally — remove ours
        if CFG_PATH.exists():
            CFG_PATH.unlink()
            print(f"  - 删除 {CFG_PATH}")
    else:
        CFG_PATH.write_text(backup_cfg, encoding="utf-8")
        print(f"  - 还原 {CFG_PATH}")

    # Scrub simulator dir
    if SIM_ROOT.exists():
        shutil.rmtree(SIM_ROOT, ignore_errors=True)
        print(f"  - 删除 {SIM_ROOT}")

    # Scrub decrypted output for any wxid_simulated_* that the scenario produced.
    # Don't touch real-user wxid dirs.
    if DECRYPTED_ROOT.exists():
        for child in DECRYPTED_ROOT.iterdir():
            if child.is_dir() and child.name.startswith("wxid_simulated_"):
                shutil.rmtree(child, ignore_errors=True)
                print(f"  - 删除 {child}")

    # Drop state file
    if STATE_PATH.exists():
        STATE_PATH.unlink()
        print(f"  - 删除 {STATE_PATH}")

    print("[reset] 完成。重启 Murmur 即可恢复正常。")


def status() -> None:
    state = load_state()
    if not state:
        print("当前无激活场景。")
        return
    if state.get("fresh_onboard"):
        print("当前模式: fresh-onboard")
        print(f"  WeChat decrypted 备份: {DECRYPTED_BACKUP if state.get('decrypted_was_at') else '无'}")
        print(f"  QQ decrypted 备份:    {DECRYPTED_QQ_BACKUP if state.get('decrypted_qq_was_at') else '无'}")
        print(f"  config.json 备份:     {'有 (' + str(len(state.get('backup_cfg') or '')) + ' 字节)' if state.get('backup_cfg') else '无（用户原本没 config）'}")
        print(f"  qq_keys.json 备份:    {'有' if state.get('backup_qq_keys') else '无'}")
        print()
        print("测完: python cli/simulate.py restore")
        return
    sc = state.get("active") or state.get("isolated") or "(unknown)"
    mode = "isolated" if state.get("isolated") else "activate"
    print(f"当前模式: {mode}")
    print(f"激活场景: {sc}")
    print(f"  xwechat_files: {state.get('xwf')}")
    if state.get("match"):
        print(f"  期望匹配: {state['match']}")
    print(f"  config 备份: {'有' if state.get('backup_cfg') else '无（用户原本就没有 config）'}")
    print()
    print("测完: python cli/simulate.py " + ("restore" if mode == "isolated" else "reset"))


PRIMARY = {
    "multi-account-correct-key",
    "multi-account-wrong-key",
    "unicode-print-stress",
    "chinese-path",
}


def _find_etcli_exe() -> Path | None:
    """Locate the installed Murmur's etcli.exe so we test the EXACT binary the
    user has — frozen PyInstaller, not dev Python."""
    candidates = [
        Path.home() / "AppData" / "Local" / "Murmur" / "etcli" / "etcli.exe",
        Path("C:/Murmur/etcli/etcli.exe"),
        Path("C:/Program Files/Murmur/etcli/etcli.exe"),
        Path(r"C:\Users\YY\murmur\cli\dist\etcli\etcli.exe"),  # dev build fallback
    ]
    for p in candidates:
        try:
            if p.exists():
                return p
        except OSError:
            continue
    return None


def _run_refresh(scenario: str, info: dict, etcli: Path) -> tuple[bool, str]:
    """Stage a scenario in an isolated temp dir and run refresh.py via the
    installed etcli.exe. Returns (passed, message). Does NOT touch the user's
    real ~/.murmur/config.json — uses MURMUR_WECHAT_ROOT_ONLY=1 + --key arg
    so the staged scenario is the only profile source for this one invocation.
    """
    import subprocess
    import tempfile

    xwf = info["xwf"]
    saved_key = info.get("saved_key")
    match = info.get("match")

    env = {k: v for k, v in os.environ.items()
           if k not in ("PYTHONIOENCODING", "PYTHONUTF8")}
    env["MURMUR_WECHAT_ROOT"] = xwf
    env["MURMUR_WECHAT_ROOT_ONLY"] = "1"

    # Build args. If the scenario has a saved key, pass it via --key (avoids
    # touching ~/.murmur/config.json — user's running Murmur is unaffected).
    args = [str(etcli), "refresh"]
    if saved_key:
        args += ["--key", saved_key]

    try:
        r = subprocess.run(args, env=env, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60)
    except subprocess.TimeoutExpired:
        return False, "refresh hung > 60s"

    out = (r.stdout or "") + "\n" + (r.stderr or "")
    rc = r.returncode

    # Per-scenario assertions.
    if scenario == "multi-account-correct-key":
        if "UnicodeEncodeError" in out:
            return False, "UnicodeEncodeError — stdio encoding fix didn't apply"
        if rc != 0:
            return False, f"expected rc=0 (auto-pick succeeded), got rc={rc}\n{out[-500:]}"
        if match and f"自动选中 {match}" not in out:
            return False, f"expected '自动选中 {match}', not found"
        if "✓ 匹配" not in out:
            return False, "expected ✓ 匹配 in output"
        return True, f"auto-picked {match}, ✓ printed cleanly"

    if scenario == "multi-account-wrong-key":
        if "UnicodeEncodeError" in out:
            return False, "UnicodeEncodeError — stdio encoding fix didn't apply"
        if rc == 0:
            return False, f"expected rc != 0 (no key matches), got rc=0"
        if "都验证失败" not in out:
            return False, f"expected '都验证失败' error message"
        # Should print × for every profile attempted
        if "× 不匹配" not in out:
            return False, "expected at least one × 不匹配"
        return True, "clear error reported, no silent loop"

    if scenario == "unicode-print-stress":
        if "UnicodeEncodeError" in out:
            return False, "UnicodeEncodeError — encoding fix failed under load"
        if rc != 0:
            return False, f"expected rc=0, got rc={rc}\n{out[-500:]}"
        x_count = out.count("× 不匹配")
        v_count = out.count("✓ 匹配")
        if x_count < 4:
            return False, f"expected ≥4 × marks (4 wrong wxids), got {x_count}"
        if v_count < 1:
            return False, f"expected 1 ✓ mark, got {v_count}"
        return True, f"printed {x_count}× and {v_count}✓ without crash"

    if scenario == "chinese-path":
        if rc != 0:
            return False, f"中文路径 discover/decrypt 失败: rc={rc}\n{out[-500:]}"
        # Single-profile scenario — no auto-pick log line (select_profile
        # short-circuits when len(profiles) == 1). Instead verify the [INFO]
        # 账号: line shows our staged wxid, and the path was preserved as utf-8
        # all the way through (no mojibake).
        if match and f"账号: {match}" not in out:
            return False, f"expected '账号: {match}' in output, refresh picked something else"
        if "我的微信测试" not in out:
            return False, "Chinese path 我的微信测试 mojibake'd or missing in log"
        return True, f"中文 path discovered + decrypted, picked {match}"

    return True, "(no assertions defined for this scenario)"


def _kill_murmur() -> None:
    """Kill any running Murmur + etcli so the next launch picks up new env."""
    import subprocess
    if sys.platform.startswith("win"):
        for image in ("Murmur.exe", "etcli.exe"):
            subprocess.run(["taskkill", "/F", "/IM", image], capture_output=True, text=True)
        return
    for pattern in ("Murmur.app/Contents/MacOS/Murmur", "etcli serve"):
        subprocess.run(["pkill", "-f", pattern], capture_output=True, text=True)


def _launch_murmur(env_overrides: dict | None = None) -> bool:
    """Spawn Murmur (optionally with env overrides for isolation modes).
    Uses CREATE_NEW_PROCESS_GROUP only (NOT DETACHED_PROCESS — combining with
    close_fds was silently failing on this Windows install)."""
    import subprocess
    if sys.platform.startswith("win"):
        target = MURMUR_EXE
    elif sys.platform == "darwin":
        target = next((p / "Contents" / "MacOS" / "Murmur" for p in MURMUR_MAC_APPS
                       if (p / "Contents" / "MacOS" / "Murmur").exists()), None)
    else:
        target = None
    if not target or not target.exists():
        print(f"  [警告] 找不到已安装的 Murmur，请你手动打开 Murmur")
        return False
    env = os.environ.copy()
    if env_overrides:
        env.update(env_overrides)
    try:
        flags = (subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
                 if sys.platform.startswith("win") else 0)
        subprocess.Popen([str(target)], env=env, creationflags=flags)
        return True
    except OSError as e:
        print(f"  [警告] spawn failed: {e}")
        return False


def cmd_isolate(scenario_name: str) -> int:
    """Full data-isolation mode for hands-on UI testing.

    Backs up the user's real config + decrypted dir → stages a scenario →
    launches Murmur with env vars that scope it to the simulator's xwechat_files
    so the user can re-walk the onboarding flow as if they were a fresh
    install. Restore puts everything back."""
    if scenario_name not in SCENARIOS:
        print(f"未知场景: {scenario_name}\n可用: {list(SCENARIOS)}", file=sys.stderr)
        return 2
    state = load_state()
    if state.get("isolated") or state.get("active"):
        print(f"已有场景在跑（{state.get('isolated') or state.get('active')}）。先 restore 再来。",
              file=sys.stderr)
        return 2

    print(f"[1/5] 备份当前 ~/.murmur/config.json...")
    backup_cfg = None
    if CFG_PATH.exists():
        backup_cfg = CFG_PATH.read_text(encoding="utf-8-sig")
        print(f"      已读 {len(backup_cfg)} 字节")
    else:
        print(f"      （没有现有 config.json）")

    print(f"[2/5] 把真实 decrypted 目录改名（不删！）...")
    decrypted_was_at = None
    if DECRYPTED_ROOT.exists():
        if DECRYPTED_BACKUP.exists():
            print(f"      [警告] 已有旧备份 {DECRYPTED_BACKUP}，先清掉")
            shutil.rmtree(DECRYPTED_BACKUP, ignore_errors=True)
        DECRYPTED_ROOT.rename(DECRYPTED_BACKUP)
        decrypted_was_at = str(DECRYPTED_ROOT)
        print(f"      {DECRYPTED_ROOT} → {DECRYPTED_BACKUP}")
    else:
        print(f"      （没有现有 decrypted 目录）")

    print(f"[3/5] 激活场景 {scenario_name}...")
    sc = SCENARIOS[scenario_name]
    info = sc.setup()
    xwf = info["xwf"]
    saved_key = info.get("saved_key")
    match = info.get("match")
    print(f"      staged: {xwf}")
    print(f"      saved_key: {'有' if saved_key else '无'}")
    print(f"      期望命中: {match or '(看场景)'}")

    print(f"[4/5] 写新的 config.json（只指向模拟器数据）...")
    cfg: dict = {"wechat_roots": [xwf]}
    if saved_key:
        cfg["decrypt_key"] = saved_key
    save_cfg(cfg)

    new_state = {
        "isolated": scenario_name,
        "xwf": xwf,
        "match": match,
        "backup_cfg": backup_cfg,
        "decrypted_was_at": decrypted_was_at,
    }
    save_state(new_state)

    print(f"[5/5] 启动 Murmur (kill 旧的 + 用隔离环境变量起新的)...")
    _kill_murmur()
    import time as _time
    _time.sleep(1)  # let processes actually exit
    launched = _launch_murmur({
        "MURMUR_WECHAT_ROOT": xwf,
        "MURMUR_WECHAT_ROOT_ONLY": "1",
    })

    print()
    print("=" * 70)
    print(f"已隔离 + 启动 Murmur: {scenario_name}")
    print("=" * 70)
    print()
    print(f"【期望】")
    print(f"  {sc.expected_after_fix}")
    print()
    print(f"【该看到的】")
    print(f"  Murmur 会进 bootstrap onboarding (没有解密数据)")
    if saved_key and match:
        print(f"  config 里已经有 key + 模拟数据，引导窗会让你点「更新数据」/「开始」")
        print(f"  refresh.py 自动验证多账号 → 选中 {match} → 解密 → 进 Home 主页")
    elif not saved_key:
        print(f"  没有保存 key，引导窗会让你「抓密钥」 — 但这是模拟数据，不要点抓 key")
    print()
    print(f"【你的真实数据已经备份】")
    print(f"  {DECRYPTED_BACKUP}")
    print(f"  config.json 也存在 state file 里 ({STATE_PATH})")
    print()
    print(f"【测完恢复】")
    print(f"  python cli/simulate.py restore")
    print(f"  会 kill 隔离 Murmur + 还原所有数据 + 删模拟数据")
    print()
    if not launched:
        print(f"[手动启动] 请用 PowerShell 跑：")
        print(f'   $env:MURMUR_WECHAT_ROOT_ONLY="1"; $env:MURMUR_WECHAT_ROOT="{xwf}"; & "{MURMUR_EXE}"')
    return 0


def _restore_dir_from_backup(real: Path, backup: Path, label: str) -> None:
    """Atomically restore `backup` to `real`, cleaning sim residue first.

    Order matters: if Murmur ran during isolation, it may have created
    wxid_simulated_*/ inside `real`. We must scrub those (and rmdir if real
    is then empty) BEFORE renaming `backup` over `real`, otherwise the rename
    fails and we'd have to leave the user's data in a *_conflict_* path."""
    if not backup.exists():
        print(f"        ({label}: 没有需要还原的备份)")
        return
    if real.exists():
        # Wipe sim residue
        for child in list(real.iterdir()):
            if child.is_dir() and child.name.startswith("wxid_simulated_"):
                shutil.rmtree(child, ignore_errors=True)
                print(f"        清掉 sim 残留 {child.name}")
        # If still has children, that's user-created data we shouldn't touch.
        # Move backup into a conflict path so user can manually merge.
        if any(real.iterdir()):
            import time as _time
            ts = int(_time.time())
            conflict = real.parent / f"{real.name}__conflict_{ts}__"
            backup.rename(conflict)
            print(f"        [警告] {real} 不为空 — 真实备份保到 {conflict.name}/")
            print(f"               请手动 merge 一下（不要直接覆盖）")
            return
        # Empty after scrub: rmdir then rename
        try:
            real.rmdir()
        except OSError:
            print(f"        [警告] 无法 rmdir {real}，备份留在 {backup.name}/")
            return
    backup.rename(real)
    print(f"        ✓ {backup.name}/ → {real.name}/")


def cmd_restore() -> int:
    state = load_state()
    mode = state.get("isolated") or state.get("fresh_onboard")
    if not mode:
        # Maybe a manual `activate` was used — fall back to existing reset
        if state.get("active"):
            print("（这是 activate 模式，转 reset）")
            reset()
            return 0
        print("没有 isolation / fresh-onboard 状态可恢复。")
        return 0

    print(f"[restore] 关闭场景: {mode}")

    print(f"[1] kill 隔离的 Murmur + etcli...")
    _kill_murmur()
    import time as _time
    _time.sleep(1)  # let processes actually exit before file ops

    print(f"[2] 清掉模拟器数据 + ~/.murmur 临时文件...")
    if SIM_ROOT.exists():
        shutil.rmtree(SIM_ROOT, ignore_errors=True)
        print(f"        删 {SIM_ROOT}")

    print(f"[3] 还原 ~/.murmur/config.json...")
    backup_cfg = state.get("backup_cfg")
    if backup_cfg is None:
        if CFG_PATH.exists():
            CFG_PATH.unlink()
            print(f"        删除 (用户原来没 config)")
    else:
        CFG_PATH.write_text(backup_cfg, encoding="utf-8")
        print(f"        还原 {len(backup_cfg)} 字节")

    print(f"[3b] 还原 ~/.murmur/qq_keys.json...")
    backup_qq_keys = state.get("backup_qq_keys")
    if backup_qq_keys is not None:
        QQ_KEYS_PATH.write_text(backup_qq_keys, encoding="utf-8")
        print(f"        还原 {len(backup_qq_keys)} 字节")

    print(f"[4] 还原 decrypted (微信)...")
    if state.get("decrypted_was_at"):
        _restore_dir_from_backup(DECRYPTED_ROOT, DECRYPTED_BACKUP, "WeChat decrypted")

    print(f"[4b] 还原 decrypted_qq (QQ)...")
    if state.get("decrypted_qq_was_at"):
        _restore_dir_from_backup(DECRYPTED_QQ_ROOT, DECRYPTED_QQ_BACKUP, "QQ decrypted")

    print(f"[5] 删 state file...")
    if STATE_PATH.exists():
        STATE_PATH.unlink()

    print()
    print("[OK] 恢复完成。重启 Murmur 即可继续看你真实的数据。")
    return 0


def cmd_fresh_onboard() -> int:
    """Clean Murmur to look like a fresh install — but with the user's real
    WeChat/QQ on the system. They walk through actual onboarding (scan,
    extract key, decrypt) on their REAL data and verify the v0.3.17 install
    works end-to-end. No simulator data is staged."""
    state = load_state()
    if state:
        print(f"已经有场景在跑: {state.get('isolated') or state.get('active') or state.get('fresh_onboard')}",
              file=sys.stderr)
        print("先 restore 再来。", file=sys.stderr)
        return 2

    print(f"[1/5] 备份 ~/.murmur/config.json...")
    backup_cfg = None
    if CFG_PATH.exists():
        backup_cfg = CFG_PATH.read_text(encoding="utf-8-sig")
        CFG_PATH.unlink()
        print(f"        备份 {len(backup_cfg)} 字节并删除（让 Murmur 没 saved key）")
    else:
        print(f"        （没有现有 config.json）")

    print(f"[1b] 备份 ~/.murmur/qq_keys.json...")
    backup_qq_keys = None
    if QQ_KEYS_PATH.exists():
        backup_qq_keys = QQ_KEYS_PATH.read_text(encoding="utf-8-sig")
        QQ_KEYS_PATH.unlink()
        print(f"        备份 {len(backup_qq_keys)} 字节并删除（让 Murmur 没 QQ key）")

    print(f"[2/5] 把真实 decrypted 目录改名（不删！）...")
    decrypted_was_at = None
    if DECRYPTED_ROOT.exists():
        if DECRYPTED_BACKUP.exists():
            shutil.rmtree(DECRYPTED_BACKUP, ignore_errors=True)
        DECRYPTED_ROOT.rename(DECRYPTED_BACKUP)
        decrypted_was_at = str(DECRYPTED_ROOT)
        print(f"        {DECRYPTED_ROOT.name} → {DECRYPTED_BACKUP.name}")

    print(f"[2b] 把 decrypted_qq 也改名...")
    decrypted_qq_was_at = None
    if DECRYPTED_QQ_ROOT.exists():
        if DECRYPTED_QQ_BACKUP.exists():
            shutil.rmtree(DECRYPTED_QQ_BACKUP, ignore_errors=True)
        DECRYPTED_QQ_ROOT.rename(DECRYPTED_QQ_BACKUP)
        decrypted_qq_was_at = str(DECRYPTED_QQ_ROOT)
        print(f"        {DECRYPTED_QQ_ROOT.name} → {DECRYPTED_QQ_BACKUP.name}")

    new_state = {
        "fresh_onboard": True,
        "backup_cfg": backup_cfg,
        "backup_qq_keys": backup_qq_keys,
        "decrypted_was_at": decrypted_was_at,
        "decrypted_qq_was_at": decrypted_qq_was_at,
    }
    save_state(new_state)

    print(f"[4/5] 启动 Murmur (kill 旧的 + 普通环境，不限制 root)...")
    _kill_murmur()
    import time as _time
    _time.sleep(1)
    # NO MURMUR_WECHAT_ROOT_ONLY here — user wants their real WeChat to be
    # scanned and discoverable.
    if _launch_murmur():
        print(f"        ✓ Murmur 已启动")
    else:
        print(f"        请你手动开 Murmur")

    print()
    print("=" * 70)
    print("已进入「全新用户 onboarding」模式")
    print("=" * 70)
    print()
    print("Murmur 现在看不到任何已解密数据，也没有 saved key。")
    print()
    print("【你按真实用户的步骤走一遍】")
    print("  1. 等 Murmur 窗口出来 — 应该是 Welcome / 引导页")
    print("  2. 「微信引导」：")
    print("       a) 让 Murmur 扫盘找你真实 xwechat_files")
    print("       b) 退出微信到登录页（不要关进程）")
    print("       c) 回 Murmur 点「开始抓密钥」")
    print("       d) 回微信扫码登录 → key 抓到 → 自动解密 → 进 Home")
    print("  3. 「QQ 引导」（顶栏 + 添加新账号 → 🐧 QQ）：")
    print("       走完整 QQ 流程")
    print("  4. 验证「微信和 QQ 路径搞混了」这个 bug 还在不在")
    print()
    print("【你真实数据已经备份】")
    print(f"  WeChat decrypted: {DECRYPTED_BACKUP}")
    if decrypted_qq_was_at:
        print(f"  QQ     decrypted: {DECRYPTED_QQ_BACKUP}")
    print(f"  config.json:      存在 state 文件里")
    if backup_qq_keys:
        print(f"  qq_keys.json:     存在 state 文件里")
    print()
    print("【测完恢复】")
    print("  python cli/simulate.py restore")
    return 0


def cmd_test() -> int:
    """Run all PRIMARY scenarios automatically. No Murmur restart needed."""
    etcli = _find_etcli_exe()
    if etcli is None:
        print("找不到 etcli.exe。先装 v0.3.17 setup.exe 再来。", file=sys.stderr)
        return 2
    print(f"测试用 etcli: {etcli}")
    print()

    state_was_active = bool(load_state())
    if state_was_active:
        print("有手动场景在跑，先 reset 再开始自动测试...")
        reset()
        print()

    primary_order = [
        "multi-account-correct-key",
        "multi-account-wrong-key",
        "unicode-print-stress",
        "chinese-path",
    ]

    results = []
    for i, name in enumerate(primary_order, 1):
        sc = SCENARIOS[name]
        print(f"[{i}/{len(primary_order)}] {name} ", end="", flush=True)
        # Stage into ~/.murmur/simulator_data/<name>/ (consistent with manual mode)
        info = sc.setup()
        ok, msg = _run_refresh(name, info, etcli)
        marker = "PASS" if ok else "FAIL"
        dots = "." * max(1, 50 - len(name))
        print(f"{dots} {marker}")
        print(f"        {msg}")
        results.append((name, ok, msg))

    # Cleanup: remove staged data + any decrypted artifacts.
    if SIM_ROOT.exists():
        shutil.rmtree(SIM_ROOT, ignore_errors=True)
    if DECRYPTED_ROOT.exists():
        for child in DECRYPTED_ROOT.iterdir():
            if child.is_dir() and child.name.startswith("wxid_simulated_"):
                shutil.rmtree(child, ignore_errors=True)

    print()
    n_pass = sum(1 for _, ok, _ in results if ok)
    n_fail = len(results) - n_pass
    if n_fail == 0:
        print(f"[OK] 全部 {n_pass}/{len(results)} 个主路径测试通过")
        print("    v0.3.17 编码修复 + 多账号自动检测 已确认工作。")
        return 0
    else:
        print(f"[FAIL] {n_fail}/{len(results)} 个测试失败 — 修复有问题，先别 push")
        return 1


def list_scenarios() -> None:
    print("4 种用法:")
    print()
    print("  ① 真·全新用户 onboarding（你真实数据备份+清空 Murmur 状态，走真实引导）:")
    print("     python cli/simulate.py fresh-onboard")
    print("     python cli/simulate.py restore   # 测完，把真实数据搬回来")
    print()
    print("  ② 自动跑所有 ★ 多账号场景（最快，不动 Murmur，用模拟假数据）:")
    print("     python cli/simulate.py test")
    print()
    print("  ③ 隔离一个具体场景（备份真实数据 + 用模拟数据走一遍）:")
    print("     python cli/simulate.py isolate:<场景名>")
    print("     python cli/simulate.py restore")
    print()
    print("  ④ 浅模式 activate（只改 config，不动 decrypted 数据，会同时显示真实+模拟）:")
    print("     python cli/simulate.py <场景名>")
    print("     python cli/simulate.py reset")
    print()
    print("可用场景（★ = v0.3.17 必测主路径，给 ② ③ ④ 用）:")
    print()
    for name, sc in SCENARIOS.items():
        star = "★ " if name in PRIMARY else "  "
        print(f"  {star}{name}")
        print(f"    {sc.title}")
        print()


# ---------- argparse ----------

def main():
    p = argparse.ArgumentParser(
        prog="simulate.py",
        description="Murmur 故障场景模拟器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="先 list 看有什么场景；再选一个激活；测完 reset。",
    )
    p.add_argument("scenario", nargs="?",
                   help="场景名 / list / status / reset / 各场景名")
    args = p.parse_args()

    if args.scenario is None or args.scenario == "list":
        list_scenarios()
        return 0
    if args.scenario == "status":
        status()
        return 0
    if args.scenario == "reset":
        reset()
        return 0
    if args.scenario == "test":
        return cmd_test()
    if args.scenario == "restore":
        return cmd_restore()
    if args.scenario in ("fresh-onboard", "fresh"):
        return cmd_fresh_onboard()
    if args.scenario.startswith("isolate:"):
        return cmd_isolate(args.scenario.split(":", 1)[1])
    activate(args.scenario)
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
