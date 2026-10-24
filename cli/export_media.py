"""export_media.py — copy a chat's images / videos next to an export file.

Used by exporters.export_to_dir() when the user picks a media policy:

    none       text only (default; this module isn't involved)
    originals  only already-decrypted full-size images + video files
    best       originals when available, otherwise fall back to thumbnails

How a message is tied to a file on disk (verified against WeChat 4.x data):

    image (type 3):  <img md5="X">  → hardlink.db image_hardlink_info_v4[md5=X].file_name
                     → decrypted copy written by `media.py decrypt-images` at
                       <media_root>/<scope>/<stem>{,_h,_t}.<ext>
    video (type 43): <videomsg md5="X"> → hardlink.db video_hardlink_info_v4[md5=X]
                     → <xwechat_files>/msg/video/<month>/<file_name> (+ <stem>_thumb.jpg)

Everything is read-only against WeChat's own dirs; files are only ever copied
into the export folder. Nothing here imports third-party packages.
"""
from __future__ import annotations

import hashlib
import re
import shutil
import sqlite3
from collections import Counter
from pathlib import Path
from typing import Optional

POLICIES = ("none", "originals", "best")

# Missing-reason codes → user-facing explanation (shown in the export report).
REASON_LABELS = {
    "no_media_ref": "消息里没有可识别的媒体标识（XML 缺失或无法解码）",
    "not_downloaded": "本机没有这个文件（没在微信里点开过，或已被微信清理）",
    "not_decrypted": "源文件在本机，但还没解密（先在 Murmur 里解密图片再导出）",
    "unsupported_format": "原图是微信私有的 wxgf 格式，暂不支持转码",
    "platform_unsupported": "当前平台（QQ）暂不支持导出媒体",
    "copy_failed": "复制文件失败",
}

_IMG_MD5_RE = re.compile(r'<img\b[^>]*?\bmd5\s*=\s*"([0-9a-fA-F]{32})"')
_VIDEO_MD5_RE = re.compile(r'<videomsg\b[^>]*?\bmd5\s*=\s*"([0-9a-fA-F]{32})"')

_IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic")
# Subdirs of <media_root> that media.py bulk_decrypt writes into (scope names).
_DECRYPTED_SCOPES = ("all", "images")

IMAGE_TYPE = 3
VIDEO_TYPE = 43
MEDIA_TYPES = (IMAGE_TYPE, VIDEO_TYPE)


def media_kind(msg_type: int) -> Optional[str]:
    if msg_type == IMAGE_TYPE:
        return "image"
    if msg_type == VIDEO_TYPE:
        return "video"
    return None


def extract_md5(kind: str, raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    rx = _IMG_MD5_RE if kind == "image" else _VIDEO_MD5_RE
    m = rx.search(raw)
    return m.group(1).lower() if m else None


class MediaResolver:
    """Maps (kind, md5) → (original path, thumbnail path, reason when no original).

    All roots are optional so tests can point it at a synthetic layout:
      decrypted_dir  — dir holding hardlink.db
      media_root     — Murmur's per-account media output (holds all/ images/)
      wechat_root    — xwechat_files/<wxid>/ (holds msg/attach, msg/video)
    """

    def __init__(self, decrypted_dir: Optional[Path] = None,
                 media_root: Optional[Path] = None,
                 wechat_root: Optional[Path] = None):
        self.decrypted_dir = Path(decrypted_dir) if decrypted_dir else None
        self.media_root = Path(media_root) if media_root else None
        self.wechat_root = Path(wechat_root) if wechat_root else None
        self._hl_loaded = False
        self._img_hl: dict[str, tuple[str, str, str]] = {}   # md5 → (file_name, dir1, dir2)
        self._vid_hl: dict[str, tuple[str, str]] = {}        # md5 → (file_name, month)
        self._decrypted: Optional[dict[str, list[Path]]] = None  # stem → files

    # ---- lazy indexes ----
    def _load_hardlinks(self) -> None:
        if self._hl_loaded:
            return
        self._hl_loaded = True
        if not self.decrypted_dir:
            return
        db = self.decrypted_dir / "hardlink.db"
        if not db.exists():
            return
        try:
            c = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
        except sqlite3.Error:
            return
        try:
            try:
                dir2id = {r[0]: r[1] for r in c.execute("SELECT rowid, username FROM dir2id")}
            except sqlite3.Error:
                dir2id = {}
            try:
                for md5, fname, d1, d2 in c.execute(
                        "SELECT md5, file_name, dir1, dir2 FROM image_hardlink_info_v4"):
                    if md5 and fname:
                        self._img_hl[str(md5).lower()] = (fname, dir2id.get(d1, ""), dir2id.get(d2, ""))
            except sqlite3.Error:
                pass
            try:
                for md5, fname, d1 in c.execute(
                        "SELECT md5, file_name, dir1 FROM video_hardlink_info_v4"):
                    if md5 and fname:
                        self._vid_hl[str(md5).lower()] = (fname, dir2id.get(d1, ""))
            except sqlite3.Error:
                pass
        finally:
            c.close()

    def _decrypted_index(self) -> dict[str, list[Path]]:
        if self._decrypted is None:
            idx: dict[str, list[Path]] = {}
            if self.media_root:
                for scope in _DECRYPTED_SCOPES:
                    d = self.media_root / scope
                    if not d.is_dir():
                        continue
                    for f in d.iterdir():
                        if f.is_file():
                            idx.setdefault(f.name.split(".", 1)[0], []).append(f)
            self._decrypted = idx
        return self._decrypted

    def _pick_decrypted(self, stem: str) -> tuple[Optional[Path], bool]:
        """Returns (usable image, saw_only_wxgf)."""
        files = self._decrypted_index().get(stem) or []
        usable = [f for f in files if f.suffix.lower() in _IMAGE_EXTS]
        if usable:
            return usable[0], False
        return None, any(f.suffix.lower() == ".wxgf" for f in files)

    # ---- resolution ----
    def resolve(self, kind: str, md5: Optional[str]) -> tuple[Optional[Path], Optional[Path], Optional[str]]:
        if not md5:
            return None, None, "no_media_ref"
        self._load_hardlinks()
        if kind == "image":
            return self._resolve_image(md5)
        if kind == "video":
            return self._resolve_video(md5)
        return None, None, "no_media_ref"

    def _resolve_image(self, md5: str):
        hl = self._img_hl.get(md5)
        stem = hl[0].rsplit(".", 1)[0] if hl else md5
        original = None
        wxgf = False
        for cand in (stem + "_h", stem):
            p, w = self._pick_decrypted(cand)
            wxgf = wxgf or w
            if p:
                original = p
                break
        thumb, _ = self._pick_decrypted(stem + "_t")
        if original:
            return original, thumb, None
        if wxgf:
            return None, thumb, "unsupported_format"
        if not hl:
            return None, thumb, "not_downloaded"
        fname, d1, d2 = hl
        if self.wechat_root and d1 and d2:
            src = self.wechat_root / "msg" / "attach" / d1 / d2 / "Img" / fname
            return None, thumb, ("not_decrypted" if src.exists() else "not_downloaded")
        return None, thumb, "not_decrypted"

    def _resolve_video(self, md5: str):
        hl = self._vid_hl.get(md5)
        if not hl or not self.wechat_root:
            return None, None, "not_downloaded"
        fname, month = hl
        base = self.wechat_root / "msg" / "video" / month if month else None
        if base is None:
            return None, None, "not_downloaded"
        original = base / fname
        thumb = base / (fname.rsplit(".", 1)[0] + "_thumb.jpg")
        thumb_p = thumb if thumb.is_file() else None
        if original.is_file():
            return original, thumb_p, None
        return None, thumb_p, "not_downloaded"


class MediaExporter:
    """Copies resolved media into <out_dir>/media/ and tallies the outcome."""

    def __init__(self, policy: str, out_dir: Path, resolver: Optional[MediaResolver],
                 platform_supported: bool = True):
        if policy not in POLICIES:
            raise ValueError(f"未知媒体策略: {policy} (支持 {' / '.join(POLICIES)})")
        self.policy = policy
        self.out_dir = Path(out_dir)
        self.media_dir = self.out_dir / "media"
        self.resolver = resolver
        self.platform_supported = platform_supported
        self.media_messages = 0
        self.exported = Counter()          # "original" / "thumbnail"
        self.missing = Counter()           # reason code → count
        self.missing_by_kind = Counter()   # "image" / "video" → count
        self.thumbnail_skipped = 0
        self._copied: dict[str, str] = {}  # src path → rel path

    @property
    def active(self) -> bool:
        return self.policy != "none"

    def handle(self, msg_type: int, raw: Optional[str]) -> Optional[str]:
        """Returns the export-relative path ("media/x.jpg") or None."""
        kind = media_kind(msg_type)
        if not self.active or kind is None:
            return None
        self.media_messages += 1
        if not self.platform_supported or self.resolver is None:
            return self._miss(kind, "platform_unsupported")
        md5 = extract_md5(kind, raw)
        original, thumb, reason = self.resolver.resolve(kind, md5)
        if original is not None:
            return self._copy(kind, original, "original", reason_on_fail="copy_failed")
        if self.policy == "best" and thumb is not None:
            return self._copy(kind, thumb, "thumbnail", reason_on_fail="copy_failed")
        if thumb is not None:
            # "originals" skipped a usable thumbnail — surfaced in the report
            # so the user knows "best" would recover it.
            self.thumbnail_skipped += 1
        return self._miss(kind, reason or "not_downloaded")

    def _miss(self, kind: str, reason: str) -> Optional[str]:
        self.missing[reason] += 1
        self.missing_by_kind[kind] += 1
        return None

    def _copy(self, kind: str, src: Path, tier: str, reason_on_fail: str) -> Optional[str]:
        key = str(src)
        if key in self._copied:
            self.exported[tier] += 1
            return self._copied[key]
        name = src.name
        # Keep names unique + stable even when two sources share a basename.
        dest = self.media_dir / name
        if dest.exists():
            h = hashlib.md5(key.encode("utf-8")).hexdigest()[:8]
            dest = self.media_dir / f"{src.stem}_{h}{src.suffix}"
        try:
            self.media_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
        except OSError:
            return self._miss(kind, reason_on_fail)
        rel = f"media/{dest.name}"
        self._copied[key] = rel
        self.exported[tier] += 1
        return rel

    def summary(self) -> dict:
        return {
            "policy": self.policy,
            "media_messages": self.media_messages,
            "exported_original": self.exported["original"],
            "exported_thumbnail": self.exported["thumbnail"],
            "exported_total": sum(self.exported.values()),
            "missing_total": sum(self.missing.values()),
            "missing_by_kind": dict(self.missing_by_kind),
            "missing_reasons": dict(self.missing.most_common()),
            "missing_reason_labels": {c: REASON_LABELS.get(c, c) for c in self.missing},
            "thumbnail_skipped": self.thumbnail_skipped,
        }


def resolver_for_store(store) -> Optional[MediaResolver]:
    """Build a resolver for the active WeChat store; None for QQ / unknown."""
    if type(store).__name__ == "QQStore":
        return None
    store_dir = Path(getattr(store, "dir", "") or ".")
    try:
        import paths as _paths
        profs = _paths.discover_wechat_profiles()
    except Exception:
        profs = []
    chosen = None
    try:
        target = store_dir.resolve()
    except OSError:
        target = store_dir
    for p in profs:
        try:
            d = _paths.decrypted_root_for(p, must_exist=True)
        except Exception:
            d = None
        if d is not None:
            try:
                if Path(d).resolve() == target:
                    chosen = p
                    break
            except OSError:
                continue
    if chosen is None:
        # Store dir is usually <...>/decrypted/<wxid_short>; match by name.
        for p in profs:
            if p.wxid_short == store_dir.name:
                chosen = p
                break
    if chosen is None:
        return MediaResolver(decrypted_dir=store_dir)
    return MediaResolver(
        decrypted_dir=store_dir,
        media_root=_paths.media_root_for(chosen),
        wechat_root=chosen.cache_root,
    )


def format_report_md(report: dict) -> str:
    """Short human-readable export report (written as 导出报告.md)."""
    lines = [
        "# Murmur 导出报告",
        "",
        f"- 对象：{report.get('name', '')}（{report.get('chat_id', '')}）",
        f"- 格式：{report.get('format', '')}",
        f"- 导出时间：{report.get('exported_at', '')}",
        f"- 消息：共 {report.get('messages', 0)} 条",
    ]
    media = report.get("media") or {}
    policy = media.get("policy", "none")
    policy_label = {"none": "不带附件", "originals": "仅原图", "best": "尽可能（原图优先，缺失时用缩略图）"}.get(policy, policy)
    lines.append(f"- 媒体策略：{policy_label}")
    if policy != "none":
        lines += [
            f"- 图片 / 视频消息：{media.get('media_messages', 0)} 条",
            f"- 附件导出成功：{media.get('exported_total', 0)} 个"
            f"（原图 / 原视频 {media.get('exported_original', 0)}，缩略图 {media.get('exported_thumbnail', 0)}）",
            f"- 附件缺失：{media.get('missing_total', 0)} 个",
        ]
        reasons = media.get("missing_reasons") or {}
        if reasons:
            lines += ["", "## 缺失原因", "", "| 原因 | 数量 |", "| --- | --- |"]
            for code, n in reasons.items():
                lines.append(f"| {REASON_LABELS.get(code, code)} | {n} |")
        if media.get("thumbnail_skipped"):
            lines += ["", f"其中 {media['thumbnail_skipped']} 个有缩略图，改用「尽可能」策略可以导出缩略图。"]
    lines += ["", "附件在同目录的 media/ 文件夹里，导出文件中用相对路径引用。", ""]
    return "\n".join(lines)
