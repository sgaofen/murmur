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


def inspect_signature(main_exec: Path) -> dict:
    """Run codesign on the QQ main executable. Fields are None on error."""
    out = {"hardened": None, "adhoc": None, "get_task_allow": None, "debuggable": None}
    try:
        v = subprocess.run(["codesign", "-d", "-v", str(main_exec)],
                           capture_output=True, text=True, timeout=10)
        ents = read_entitlements(main_exec)
        out.update(signature_status((v.stdout or "") + "\n" + (v.stderr or ""), ents))
    except Exception:
        pass
    return out


def read_entitlements(main_exec: Path) -> Optional[dict]:
    for args in (["codesign", "-d", "--entitlements", "-", "--xml", str(main_exec)],
                 ["codesign", "-d", "--entitlements", ":-", str(main_exec)]):
        try:
            r = subprocess.run(args, capture_output=True, timeout=10)
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


def quit_qq(app: Optional[Path]) -> list:
    """Ask QQ to quit, then SIGTERM/SIGKILL whatever is still running from the
    bundle. Returns PIDs still alive afterwards."""
    import qq_paths as _qp
    subprocess.run(["osascript", "-e",
                    f'try\n  tell application id "{_qp.MAC_QQ_BUNDLE_ID}" to quit\nend try'],
                   capture_output=True, text=True, timeout=15)
    for _ in range(10):
        if not _qp.qq_running_pids():
            break
        time.sleep(0.5)
    if _qp.qq_running_pids():
        pattern = f"{app}/Contents/" if app else "/QQ.app/Contents/"
        subprocess.run(["pkill", "-f", pattern], capture_output=True)
        time.sleep(1.2)
        subprocess.run(["pkill", "-9", "-f", pattern], capture_output=True)
        time.sleep(0.6)
    return _qp.qq_running_pids()


def resign_qq(app: Optional[Path] = None) -> dict:
    """Quit QQ and re-sign its main executable for debugging."""
    import qq_paths as _qp
    log: list = []
    app = app or _qp.find_mac_qq_app()
    main_exec = _qp.mac_qq_main_exec(app)
    if not app or not main_exec:
        return {"ok": False, "error": "没找到 QQ.app。请先从 QQ 官网安装 macOS 版 QQ，或设置 MURMUR_QQ_APP。",
                "log": log}
    log.append("[1/4] 退出 QQ…")
    alive = quit_qq(app)
    if alive:
        return {"ok": False, "log": log,
                "error": "QQ 还在运行，没法重签名。请在 QQ 菜单里选「退出 QQ」，或到「活动监视器」结束 QQ 后再试。",
                "stderr": "pids: " + ", ".join(str(p) for p in alive)}

    log.append("[2/4] 重签名（会弹出 macOS 授权窗口，请输入开机密码）…")
    ents = build_debug_entitlements(read_entitlements(main_exec))
    fd, ent_path = tempfile.mkstemp(prefix="murmur-qq-ents-", suffix=".plist")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(ents)
        cmd = build_osascript_admin(build_resign_shell(main_exec, Path(ent_path)))
        t0 = time.time()
        r = subprocess.run(["osascript", "-e", cmd], capture_output=True, text=True, timeout=180)
        ms = round((time.time() - t0) * 1000)
    finally:
        try:
            os.unlink(ent_path)
        except OSError:
            pass
    if r.returncode != 0:
        blob = ((r.stdout or "") + "\n" + (r.stderr or "")).strip()
        return {"ok": False, "error": resign_error_message(r.returncode, blob),
                "stderr": blob[-800:], "log": log, "ms": ms}

    log.append("[3/4] 验证签名…")
    sig = inspect_signature(main_exec)
    if not sig.get("debuggable"):
        return {"ok": False, "log": log, "signature": sig,
                "error": "重签名后 QQ 仍然不能被调试（hardened runtime 还在且没有 get-task-allow）。"
                         "可能是 macOS / codesign 行为变了，请反馈 issue。"}
    log.append("[4/4] 完成。QQ 暂时不会自动打开，下一步「抓 key」时由 Murmur 启动。")
    return {"ok": True, "log": log, "ms": ms, "signature": sig}


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
    if not res["ok"]:
        if any(s.get("reason") == "cancelled" for s in statuses):
            res["error"] = "已取消抓 key。"
        elif not _qdec.parse_key_candidates(log):
            hint = failure_hint(statuses)
            if hint:
                res["error"] = hint
    return res


# ---------------------------------------------------------------------------
# Background job (the UI polls /api/qq/extract-key/status)
# ---------------------------------------------------------------------------

_JOB_LOCK = threading.Lock()
_JOB: dict = {"running": False, "stage": None, "hits": 0, "started_at": None,
              "finished_at": None, "result": None, "cancel_file": None}


def capture_state() -> dict:
    with _JOB_LOCK:
        out = {k: v for k, v in _JOB.items() if k != "cancel_file"}
    return out


def _on_status(st: dict) -> None:
    with _JOB_LOCK:
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
            res = {"ok": False, "key": None, "error": f"{type(e).__name__}: {e}",
                   "candidates": [], "log": ""}
        with _JOB_LOCK:
            _JOB.update({"running": False, "finished_at": int(time.time()),
                         "stage": "done", "result": res})
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
    if running and path:
        try:
            Path(path).write_text("cancel", encoding="utf-8")
        except OSError:
            pass
    return {"ok": True, "cancelled": bool(running)}
