#!/bin/sh
# build_keycap.sh — compile the Murmur private-copy capture dylib.
#
# Produces a universal (arm64 + x86_64) ad-hoc-signed dylib that Murmur injects
# into its private WeChat copy via DYLD_INSERT_LIBRARIES (see cli/mac_private_copy.py).
# Run locally or in release CI (release-build.yml). The binary is NOT committed;
# the backend refuses the private-copy flow when it is missing.
#
# Usage: sh cli/native/build_keycap.sh [output.dylib]
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/murmur_keycap.c"
OUT="${1:-$HERE/murmur_keycap.dylib}"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "build_keycap.sh: macOS only (needs clang + CommonCrypto)" >&2
    exit 1
fi

clang -arch arm64 -arch x86_64 \
    -dynamiclib \
    -fvisibility=hidden \
    -O2 \
    -Wall -Wextra \
    -o "$OUT" \
    "$SRC"

# Ad-hoc sign so the re-signed copy (disable-library-validation) will load it.
codesign --force --sign - "$OUT"

echo "built $OUT"
