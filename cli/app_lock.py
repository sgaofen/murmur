"""App lock — keep someone else at the keyboard from browsing Murmur.

What it is: a password gate in front of the local HTTP API. While locked,
``etcli serve`` answers every request except the lock endpoints with
``423 APP_LOCKED`` and the frontend renders nothing but the lock screen.
The idle timeout is enforced here too: once no user activity has been
reported for ``idle_minutes`` the backend locks itself, whether or not the
frontend managed to ask for it.

What it is NOT: encryption. The decrypted databases under
``~/Documents/Murmur/decrypted`` stay readable to anyone with access to this
user account; ``etcli mcp`` and other tools that open those files directly
are not affected by the lock.

Storage: ``~/.murmur/app_lock.json`` (next to config.json) holds only a salted
PBKDF2-HMAC-SHA256 hash, the idle timeout, and the failed-attempt counter.
Forgot the password? Quit Murmur and delete that file — the lock is then off
(documented in docs/app-lock.md). There is no other bypass.

Pure stdlib, no side effects on import — safe to unit-test in CI.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import unicodedata
from pathlib import Path
from typing import Callable, Optional

ALGO = "pbkdf2_sha256"
# OWASP 2023 recommendation for PBKDF2-HMAC-SHA256. ~0.3 s on a laptop, which
# is fine for an interactive unlock and slows offline guessing of the file.
DEFAULT_ITERATIONS = 600_000
SALT_BYTES = 16

MIN_PASSWORD_LEN = 4
MAX_PASSWORD_LEN = 256
# Request bodies for /api/app-lock/* are tiny JSON objects.
MAX_BODY_BYTES = 4096

IDLE_CHOICES = (0, 5, 15, 30)  # minutes; 0 = never auto-lock
DEFAULT_IDLE_MINUTES = 15

# Failed unlocks: the first FREE_ATTEMPTS are free, then each further failure
# doubles the wait, starting at BASE_DELAY seconds and capped at MAX_DELAY.
FREE_ATTEMPTS = 3
BASE_DELAY = 5.0
MAX_DELAY = 300.0

LOCK_FILE_NAME = "app_lock.json"


def default_lock_path() -> Path:
    return Path.home() / ".murmur" / LOCK_FILE_NAME


def _nfc(password: str) -> str:
    # The same password typed through different input methods can arrive
    # composed or decomposed; hash one canonical form.
    return unicodedata.normalize("NFC", password)


def _pbkdf2(password: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)


def hash_password(password: str, salt: Optional[bytes] = None,
                  iterations: int = DEFAULT_ITERATIONS) -> dict:
    """Return a storable record ``{algo, iterations, salt, hash}`` (hex)."""
    if salt is None:
        salt = secrets.token_bytes(SALT_BYTES)
    dk = _pbkdf2(_nfc(password), salt, iterations)
    return {"algo": ALGO, "iterations": iterations, "salt": salt.hex(), "hash": dk.hex()}


def verify_password(password: str, record: dict) -> bool:
    """Constant-time check of ``password`` against a ``hash_password`` record.

    Tries the NFC form first, then the raw string, so a record written before
    passwords were normalized still verifies. Nothing is migrated.
    """
    try:
        if record.get("algo") != ALGO:
            return False
        iterations = int(record["iterations"])
        salt = bytes.fromhex(record["salt"])
        expected = bytes.fromhex(record["hash"])
    except (KeyError, TypeError, ValueError, AttributeError):
        return False
    if iterations < 1 or not salt or not expected:
        return False
    candidates = [_nfc(password)]
    if candidates[0] != password:
        candidates.append(password)
    ok = False
    for cand in candidates:
        ok = hmac.compare_digest(_pbkdf2(cand, salt, iterations), expected) or ok
    return ok


def retry_delay(failed_attempts: int) -> float:
    """Seconds to wait after ``failed_attempts`` consecutive failures."""
    if failed_attempts < FREE_ATTEMPTS:
        return 0.0
    # Clamp the exponent so a huge counter can't overflow the float.
    exp = min(failed_attempts - FREE_ATTEMPTS, 32)
    return min(MAX_DELAY, BASE_DELAY * (2 ** exp))


class AppLockError(Exception):
    """A rejected lock operation. ``code`` maps to cli/error_codes.py."""

    def __init__(self, code: str, message: str, status: int = 400, retry_after: float = 0.0):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retry_after = retry_after

    def payload(self) -> dict:
        out = {"ok": False, "error": self.message, "code": self.code}
        if self.retry_after:
            out["retry_after"] = int(-(-self.retry_after // 1))  # ceil
        return out


# Codes duplicated here (not imported) so this module stays importable on its
# own; tests assert they exist in error_codes.ALL_CODES.
APP_LOCKED = "APP_LOCKED"
APP_LOCK_WRONG_PASSWORD = "APP_LOCK_WRONG_PASSWORD"
APP_LOCK_RATE_LIMITED = "APP_LOCK_RATE_LIMITED"
APP_LOCK_INVALID = "APP_LOCK_INVALID"


class AppLock:
    """Lock state for one backend process. Thread-safe.

    The persisted file survives restarts (so the failure back-off can't be
    reset by relaunching the app); the ``locked`` flag and the last-activity
    time are in memory, and the lock starts engaged whenever a password is
    configured.
    """

    def __init__(self, path: Optional[Path] = None, iterations: int = DEFAULT_ITERATIONS,
                 clock: Callable[[], float] = time.time):
        self.path = Path(path) if path is not None else default_lock_path()
        self.iterations = iterations
        self._clock = clock
        self._mu = threading.Lock()
        self._data = self._load()
        self._locked = self.enabled
        self._last_activity = clock()

    # ---- persistence ----

    def _load(self) -> dict:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        try:
            tmp.unlink()  # O_CREAT keeps an existing file's mode
        except FileNotFoundError:
            pass
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(self._data, indent=2))
        os.replace(tmp, self.path)

    # ---- idle + back-off bookkeeping (caller holds self._mu) ----

    @property
    def enabled(self) -> bool:
        rec = self._data.get("password")
        return isinstance(rec, dict) and bool(rec.get("hash"))

    @property
    def idle_minutes(self) -> int:
        v = self._data.get("idle_minutes", DEFAULT_IDLE_MINUTES)
        return v if v in IDLE_CHOICES else DEFAULT_IDLE_MINUTES

    def _check_idle(self) -> None:
        """Engage the lock once the idle timeout has passed with no activity."""
        if not self.enabled or self._locked or self.idle_minutes <= 0:
            return
        now = self._clock()
        if now < self._last_activity:
            # Clock went backwards: restart the idle window from now rather
            # than trusting a negative (or wrapped) elapsed time.
            self._last_activity = now
            return
        if now - self._last_activity >= self.idle_minutes * 60:
            self._locked = True

    def _wait_left(self) -> float:
        """Seconds of back-off remaining, never more than MAX_DELAY.

        If the wall clock moved backwards, ``retry_at`` may sit far in the
        future; pull it in so the wait is at most MAX_DELAY from now.
        """
        until = float(self._data.get("retry_at") or 0)
        now = self._clock()
        left = until - now
        if left > MAX_DELAY:
            self._data["retry_at"] = now + MAX_DELAY
            self._save()
            left = MAX_DELAY
        return max(0.0, left)

    def _record_failure(self, message: str) -> AppLockError:
        fails = int(self._data.get("failed_attempts") or 0) + 1
        delay = retry_delay(fails)
        self._data["failed_attempts"] = fails
        self._data["retry_at"] = self._clock() + delay if delay else 0
        self._save()
        return AppLockError(APP_LOCK_WRONG_PASSWORD, message, 401, delay)

    def _verify_attempt(self, password, message: str) -> None:
        """Rate-limited password check; raises on wait or mismatch."""
        wait = self._wait_left()
        if wait > 0:
            raise AppLockError(APP_LOCK_RATE_LIMITED, "尝试次数过多，请稍后再试", 429, wait)
        # Over-long input counts as a failed guess and is never hashed.
        if (not isinstance(password, str) or len(password) > MAX_PASSWORD_LEN
                or not verify_password(password, self._data["password"])):
            raise self._record_failure(message)

    # ---- queries ----

    def is_locked(self) -> bool:
        with self._mu:
            self._check_idle()
            return self._locked and self.enabled

    def status(self) -> dict:
        with self._mu:
            self._check_idle()
            return {
                "enabled": self.enabled,
                "locked": self._locked and self.enabled,
                "idle_minutes": self.idle_minutes,
                "idle_choices": list(IDLE_CHOICES),
                "retry_after": int(-(-self._wait_left() // 1)),
                "failed_attempts": int(self._data.get("failed_attempts") or 0),
                "touch_id": False,
                "lock_file": str(self.path),
            }

    # ---- transitions ----

    def touch(self) -> bool:
        """Record user activity. Returns False (and does nothing) if locked."""
        with self._mu:
            self._check_idle()
            if self._locked and self.enabled:
                return False
            self._last_activity = self._clock()
            return True

    def lock(self) -> bool:
        with self._mu:
            self._locked = self.enabled
            return self._locked

    def unlock(self, password: str) -> None:
        with self._mu:
            if not self.enabled:
                self._locked = False
                return
            self._verify_attempt(password, "密码不对")
            self._locked = False
            self._last_activity = self._clock()
            if self._data.get("failed_attempts") or self._data.get("retry_at"):
                self._data["failed_attempts"] = 0
                self._data["retry_at"] = 0
                self._save()

    def set_password(self, new_password: str, current_password: Optional[str] = None,
                     idle_minutes: Optional[int] = None) -> None:
        """Turn the lock on, or change the password (needs the current one)."""
        if not isinstance(new_password, str) or not (MIN_PASSWORD_LEN <= len(new_password) <= MAX_PASSWORD_LEN):
            raise AppLockError(APP_LOCK_INVALID, f"密码长度要在 {MIN_PASSWORD_LEN}–{MAX_PASSWORD_LEN} 位之间", 400)
        if idle_minutes is not None and idle_minutes not in IDLE_CHOICES:
            raise AppLockError(APP_LOCK_INVALID, "闲置时间只能是 5 / 15 / 30 分钟或从不", 400)
        with self._mu:
            if self.enabled:
                self._verify_attempt(current_password, "当前密码不对")
            self._data["password"] = hash_password(new_password, iterations=self.iterations)
            if idle_minutes is not None:
                self._data["idle_minutes"] = idle_minutes
            self._data.setdefault("idle_minutes", DEFAULT_IDLE_MINUTES)
            self._data["failed_attempts"] = 0
            self._data["retry_at"] = 0
            self._locked = False  # the user who just set it is at the keyboard
            self._last_activity = self._clock()
            self._save()

    def disable(self, current_password: Optional[str]) -> None:
        with self._mu:
            if not self.enabled:
                return
            self._verify_attempt(current_password, "当前密码不对")
            self._data = {}
            self._locked = False
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass

    def set_idle_minutes(self, minutes: int) -> None:
        if minutes not in IDLE_CHOICES:
            raise AppLockError(APP_LOCK_INVALID, "闲置时间只能是 5 / 15 / 30 分钟或从不", 400)
        with self._mu:
            if not self.enabled:
                raise AppLockError(APP_LOCK_INVALID, "还没有设置应用锁密码", 400)
            self._data["idle_minutes"] = minutes
            self._last_activity = self._clock()
            self._save()
