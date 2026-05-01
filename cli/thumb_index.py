"""thumb_index.py — Index every already-decrypted image WeChat has cached on disk.

WeChat 4.x stores message attachments encrypted (.dat in `msg/attach/`), but ALSO
keeps the **thumbnails** as real JPEG/PNG when the user has viewed an image. The
thumbs sit at:

  xwechat_files/<wxid>/cache/<YYYY-MM>/Message/<chat_md5>/Thumb/<msg_local_id>_<ts>_thumb.jpg
  xwechat_files/<wxid>/msg/video/<YYYY-MM>/<hash>_thumb.jpg                 (video covers)
  xwechat_files/<wxid>/msg/video/<YYYY-MM>/<hash>.mp4                       (video files)
  xwechat_files/<wxid>/msg/file/<YYYY-MM>/...                               (saved files)

`chat_md5` is `md5(wxid_or_chatroom)`, same hash used for the Msg_<md5> tables.
We build a reverse-lookup: chat_md5 → wxid, then walk every Thumb/ dir and tie
each thumbnail to (wxid, msg_local_id).

Output: ~/Documents/Murmur/thumb-index.json
        { "<wxid_or_chatroom>": {
              "thumbs": [{path, ts, msg_id, kind: 'image'|'video'}, ...],
              "videos": [{path, ts, name}, ...],
              "files":  [{path, ts, name, ext}, ...],
            }, ...
        }
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import discover_wechat_profiles, murmur_home  # noqa: E402


def _md5_to_wxid(contacts_db: Path, sessions_db: Path) -> dict[str, str]:
    """Build chat_md5 → wxid map from every wxid in contact + session tables."""
    import sqlite3
    out: dict[str, str] = {}

    def collect(db: Path, table: str, col: str):
        try:
            c = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
            for (u,) in c.execute(f"SELECT DISTINCT {col} FROM {table}"):
                if u:
                    out[hashlib.md5(u.encode()).hexdigest()] = u
            c.close()
        except Exception:
            pass

    collect(contacts_db, "contact", "username")
    collect(sessions_db, "SessionTable", "username")
    return out


def build_index(decrypted_root: Path, profile_root: Path) -> dict:
    """Scan profile_root (raw xwechat_files dir) + decrypted_root (for hash map)."""
    contacts_db = decrypted_root / "contact.db"
    sessions_db = decrypted_root / "session.db"
    if not contacts_db.exists() or not sessions_db.exists():
        raise FileNotFoundError("contact.db / session.db missing — run decrypt first")

    md5_to_wxid = _md5_to_wxid(contacts_db, sessions_db)
    print(f"[index] {len(md5_to_wxid)} wxids in contact/session tables")

    index: dict[str, dict] = {}

    def add(wxid: str, kind: str, entry: dict):
        if wxid not in index:
            index[wxid] = {"thumbs": [], "videos": [], "files": []}
        index[wxid][kind].append(entry)

    # ---- Pattern 1: cache/<YYYY-MM>/Message/<chat_md5>/Thumb/<id>_<ts>_thumb.jpg ----
    cache_root = profile_root / "cache"
    if cache_root.exists():
        n_thumb = 0
        for thumb in cache_root.rglob("Thumb/*_thumb.jpg"):
            try:
                # Walk path to find the chat_md5 (parent of "Thumb")
                parent = thumb.parent.parent
                chat_md5 = parent.name
                wxid = md5_to_wxid.get(chat_md5)
                if not wxid:
                    continue
                m = re.match(r"^(\d+)_(\d+)_thumb", thumb.stem)
                msg_id = int(m.group(1)) if m else 0
                ts = int(m.group(2)) if m else 0
                add(wxid, "thumbs", {
                    "path": str(thumb),
                    "ts": ts,
                    "msg_id": msg_id,
                    "kind": "image",
                    "size": thumb.stat().st_size,
                })
                n_thumb += 1
            except Exception:
                continue
        print(f"[index] cached thumbs: {n_thumb}")

    # ---- Pattern 2: msg/video/<YYYY-MM>/<hash>.mp4 + <hash>_thumb.jpg ----
    video_root = profile_root / "msg" / "video"
    if video_root.exists():
        n_video = n_vthumb = 0
        for f in video_root.rglob("*"):
            if not f.is_file():
                continue
            if f.suffix.lower() == ".mp4":
                # Video file — no per-friend mapping (no chat_md5 in path), skip wxid binding
                # Save under "_unbound" bucket
                add("_unbound", "videos", {
                    "path": str(f), "ts": int(f.stat().st_mtime),
                    "name": f.name, "size": f.stat().st_size,
                })
                n_video += 1
            elif f.name.endswith("_thumb.jpg"):
                add("_unbound", "thumbs", {
                    "path": str(f), "ts": int(f.stat().st_mtime),
                    "msg_id": 0, "kind": "video_thumb",
                    "size": f.stat().st_size,
                })
                n_vthumb += 1
        print(f"[index] video files: {n_video}, video thumbs: {n_vthumb}")

    # ---- Pattern 3: msg/file/<YYYY-MM>/* — saved files (when user clicked Save) ----
    file_root = profile_root / "msg" / "file"
    if file_root.exists():
        n_file = 0
        for f in file_root.rglob("*"):
            if not f.is_file():
                continue
            ext = f.suffix.lower().lstrip(".")
            add("_unbound", "files", {
                "path": str(f), "ts": int(f.stat().st_mtime),
                "name": f.name, "ext": ext, "size": f.stat().st_size,
            })
            n_file += 1
        print(f"[index] saved files: {n_file}")

    # Sort each bucket
    for wxid, buckets in index.items():
        for k in ("thumbs", "videos", "files"):
            if k in buckets:
                buckets[k].sort(key=lambda e: e.get("ts", 0))

    summary = {
        "wxids_with_thumbs": sum(1 for b in index.values() if b.get("thumbs")),
        "total_thumbs": sum(len(b.get("thumbs", [])) for b in index.values()),
        "total_videos": sum(len(b.get("videos", [])) for b in index.values()),
        "total_files": sum(len(b.get("files", [])) for b in index.values()),
    }
    print(f"[index] summary: {summary}")
    return {"summary": summary, "by_wxid": index}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=str(murmur_home() / "thumb-index.json"))
    args = p.parse_args()

    profs = discover_wechat_profiles()
    if not profs:
        print("[X] no WeChat profile found")
        return 1
    prof = profs[0]

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from paths import decrypted_root_for
    decrypted = decrypted_root_for(prof, must_exist=True)
    if not decrypted:
        print("[X] no decrypted db found")
        return 1

    idx = build_index(decrypted, prof.cache_root)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(idx, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[index] wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
