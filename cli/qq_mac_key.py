"""qq_mac_key.py — QQ NT key capture on macOS (re-sign QQ.app + lldb).

Flow (driven by /api/qq/* in etcli.py and QQOnboardingDialog.tsx):

1. Re-sign QQ.app's main executable ad-hoc, dropping the hardened-runtime
   flag and adding `com.apple.security.get-task-allow`, so lldb can attach
   with SIP left ON. Needs the admin password (osascript "with administrator
   privileges"), same pattern as /api/resign-wechat. QQ must be quit first.
2. Run `lldb --batch` with cli/native/qq_lldb_capture.py: it waits for the
   QQ process, `open`s QQ.app, breakpoints nt_sqlite3_key_v2 inside
   wrapper.node and prints `MURMUR_KEY_CANDIDATE` lines while the user logs
   in, then detaches (QQ keeps running).
3. Candidates go through qq_decrypt.finish_extraction — the same login.db /
   zDb filtering + nt_msg.db page-1 HMAC verification the Windows path uses.

Decryption itself is shared with Windows (qq_decrypt.decrypt_profile): the
QQ NT SQLCipher parameters are the same on macOS.

Everything that builds commands or parses tool output is a pure function so
it is unit tested without lldb / codesign / a real QQ.
"""
from __future__ import annotations

import os
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

GET_TASK_ALLOW = "com.apple.security.get-task-allow"
STATUS_MARKER = "MURMUR_STATUS"
CAPTURE_SCRIPT_NAME = "qq_lldb_capture.py"

# Env vars that would make lldb's embedded Python load the wrong runtime
# when Murmur runs as a PyInstaller bundle.
_ENV_STRIP = ("PYTHONHOME", "PYTHONPATH", "DYLD_LIBRARY_PATH",
              "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES")


# ---------------------------------------------------------------------------
# Tool discovery
# ---------------------------------------------------------------------------

def capture_script_path() -> Path:
    cli_dir = Path(__file__).resolve().parent
    p = cli_dir / "native" / CAPTURE_SCRIPT_NAME
    if p.exists():
        return p
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        cand = Path(meipass) / "native" / CAPTURE_SCRIPT_NAME
        if cand.exists():
            return cand
    return p


def find_lldb() -> tuple:
    """(lldb_path, None) or (None, chinese_error).

    /usr/bin/lldb is a shim that pops the "install Command Line Tools" dialog
    when CLT is missing, so check `xcode-select -p` first."""
    if sys.platform != "darwin":
        return None, "lldb 抓 key 只支持 macOS"
    try:
        r = subprocess.run(["xcode-select", "-p"], capture_output=True, text=True, timeout=5)
        dev_dir = (r.stdout or "").strip()
        if r.returncode != 0 or not dev_dir or not Path(dev_dir).exists():
            return None, ("没有找到 Xcode 命令行工具（lldb 在里面）。请在「终端」运行 "
                          "xcode-select --install 装好后再试。")
    except Exception:
        pass
    try:
        r = subprocess.run(["xcrun", "--find", "lldb"], capture_output=True, text=True, timeout=10)
        cand = (r.stdout or "").strip()
        if r.returncode == 0 and cand and Path(cand).exists():
            return cand, None
    except Exception:
        pass
    which = shutil.which("lldb")
    if which:
        return which, None
    return None, "没有找到 lldb。请先安装 Xcode 命令行工具：xcode-select --install"


# ---------------------------------------------------------------------------
# Code signature inspection
# ---------------------------------------------------------------------------

def _has_runtime_flag(blob: str) -> bool:
    try:
        from paths import codesign_has_runtime_flag  # type: ignore
        return codesign_has_runtime_flag(blob)
    except Exception:
        import re
        for m in re.finditer(r"flags=[^\n()]*\(([^)]*)\)", (blob or "").lower()):
            if "runtime" in {x.strip() for x in m.group(1).split(",")}:
                return True
        return False


def parse_entitlements(raw: bytes) -> Optional[dict]:
    """Entitlements dict from `codesign -d --entitlements - --xml` (or the
    legacy `:-`) output; None if there is no plist in it."""
    if not raw:
        return None
    start = -1
    for marker in (b"<?xml", b"<plist", b"bplist00"):
        start = raw.find(marker)
        if start >= 0:
            break
    if start < 0:
        return None
    try:
        val = plistlib.loads(raw[start:])
    except Exception:
        return None
    return val if isinstance(val, dict) else None


def signature_status(codesign_dv: str, entitlements: Optional[dict]) -> dict:
    """Summarize `codesign -d -v` output + entitlements.

    debuggable is True when lldb should be able to attach with SIP on:
    either get-task-allow is granted or the hardened runtime is gone."""
    text = codesign_dv or ""
    hardened = _has_runtime_flag(text)
    adhoc = "signature=adhoc" in text.lower().replace(" ", "") or "(adhoc" in text.lower() \
        or ",adhoc" in text.lower()
    gta = bool(entitlements and entitlements.get(GET_TASK_ALLOW) is True)
    return {"hardened": hardened, "adhoc": adhoc, "get_task_allow": gta,
            "debuggable": gta or not hardened}


def _codesign_dv(main_exec: Path, runner=None) -> str:
    run = runner or subprocess.run
    v = run(["codesign", "-d", "-v", str(main_exec)], capture_output=True, text=True, timeout=10)
    return (v.stdout or "") + "\n" + (v.stderr or "")


def inspect_signature(main_exec: Path, runner=None) -> dict:
    """Run codesign on the QQ main executable. Fields are None on error."""
    out = {"hardened": None, "adhoc": None, "get_task_allow": None, "debuggable": None}
    try:
        text = _codesign_dv(main_exec, runner)
        ents = read_entitlements(main_exec, runner)
        out.update(signature_status(text, ents))
    except Exception:
        pass
    return out


def team_identifier(codesign_dv: str) -> Optional[str]:
    """TeamIdentifier from `codesign -d -v` output; None for ad-hoc / unsigned."""
    for line in (codesign_dv or "").splitlines():
        if line.strip().startswith("TeamIdentifier="):
            val = line.strip().split("=", 1)[1].strip()
            return None if not val or val.lower() == "not set" else val
    return None


def is_vendor_signed(codesign_dv: str) -> bool:
    """True when the binary still carries a real (Tencent) Developer ID
    signature, i.e. it was not re-signed ad-hoc yet."""
    st = signature_status(codesign_dv, None)
    return bool(team_identifier(codesign_dv)) and not st["adhoc"]


def read_entitlements(main_exec: Path, runner=None) -> Optional[dict]:
    run = runner or subprocess.run
    for args in (["codesign", "-d", "--entitlements", "-", "--xml", str(main_exec)],
                 ["codesign", "-d", "--entitlements", ":-", str(main_exec)]):
        try:
            r = run(args, capture_output=True, timeout=10)
        except Exception:
            continue
        ents = parse_entitlements(r.stdout or b"")
        if ents is not None:
            return ents
    return None


def build_debug_entitlements(original: Optional[dict]) -> bytes:
    """Original entitlements (sandbox, network, camera, …) + get-task-allow."""
    ents = dict(original or {})
    ents[GET_TASK_ALLOW] = True
    return plistlib.dumps(ents, fmt=plistlib.FMT_XML)


# ---------------------------------------------------------------------------
# Re-sign command (quit → codesign main exec with admin rights → verify)
# ---------------------------------------------------------------------------

def build_resign_shell(main_exec: Path, entitlements_plist: Path) -> str:
    """Shell script run as root via osascript.

    Mirrors /api/resign-wechat: sign ONLY the main executable (AMFI checks it
    when deciding task_for_pid), back it up first and restore it if codesign
    leaves it empty. Differences: we pass an explicit entitlements plist
    (original + get-task-allow) instead of --preserve-metadata=entitlements,
    and no `runtime` option, so the hardened-runtime flag is dropped."""
    target = shlex.quote(str(main_exec))
    ents = shlex.quote(str(entitlements_plist))
    return (
        "set -e\n"
        f"target={target}\n"
        f"ents={ents}\n"
        'backup="$(/usr/bin/mktemp -t murmur-qq-main)"\n'
        'trap \'if [ -f "$backup" ] && [ ! -s "$target" ]; then /usr/bin/install -m 755 "$backup" "$target"; fi; /bin/rm -f "$backup"\' EXIT\n'
        '/usr/bin/ditto "$target" "$backup"\n'
        '/bin/chmod 755 "$backup"\n'
        '/usr/bin/codesign --force --sign - --entitlements "$ents" '
        '--preserve-metadata=identifier,requirements "$target"\n'
    )


def build_osascript_admin(shell_cmd: str) -> str:
    """AppleScript that runs `shell_cmd` with the native admin-password prompt."""
    escaped = shell_cmd.replace("\\", "\\\\").replace('"', '\\"')
    return f'do shell script "{escaped}" with administrator privileges'


def resign_error_message(returncode: int, blob: str) -> str:
    low = (blob or "").lower()
    if returncode == -128 or "user canceled" in low or "用户已取消" in low or "(-128)" in low:
        return ("重签名被 macOS 授权窗口取消了。请重新点「重签 QQ」，在系统窗口里输入这台 Mac "
                "的开机密码（不是 Apple ID 密码）。")
    if "operation not permitted" in low or "permission" in low:
        return ("重签名被系统拦截（Operation not permitted）。请到「系统设置 → 隐私与安全性」"
                "给 Murmur 打开「App 管理」和「完全磁盘访问」，完全退出 Murmur 后重开再试；"
                "也确认 QQ 已经彻底退出。")
    return "codesign 重签名失败。请确认 QQ 已退出，并在系统授权窗口输入开机密码。"


def quit_qq(app: Optional[Path], *, runner=None, pids=None, sleep=None) -> list:
    """Ask QQ to quit, then SIGTERM/SIGKILL whatever is still running from the
    bundle. Returns PIDs still alive afterwards."""
    import qq_paths as _qp
    run = runner or subprocess.run
    pids = pids or _qp.qq_running_pids
    sleep = sleep or time.sleep
    run(["osascript", "-e",
         f'try\n  tell application id "{_qp.MAC_QQ_BUNDLE_ID}" to quit\nend try'],
        capture_output=True, text=True, timeout=15)
    for _ in range(10):
        if not pids():
            break
        sleep(0.5)
    if pids():
        pattern = f"{app}/Contents/" if app else "/QQ.app/Contents/"
        run(["pkill", "-f", pattern], capture_output=True)
        sleep(1.2)
        run(["pkill", "-9", "-f", pattern], capture_output=True)
        sleep(0.6)
    return pids()


# ---------------------------------------------------------------------------
# Backup / restore of the original (Tencent) signature
#
# codesign rewrites the main executable in place (the signature lives inside
# the Mach-O) and refreshes Contents/_CodeSignature. Both are copied to
# ~/.murmur/qq-backup/<version>/ BEFORE re-signing, so the original signature
# can be put back byte for byte (the "恢复原签名" button), and is put back
# automatically when the re-signed QQ fails to start.
# ---------------------------------------------------------------------------

BACKUP_MANIFEST = "manifest.json"
_CODESIG_DIR = "_CodeSignature"


def backup_root(home: Optional[Path] = None) -> Path:
    env = os.environ.get("MURMUR_QQ_BACKUP_DIR", "").strip()
    if env and home is None:
        return Path(env)
    return (home or Path.home()) / ".murmur" / "qq-backup"


def read_app_version(app: Path) -> str:
    """`<CFBundleShortVersionString>-<CFBundleVersion>` from Info.plist, made
    safe for a directory name. "unknown" if it cannot be read."""
    try:
        with open(Path(app) / "Contents" / "Info.plist", "rb") as f:
            info = plistlib.load(f)
    except Exception:
        return "unknown"
    parts = [str(info.get(k) or "").strip()
             for k in ("CFBundleShortVersionString", "CFBundleVersion")]
    parts = [x for i, x in enumerate(parts) if x and x not in parts[:i]]
    raw = "-".join(parts) or "unknown"
    safe = "".join(c if (c.isalnum() or c in "._-") else "_" for c in raw).strip("._")
    return safe[:80] or "unknown"


def _sha256(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _rel_main_exec(app: Path, main_exec: Path) -> str:
    try:
        return Path(main_exec).relative_to(app).as_posix()
    except ValueError:
        return "Contents/MacOS/" + Path(main_exec).name


def load_backup(app: Path, root: Optional[Path] = None) -> Optional[dict]:
    """Manifest of a complete, intact backup for this QQ version, or None."""
    import json
    d = (root or backup_root()) / read_app_version(app)
    try:
        man = json.loads((d / BACKUP_MANIFEST).read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(man, dict) or not man.get("sha256"):
        return None
    exe = d / "MacOS" / Path(man.get("main_exec_rel") or "QQ").name
    try:
        if not exe.is_file() or _sha256(exe) != man["sha256"]:
            return None
    except OSError:
        return None
    man["dir"] = str(d)
    man["exec_backup"] = str(exe)
    return man


def backup_info(app: Optional[Path], root: Optional[Path] = None) -> dict:
    """Small summary for /api/qq/profiles (drives the restore button)."""
    if not app:
        return {"exists": False}
    man = load_backup(Path(app), root)
    if not man:
        return {"exists": False, "version": read_app_version(Path(app))}
    return {"exists": True, "version": man.get("version"), "dir": man["dir"],
            "created_at": man.get("created_at"), "team_id": man.get("team_id")}


def backup_original(app: Path, main_exec: Path, *, root: Optional[Path] = None,
                    runner=None) -> dict:
    """Copy the vendor-signed main executable + _CodeSignature into
    ~/.murmur/qq-backup/<version>/. Reuses an intact existing backup. Refuses
    when QQ is already ad-hoc signed and no backup exists (we would only be
    backing up our own signature)."""
    import json
    app, main_exec = Path(app), Path(main_exec)
    existing = load_backup(app, root)
    if existing:
        return {"ok": True, "reused": True, "dir": existing["dir"], "manifest": existing}
    try:
        dv = _codesign_dv(main_exec, runner)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"读取 QQ 签名失败：{type(e).__name__}: {e}"}
    if not is_vendor_signed(dv):
        return {"ok": False, "error": (
            "QQ.app 现在已经不是腾讯原签名（可能之前重签过），而且找不到 Murmur 的原签名备份。"
            "为了不覆盖掉唯一的原版，Murmur 不会再重签。请先从 QQ 官网重新安装 QQ，再回来重签。")}
    version = read_app_version(app)
    base = root or backup_root()
    final = base / version
    tmp = base / (version + ".partial")
    rel = _rel_main_exec(app, main_exec)
    try:
        if tmp.exists():
            shutil.rmtree(tmp)
        (tmp / "MacOS").mkdir(parents=True)
        dst_exe = tmp / "MacOS" / main_exec.name
        shutil.copy2(main_exec, dst_exe)
        codesig = app / "Contents" / _CODESIG_DIR
        has_codesig = codesig.is_dir()
        if has_codesig:
            shutil.copytree(codesig, tmp / _CODESIG_DIR)
        digest = _sha256(main_exec)
        if _sha256(dst_exe) != digest:
            raise OSError("backup copy does not match the original")
        man = {"version": version, "app": str(app), "main_exec_rel": rel,
               "sha256": digest, "has_codesignature": has_codesig,
               "team_id": team_identifier(dv), "created_at": int(time.time())}
        (tmp / BACKUP_MANIFEST).write_text(json.dumps(man, ensure_ascii=False, indent=2),
                                           encoding="utf-8")
        if final.exists():
            shutil.rmtree(final)  # broken earlier backup (load_backup rejected it)
        os.replace(str(tmp), str(final))
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(tmp, ignore_errors=True)
        return {"ok": False, "error": f"备份 QQ 原签名失败（{type(e).__name__}: {e}），没有改动 QQ。"}
    man["dir"] = str(final)
    return {"ok": True, "reused": False, "dir": str(final), "manifest": man}


def build_restore_shell(app: Path, backup_dir: Path, main_exec_rel: str,
                        has_codesignature: bool) -> str:
    """Root shell script that copies the backed-up files back into QQ.app."""
    target = shlex.quote(str(Path(app) / main_exec_rel))
    src = shlex.quote(str(Path(backup_dir) / "MacOS" / Path(main_exec_rel).name))
    lines = ["set -e",
             f"/usr/bin/ditto {src} {target}",
             f"/bin/chmod 755 {target}"]
    if has_codesignature:
        cs_dst = shlex.quote(str(Path(app) / "Contents" / _CODESIG_DIR))
        cs_src = shlex.quote(str(Path(backup_dir) / _CODESIG_DIR))
        lines += [f"/bin/rm -rf {cs_dst}", f"/usr/bin/ditto {cs_src} {cs_dst}"]
    return "\n".join(lines) + "\n"


def restore_original(app: Optional[Path] = None, *, root: Optional[Path] = None,
                     runner=None, pids=None, sleep=None, quit_first: bool = True) -> dict:
    """Put the backed-up Tencent signature back (admin prompt)."""
    import qq_paths as _qp
    run = runner or subprocess.run
    log: list = []
    app = app or _qp.find_mac_qq_app()
    main_exec = _qp.mac_qq_main_exec(app) if app else None
    if not app or not main_exec:
        return {"ok": False, "log": log, "error": "没找到 QQ.app，没法恢复。"}
    man = load_backup(Path(app), root)
    if not man:
        try:
            vendor = is_vendor_signed(_codesign_dv(main_exec, run))
        except Exception:
            vendor = False
        if vendor:
            return {"ok": True, "log": log, "already_original": True,
                    "message": "QQ 现在就是腾讯原签名，不需要恢复。"}
        return {"ok": False, "log": log, "error": (
            "没找到这个 QQ 版本（{}）的原签名备份。请从 QQ 官网重新安装 QQ 来恢复。"
            .format(read_app_version(Path(app))))}
    if quit_first:
        log.append("退出 QQ…")
        alive = quit_qq(app, runner=run, pids=pids, sleep=sleep)
        if alive:
            return {"ok": False, "log": log,
                    "error": "QQ 还在运行，没法恢复签名。请先退出 QQ 再试。"}
    log.append("恢复原签名（会弹出 macOS 授权窗口，请输入开机密码）…")
    cmd = build_osascript_admin(build_restore_shell(
        Path(app), Path(man["dir"]), man.get("main_exec_rel") or _rel_main_exec(app, main_exec),
        bool(man.get("has_codesignature"))))
    r = run(["osascript", "-e", cmd], capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        blob = ((r.stdout or "") + "\n" + (r.stderr or "")).strip()
        low = blob.lower()
        if r.returncode == -128 or "user canceled" in low or "(-128)" in low:
            err = "恢复被 macOS 授权窗口取消了。请再点一次「恢复原签名」，在系统窗口里输入开机密码。"
        else:
            err = "恢复原签名失败。请确认 QQ 已退出，并在系统授权窗口输入开机密码；还不行就从 QQ 官网重新安装 QQ。"
        return {"ok": False, "log": log, "stderr": blob[-800:], "error": err}
    try:
        same = _sha256(main_exec) == man["sha256"]
    except OSError:
        same = False
    if not same:
        return {"ok": False, "log": log,
                "error": "恢复后 QQ 主程序和备份不一致。请从 QQ 官网重新安装 QQ。"}
    log.append("已恢复腾讯原签名。")
    return {"ok": True, "log": log, "restored": True, "backup_dir": man["dir"]}


def trial_launch(app: Path, *, runner=None, pids=None, sleep=None,
                 wait: float = 20.0, stable: float = 6.0, step: float = 0.5) -> dict:
    """Start QQ once (in the background) and check it stays up for `stable`
    seconds, then quit it. Catches the case where AMFI kills an ad-hoc binary
    that kept restricted entitlements."""
    import qq_paths as _qp
    run = runner or subprocess.run
    pids = pids or _qp.qq_running_pids
    sleep = sleep or time.sleep
    try:
        r = run(["open", "-g", str(app)], capture_output=True, text=True, timeout=30)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"open 失败：{type(e).__name__}: {e}"}
    if r.returncode != 0:
        blob = ((r.stdout or "") + (r.stderr or "")).strip()
        return {"ok": False, "error": "macOS 拒绝打开重签后的 QQ：" + (blob[-300:] or "open 返回错误")}
    waited = 0.0
    while not pids():
        if waited >= wait:
            return {"ok": False, "error": f"重签后的 QQ 在 {int(wait)} 秒内没有启动起来"}
        sleep(step)
        waited += step
    up = 0.0
    while up < stable:
        sleep(step)
        up += step
        if not pids():
            return {"ok": False, "error": "重签后的 QQ 启动后马上退出了（可能被系统签名检查拦截）"}
    alive = quit_qq(app, runner=run, pids=pids, sleep=sleep)
    return {"ok": True, "still_running": alive} if alive else {"ok": True}


def resign_qq(app: Optional[Path] = None, *, root: Optional[Path] = None, runner=None,
              pids=None, sleep=None, try_launch: bool = True) -> dict:
    """Back up the original signature, quit QQ, re-sign its main executable
    for debugging, then start it once. Any failure after codesign puts the
    original signature back automatically."""
    import qq_paths as _qp
    run = runner or subprocess.run
    log: list = []
    app = app or _qp.find_mac_qq_app()
    main_exec = _qp.mac_qq_main_exec(app) if app else None
    if not app or not main_exec:
        return {"ok": False, "error": "没找到 QQ.app。请先从 QQ 官网安装 macOS 版 QQ，或设置 MURMUR_QQ_APP。",
                "log": log}
    log.append("[1/5] 退出 QQ…")
    alive = quit_qq(app, runner=run, pids=pids, sleep=sleep)
    if alive:
        return {"ok": False, "log": log,
                "error": "QQ 还在运行，没法重签名。请在 QQ 菜单里选「退出 QQ」，或到「活动监视器」结束 QQ 后再试。",
                "stderr": "pids: " + ", ".join(str(p) for p in alive)}

    log.append("[2/5] 备份原签名…")
    bk = backup_original(Path(app), Path(main_exec), root=root, runner=run)
    if not bk.get("ok"):
        return {"ok": False, "log": log, "error": bk.get("error")}
    log.append(("      沿用已有备份：" if bk.get("reused") else "      已备份到 ") + bk["dir"])

    log.append("[3/5] 重签名（会弹出 macOS 授权窗口，请输入开机密码）…")
    ents = build_debug_entitlements(read_entitlements(main_exec, run))
    fd, ent_path = tempfile.mkstemp(prefix="murmur-qq-ents-", suffix=".plist")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(ents)
        cmd = build_osascript_admin(build_resign_shell(main_exec, Path(ent_path)))
        t0 = time.time()
        r = run(["osascript", "-e", cmd], capture_output=True, text=True, timeout=180)
        ms = round((time.time() - t0) * 1000)
    finally:
        try:
            os.unlink(ent_path)
        except OSError:
            pass
    if r.returncode != 0:
        blob = ((r.stdout or "") + "\n" + (r.stderr or "")).strip()
        return {"ok": False, "error": resign_error_message(r.returncode, blob),
                "stderr": blob[-800:], "log": log, "ms": ms, "backup_dir": bk["dir"]}

    def rollback(reason: str, **extra) -> dict:
        log.append("      " + reason + "，正在自动恢复原签名（会再弹一次授权窗口）…")
        rs = restore_original(Path(app), root=root, runner=run, pids=pids, sleep=sleep)
        log.extend("      " + x for x in rs.get("log", []))
        if rs.get("ok"):
            err = (reason + "。已自动恢复腾讯原签名，QQ 可以照常使用；"
                   "这台 Mac 暂时没法用这个方式抓 key，请到 GitHub issue 反馈 QQ 版本号。")
        else:
            err = (reason + "。自动恢复原签名也失败了（" + (rs.get("error") or "未知错误") +
                   "）。可以稍后点「恢复原签名」再试，或从 QQ 官网重新安装 QQ。")
        out = {"ok": False, "log": log, "ms": ms, "error": err,
               "rolled_back": bool(rs.get("ok")), "backup_dir": bk["dir"]}
        out.update(extra)
        return out

    log.append("[4/5] 验证签名…")
    sig = inspect_signature(main_exec, run)
    if not sig.get("debuggable"):
        return rollback("重签名后 QQ 仍然不能被调试（hardened runtime 还在且没有 get-task-allow）",
                        signature=sig)
    if try_launch:
        log.append("[5/5] 试启动一次 QQ，确认重签后能正常打开…")
        tl = trial_launch(Path(app), runner=run, pids=pids, sleep=sleep)
        if not tl.get("ok"):
            return rollback(tl.get("error") or "试启动失败", signature=sig)
        log.append("      QQ 能正常启动，已再次退出。")
    log.append("完成。下一步「抓 key」时由 Murmur 启动 QQ。")
    return {"ok": True, "log": log, "ms": ms, "signature": sig, "backup_dir": bk["dir"]}


# ---------------------------------------------------------------------------
# lldb capture
# ---------------------------------------------------------------------------

def build_lldb_argv(lldb_path: str, script: Path) -> list:
    """lldb invocation. Options travel through env (see build_capture_env), so
    only the script path needs quoting — lldb accepts a double-quoted path."""
    script_s = str(script).replace("\\", "\\\\").replace('"', '\\"')
    return [lldb_path, "--batch", "--no-lldbinit",
            "-o", f'command script import "{script_s}"',
            "-o", "murmur_qq_capture"]


def build_capture_env(app: Path, *, timeout: int, settle: int = 15, max_hits: int = 200,
                      cancel_file: Optional[Path] = None,
                      base_env: Optional[dict] = None) -> dict:
    env = dict(os.environ if base_env is None else base_env)
    for k in _ENV_STRIP:
        env.pop(k, None)
    env.update({
        "MURMUR_QQ_APP": str(app),
        "MURMUR_QQ_PROCESS": "QQ",
        "MURMUR_QQ_TIMEOUT": str(int(timeout)),
        "MURMUR_QQ_SETTLE": str(int(settle)),
        "MURMUR_QQ_MAX_HITS": str(int(max_hits)),
        "PYTHONUNBUFFERED": "1",
    })
    if cancel_file is not None:
        env["MURMUR_QQ_CANCEL_FILE"] = str(cancel_file)
    return env


def parse_status_line(line: str) -> Optional[dict]:
    """`MURMUR_STATUS stage=hit n=3` -> {"stage": "hit", "n": "3"}."""
    idx = (line or "").find(STATUS_MARKER)
    if idx < 0:
        return None
    out: dict = {}
    for tok in line[idx + len(STATUS_MARKER):].split():
        if "=" in tok:
            k, v = tok.split("=", 1)
            out[k] = v
    return out if "stage" in out else None


def failure_hint(statuses: list) -> Optional[str]:
    """Chinese explanation for lldb-side failures (before any candidate)."""
    stages = [s.get("stage") for s in statuses]
    last = statuses[-1] if statuses else {}
    if "attach_failed" in stages:
        return ("lldb 没能附加到 QQ 进程（{}）。通常是 QQ 还没重签名、重签名被 QQ 更新覆盖了，"
                "或者 macOS 的「开发者工具」授权窗口被取消。请先点「重签 QQ」，抓 key 时如果弹出"
                "授权窗口请输入开机密码。".format(
                    next((s.get("error") for s in statuses if s.get("stage") == "attach_failed"), "")))
    if "attach_timeout" in stages:
        return "等了很久 QQ 都没有启动。请确认 QQ.app 能正常打开（可能被系统提示「已损坏/已修改」拦住了）。"
    if "analyze_failed" in stages:
        err = next((s.get("error") for s in statuses if s.get("stage") == "analyze_failed"), "")
        return ("在 wrapper.node 里没找到 nt_sqlite3_key_v2（{}）。这个 QQ 版本的结构可能变了，"
                "请到 https://github.com/sgaofen/murmur/issues 反馈 QQ 版本号。".format(err))
    if "bp_set" not in stages and stages:
        return ("lldb 附加上了，但一直没等到 wrapper.node 加载（最后状态：{}）。"
                "请确认 QQ 窗口正常出现并登录。".format(last.get("stage")))
    if "bp_set" in stages and "hit" not in stages:
        return ("断点已下好，但 QQ 一直没打开数据库。请在弹出的 QQ 里完成登录；如果 QQ 自动登录了但没抓到，"
                "在 QQ 里点头像 →「退出账号」再重新登录（不要用菜单栏的「切换账号」）。")
    return None


def run_capture(verify_dbs: list, *, timeout: int = 240, settle: int = 15,
                on_status=None, cancel_file: Optional[Path] = None) -> dict:
    """Blocking capture. Returns the qq_decrypt.finish_extraction dict plus
    `statuses`. `on_status(dict)` is called for each MURMUR_STATUS line."""
    import qq_decrypt as _qdec
    import qq_paths as _qp

    def fail(msg: str, log: str = "", statuses=None) -> dict:
        return {"ok": False, "key": None, "qq": None, "variant": None, "candidates": [],
                "log": log[-3000:], "error": msg, "statuses": statuses or []}

    if sys.platform != "darwin":
        return fail("macOS only")
    lldb_path, err = find_lldb()
    if not lldb_path:
        return fail(err or "lldb not found")
    app = _qp.find_mac_qq_app()
    if not app:
        return fail("没找到 QQ.app。请先安装 macOS 版 QQ。")
    script = capture_script_path()
    if not script.exists():
        return fail(f"{CAPTURE_SCRIPT_NAME} not found at {script}")

    if on_status:
        on_status({"stage": "quitting"})
    alive = quit_qq(app)
    if alive:
        return fail("QQ 还在运行，Murmur 没能让它退出。请手动退出 QQ（菜单栏 QQ → 退出 QQ）后再点抓 key。")

    script_timeout = max(30, int(timeout) - 20)
    argv = build_lldb_argv(lldb_path, script)
    env = build_capture_env(app, timeout=script_timeout, settle=settle, cancel_file=cancel_file)
    lines: list = []
    statuses: list = []
    timed_out = False
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, env=env, text=True,
                                encoding="utf-8", errors="replace", bufsize=1)
    except Exception as e:
        return fail(f"启动 lldb 失败：{type(e).__name__}: {e}")

    def killer():
        nonlocal timed_out
        timed_out = True
        try:
            proc.kill()
        except Exception:
            pass
    timer = threading.Timer(timeout, killer)
    timer.daemon = True
    timer.start()
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip("\n")
            lines.append(line)
            st = parse_status_line(line)
            if st is not None:
                statuses.append(st)
                if on_status:
                    on_status(st)
        proc.wait()
    finally:
        timer.cancel()

    log = "\n".join(lines)
    res = _qdec.finish_extraction(log, list(verify_dbs or []), timed_out=timed_out, timeout=timeout)
    res["statuses"] = statuses
    # The cancel file also stops the attach watchdog (stage=attach_timeout),
    # so check the file itself, not only the lldb-side reason.
    cancelled = any(s.get("reason") == "cancelled" for s in statuses) or \
        bool(cancel_file is not None and Path(cancel_file).exists())
    res["cancelled"] = bool(cancelled and not res["ok"])
    if not res["ok"]:
        if cancelled:
            res["error"] = "已取消抓 key。"
        elif not _qdec.parse_key_candidates(log):
            hint = failure_hint(statuses)
            if hint:
                res["error"] = hint
    return res


# ---------------------------------------------------------------------------
# Background job (the UI polls /api/qq/extract-key/status)
#
# The job never keeps the lldb log or the candidate list (both contain the
# key in hex). The verified key itself is handed out by the first status
# read after the job finishes and then dropped; an unread key expires after
# RESULT_KEY_TTL seconds.
# ---------------------------------------------------------------------------

RESULT_KEY_TTL = 300

_JOB_LOCK = threading.Lock()
_JOB: dict = {"running": False, "stage": None, "hits": 0, "started_at": None,
              "finished_at": None, "result": None, "cancel_file": None}


def public_result(res: Optional[dict]) -> Optional[dict]:
    """Strip a run_capture result down to what the UI needs: no log, no
    candidate values (only how many there were)."""
    if res is None:
        return None
    return {"ok": bool(res.get("ok")), "key": res.get("key") if res.get("ok") else None,
            "qq": res.get("qq"), "variant": res.get("variant"), "error": res.get("error"),
            "cancelled": bool(res.get("cancelled")),
            "n_candidates": len(res.get("candidates") or [])}


def capture_state(now: Optional[float] = None) -> dict:
    now = time.time() if now is None else now
    with _JOB_LOCK:
        res = _JOB.get("result")
        out_res = dict(res) if res else None
        if res and res.get("key"):
            if now - (_JOB.get("finished_at") or 0) > RESULT_KEY_TTL:
                expired = dict(res, key=None, expired=True,
                               error=res.get("error") or "结果已过期，请重新抓 key。")
                _JOB["result"] = expired
                out_res = dict(expired)
            else:
                # hand the key out once, then forget it
                _JOB["result"] = dict(res, key=None, key_delivered=True)
        out = {k: v for k, v in _JOB.items() if k not in ("cancel_file", "result")}
        out["result"] = out_res
    return out


def _on_status(st: dict) -> None:
    with _JOB_LOCK:
        if _JOB["stage"] != "cancelling":
            _JOB["stage"] = st.get("stage")
        if st.get("stage") == "hit":
            try:
                _JOB["hits"] = int(st.get("n", _JOB["hits"]))
            except ValueError:
                pass


def start_capture(verify_dbs: list, *, timeout: int = 240) -> dict:
    with _JOB_LOCK:
        if _JOB["running"]:
            return {"ok": True, "already_running": True}
        fd, cancel_path = tempfile.mkstemp(prefix="murmur-qq-cancel-")
        os.close(fd)
        os.unlink(cancel_path)
        _JOB.update({"running": True, "stage": "starting", "hits": 0,
                     "started_at": int(time.time()), "finished_at": None,
                     "result": None, "cancel_file": cancel_path})

    def worker():
        try:
            res = run_capture(verify_dbs, timeout=timeout, on_status=_on_status,
                              cancel_file=Path(cancel_path))
        except Exception as e:  # noqa: BLE001
            res = {"ok": False, "key": None, "error": f"{type(e).__name__}: {e}"}
        if not res.get("ok") and os.path.exists(cancel_path):
            res = dict(res, cancelled=True, error="已取消抓 key。")
        with _JOB_LOCK:
            _JOB.update({"running": False, "finished_at": int(time.time()),
                         "stage": "cancelled" if res.get("cancelled") else "done",
                         "result": public_result(res), "cancel_file": None})
        try:
            os.unlink(cancel_path)
        except OSError:
            pass

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "started": True}


def cancel_capture() -> dict:
    with _JOB_LOCK:
        path = _JOB.get("cancel_file")
        running = _JOB["running"]
        if running:
            _JOB["stage"] = "cancelling"
    if running and path:
        try:
            Path(path).write_text("cancel", encoding="utf-8")
        except OSError:
            pass
    return {"ok": True, "cancelled": bool(running)}
