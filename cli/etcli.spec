# PyInstaller spec for the Murmur backend.
# Produces a single self-contained executable that works as:
#   etcli serve --port 9100
#   etcli --internal-script refresh
#   etcli --internal-script extract_key_mac --salts ... --out-keys ...
# The Tauri shell spawns this binary; no system Python required.
#
# Build:
#   cd cli && python3 -m PyInstaller etcli.spec --clean -y

# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path

cli_dir = Path('.').resolve()

a = Analysis(
    ['etcli_entry.py'],
    pathex=[str(cli_dir)],
    binaries=[],
    datas=[
        # Bundle the native/ dir (wx_key.dll / go_decrypt.dll / silk_v3_decoder.exe).
        # On Windows these are required for memory-key extraction + DLL-based decrypt.
        # On Mac they're harmless dead weight (~5 MB) — can comment out if size matters.
        ('native', 'native'),
    ],
    hiddenimports=[
        # Make sure all our companion modules are picked up (some are dynamically imported)
        'etcli', 'paths', 'refresh', 'decrypt_py',
        'extract_key_mac', 'extract_key_dll',
        'media', 'sns', 'voice', 'transcribe_voice',
        'thumb_index', 'decrypted_media_index',
        'extract_image_key_v2', 'extract_key',
        'batch_analyze',
        # cryptography backends needed at runtime
        'cryptography.hazmat.backends.openssl',
        'cryptography.hazmat.bindings.openssl.binding',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Aggressive size trim — these aren't used by the backend
        'tkinter', 'matplotlib', 'pytest', 'IPython', 'jupyter',
        'numpy.tests', 'pandas',
        # faster-whisper is heavy (~500 MB onnxruntime + tokenizers).
        # Only voice transcription needs it; ship without and add later if user wants.
        'faster_whisper', 'ctranslate2', 'tokenizers', 'onnxruntime',
        'av', 'huggingface_hub', 'transformers',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='etcli',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
