"""hook_cc_key_frida.py — macOS-only: catch WeChat's live SQLCipher AES keys
by hooking CommonCrypto, using Frida instead of a debugger.

macOS only, WeChat 4.1.9+. Not tested on Windows/Linux — WeChat's key
handling there is different (see extract_key_dll.py for Windows).

Why this exists: on WeChat 4.1.9+, the `x'<hex key><hex salt>'` ASCII PRAGMA
literal extract_key_mac.py scans for is no longer reliably resident in
memory (same underlying shift that made extract_image_key_v2.py drop its
ASCII filter for the image key). WCDB still calls straight into macOS's
CommonCrypto (`CCCrypt` / `CCCryptorCreate` / `CCCryptorCreateWithMode` in
libcommonCrypto.dylib — confirmed present in wechat.dylib's import table, not
a bundled OpenSSL/mbedTLS), so hooking those calls directly and reading the
key argument works regardless of whether anything stays cached afterward.

Why Frida and not lldb: a debugger breakpoint stops the WHOLE process (every
thread) on every single hit, and WeChat's background WCDB worker threads
call these functions very frequently — even a fast, auto-continuing script
callback causes visible freezing/lag for the whole capture window (and lldb
has its own reliability quirks around auto-continue under heavy concurrent
hits — see llvm-project#112186). Frida's Interceptor.attach() does inline
hooking instead: it patches the target function's own prologue with a
trampoline to our JS callback, which runs in-process, in the same thread,
with no stop-the-world involved. Other threads are never paused. In testing
this handled thousands of calls/second with no perceptible impact on WeChat.

IMPORTANT — how to actually catch keys: WCDB only calls into CommonCrypto
with a DB's raw key when it's genuinely used this session (not just sitting
open in the background). Passively leaving WeChat idle while this runs won't
catch much. While this script is running, actively DO things across every
feature whose data you want — send (not just read) a text message, send a
voice message, send/view an image, open several different conversations you
haven't opened yet this session, check Moments, browse Contacts/Favorites,
open the sticker panel. Each DB (session, contacts, per-shard message DBs,
Moments, favorites, stickers, media, ...) only yields its key once triggered
this way. Run it more than once (progress accumulates in decrypted_keys.json
across runs) until you've covered everything you care about.

Usage:
    python3.12 hook_cc_key_frida.py [--seconds 30]
    (prefix with `sudo` if it fails to attach — same task_for_pid
    requirement as extract_key_mac.py)

App-driven mode (what Murmur's onboarding uses — see etcli.py
`/api/live-key/*`): root can't read ~/Library/Containers (TCC), so the
backend collects page 1 of every still-missing DB as the user and hands it
over, and the root process never touches the WeChat data dir:
    hook_cc_key_frida.py --pages pages.json --out-keys new_keys.json \
        --progress progress.json --stop-file stop --seconds 90
`--pages` is {"__wxid__": ..., "pages": {rel: page1_hex}}; `--out-keys`
receives only the newly matched {rel: key_hex} (the backend merges it into
~/.murmur/decrypted_keys.json); `--progress` is rewritten atomically about
twice a second; creating `--stop-file` ends the capture early (the backend
can't signal a root process).

Exit codes: 0 done, 1 generic failure, 5 attach denied (retry as root),
6 frida not importable.

Writes/merges into ~/.murmur/decrypted_keys.json — same format and file as
extract_key_mac.py / hook_cc_key.py, safe to alternate between them. Each
run loads existing keys first and only reports on what's still missing.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import time

PAGE_SIZE = 4096
SALT_SIZE = 16
KEY_SIZE = 32
AES_BLOCK = 16
HMAC_HASH_SIZE = 64
RESERVE = 80

OUT_PATH = os.path.expanduser("~/.murmur/decrypted_keys.json")
# Often run as root: never a fixed, predictable /tmp name (symlink attacks).
# App-driven runs pass --log inside their private temp dir.
LOG_PATH = os.path.join(tempfile.gettempdir(), f"murmur_cc_hook_frida-{os.getuid() if hasattr(os, 'getuid') else 0}.log")

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_ATTACH_DENIED = 5
EXIT_NO_FRIDA = 6

JS_AGENT = r"""
const KEY_SIZE = 32;

function tryHook(name) {
    let addr = null;
    try {
        const mod = Process.getModuleByName("libcommonCrypto.dylib");
        addr = mod.getExportByName(name);
    } catch (e) {
        send({type: "error", msg: "resolve " + name + ": " + e});
        return;
    }
    if (!addr) {
        send({type: "info", msg: "symbol not found: " + name});
        return;
    }
    Interceptor.attach(addr, {
        onEnter(args) {
            try {
                let keyLen, keyPtr;
                if (name === "CCCryptorCreateWithMode") {
                    keyLen = args[6].toInt32();
                    keyPtr = args[5];
                } else {
                    keyLen = args[4].toInt32();
                    keyPtr = args[3];
                }
                if (keyLen !== KEY_SIZE) return;
                const bytes = keyPtr.readByteArray(KEY_SIZE);
                send({type: "candidate", fn: name, key: Array.from(new Uint8Array(bytes))});
            } catch (e) {
                send({type: "error", msg: name + ": " + e});
            }
        }
    });
    send({type: "info", msg: "hooked " + name + " @ " + addr});
}

tryHook("CCCrypt");
tryHook("CCCryptorCreate");
tryHook("CCCryptorCreateWithMode");
send({type: "ready"});
"""


def _open_log(path, truncate=False):
    """Open the log without following symlinks, and only if it's a plain file
    we own with a single link — refuse anything an attacker could have
    pre-planted at that path."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
    if truncate:
        flags |= os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    try:
        st = os.fstat(fd)
        if hasattr(os, "getuid") and (st.st_uid != os.getuid() or st.st_nlink != 1):
            raise OSError("refusing to write log: not our own regular file")
    except OSError:
        os.close(fd)
        raise
    return os.fdopen(fd, "a")


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with _open_log(LOG_PATH) as f:
            f.write(line + "\n")
    except OSError:
        pass


def _hmac_key_from_aes(aes_key, salt):
    mac_salt = bytes(b ^ 0x3A for b in salt)
    return hashlib.pbkdf2_hmac("sha512", aes_key, mac_salt, 2, KEY_SIZE)


def verify_candidate_key(page1, candidate_key):
    if len(candidate_key) != KEY_SIZE or len(page1) != PAGE_SIZE:
        return False
    salt = page1[:SALT_SIZE]
    body_end = PAGE_SIZE - RESERVE
    body = page1[SALT_SIZE:body_end]
    iv = page1[body_end:body_end + AES_BLOCK]
    stored_hmac = page1[body_end + AES_BLOCK:body_end + AES_BLOCK + HMAC_HASH_SIZE]
    hk = _hmac_key_from_aes(candidate_key, salt)
    mac = hmac.new(hk, digestmod=hashlib.sha512)
    mac.update(body)
    mac.update(iv)
    mac.update((1).to_bytes(4, "little"))
    return hmac.compare_digest(mac.digest(), stored_hmac)


def discover_dbs():
    root_glob = os.path.expanduser(
        "~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"
    )
    wxid_dirs = sorted(glob.glob(os.path.join(root_glob, "wxid_*")))
    if not wxid_dirs:
        return {}, None
    profile_dir = wxid_dirs[0]
    enc_root = os.path.join(profile_dir, "db_storage")
    out = {}
    for path in glob.glob(os.path.join(enc_root, "**", "*.db"), recursive=True):
        name = os.path.basename(path)
        if "_fts" in name or name.endswith("-shm") or name.endswith("-wal"):
            continue
        try:
            with open(path, "rb") as f:
                page1 = f.read(PAGE_SIZE)
        except OSError:
            continue
        if len(page1) < PAGE_SIZE or page1.startswith(b"SQLite format 3"):
            continue
        rel = os.path.relpath(path, enc_root)
        out[rel] = page1
    return out, os.path.basename(profile_dir)


def load_pages_file(path):
    """Read the backend-provided {"__wxid__", "pages": {rel: page1_hex}} file."""
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    pages = {}
    for rel, hx in (raw.get("pages") or {}).items():
        try:
            page1 = bytes.fromhex(hx)
        except (TypeError, ValueError):
            continue
        if len(page1) == PAGE_SIZE:
            pages[rel] = page1
    return pages, raw.get("__wxid__")


def _write_json_atomic(path, payload, mode=0o644):
    tmp = f"{path}.tmp-{os.getpid()}-{os.urandom(4).hex()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    # 0644 by default: written by root in app-driven mode, the (non-root)
    # backend must still be able to read it. Key files use 0600.
    try:
        os.chmod(tmp, mode)
    except OSError:
        pass
    os.replace(tmp, path)


class Capture:
    """Matches candidate keys streamed from the Frida agent against page 1 of
    every still-missing DB. Frida-free so it can be unit-tested directly."""

    def __init__(self, pending, wxid=None, seconds=30, out_keys=None,
                 progress_path=None, already=None):
        self.pending = dict(pending)
        self.total = len(self.pending) + len(already or {})
        self.matched = dict(already or {})   # everything known (for save())
        self.new = {}                        # matched during this run only
        self.wxid = wxid
        self.seconds = seconds
        self.out_keys = out_keys
        self.progress_path = progress_path
        self.hits = 0
        self.phase = "starting"
        self.error = None
        self.started_at = time.time()
        self.hooked_at = None

    # --- persistence ---------------------------------------------------
    def save(self):
        if self.out_keys:
            # App-driven: only report what's new; the backend owns the merge.
            try:
                _write_json_atomic(self.out_keys, {"wxid": self.wxid, "keys_by_db": self.new})
            except OSError as e:
                log(f"WARNING: could not write {self.out_keys} ({e}) — new keys: {self.new}")
            return
        if not self.matched:
            return
        # Merge into whatever is there (keys from the memory scan, earlier
        # rounds, keys_by_salt) instead of overwriting the file.
        payload = {}
        try:
            with open(OUT_PATH, encoding="utf-8") as f:
                payload = json.load(f)
            if not isinstance(payload, dict):
                payload = {}
        except (OSError, ValueError):
            payload = {}
        by_db = dict(payload.get("keys_by_db") or {})
        by_db.update(self.matched)
        payload.update({
            "wxid": self.wxid or payload.get("wxid"),
            "extracted_at": int(time.time()),
            "keys_by_db": by_db,
            "keys_by_salt": dict(payload.get("keys_by_salt") or {}),
        })
        os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
        try:
            _write_json_atomic(OUT_PATH, payload, mode=0o600)
            # Run via sudo: hand the file back to the real user so a later
            # non-sudo run (or the App) can still read and update it.
            sudo_uid = os.environ.get("SUDO_UID")
            if sudo_uid and hasattr(os, "geteuid") and os.geteuid() == 0:
                try:
                    os.chown(OUT_PATH, int(sudo_uid), int(os.environ.get("SUDO_GID", "-1")))
                except (OSError, ValueError):
                    pass
            log(f"wrote {len(by_db)} keys -> {OUT_PATH}")
        except OSError as e:
            # Never let a save failure lose in-memory progress: fall back to a
            # path we know we can write, and keep going.
            fallback = OUT_PATH + f".fallback-{os.getpid()}.json"
            log(f"WARNING: could not write {OUT_PATH} ({e}) — writing {fallback} instead. "
                f"Fix perms (e.g. `sudo chown {os.environ.get('USER', '$USER')} {OUT_PATH}`) and merge it in by hand if this keeps happening.")
            try:
                _write_json_atomic(fallback, payload, mode=0o600)
            except OSError as e2:
                log(f"fallback write ALSO failed ({e2}) — keys are only in this process's memory now: {self.matched}")

    def write_progress(self):
        if not self.progress_path:
            return
        now = time.time()
        remaining = None
        if self.hooked_at is not None:
            remaining = max(0, int(round(self.seconds - (now - self.hooked_at))))
        try:
            _write_json_atomic(self.progress_path, {
                "phase": self.phase,
                "seconds": self.seconds,
                "remaining": remaining,
                "total": self.total,
                "matched_count": len(self.matched),
                "new": sorted(self.new.keys()),
                "pending": sorted(self.pending.keys()),
                "hits": self.hits,
                "error": self.error,
                "updated_at": now,
            })
        except OSError:
            pass

    # --- agent messages ------------------------------------------------
    def on_candidate(self, key_bytes, fn=None):
        self.hits += 1
        hit = False
        for rel, page1 in list(self.pending.items()):
            if verify_candidate_key(page1, key_bytes):
                self.matched[rel] = key_bytes.hex()
                self.new[rel] = key_bytes.hex()
                del self.pending[rel]
                hit = True
                log(f"MATCHED {rel} (via {fn})  ({len(self.matched)}/{self.total})")
        if hit:
            self.save()
            self.write_progress()
        return hit

    def on_message(self, message, data):
        if message.get("type") != "send":
            if message.get("type") == "error":
                log(f"[agent error] {message.get('description')}")
            return
        payload = message.get("payload", {})
        kind = payload.get("type")
        if kind == "info":
            log(f"[agent] {payload.get('msg')}")
            return
        if kind == "error":
            log(f"[agent error] {payload.get('msg')}")
            return
        if kind == "ready":
            log("[agent] ready — hooks installed")
            return
        if kind != "candidate":
            return
        self.on_candidate(bytes(payload["key"]), payload.get("fn"))


def _is_attach_denied(exc):
    name = type(exc).__name__
    msg = str(exc).lower()
    return (name in ("PermissionDeniedError", "ProcessNotRespondingError")
            or "permission" in msg or "unable to access process" in msg
            or "task_for_pid" in msg or "not permitted" in msg)


def should_stop(stop_file=None, parent_pid=None):
    """True once the backend asked us to stop: the stop file exists, its
    directory is gone (backend cleaned up — it will never write the file
    now), or the backend process itself is gone."""
    if stop_file:
        if os.path.exists(stop_file):
            return True
        if not os.path.isdir(os.path.dirname(os.path.abspath(stop_file))):
            return True
    # POSIX only: on Windows os.kill(pid, 0) is CTRL_C_EVENT, not a probe.
    if parent_pid and os.name == "posix":
        try:
            os.kill(parent_pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            pass  # exists, just not ours to signal
        except OSError:
            pass
    return False


def find_wechat_pid():
    pid_raw = subprocess.run(["pgrep", "-x", "WeChat"], capture_output=True,
                             text=True).stdout.strip().split("\n")[0]
    return int(pid_raw) if pid_raw else None


def run_capture(cap, pid, attach=None, stop_file=None, sleep=time.sleep,
                clock=time.time, stop_when_complete=True, parent_pid=None):
    """Attach to `pid`, stream candidates into `cap` for `cap.seconds`.

    `attach(pid) -> (session, script)` is injectable for tests; the default
    uses Frida. Returns an EXIT_* code.
    """
    if attach is None:
        attach = _frida_attach
    if should_stop(stop_file, parent_pid):
        cap.phase = "done"
        cap.write_progress()
        log("stop requested before attaching — exiting")
        return EXIT_OK
    cap.phase = "attaching"
    cap.write_progress()
    log(f"attaching to pid {pid} via frida")
    try:
        session, script = attach(pid, cap.on_message)
    except ImportError:
        cap.phase, cap.error = "error", "frida-missing"
        cap.write_progress()
        log("frida not installed. Run: pip install -r requirements-mac-keyextract.txt")
        return EXIT_NO_FRIDA
    except Exception as e:  # frida raises its own exception hierarchy
        denied = _is_attach_denied(e)
        cap.phase = "error"
        cap.error = "attach-denied" if denied else f"attach-failed: {e}"
        cap.write_progress()
        log(f"attach failed: {type(e).__name__}: {e}")
        return EXIT_ATTACH_DENIED if denied else EXIT_FAIL

    cap.phase = "capturing"
    cap.hooked_at = clock()
    cap.write_progress()
    log(">>> hooks are live — go ACTIVELY USE WeChat now: send a text, send a voice "
        "message, send/view an image, open chats you haven't opened yet this session, "
        "check Moments/Contacts/Favorites/stickers. Passively idling won't trigger much. <<<")
    reason = "timeout"
    try:
        while clock() - cap.hooked_at < cap.seconds:
            if stop_when_complete and not cap.pending:
                reason = "complete"
                break
            if should_stop(stop_file, parent_pid):
                reason = "stopped"
                break
            sleep(0.5)
            cap.write_progress()
    finally:
        try:
            script.unload()
        except Exception:
            pass
        try:
            session.detach()
        except Exception:
            pass
    log(f"finishing ({reason}) — matched {len(cap.matched)}/{cap.total}, hits seen: {cap.hits}")
    cap.save()
    if cap.pending:
        log(f"still missing: {sorted(cap.pending.keys())}")
    cap.phase = "done"
    cap.write_progress()
    log("DONE")
    return EXIT_OK


def _frida_attach(pid, on_message):
    import frida  # optional dependency — ImportError is handled by the caller
    device = frida.get_local_device()
    session = device.attach(pid)
    script = session.create_script(JS_AGENT)
    script.on("message", on_message)
    script.load()
    return session, script


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--seconds", type=int, default=30)
    p.add_argument("--pid", type=int, default=None, help="override target pid (for testing against a non-WeChat process)")
    p.add_argument("--pages", default=None, help="JSON of {__wxid__, pages: {rel: page1_hex}} (app-driven mode)")
    p.add_argument("--out-keys", default=None, help="write only newly matched keys here instead of ~/.murmur")
    p.add_argument("--progress", default=None, help="rewrite a JSON progress snapshot here while running")
    p.add_argument("--stop-file", default=None, help="stop early once this path exists")
    p.add_argument("--parent-pid", type=int, default=None, help="exit if this process (the backend) goes away")
    p.add_argument("--log", default=None, help="log file (default: per-user file in the temp dir)")
    args = p.parse_args(argv)

    global LOG_PATH
    if args.log:
        LOG_PATH = args.log
    try:
        _open_log(LOG_PATH, truncate=True).close()
    except OSError:
        pass
    log("hook_cc_key_frida starting")

    already = {}
    if args.pages:
        pending, wxid = load_pages_file(args.pages)
    elif args.pid is None:
        pending, wxid = discover_dbs()
        if os.path.exists(OUT_PATH):
            try:
                already = json.load(open(OUT_PATH)).get("keys_by_db", {})
            except Exception:
                pass
        already = {rel: k for rel, k in already.items() if rel in pending}
        for rel in already:
            del pending[rel]
        if already:
            log(f"carried over {len(already)} already-known keys: {sorted(already.keys())}")
    else:
        pending, wxid = {}, None

    cap = Capture(pending, wxid=wxid, seconds=args.seconds, out_keys=args.out_keys,
                  progress_path=args.progress, already=already)

    if args.pid is None:
        if not pending and not already:
            cap.phase, cap.error = "error", "no-dbs"
            cap.write_progress()
            log("no encrypted DBs found — aborting")
            return EXIT_FAIL
        if not pending:
            cap.phase = "done"
            cap.write_progress()
            log("all DBs already matched — nothing to do")
            return EXIT_OK
        log(f"tracking {len(pending)} still-missing DBs: {sorted(pending.keys())}")
        pid = find_wechat_pid()
        if not pid:
            cap.phase, cap.error = "error", "wechat-not-running"
            cap.write_progress()
            log("WeChat not running")
            return EXIT_FAIL
    else:
        pid = args.pid

    return run_capture(cap, pid, stop_file=args.stop_file,
                       stop_when_complete=args.pid is None, parent_pid=args.parent_pid)


if __name__ == "__main__":
    sys.exit(main())
