"""Entrypoint for PyInstaller-built etcli binary.

PyInstaller's single-file mode unpacks resources to a temp dir and sets
sys._MEIPASS. We just delegate to etcli.main(...) but ensure subprocesses
launched from etcli (refresh.py, extract_key_mac.py) can still find their
companion .py files by adding the unpacked dir to PATH and PYTHONPATH.

The bundled binary supports the same CLI as `python3 etcli.py`:
    etcli serve --port 9100
    etcli info
    etcli contacts
    ...

When refresh.py / extract_key_mac.py need to be re-invoked, etcli.py uses
sys.executable. In PyInstaller mode that points to the bundled binary, so
the helpers run as `<binary> --internal-script <name>`. We dispatch
those at the very top of this entry.
"""
import os
import sys
from pathlib import Path


def _internal_dispatch():
    """Allow `etcli --internal-script refresh` etc. to invoke companion modules.

    PyInstaller unpacks them to sys._MEIPASS at runtime; we just import + call.
    """
    if len(sys.argv) >= 3 and sys.argv[1] == "--internal-script":
        script_name = sys.argv[2]
        sys.argv = [script_name] + sys.argv[3:]
        if script_name == "refresh":
            import refresh  # noqa: E402
            sys.exit(refresh.main())
        if script_name == "extract_key_mac":
            import extract_key_mac  # noqa: E402
            sys.exit(extract_key_mac.main())
        if script_name == "extract_key_dll":
            import extract_key_dll  # noqa: E402
            sys.exit(extract_key_dll.main() if hasattr(extract_key_dll, "main") else 0)
        if script_name == "batch_analyze":
            import batch_analyze  # noqa: E402
            sys.exit(batch_analyze.main() if hasattr(batch_analyze, "main") else 0)
        sys.stderr.write(f"unknown internal script: {script_name}\n")
        sys.exit(1)


_internal_dispatch()


# Default path: behave exactly like `python etcli.py <args>`
import etcli  # noqa: E402

if __name__ == "__main__":
    etcli.main()
