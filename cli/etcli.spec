# PyInstaller spec for Murmur etcli backend
# Build: pyinstaller etcli.spec
# Output: dist/etcli/etcli.exe + dist/etcli/_internal/

block_cipher = None

import sys
from pathlib import Path

# Path resolution
HERE = Path(SPECPATH)

# Bundle native/ DLLs as data
native_files = []
native_dir = HERE / "native"
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
        # Cross-platform decrypt fallback (Mac mostly, but bundled for completeness)
        "cryptography",
        "cryptography.hazmat",
        "cryptography.hazmat.primitives",
        "cryptography.hazmat.primitives.ciphers",
        "cryptography.hazmat.primitives.kdf",
        "cryptography.hazmat.primitives.kdf.pbkdf2",
        "cryptography.hazmat.primitives.hashes",
        "cryptography.hazmat.primitives.hmac",
        "cryptography.hazmat.backends",
        # Image decrypt deps (pycryptodome)
        "Crypto",
        "Crypto.Cipher",
        "Crypto.Cipher.AES",
        # Local cli/ modules — explicit so PyInstaller doesn't miss them
        "paths",
        "refresh",
        "extract_key_dll",
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
        # Keep bundle smaller: don't pull these heavy optional deps unless used
        "tkinter",
        "matplotlib",
        "PIL",
        "scipy",
        "pandas",
        # faster_whisper IS optional. If user wants voice transcription, they install it
        # in their own environment and run transcribe_voice.py separately.
        "faster_whisper",
        "torch",
        "torchaudio",
        "numpy",
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
    console=True,        # Console enabled so we can see Python errors during dev. Tauri spawns with CREATE_NO_WINDOW so user never sees the console.
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
