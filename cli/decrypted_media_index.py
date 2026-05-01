"""decrypted_media_index.py — Index every PRE-DECRYPTED image/video WeChat has on disk.

Companion to media.py (which indexes encrypted .dat). This one finds ALREADY-DECRYPTED
content that the user has viewed/downloaded:

  • Image thumbs (cache/<YYYY-MM>/Message/<chat_md5>/Thumb/<id>_<ts>_thumb.jpg) — JPEG/PNG
  • Video files (msg/video/<YYYY-MM>/<file_md5>.mp4) — MP4
  • Video thumbs (msg/video/<YYYY-MM>/<file_md5>_thumb.jpg) — JPEG
  • Migrate files (msg/migrate/File/<YYYY-MM>/<hash>_t.gif) — JPEG (despite extension)

Output merges into ~/Documents/Murmur/media-index.json so existing /api/friend/<wxid>/media
endpoint serves them automatically.

Video binding to friends: video file paths don't include chat_md5, so we scan every
Msg_<table> for local_type=43 messages, parse <videomsg ... md5="..." />, and match
the md5 to a video file on disk → bind that video to that wxid.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import discover_wechat_profiles, decrypted_root_for, murmur_home  # noqa: E402


def build_md5_to_wxid(decrypted_root: Path) -> dict[str, str]:
    """chat_md5 → wxid via every contact + session username."""
    out: dict[str, str] = {}
    for db_name, table, col in [
        ("contact.db", "contact", "username"),
        ("session.db", "SessionTable", "username"),
    ]:
        p = decrypted_root / db_name
        if not p.exists():
            continue
        try:
            c = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True)
            for (u,) in c.execute(f"SELECT DISTINCT {col} FROM {table}"):
                if u:
                    out[hashlib.md5(u.encode()).hexdigest()] = u
            c.close()
        except Exception:
            pass
    return out


def build_video_md5_to_wxid(decrypted_root: Path) -> dict[str, str]:
    """For every video msg (local_type=43) in every Msg_<md5> table, parse the XML
    and extract the video's file MD5 → returns md5 → wxid map.
    """
    try:
        import zstandard as zstd
        dctx = zstd.ZstdDecompressor()
    except ImportError:
        dctx = None
    out: dict[str, str] = {}
    md5_to_wxid = build_md5_to_wxid(decrypted_root)

    msg_dbs = sorted(decrypted_root.glob("message_*.db"))
    msg_dbs = [p for p in msg_dbs if "_fts" not in p.name and "_resource" not in p.name and "biz_" not in p.name]

    for db in msg_dbs:
        try:
            c = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
            c.text_factory = bytes
            tables = [r[0].decode() if isinstance(r[0], bytes) else r[0]
                      for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")]
            for t in tables:
                chat_md5 = t[4:]
                wxid = md5_to_wxid.get(chat_md5)
                if not wxid:
                    continue
                try:
                    rows = c.execute(f"SELECT message_content FROM {t} WHERE local_type=43").fetchall()
                except Exception:
                    continue
                for (content,) in rows:
                    if not content:
                        continue
                    raw = content
                    # Try zstd decompress first (modern WeChat compresses XML)
                    if dctx and isinstance(raw, bytes) and raw.startswith(b"\x28\xb5\x2f\xfd"):
                        try:
                            raw = dctx.decompress(raw)
                        except Exception:
                            pass
                    s = raw if isinstance(raw, str) else raw.decode("utf-8", errors="replace")
                    # newmd5 is the local file's MD5 in WeChat 4.x
                    for m in re.finditer(r'md5="([a-f0-9]{32})"', s):
                        out[m.group(1)] = wxid
            c.close()
        except Exception as e:
            sys.stderr.write(f"[video-md5] {db.name}: {e}\n")

    return out


def build_index(profile_root: Path, decrypted_root: Path) -> dict:
    md5_to_wxid = build_md5_to_wxid(decrypted_root)
    print(f"[md5-map] {len(md5_to_wxid)} chat-md5 → wxid entries")

    video_md5_to_wxid = build_video_md5_to_wxid(decrypted_root)
    print(f"[video-md5] {len(video_md5_to_wxid)} videos bound to wxids via msg db")

    items: dict[str, dict] = {}  # content_md5 → record

    def add(file_md5: str, src: Path, kind: str, chat_md5: str | None,
             month: str = "", file_name: str | None = None):
        if file_md5 in items:
            return
        try:
            size = src.stat().st_size
        except OSError:
            return
        items[file_md5] = {
            "kind": kind,
            "chat_hash": chat_md5,
            "file_name": file_name or src.name,
            "month": month,
            "size": size,
            "source_path": str(src),
            "exists": True,
            "decrypted": True,           # marks: already a real file, no decryption needed
        }

    # 1) Cache image thumbs — bound by chat_md5 in path
    cache_root = profile_root / "cache"
    if cache_root.exists():
        n = 0
        for thumb in cache_root.rglob("Thumb/*_thumb.jpg"):
            try:
                month = thumb.parents[3].name  # cache/<month>/Message/<md5>/Thumb/file
                chat_md5 = thumb.parent.parent.name
                wxid = md5_to_wxid.get(chat_md5)
                # Use a hash of the path so each thumb has unique key
                file_md5 = hashlib.md5(str(thumb).encode()).hexdigest()
                add(file_md5, thumb, "image_thumb",
                     hashlib.md5(wxid.encode()).hexdigest() if wxid else None,
                     month=month)
                n += 1
            except Exception:
                continue
        print(f"[thumbs] cached image thumbs: {n}")

    # 2) Video files (.mp4) — bind via video_md5_to_wxid
    video_root = profile_root / "msg" / "video"
    if video_root.exists():
        n_v = n_t = 0
        for f in video_root.rglob("*"):
            if not f.is_file():
                continue
            stem = f.stem.replace("_thumb", "")
            wxid = video_md5_to_wxid.get(stem.lower())
            chat_hash = hashlib.md5(wxid.encode()).hexdigest() if wxid else None
            month = f.parent.name
            if f.suffix.lower() == ".mp4":
                add(hashlib.md5(str(f).encode()).hexdigest(), f, "video", chat_hash, month=month)
                n_v += 1
            elif f.name.endswith("_thumb.jpg"):
                add(hashlib.md5(str(f).encode()).hexdigest(), f, "video_thumb", chat_hash, month=month)
                n_t += 1
        print(f"[videos] mp4: {n_v}, video thumbs: {n_t}")

    # 3) Migrate jpgs (legacy)
    migrate_root = profile_root / "msg" / "migrate"
    if migrate_root.exists():
        n = 0
        for f in migrate_root.rglob("*"):
            if not f.is_file():
                continue
            try:
                # Read first 4 bytes to confirm it's a real image
                with open(f, "rb") as fh:
                    head = fh.read(4)
                is_jpeg = head[:3] == b"\xff\xd8\xff"
                is_png = head[:4] == b"\x89PNG"
                if not (is_jpeg or is_png):
                    continue
                month = f.parent.name
                add(hashlib.md5(str(f).encode()).hexdigest(), f, "image_thumb", None, month=month)
                n += 1
            except Exception:
                continue
        print(f"[migrate] decrypted images: {n}")

    return items


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=str(murmur_home() / "media-index.json"),
                    help="merged into existing media-index.json (or create new)")
    args = p.parse_args()

    profs = discover_wechat_profiles()
    if not profs:
        print("[X] no WeChat profile")
        return 1
    prof = profs[0]
    decrypted = decrypted_root_for(prof, must_exist=True)
    if not decrypted:
        print("[X] no decrypted db"); return 1

    new_items = build_index(prof.cache_root, decrypted)
    print(f"[total] new items: {len(new_items)}")

    out_path = Path(args.out)
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
        except Exception:
            existing = {}
    else:
        existing = {}

    # Merge: don't overwrite existing entries (encrypted .dat indexed by media.py).
    added = 0
    for k, v in new_items.items():
        if k not in existing:
            existing[k] = v
            added += 1
    out_path.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[merged] added {added} new entries to {out_path} (total now {len(existing)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
