/*
 * murmur_keycap.c — tiny macOS DYLD_INSERT_LIBRARIES capture shim.
 *
 * Part of Murmur's "private copy" key capture (免 Frida、免 root). Instead of
 * attaching Frida to /Applications/WeChat.app as root, Murmur copies WeChat
 * into its own directory, ad-hoc re-signs the copy with
 * disable-library-validation + allow-dyld-environment-variables, and launches
 * it with this dylib injected via DYLD_INSERT_LIBRARIES. The copy reuses the
 * existing login session; the user just signs in / uses WeChat once.
 *
 * WeChat 4.1.9+ derives each SQLCipher DB key with
 *   PBKDF2-HMAC-SHA512(account passphrase, DB salt, 256000)
 * through macOS CommonCrypto. We interpose the relevant CommonCrypto entry
 * points and append every candidate (the derived 32-byte key, and the
 * PBKDF2 password+params so the backend can derive the rest offline) to the
 * file named by $MURMUR_KEYCAP_OUT. The backend verifies each candidate with
 * the usual page-1 HMAC check before trusting it — this shim performs no
 * crypto and makes no judgement about which candidate is "the" key.
 *
 * Nothing here is WeChat-specific: it is a generic CommonCrypto logger. It
 * writes ONLY to the private, 0600 file passed in the environment, and only
 * when that variable is set, so injecting it into anything else is inert.
 *
 * Build (see build_keycap.sh): a universal (arm64 + x86_64) dylib, compiled
 * locally / in CI with clang. The binary is never committed.
 */
#include <CommonCrypto/CommonCrypto.h>
#include <CommonCrypto/CommonKeyDerivation.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* dyld interpose table entry (same mechanism libgmalloc etc. use). */
#define MURMUR_INTERPOSE(_replacement, _original)                       \
    __attribute__((used)) static struct {                               \
        const void *replacement;                                        \
        const void *original;                                           \
    } _interpose_##_original                                            \
        __attribute__((section("__DATA,__interpose"))) = {              \
            (const void *)(unsigned long)&_replacement,                 \
            (const void *)(unsigned long)&_original}

#define KEY_SIZE 32

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;

/* Open $MURMUR_KEYCAP_OUT for append, refusing symlinks. Returns -1 when the
 * env var is unset (shim stays inert) or the path can't be opened safely. */
static int keycap_open(void) {
    const char *path = getenv("MURMUR_KEYCAP_OUT");
    if (path == NULL || path[0] == '\0') {
        return -1;
    }
    return open(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0600);
}

static void hex_append(char *dst, const uint8_t *src, size_t n) {
    static const char *H = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        dst[2 * i] = H[(src[i] >> 4) & 0xF];
        dst[2 * i + 1] = H[src[i] & 0xF];
    }
    dst[2 * n] = '\0';
}

/* Append one newline-terminated record under the lock. */
static void keycap_write_line(const char *line, size_t len) {
    pthread_mutex_lock(&g_lock);
    int fd = keycap_open();
    if (fd >= 0) {
        ssize_t _ = write(fd, line, len);
        (void)_;
        close(fd);
    }
    pthread_mutex_unlock(&g_lock);
}

/* "key <hexkey>\n" — a 32-byte key seen by a CCCrypt* call. */
static void emit_key(const uint8_t *key) {
    char line[8 + 2 * KEY_SIZE + 2];
    size_t off = 0;
    memcpy(line, "key ", 4);
    off = 4;
    hex_append(line + off, key, KEY_SIZE);
    off += 2 * KEY_SIZE;
    line[off++] = '\n';
    keycap_write_line(line, off);
}

/* "pbkdf <prf> <rounds> <pwhex> <derivedhex>\n" — a PBKDF2 derivation.
 * The derived key is only known on return, so this is emitted from onLeave. */
static void emit_pbkdf(unsigned prf, unsigned rounds, const uint8_t *pw,
                       size_t pwlen, const uint8_t *dk, size_t dklen) {
    /* Cap the password we log so a bogus huge length can't blow the buffer. */
    if (pwlen > 1024) {
        return;
    }
    size_t cap = 64 + 2 * pwlen + 2 * dklen + 8;
    char *line = (char *)malloc(cap);
    if (line == NULL) {
        return;
    }
    int n = snprintf(line, cap, "pbkdf %u %u ", prf, rounds);
    if (n < 0 || (size_t)n >= cap) {
        free(line);
        return;
    }
    size_t off = (size_t)n;
    hex_append(line + off, pw, pwlen);
    off += 2 * pwlen;
    line[off++] = ' ';
    hex_append(line + off, dk, dklen);
    off += 2 * dklen;
    line[off++] = '\n';
    keycap_write_line(line, off);
    free(line);
}

/* ---- interposed CommonCrypto entry points ---------------------------- */

CCCryptorStatus murmur_CCCrypt(CCOperation op, CCAlgorithm alg,
                               CCOptions options, const void *key,
                               size_t keyLength, const void *iv,
                               const void *dataIn, size_t dataInLength,
                               void *dataOut, size_t dataOutAvailable,
                               size_t *dataOutMoved) {
    if (key != NULL && keyLength == KEY_SIZE) {
        emit_key((const uint8_t *)key);
    }
    return CCCrypt(op, alg, options, key, keyLength, iv, dataIn, dataInLength,
                   dataOut, dataOutAvailable, dataOutMoved);
}
MURMUR_INTERPOSE(murmur_CCCrypt, CCCrypt);

CCCryptorStatus murmur_CCCryptorCreate(CCOperation op, CCAlgorithm alg,
                                       CCOptions options, const void *key,
                                       size_t keyLength, const void *iv,
                                       CCCryptorRef *cryptorRef) {
    if (key != NULL && keyLength == KEY_SIZE) {
        emit_key((const uint8_t *)key);
    }
    return CCCryptorCreate(op, alg, options, key, keyLength, iv, cryptorRef);
}
MURMUR_INTERPOSE(murmur_CCCryptorCreate, CCCryptorCreate);

CCCryptorStatus murmur_CCCryptorCreateWithMode(
    CCOperation op, CCMode mode, CCAlgorithm alg, CCPadding padding,
    const void *iv, const void *key, size_t keyLength, const void *tweak,
    size_t tweakLength, int numRounds, CCModeOptions options,
    CCCryptorRef *cryptorRef) {
    if (key != NULL && keyLength == KEY_SIZE) {
        emit_key((const uint8_t *)key);
    }
    return CCCryptorCreateWithMode(op, mode, alg, padding, iv, key, keyLength,
                                   tweak, tweakLength, numRounds, options,
                                   cryptorRef);
}
MURMUR_INTERPOSE(murmur_CCCryptorCreateWithMode, CCCryptorCreateWithMode);

int murmur_CCKeyDerivationPBKDF(CCPBKDFAlgorithm algorithm,
                                const char *password, size_t passwordLen,
                                const uint8_t *salt, size_t saltLen,
                                CCPseudoRandomAlgorithm prf, unsigned rounds,
                                uint8_t *derivedKey, size_t derivedKeyLen) {
    int rc = CCKeyDerivationPBKDF(algorithm, password, passwordLen, salt,
                                  saltLen, prf, rounds, derivedKey,
                                  derivedKeyLen);
    /* Skip SQLCipher's 2-round HMAC-key derivation and absurd sizes — only
     * the account passphrase derivation (256000 rounds) matters. */
    if (rc == 0 && password != NULL && passwordLen > 0 && passwordLen <= 1024 &&
        rounds >= 1000 && derivedKey != NULL && derivedKeyLen == KEY_SIZE) {
        emit_pbkdf((unsigned)prf, rounds, (const uint8_t *)password, passwordLen,
                   derivedKey, derivedKeyLen);
    }
    return rc;
}
MURMUR_INTERPOSE(murmur_CCKeyDerivationPBKDF, CCKeyDerivationPBKDF);
