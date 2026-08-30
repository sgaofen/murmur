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
import time

try:
    import frida
except ImportError:
    sys.exit("frida not installed. Run: pip install frida")

PAGE_SIZE = 4096
SALT_SIZE = 16
KEY_SIZE = 32
AES_BLOCK = 16
HMAC_HASH_SIZE = 64
RESERVE = 80

OUT_PATH = os.path.expanduser("~/.murmur/decrypted_keys.json")
LOG_PATH = "/tmp/murmur_cc_hook_frida.log"

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


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a") as f:
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


STATE = {"pending": {}, "matched": {}, "wxid": None, "hits": 0}


def save():
    if not STATE["matched"]:
        return
    payload = {
        "wxid": STATE["wxid"],
        "extracted_at": int(time.time()),
        "keys_by_db": STATE["matched"],
        "keys_by_salt": {},
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    try:
        with open(OUT_PATH, "w") as f:
            json.dump(payload, f, indent=2)
        # Whoever writes it first (root via sudo, or a plain user) shouldn't
        # lock the other out of writing next time — this exact mismatch
        # (root-owned file from a sudo run, then a later non-sudo run can't
        # save) already ate 6 freshly-captured keys once.
        try:
            os.chmod(OUT_PATH, 0o666)
        except OSError:
            pass
        log(f"wrote {len(STATE['matched'])} keys -> {OUT_PATH}")
    except OSError as e:
        # Never let a save failure lose in-memory progress: fall back to a
        # path we know we can write, and keep going.
        fallback = OUT_PATH + f".fallback-{os.getpid()}.json"
        log(f"WARNING: could not write {OUT_PATH} ({e}) — writing {fallback} instead. "
            f"Fix perms (e.g. `sudo chown {os.environ.get('USER', '$USER')} {OUT_PATH}`) and merge it in by hand if this keeps happening.")
        try:
            with open(fallback, "w") as f:
                json.dump(payload, f, indent=2)
        except OSError as e2:
            log(f"fallback write ALSO failed ({e2}) — keys are only in this process's memory now: {STATE['matched']}")


def on_message(message, data):
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
    key_bytes = bytes(payload["key"])
    STATE["hits"] += 1
    for rel, page1 in list(STATE["pending"].items()):
        if verify_candidate_key(page1, key_bytes):
            STATE["matched"][rel] = key_bytes.hex()
            del STATE["pending"][rel]
            total = len(STATE["matched"]) + len(STATE["pending"])
            log(f"MATCHED {rel} (via {payload.get('fn')})  ({len(STATE['matched'])}/{total})")
            save()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--seconds", type=int, default=30)
    p.add_argument("--pid", type=int, default=None, help="override target pid (for testing against a non-WeChat process)")
    args = p.parse_args()

    open(LOG_PATH, "w").close()
    log("hook_cc_key_frida starting")

    pending, wxid = discover_dbs()
    if args.pid is None:
        if not pending:
            log("no encrypted DBs found — aborting")
            return 1
        already = {}
        if os.path.exists(OUT_PATH):
            try:
                already = json.load(open(OUT_PATH)).get("keys_by_db", {})
            except Exception:
                pass
        for rel, key_hex in already.items():
            if rel in pending:
                STATE["matched"][rel] = key_hex
                del pending[rel]
        if STATE["matched"]:
            log(f"carried over {len(STATE['matched'])} already-known keys: {sorted(STATE['matched'].keys())}")
        STATE["pending"] = pending
        STATE["wxid"] = wxid
        if not pending:
            log("all DBs already matched — nothing to do")
            return 0
        log(f"tracking {len(pending)} still-missing DBs: {sorted(pending.keys())}")

        pid_raw = subprocess.run(["pgrep", "-x", "WeChat"], capture_output=True, text=True).stdout.strip().split("\n")[0]
        if not pid_raw:
            log("WeChat not running")
            return 1
        pid = int(pid_raw)
    else:
        pid = args.pid
        STATE["pending"] = {}

    log(f"attaching to pid {pid} via frida")
    device = frida.get_local_device()
    session = device.attach(pid)
    script = session.create_script(JS_AGENT)
    script.on("message", on_message)
    script.load()
    if args.pid is None:
        log(">>> hooks are live — go ACTIVELY USE WeChat now: send a text, send a voice "
            "message, send/view an image, open chats you haven't opened yet this session, "
            "check Moments/Contacts/Favorites/stickers. Passively idling won't trigger much. <<<")

    start = time.time()
    while time.time() - start < args.seconds:
        if args.pid is None and not STATE["pending"]:
            break
        time.sleep(0.5)

    log(f"finishing — matched {len(STATE['matched'])} total, hits seen: {STATE['hits']}")
    save()
    if STATE.get("pending"):
        log(f"still missing: {sorted(STATE['pending'].keys())}")
    session.detach()
    log("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
