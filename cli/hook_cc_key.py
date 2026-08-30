"""hook_cc_key.py — macOS-only, WeChat 4.1.9+: lldb script that catches
WeChat's SQLCipher AES key live, at the moment WCDB calls into CommonCrypto
with it, instead of scavenging process memory after the fact.

PREFER hook_cc_key_frida.py INSTEAD OF THIS SCRIPT if you have (or can
`pip install`) Frida. This lldb version works — it does capture real keys —
but every hit stops the WHOLE process (every thread) via a debugger
exception, and WeChat's background WCDB worker threads call
CCCryptorCreate/CCCryptorCreateWithMode very frequently, so WeChat visibly
freezes/lags for the whole capture window even with the self-healing
watchdog below. It also runs into a real, currently-unfixed lldb bug where
a script callback can silently fail to bind right after breakpoint creation
(llvm-project#112186) — the watchdog exists specifically to recover from
that. Keep this file around as a no-extra-dependency fallback, but expect
Frida to be smoother.

Why this is needed at all: on WeChat 4.1.9+, the `x'<hex key><hex salt>'`
ASCII PRAGMA literal extract_key_mac.py looks for is not reliably resident
in memory (same underlying shift that made extract_image_key_v2.py drop its
ASCII filter for the image key), and neither are the raw salt bytes
findable by scanning for them directly. wechat.dylib still imports
CCCrypt/CCCryptorCreate/CCCryptorCreateWithMode (confirmed via `nm -u`, not
a bundled OpenSSL/mbedTLS), so hooking those calls and reading the key
argument works regardless of whether anything stays cached in memory
afterward. Matches a community-reported fix for the same class of failure
on WeChat 4.1.8+ (hicccc77/WeFlow issue #771).

IMPORTANT — how to actually catch keys: WCDB only calls into CommonCrypto
with a DB's raw key when that DB is genuinely used. Attach this BEFORE
logging into WeChat if you can (quit WeChat, relaunch fresh, run this
immediately, then log in) — but even against an already-running WeChat,
actively DOING things (send a text, send a voice message, send/view an
image, open conversations you haven't opened yet this session, check
Moments/Contacts/Favorites/stickers) keeps triggering fresh calls, so it's
worth running more than once. Passively idling won't catch much.

Usage (from Terminal — needs root for task_for_pid, same as extract_key_mac.py):
    sudo lldb --no-lldbinit -o "command script import /path/to/hook_cc_key.py" -o "quit"

Writes results to ~/.murmur/decrypted_keys.json in the same format
extract_key_mac.py / hook_cc_key_frida.py use, so refresh.py picks it up
unmodified — safe to alternate between all three. Progress log also
mirrored to /tmp/murmur_cc_hook.log (tail -f it from another terminal if
you want to watch live).
"""
import glob
import hashlib
import hmac
import json
import os
import time

import lldb

PAGE_SIZE = 4096
SALT_SIZE = 16
KEY_SIZE = 32
AES_BLOCK = 16
HMAC_HASH_SIZE = 64
RESERVE = 80

RUN_SECONDS = 30
OUT_PATH = os.path.expanduser("~/.murmur/decrypted_keys.json")
LOG_PATH = "/tmp/murmur_cc_hook.log"

# Safety net: CCCryptorCreate/CCCrypt are shared system-wide crypto entry
# points — TLS/network code calls them constantly too, not just WCDB. EVERY
# call, from ANY caller, stops the whole process momentarily (that's how
# breakpoints work) before our callback gets to decide whether to care. A
# burst of unrelated network activity (e.g. at login) can fire hundreds of
# these in a couple seconds, which — even with fast per-hit filtering below —
# made WeChat visibly freeze once already. These limits force an abort well
# before that happens again, at the cost of possibly missing the key if it's
# buried in the same burst.
BURST_LIMIT_PER_SEC = 25
TOTAL_HIT_CEILING = 400

STATE = {"pending": {}, "matched": {}, "wxid": None, "hits": 0, "abort": False,
         "_bucket": None, "_bucket_count": 0, "target": None}


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line)
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


def _save():
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
        # lock the other out of writing next time.
        try:
            os.chmod(OUT_PATH, 0o666)
        except OSError:
            pass
        log(f"wrote {len(STATE['matched'])} keys -> {OUT_PATH}")
    except OSError as e:
        fallback = OUT_PATH + f".fallback-{os.getpid()}.json"
        log(f"WARNING: could not write {OUT_PATH} ({e}) — writing {fallback} instead.")
        try:
            with open(fallback, "w") as f:
                json.dump(payload, f, indent=2)
        except OSError as e2:
            log(f"fallback write ALSO failed ({e2}) — keys are only in this process's memory now: {STATE['matched']}")


def _check_candidate(key_bytes):
    if len(key_bytes) != KEY_SIZE:
        return
    STATE["hits"] += 1
    for rel, page1 in list(STATE["pending"].items()):
        if verify_candidate_key(page1, key_bytes):
            STATE["matched"][rel] = key_bytes.hex()
            del STATE["pending"][rel]
            total = len(STATE["matched"]) + len(STATE["pending"])
            log(f"MATCHED {rel}  ({len(STATE['matched'])}/{total})")
            _save()


def _read_bytes(process, addr, length):
    err = lldb.SBError()
    data = process.ReadMemory(addr, length, err)
    if not err.Success() or data is None:
        return None
    return data


def _is_arm64(frame):
    return "arm64" in frame.GetThread().GetProcess().GetTarget().GetTriple()


def _trip_circuit_breaker(process, reason):
    if STATE["abort"]:
        return
    STATE["abort"] = True
    log(f"CIRCUIT BREAKER TRIPPED ({reason}) — deleting breakpoints and detaching NOW to protect WeChat")
    try:
        process.GetTarget().DeleteAllBreakpoints()
    except Exception as e:
        log(f"  (delete breakpoints failed: {e})")
    try:
        process.Detach(False)  # False = resume the process on detach, don't leave it stopped
    except Exception as e:
        log(f"  (detach failed: {e})")


def _register_hit_and_check_breaker(process):
    """Cheapest possible per-hit bookkeeping — runs before any other work so
    the circuit breaker can fire even if something else in the callback is
    slow or throws. Returns True if we should abort processing this hit."""
    STATE["hits"] += 1
    now_bucket = int(time.time())
    if STATE["_bucket"] != now_bucket:
        STATE["_bucket"] = now_bucket
        STATE["_bucket_count"] = 0
    STATE["_bucket_count"] += 1
    if STATE["abort"]:
        return True
    if STATE["_bucket_count"] > BURST_LIMIT_PER_SEC:
        _trip_circuit_breaker(process, f"{STATE['_bucket_count']} hits in 1s")
        return True
    if STATE["hits"] > TOTAL_HIT_CEILING:
        _trip_circuit_breaker(process, f"{STATE['hits']} total hits")
        return True
    return False


def _from_wechat_bundle(thread):
    """Is the CALLER of this CommonCrypto entry point WeChat's own code (some
    module inside WeChat.app), as opposed to a system framework (Security.
    framework / CFNetwork / etc. handling unrelated TLS traffic)? Cheap: a
    couple of SBAPI calls + a substring check, no memory reads."""
    if thread.GetNumFrames() < 2:
        return False
    caller = thread.GetFrameAtIndex(1)
    module = caller.GetModule()
    if not module.IsValid():
        return False
    path = module.GetFileSpec().fullpath or ""
    return "/WeChat.app/" in path


def on_cc_simple(frame, bp_loc, internal_dict):
    # CCCrypt(op, alg, options, key, keyLength, ...) / CCCryptorCreate(op, alg,
    # options, key, keyLength, ...) — key is arg index 3, keyLength is arg index 4.
    process = frame.GetThread().GetProcess()
    if _register_hit_and_check_breaker(process):
        return False
    try:
        if not _from_wechat_bundle(frame.GetThread()):
            return False  # TLS/network noise from a system framework — skip fast
        if _is_arm64(frame):
            key_ptr = frame.FindRegister("x3").GetValueAsUnsigned()
            key_len = frame.FindRegister("x4").GetValueAsUnsigned()
        else:
            key_ptr = frame.FindRegister("rcx").GetValueAsUnsigned()
            key_len = frame.FindRegister("r8").GetValueAsUnsigned()
        if key_len == KEY_SIZE:
            data = _read_bytes(process, key_ptr, KEY_SIZE)
            if data:
                _check_candidate(bytes(data))
    except Exception as e:
        try:
            log(f"on_cc_simple error: {e}")
        except Exception:
            pass  # never let a logging failure stop us from returning False below
    return False  # never stop — auto-resume


def on_cc_with_mode(frame, bp_loc, internal_dict):
    # CCCryptorCreateWithMode(op, mode, alg, padding, iv, key, keyLength, ...)
    # key is arg index 5, keyLength is arg index 6. arm64 only (x86_64 7th arg
    # spills to the stack — not worth the extra complexity on an ARM Mac).
    process = frame.GetThread().GetProcess()
    if _register_hit_and_check_breaker(process):
        return False
    if not _is_arm64(frame):
        return False
    try:
        if not _from_wechat_bundle(frame.GetThread()):
            return False
        key_ptr = frame.FindRegister("x5").GetValueAsUnsigned()
        key_len = frame.FindRegister("x6").GetValueAsUnsigned()
        if key_len == KEY_SIZE:
            data = _read_bytes(process, key_ptr, KEY_SIZE)
            if data:
                _check_candidate(bytes(data))
    except Exception as e:
        try:
            log(f"on_cc_with_mode error: {e}")
        except Exception:
            pass
    return False


def __lldb_init_module(debugger, internal_dict):
    open(LOG_PATH, "w").close()
    log("hook_cc_key starting")

    pending, wxid = discover_dbs()
    if not pending:
        log("no encrypted DBs found under xwechat_files — is WeChat logged in on this Mac? aborting")
        return

    # Each lldb invocation is a fresh Python process, so pick up keys already
    # captured by a previous short run instead of clobbering them — this is
    # meant to be run several times in a row (30s each) to mop up whichever
    # DBs the user happens to click into that session.
    already = {}
    if os.path.exists(OUT_PATH):
        try:
            with open(OUT_PATH) as f:
                already = json.load(f).get("keys_by_db", {})
        except Exception as e:
            log(f"could not read existing {OUT_PATH} ({e}) — starting fresh")
    for rel, key_hex in already.items():
        if rel in pending:
            STATE["matched"][rel] = key_hex
            del pending[rel]
    if STATE["matched"]:
        log(f"carried over {len(STATE['matched'])} already-known keys from a previous run: {sorted(STATE['matched'].keys())}")

    STATE["pending"] = pending
    STATE["wxid"] = wxid
    if not pending:
        log("all DBs already matched from previous runs — nothing left to do!")
        return
    log(f"tracking {len(pending)} still-missing encrypted DBs for wxid={wxid}: {sorted(pending.keys())}")

    pid_raw = os.popen("pgrep -x WeChat").read().strip().split("\n")[0]
    if not pid_raw:
        log("WeChat is not running — launch it fresh (do NOT log in yet) and re-run")
        return
    pid = int(pid_raw)
    log(f"target WeChat pid: {pid}")

    debugger.SetAsync(True)
    target = debugger.CreateTarget("")
    err = lldb.SBError()
    process = target.AttachToProcessWithID(debugger.GetListener(), pid, err)
    if not err.Success():
        log(f"ATTACH FAILED: {err}  (try running this whole thing with sudo)")
        return
    log("attached OK")

    # Known lldb footgun (confirmed by an lldb maintainer, llvm-project#112186):
    # SetScriptCallbackFunction can silently fail to actually bind if called
    # right after breakpoint creation, especially setting up several
    # breakpoints back-to-back like this. The community-found fix is a short
    # sleep before each registration — cheap, and this is exactly what
    # produced our stuck-breakpoint incident (WeChat froze with the callback
    # apparently never firing for one of these).
    n_locs = 0
    for name in ("CCCrypt", "CCCryptorCreate"):
        bp = target.BreakpointCreateByName(name)
        time.sleep(0.2)
        bp.SetScriptCallbackFunction("hook_cc_key.on_cc_simple")
        time.sleep(0.2)
        log(f"breakpoint on {name}: {bp.GetNumLocations()} location(s)")
        n_locs += bp.GetNumLocations()

    bp2 = target.BreakpointCreateByName("CCCryptorCreateWithMode")
    time.sleep(0.2)
    bp2.SetScriptCallbackFunction("hook_cc_key.on_cc_with_mode")
    time.sleep(0.2)
    log(f"breakpoint on CCCryptorCreateWithMode: {bp2.GetNumLocations()} location(s)")
    n_locs += bp2.GetNumLocations()

    if n_locs == 0:
        log("WARNING: 0 breakpoint locations resolved — symbols not found, hook will never fire")

    process.Continue()
    log(f"RUNNING for up to {RUN_SECONDS}s.")
    log(">>> GO ACTIVELY USE WECHAT NOW: log in, send a text/voice/image (not just read), "
        "open chats/moments/contacts/favorites/stickers you haven't touched this session. "
        "Passively idling won't trigger much. <<<")

    start = time.time()
    last_report = 0
    stuck_resumes = 0
    while time.time() - start < RUN_SECONDS:
        if not STATE["pending"]:
            break
        if STATE["abort"]:
            log("circuit breaker already handled detach — stopping loop")
            break
        state = process.GetState()
        if state == lldb.eStateStopped:
            # SELF-HEALING WATCHDOG: this is exactly the failure mode that
            # froze WeChat last time — a breakpoint callback silently failed
            # to bind (known lldb bug, see comment above) so lldb defaulted
            # to leaving the process stopped instead of auto-continuing.
            # We poll every ~1s specifically to catch and fix this ourselves
            # rather than let WeChat sit frozen until our own timeout.
            stuck_resumes += 1
            log(f"process unexpectedly STOPPED (not our doing) — forcing Continue() (recovery #{stuck_resumes})")
            process.Continue()
            if stuck_resumes > 20:
                _trip_circuit_breaker(process, "process kept re-stopping — giving up and detaching for safety")
                break
        elif state != lldb.eStateRunning:
            log(f"process state changed unexpectedly: {state} — stopping early")
            break
        elapsed = int(time.time() - start)
        if elapsed - last_report >= 10:
            last_report = elapsed
            log(f"...{elapsed}s elapsed, {STATE['hits']} CommonCrypto calls seen so far, "
                f"{len(STATE['matched'])}/{len(STATE['matched']) + len(STATE['pending'])} DBs matched")
        time.sleep(1)

    total = len(STATE["matched"]) + len(STATE["pending"])
    log(f"finishing — matched {len(STATE['matched'])}/{total}, total CommonCrypto calls seen: {STATE['hits']}")
    _save()
    if STATE["pending"]:
        log(f"still missing: {sorted(STATE['pending'].keys())}")
    if STATE["abort"]:
        log("stopped early by the circuit breaker (see above) — WeChat should already be running normally again")
    else:
        if process.GetState() == lldb.eStateStopped:
            log("process was stopped right at the end — Continue()-ing once more before detach")
            process.Continue()
            time.sleep(0.3)
        try:
            process.Detach(False)  # False = resume on detach, never leave WeChat stopped
        except Exception as e:
            log(f"detach error (harmless): {e}")
    log("DONE")
