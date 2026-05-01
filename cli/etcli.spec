# PyInstaller spec for Murmur etcli backend (Mac + Win)
#
# Build:    cd cli && python3 -m PyInstaller etcli.spec --clean -y
# Output:   cli/dist/etcli/etcli{.exe} + cli/dist/etcli/_internal/
#           Tauri picks the whole folder up via bundle.resources = ["etcli/**/*"]
#           (after `cp -R cli/dist/etcli app/src-tauri/etcli`).

block_cipher = None

import sys
from pathlib import Path

HERE = Path(SPECPATH)

# Bundle every file in cli/native/ as data → ends up at _internal/native/<file>
# (Win needs wx_key.dll / go_decrypt.dll; harmless dead weight on Mac.)
native_files = []
native_dir = HERE / "native"
if native_dir.is_dir():
    for f in native_dir.iterdir():
        if f.is_file():
            native_files.append((str(f), "native"))

a = Analysis(
    ["etcli.py"],
    pathex=[str(HERE)],
    binaries=[],
    datas=native_files,
    hiddenimports=[
        # Lazy-imported deps
        "zstandard",
        # Cross-platform decrypt (Mac path uses pure-Python via cryptography)
        "cryptography",
        "cryptography.hazmat",
        "cryptography.hazmat.primitives",
        "cryptography.hazmat.primitives.ciphers",
        "cryptography.hazmat.primitives.kdf",
        "cryptography.hazmat.primitives.kdf.pbkdf2",
        "cryptography.hazmat.primitives.hashes",
        "cryptography.hazmat.primitives.hmac",
        "cryptography.hazmat.backends",
        "cryptography.hazmat.backends.openssl",
        "cryptography.hazmat.bindings.openssl.binding",
        # Image decrypt (pycryptodome) — Win only at runtime but bundle on both
        "Crypto",
        "Crypto.Cipher",
        "Crypto.Cipher.AES",
        # All local cli/ modules — etcli.py imports some lazily (refresh on Win
        # via _spawn_etcli_args, extract_key_mac on Mac via osascript subprocess).
        "paths",
        "refresh",
        "extract_key_dll",
        "extract_key_mac",
        "extract_key",
        "extract_image_key_v2",
        "media",
        "sns",
        "voice",
        "thumb_index",
        "transcribe_voice",
        "decrypt_py",
        "decrypted_media_index",
        "batch_analyze",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Trim bundle size — these aren't used by the backend
        "tkinter", "matplotlib", "PIL", "scipy", "pandas",
        "pytest", "IPython", "jupyter",
        # faster_whisper is heavy (~500 MB onnxruntime + tokenizers).
        # Voice transcription is opt-in; users install it in their own env if needed.
        "faster_whisper", "ctranslate2", "tokenizers", "onnxruntime",
        "av", "huggingface_hub", "transformers",
        "torch", "torchaudio", "numpy",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="etcli",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Console enabled so Python errors are visible during dev.
    # In production, Tauri spawns with stdout/stderr piped to a log file (Mac)
    # or CREATE_NO_WINDOW (Win), so the user never sees the console.
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="etcli",
)
