"""exporters.py — 把单个朋友/群的聊天导出为 JSON / HTML / TXT / CSV / Markdown / ChatLab。

单聊导出先把消息整理成统一的 record 列表（collect_records），再交给各格式的
writer。媒体策略（none / originals / best）见 export_media.py：选了带附件时
走 export_to_dir()，把聊天文件、media/ 附件目录和 导出报告.md 写进一个文件夹。

HTTP 路由由 etcli.py 的 /api/export?wxid=&format=&media= 调用；命令行入口便于测试：

    python exporters.py json    --wxid wxid_xxx > out.json
    python exporters.py csv     --wxid wxid_xxx --out out.csv
    python exporters.py chatlab --wxid wxid_xxx --media best --dir ~/Desktop/导出
"""
from __future__ import annotations

import argparse
import csv
import html as _html
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import IO, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

CST = timezone(timedelta(hours=8))


def _fmt_ts(ts: int) -> str:
    try:
        return datetime.fromtimestamp(int(ts), CST).strftime("%Y-%m-%d %H:%M:%S")
    except (OSError, ValueError, OverflowError):
        return ""


def _default_store():
    """CLI fallback: first WeChat profile. The HTTP server always passes its
    active store instead (multi-account / QQ — issue #11)."""
    from etcli import EchoStore  # noqa: E402  (lazy: avoid circular import)
    from paths import discover_wechat_profiles, decrypted_root_for  # noqa: E402

    profs = discover_wechat_profiles()
    if not profs:
        raise SystemExit("找不到微信账号数据。")
    profile = profs[0]
    decrypted = decrypted_root_for(profile, must_exist=True)
    if not decrypted:
        raise SystemExit("没有已解密的数据库 — 请先运行 refresh.py 解密")
    return EchoStore(decrypted)


_HTML_HEADER = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{
  --bg: #f5f3ec; --fg: #1a2b4a; --mute: #6b7a99; --line: rgba(26,43,74,.08);
  --bubble-self: #FF6B47; --bubble-other: #fff; --bubble-self-fg: #fff;
}}
body {{ background: var(--bg); color: var(--fg); font-family: -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; margin: 0; padding: 24px 14px; }}
.wrap {{ max-width: 760px; margin: 0 auto; }}
header {{ padding: 20px 22px; background: #fff; border: 0.5px solid var(--line); border-radius: 12px; margin-bottom: 18px; }}
header h1 {{ margin: 0 0 4px; font-size: 18px; font-weight: 600; }}
header .meta {{ font-size: 12px; color: var(--mute); }}
.msg {{ display: flex; margin: 10px 0; }}
.msg .body {{ max-width: 70%; padding: 8px 12px; border-radius: 12px; font-size: 14px; line-height: 1.5; word-break: break-word; white-space: pre-wrap; }}
.msg.self {{ justify-content: flex-end; }}
.msg.self .body {{ background: var(--bubble-self); color: var(--bubble-self-fg); }}
.msg.other .body {{ background: var(--bubble-other); border: 0.5px solid var(--line); }}
.msg .meta {{ font-size: 11px; color: var(--mute); margin: 2px 4px; align-self: flex-end; }}
.msg.self .meta {{ order: -1; }}
.msg .body.media {{ padding: 4px; background: transparent; border: none; }}
.msg .body.media img, .msg .body.media video {{ display: block; max-width: 100%; max-height: 360px; border-radius: 10px; }}
.day {{ text-align: center; margin: 22px 0 6px; font-size: 11px; color: var(--mute); }}
footer {{ margin-top: 30px; text-align: center; color: var(--mute); font-size: 11px; }}
</style></head><body><div class="wrap">
<header>
  <h1>与 {title} 的聊天记录</h1>
  <div class="meta">{wxid} · 导出于 {when}</div>
</header>
"""

_HTML_FOOTER = """<footer>本文件由 Murmur 离线导出，仅存储于本地。</footer></div></body></html>"""


@dataclass
class ChatMeta:
    chat_id: str
    name: str
    is_group: bool
    platform: str      # "wechat" | "qq"
    self_id: str       # platform id of the account owner ("self" when unknown)
    self_name: str


def _platform_of(store) -> str:
    return "qq" if type(store).__name__ == "QQStore" else "wechat"


def chat_meta(store, wxid: str) -> ChatMeta:
    contact = None
    try:
        contact = store.contact(wxid)
    except Exception:
        contact = None
    name = contact.display() if contact else wxid
    me = getattr(store, "me", None) or "self"
    self_name = "我"
    try:
        sc = store.contact(me) if me != "self" else None
        if sc and sc.display() and sc.display() != me:
            self_name = sc.display()
    except Exception:
        pass
    return ChatMeta(
        chat_id=wxid,
        name=name,
        is_group=wxid.endswith("@chatroom"),
        platform=_platform_of(store),
        self_id=me,
        self_name=self_name,
    )


def _iter_messages(store, wxid: str):
    """store.messages() with raw XML when the store supports it (EchoStore)."""
    try:
        return store.messages(wxid, text_only=False, with_raw=True)
    except TypeError:
        # QQStore / older stores don't take with_raw.
        return store.messages(wxid, text_only=False)


_APPMSG_SUBTYPE_RE = re.compile(r"<appmsg\b.*?<type>\s*(\d+)\s*</type>", re.S)
_REFERMSG_RE = re.compile(r"<refermsg>.*?</refermsg>", re.S)

# WeChat msg_type → ChatLab standard message type (docs/cn/standard/chatlab-format.md v0.0.2)
_CHATLAB_BASE_TYPES = {
    1: 0,       # TEXT
    3: 1,       # IMAGE
    34: 2,      # VOICE
    43: 3,      # VIDEO
    47: 5,      # EMOJI
    48: 8,      # LOCATION
    42: 27,     # CONTACT (名片)
    50: 23,     # CALL
    62: 3,      # short video
    10000: 80,  # SYSTEM
    10002: 81,  # RECALL (revoke)
}
# <appmsg><type>N</type> sub-types → ChatLab types
_CHATLAB_APPMSG_TYPES = {
    "5": 7, "4": 7, "24": 7,            # LINK (link / note)
    "6": 4,                              # FILE
    "8": 5,                              # EMOJI
    "15": 26, "19": 26, "40": 26,        # FORWARD (聊天记录)
    "17": 8, "74": 8,                    # LOCATION
    "3": 24, "63": 24, "76": 24,         # SHARE (music)
    "33": 24, "36": 24, "51": 24,        # SHARE (mini program / channels)
    "57": 25,                            # REPLY (引用)
    "62": 22,                            # POKE (拍一拍)
    "2000": 21,                          # TRANSFER
    "2001": 20,                          # RED_PACKET
}


def appmsg_subtype(msg_type: int, raw: Optional[str]) -> Optional[str]:
    """`<appmsg><type>` value, or None when msg_type isn't an appmsg.

    WeChat 4.x packs the sub-type into the high 32 bits of local_type
    ((sub << 32) | 49, e.g. 21474836529 = link); legacy rows use plain 49
    and carry the sub-type only in the XML.
    """
    if msg_type > 0xFFFFFFFF and (msg_type & 0xFFFFFFFF) == 49:
        return str(msg_type >> 32)
    if msg_type == 49 or msg_type in _APPMSG_LARGEINT:
        body = _REFERMSG_RE.sub("", raw or "")
        m = _APPMSG_SUBTYPE_RE.search(body)
        return m.group(1) if m else ""
    return None


def chatlab_type(msg_type: int, raw: Optional[str], text: str) -> int:
    sub = appmsg_subtype(msg_type, raw)
    if sub is not None:
        if sub:
            return _CHATLAB_APPMSG_TYPES.get(sub, 99)
        return 7 if (text or "").startswith("[链接") else 99
    if msg_type == 10000 and "拍了拍" in (text or ""):
        return 22
    return _CHATLAB_BASE_TYPES.get(msg_type, 99)


_APPMSG_LARGEINT = {244813135921, 8589934592049, 8594229559345}
_GROUP_PREFIX_RE = re.compile(r"^[^\s:]+:\n")


def collect_records(store, wxid: str, media=None) -> list[dict]:
    """Materialize the chat into plain records every writer consumes.

    `media` is an export_media.MediaExporter (or None for text-only). Records
    carry `media` = export-relative path when an attachment was copied.
    """
    out: list[dict] = []
    for m in _iter_messages(store, wxid):
        raw = getattr(m, "raw", None)
        rel = media.handle(m.msg_type, raw) if media is not None else None
        text = m.text or ""
        label = m.raw_type_label
        if label.startswith("type_") and appmsg_subtype(m.msg_type, raw) is not None:
            label = "share"  # 4.x packed appmsg types have no MSG_TYPES entry
        if m.msg_type == 10000 and raw and not raw.lstrip().startswith("<"):
            # System notices ("你已添加了…", "拍了拍") are plain text; the
            # store only gives a "[system]" stub, so prefer the real body.
            text = _GROUP_PREFIX_RE.sub("", raw, count=1).strip() or text
        out.append({
            "ts": int(m.create_time),
            "time": _fmt_ts(m.create_time),
            "from_id": m.sender_wxid,
            "from": m.sender_name or m.sender_wxid,
            "type": label,
            "type_id": m.msg_type,
            "text": text,
            "media": rel,
            "chatlab_type": chatlab_type(m.msg_type, raw, text),
        })
    return out


def _display_text(r: dict) -> str:
    return r["text"] or f"[{r['type']}]"


# ---------- writers ----------

def write_json(meta: ChatMeta, records: list[dict], out: IO) -> int:
    """Stream-write a JSON document (format_version 1, unchanged shape + optional media)."""
    out.write(f'{{"wxid":{json.dumps(meta.chat_id, ensure_ascii=False)},')
    out.write(f'"name":{json.dumps(meta.name, ensure_ascii=False)},')
    out.write('"format_version":1,"messages":[')
    for i, r in enumerate(records):
        rec = {
            "ts": r["ts"], "time": r["time"],
            "from_id": r["from_id"], "from": r["from"],
            "type": r["type"], "type_id": r["type_id"], "text": r["text"],
        }
        if r.get("media"):
            rec["media"] = r["media"]
        if i:
            out.write(",")
        out.write(json.dumps(rec, ensure_ascii=False))
    out.write("]}")
    return len(records)


def write_txt(meta: ChatMeta, records: list[dict], out: IO) -> int:
    """Plain-text chat log. One message per line — readable on any device."""
    out.write(f"=== 与 {meta.name} 的聊天记录 ({meta.chat_id}) ===\n")
    out.write(f"导出时间: {_fmt_ts(int(datetime.now(CST).timestamp()))}\n\n")
    for r in records:
        lines = _display_text(r).split("\n")
        tail = f"  ({r['media']})" if r.get("media") else ""
        out.write(f"[{r['time']}] {r['from']}: {lines[0]}{tail if len(lines) == 1 else ''}\n")
        for ln in lines[1:]:
            out.write(f"    {ln}\n")
        if tail and len(lines) > 1:
            out.write(f"    {tail.strip()}\n")
    return len(records)


CSV_COLUMNS = ["time", "timestamp", "sender_id", "sender", "type", "text", "media"]
# Excel treats a leading = / @ (and + / - followed by formula syntax) as a
# formula. Prefix those cells with an apostrophe so a hostile message can't
# execute when the CSV is opened (OWASP "CSV injection").
_CSV_FORMULA_RE = re.compile(r"^[=@\t\r]|^[+\-].*[(!|]", re.S)


def _csv_cell(v) -> str:
    s = "" if v is None else str(v)
    if s and _CSV_FORMULA_RE.match(s):
        return "'" + s
    return s


def write_csv(meta: ChatMeta, records: list[dict], out: IO) -> int:
    """UTF-8 CSV with BOM so Excel opens Chinese correctly. RFC 4180 quoting."""
    out.write("﻿")
    w = csv.writer(out, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    w.writerow(CSV_COLUMNS)
    for r in records:
        w.writerow([_csv_cell(x) for x in (
            r["time"], r["ts"], r["from_id"], r["from"], r["type"], r["text"], r.get("media") or "",
        )])
    return len(records)


_MD_BLOCK_START = re.compile(r"^(\s*)([#>*+\-|]|\d+[.)]|```|~~~)")


# `![alt](url)` / `![alt][ref]` in message text would make a Markdown viewer
# fetch a remote image (read-tracking pixel). `!\[` renders as a literal
# "![" and is neither an image nor a link.
_MD_IMAGE_RE = re.compile(r"!(?=\[)")


def neutralize_md_images(text: str) -> str:
    return _MD_IMAGE_RE.sub(lambda m: "!\\", text)


def _md_escape_line(line: str) -> str:
    line = neutralize_md_images(line.replace("<", "&lt;"))
    m = _MD_BLOCK_START.match(line)
    if m:
        line = line[:m.end(1)] + "\\" + line[m.end(1):]
    return line


def _md_media(r: dict) -> str:
    rel = r.get("media")
    if not rel:
        return ""
    if r["type_id"] == 3 or rel.lower().endswith((".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp")):
        return f"![图片](<{rel}>)"
    return f"[视频](<{rel}>)"


_PLACEHOLDER_RE = re.compile(r"^\[[^\]\n]{1,12}\]$")


def write_md(meta: ChatMeta, records: list[dict], out: IO) -> int:
    """Markdown: H1 title, one H2 per day, `**sender** · HH:MM` then the body."""
    out.write(f"# 与 {_md_escape_line(meta.name)} 的聊天记录\n\n")
    out.write(f"> {meta.chat_id} · 导出于 {_fmt_ts(int(datetime.now(CST).timestamp()))} · 共 {len(records)} 条\n")
    last_day = None
    for r in records:
        day = r["time"][:10]
        if day != last_day:
            out.write(f"\n## {day}\n")
            last_day = day
        sender = _md_escape_line(r["from"]).replace("*", "\\*")
        out.write(f"\n**{sender}** · {r['time'][11:16]}\n\n")
        media = _md_media(r)
        # A bare "[image]" placeholder adds nothing next to the embedded file.
        placeholder = not r["text"] or _PLACEHOLDER_RE.match(r["text"]) is not None
        body_lines = [] if (media and placeholder) else _display_text(r).split("\n")
        for ln in body_lines:
            out.write(_md_escape_line(ln) + "  \n" if ln else "\n")
        if media:
            out.write(media + "\n")
    out.write("\n---\n\n*本文件由 Murmur 离线导出，仅存储于本地。*\n")
    return len(records)


def write_html(meta: ChatMeta, records: list[dict], out: IO) -> int:
    out.write(_HTML_HEADER.format(
        title=_html.escape(meta.name),
        wxid=_html.escape(meta.chat_id),
        when=_fmt_ts(int(datetime.now(CST).timestamp())),
    ))
    last_day: Optional[str] = None
    for r in records:
        day = r["time"][:10]
        if day != last_day:
            out.write(f'<div class="day">— {_html.escape(day)} —</div>\n')
            last_day = day
        is_self = (r["from_id"] == "self")
        cls = "self" if is_self else "other"
        sender_label = "" if is_self else _html.escape(r["from"])
        rel = r.get("media")
        if rel and r["type_id"] == 43:
            body = f'<video controls preload="none" src="{_html.escape(rel)}"></video>'
        elif rel:
            body = f'<a href="{_html.escape(rel)}"><img loading="lazy" src="{_html.escape(rel)}" alt=""></a>'
        else:
            body = _html.escape(_display_text(r))
        out.write(
            f'<div class="msg {cls}">'
            f'<div class="meta">{sender_label} {r["time"][11:16]}</div>'
            f'<div class="body{" media" if rel else ""}">{body}</div>'
            '</div>\n'
        )
    out.write(_HTML_FOOTER)
    return len(records)


CHATLAB_VERSION = "0.0.2"


def chatlab_payload(meta: ChatMeta, records: list[dict]) -> dict:
    """Build a ChatLab standard document (JSON flavour, spec v0.0.2).

    Spec: https://github.com/ChatLab/ChatLab/blob/main/docs/cn/standard/chatlab-format.md
    Only fields defined by the spec are emitted. Murmur's "self" sentinel is
    mapped to the account's real platform id so `sender` always references a
    member.
    """
    def pid(sender_id: str) -> str:
        return meta.self_id if sender_id == "self" else sender_id

    members: dict[str, dict] = {}
    if not meta.is_group:
        members[meta.self_id] = {"platformId": meta.self_id, "accountName": meta.self_name}
        members[meta.chat_id] = {"platformId": meta.chat_id, "accountName": meta.name}
    messages = []
    for r in records:
        sid = pid(r["from_id"]) or "unknown"
        name = meta.self_name if r["from_id"] == "self" else (r["from"] or sid)
        if sid not in members:
            members[sid] = {"platformId": sid, "accountName": name}
        ctype = int(r["chatlab_type"])
        content: Optional[str] = r["text"] if r["text"] else None
        messages.append({
            "sender": sid,
            "accountName": members[sid]["accountName"],
            "timestamp": int(r["ts"]),
            "type": ctype,
            "content": content,
        })
    chat_meta_obj = {
        "name": meta.name,
        "platform": meta.platform,
        "type": "group" if meta.is_group else "private",
    }
    if meta.is_group:
        chat_meta_obj["groupId"] = meta.chat_id
    if meta.self_id and meta.self_id != "self":
        chat_meta_obj["ownerId"] = meta.self_id
    return {
        "chatlab": {
            "version": CHATLAB_VERSION,
            "exportedAt": int(datetime.now(CST).timestamp()),
            "generator": "Murmur",
        },
        "meta": chat_meta_obj,
        "members": list(members.values()),
        "messages": messages,
    }


def write_chatlab(meta: ChatMeta, records: list[dict], out: IO) -> int:
    out.write(json.dumps(chatlab_payload(meta, records), ensure_ascii=False))
    return len(records)


# fmt → (writer, content type, file extension)
_FORMATS = {
    "json": (write_json, "application/json", "json"),
    "txt": (write_txt, "text/plain; charset=utf-8", "txt"),
    "html": (write_html, "text/html; charset=utf-8", "html"),
    "csv": (write_csv, "text/csv; charset=utf-8", "csv"),
    "md": (write_md, "text/markdown; charset=utf-8", "md"),
    "chatlab": (write_chatlab, "application/json", "chatlab.json"),
}
FORMATS = tuple(_FORMATS)


def export_json(wxid: str, out: IO) -> int:
    return write_export(wxid, "json", out)


def export_txt(wxid: str, out: IO) -> int:
    return write_export(wxid, "txt", out)


def export_html(wxid: str, out: IO) -> int:
    return write_export(wxid, "html", out)


def _safe_name(s: str, limit: int = 40) -> str:
    keep = "".join(ch for ch in s if ch.isalnum() or ch in "._-")
    return keep[:limit] or "chat"


def export_to_dir(store, wxid: str, fmt: str, media_policy: str, base_dir: Path,
                  resolver=None, now: Optional[datetime] = None) -> dict:
    """Write <base_dir>/<name>_<ts>/{murmur_<id>.<ext>, media/, 导出报告.md}.

    Returns the report dict (also embedded in 导出报告.md). `resolver` defaults
    to the active WeChat account's media layout; QQ has no media support yet.
    """
    if fmt not in _FORMATS:
        raise ValueError(f"未知格式: {fmt} (支持 {' / '.join(FORMATS)})")
    from export_media import MediaExporter, resolver_for_store, format_report_md, POLICIES
    if media_policy not in POLICIES:
        raise ValueError(f"未知媒体策略: {media_policy} (支持 {' / '.join(POLICIES)})")
    meta = chat_meta(store, wxid)
    stamp = (now or datetime.now(CST)).strftime("%Y%m%d_%H%M%S")
    out_dir = Path(base_dir) / f"{_safe_name(meta.name, 30)}_{_safe_name(wxid, 30)}_{stamp}"
    out_dir.mkdir(parents=True, exist_ok=True)
    platform_ok = meta.platform == "wechat"
    if resolver is None and platform_ok and media_policy != "none":
        resolver = resolver_for_store(store)
    media = MediaExporter(media_policy, out_dir, resolver, platform_supported=platform_ok)
    records = collect_records(store, wxid, media)
    writer, _, ext = _FORMATS[fmt]
    chat_file = out_dir / f"murmur_{_safe_name(wxid, 60)}.{ext}"
    with open(chat_file, "w", encoding="utf-8", newline="") as f:
        n = writer(meta, records, f)
    report = {
        "ok": True,
        "chat_id": wxid,
        "name": meta.name,
        "format": fmt,
        "messages": n,
        "exported_at": _fmt_ts(int((now or datetime.now(CST)).timestamp())),
        "dir": str(out_dir),
        "file": str(chat_file),
        "media": media.summary(),
    }
    report_file = out_dir / "导出报告.md"
    report_file.write_text(format_report_md(report), encoding="utf-8")
    report["report_file"] = str(report_file)
    return report


# ---------- Pair export (issue #10) ----------
#
# Murmur's signature: pair-relationship inference between two friends. The
# data lives in build_pair_inference_pack — direct evidence, mentions, group
# co-presence, individual chat samples — already shaped for AI consumption.
# We surface the same payload as JSON / HTML / Markdown(=TXT) so users can
# either feed it to an LLM or just keep an offline archive of "how A and B
# know each other from my vantage point".

def _pair_meta(wxid_a: str, wxid_b: str, store_dir: Path | None = None):
    """Locate stores + names for a pair. Raises if the pair has no direct evidence.

    `store_dir` lets the HTTP handler hand the already-resolved active-account
    decrypted dir directly, instead of letting us re-discover (which used to
    blindly grab profiles[0] and break for users with multi-account or QQ-active
    sessions — issue #11).
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from etcli import EchoStore, pair_direct_evidence, build_pair_inference_pack  # noqa: E402
    from paths import discover_wechat_profiles, decrypted_root_for  # noqa: E402

    if store_dir is not None:
        decrypted = Path(store_dir)
        if not decrypted.exists():
            raise SystemExit(f"指定的解密目录不存在：{decrypted}")
    else:
        profs = discover_wechat_profiles()
        if not profs:
            raise SystemExit("找不到微信账号数据。")
        decrypted = decrypted_root_for(profs[0], must_exist=True)
        if not decrypted:
            raise SystemExit("没有已解密的数据库 — 请先运行 refresh.py 解密")
    store = EchoStore(decrypted)
    evidence = pair_direct_evidence(store, wxid_a, wxid_b)
    contact_a = store.contact(wxid_a)
    contact_b = store.contact(wxid_b)
    name_a = contact_a.display() if contact_a else wxid_a
    name_b = contact_b.display() if contact_b else wxid_b
    if not evidence.get("ok"):
        raise SystemExit(
            f"没有直接关系证据：{name_a} 与 {name_b} 之间没找到提及/互回/朋友圈互动。"
            f" 共同群只能证明两人都在你视野里，不能证明他们认识。"
        )
    pack_md = build_pair_inference_pack(store, wxid_a, wxid_b)
    return {
        "wxid_a": wxid_a, "wxid_b": wxid_b,
        "name_a": name_a, "name_b": name_b,
        "evidence": evidence,
        "pack_md": pack_md,
    }


def export_pair_json(wxid_a: str, wxid_b: str, out: IO, store_dir: Path | None = None) -> int:
    """Pair export as a structured JSON document.

    Carries the markdown pack under `markdown` so AI clients can directly
    forward it; structured fields (`evidence.direct_edges` etc.) let scripts
    filter without parsing markdown.
    """
    meta = _pair_meta(wxid_a, wxid_b, store_dir=store_dir)
    payload = {
        "format_version": 1,
        "kind": "pair-relationship",
        "a": {"wxid": meta["wxid_a"], "name": meta["name_a"]},
        "b": {"wxid": meta["wxid_b"], "name": meta["name_b"]},
        "exported_at": _fmt_ts(int(datetime.now(CST).timestamp())),
        "evidence": {
            "direct_edges": meta["evidence"].get("direct_edges", []),
            "weak_edges": meta["evidence"].get("weak_edges", []),
        },
        "markdown": meta["pack_md"],
    }
    out.write(json.dumps(payload, ensure_ascii=False, indent=2))
    return 1


def export_pair_txt(wxid_a: str, wxid_b: str, out: IO, store_dir: Path | None = None) -> int:
    """Pair export as plain markdown — same content the AI agents see."""
    meta = _pair_meta(wxid_a, wxid_b, store_dir=store_dir)
    # The pack quotes chat samples verbatim; keep them from loading remote images.
    out.write(neutralize_md_images(meta["pack_md"]))
    return 1


def _md_to_simple_html(md: str) -> str:
    """Very-light markdown → HTML for the pair pack body. Handles only the
    constructs build_pair_inference_pack actually emits: # / ## / > / -.
    Anything else passes through escaped.
    """
    out_lines: list[str] = []
    in_list = False
    for raw in md.split("\n"):
        line = raw.rstrip()
        if not line:
            if in_list:
                out_lines.append("</ul>")
                in_list = False
            out_lines.append("")
            continue
        if line.startswith("# "):
            if in_list:
                out_lines.append("</ul>"); in_list = False
            out_lines.append(f"<h1>{_html.escape(line[2:])}</h1>")
        elif line.startswith("## "):
            if in_list:
                out_lines.append("</ul>"); in_list = False
            out_lines.append(f"<h2>{_html.escape(line[3:])}</h2>")
        elif line.startswith("> "):
            if in_list:
                out_lines.append("</ul>"); in_list = False
            out_lines.append(f'<blockquote>{_html.escape(line[2:])}</blockquote>')
        elif line.startswith("- "):
            if not in_list:
                out_lines.append("<ul>")
                in_list = True
            # `**bold**` → <b>bold</b>
            inner = _html.escape(line[2:])
            inner = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", inner)
            inner = re.sub(r"`([^`]+)`", r"<code>\1</code>", inner)
            out_lines.append(f"<li>{inner}</li>")
        else:
            if in_list:
                out_lines.append("</ul>"); in_list = False
            inner = _html.escape(line)
            inner = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", inner)
            inner = re.sub(r"`([^`]+)`", r"<code>\1</code>", inner)
            out_lines.append(f"<p>{inner}</p>")
    if in_list:
        out_lines.append("</ul>")
    return "\n".join(out_lines)


_PAIR_HTML_HEAD = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{ --bg:#f5f3ec; --fg:#1a2b4a; --mute:#6b7a99; --line:rgba(26,43,74,.10); --orange:#FF6B47; }}
body {{ background:var(--bg); color:var(--fg); margin:0; padding:32px 18px;
       font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",serif; }}
.wrap {{ max-width:760px; margin:0 auto; }}
header {{ padding:20px 24px; background:#fff; border:0.5px solid var(--line);
         border-radius:14px; margin-bottom:24px; }}
header .eyebrow {{ font-size:11px; color:var(--orange); letter-spacing:.1em; text-transform:uppercase; }}
header h1 {{ margin:6px 0 4px; font-size:22px; font-weight:600; line-height:1.3; }}
header .meta {{ font-size:12px; color:var(--mute); }}
h1, h2 {{ font-weight:600; }}
h1 {{ font-size:20px; margin:32px 0 16px; }}
h2 {{ font-size:16px; margin:24px 0 10px; padding-bottom:4px; border-bottom:0.5px solid var(--line); }}
p {{ font-size:14px; line-height:1.7; margin:8px 0; }}
ul {{ padding-left:22px; }}
li {{ font-size:13px; line-height:1.7; margin:3px 0; }}
blockquote {{ margin:12px 0; padding:8px 14px; border-left:3px solid var(--orange);
              background:rgba(255,107,71,.06); color:var(--mute); font-size:13px; line-height:1.6; }}
code {{ font-family:"JetBrains Mono",ui-monospace,monospace; font-size:11px;
        padding:2px 5px; background:rgba(26,43,74,.06); border-radius:3px; }}
b {{ color:var(--orange); }}
footer {{ margin-top:36px; font-size:11px; color:var(--mute); text-align:center; }}
</style></head><body><div class="wrap">
<header>
  <div class="eyebrow">MURMUR · 双人关系档案</div>
  <h1>{title}</h1>
  <div class="meta">{when} · 仅基于你电脑里的本地数据</div>
</header>
"""

_PAIR_HTML_FOOT = """<footer>本文件由 Murmur 离线生成。所有内容仅存储于本地，不会上云。</footer>
</div></body></html>"""


def export_pair_html(wxid_a: str, wxid_b: str, out: IO, store_dir: Path | None = None) -> int:
    """Pair export as a self-contained styled HTML report."""
    meta = _pair_meta(wxid_a, wxid_b, store_dir=store_dir)
    title = f"{meta['name_a']} ↔ {meta['name_b']}"
    out.write(_PAIR_HTML_HEAD.format(
        title=_html.escape(title),
        when=_fmt_ts(int(datetime.now(CST).timestamp())),
    ))
    out.write(_md_to_simple_html(meta["pack_md"]))
    out.write(_PAIR_HTML_FOOT)
    return 1


PAIR_CSV_LEAD = ["evidence", "type", "source", "target"]


def write_pair_csv(meta: dict, out: IO) -> int:
    """One row per A↔B edge (direct + weak evidence). BOM for Excel."""
    rows = [("direct", e) for e in meta["evidence"].get("direct_edges", [])]
    rows += [("weak", e) for e in meta["evidence"].get("weak_edges", [])]
    extra: list[str] = []
    for _, e in rows:
        for k, v in e.items():
            if k in PAIR_CSV_LEAD or k in extra:
                continue
            if v is None or isinstance(v, (str, int, float, bool)):
                extra.append(k)
    out.write("\ufeff")
    w = csv.writer(out, lineterminator="\r\n")
    w.writerow(PAIR_CSV_LEAD + extra)
    for kind, e in rows:
        w.writerow([_csv_cell(kind)] + [_csv_cell(e.get(k)) for k in PAIR_CSV_LEAD[1:] + extra])
    return len(rows)


def export_pair_csv(wxid_a: str, wxid_b: str, out: IO, store_dir: Path | None = None) -> int:
    """Pair export as a CSV table of the relationship edges."""
    return write_pair_csv(_pair_meta(wxid_a, wxid_b, store_dir=store_dir), out)


_PAIR_FORMATS = {
    "json": (export_pair_json, "application/json", "json"),
    "txt":  (export_pair_txt,  "text/markdown; charset=utf-8", "md"),
    "md":   (export_pair_txt,  "text/markdown; charset=utf-8", "md"),
    "html": (export_pair_html, "text/html; charset=utf-8", "html"),
    "csv":  (export_pair_csv,  "text/csv; charset=utf-8", "csv"),
}
PAIR_FORMATS = tuple(_PAIR_FORMATS)


def write_pair_export(a: str, b: str, fmt: str, out: IO,
                       store_dir: Path | None = None) -> int:
    if fmt not in _PAIR_FORMATS:
        raise ValueError(f"未知格式: {fmt} (支持 {' / '.join(PAIR_FORMATS)})")
    fn, _, _ = _PAIR_FORMATS[fmt]
    return fn(a, b, out, store_dir=store_dir)


def http_pair_export_meta(fmt: str) -> tuple[str, str]:
    if fmt not in _PAIR_FORMATS:
        raise ValueError(fmt)
    _, ct, ext = _PAIR_FORMATS[fmt]
    return ct, ext


def write_export(wxid: str, fmt: str, out: IO, store=None) -> int:
    """Text-only export of one chat to a stream (no media)."""
    if fmt not in _FORMATS:
        raise ValueError(f"未知格式: {fmt} (支持 {' / '.join(FORMATS)})")
    if store is None:
        store = _default_store()
    writer, _, _ = _FORMATS[fmt]
    return writer(chat_meta(store, wxid), collect_records(store, wxid), out)


def http_export_meta(fmt: str) -> tuple[str, str]:
    """Returns (content_type, file_extension) for HTTP responses."""
    if fmt not in _FORMATS:
        raise ValueError(fmt)
    _, ct, ext = _FORMATS[fmt]
    return ct, ext


def main():
    p = argparse.ArgumentParser()
    p.add_argument("format", choices=list(_FORMATS.keys()))
    p.add_argument("--wxid", required=True)
    p.add_argument("--out", help="output file (default: stdout)")
    p.add_argument("--media", choices=["none", "originals", "best"], default="none",
                   help="附件策略；非 none 时写入 --dir 下的新文件夹")
    p.add_argument("--dir", help="带附件导出时的输出根目录")
    args = p.parse_args()
    if args.media != "none":
        if not args.dir:
            p.error("--media originals/best 需要 --dir")
        report = export_to_dir(_default_store(), args.wxid, args.format, args.media, Path(args.dir))
        print(f"[OK] {report['messages']} 条消息 → {report['dir']}", file=sys.stderr)
        print(json.dumps(report["media"], ensure_ascii=False), file=sys.stderr)
    elif args.out:
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            n = write_export(args.wxid, args.format, f)
        print(f"[OK] {n} 条消息 → {args.out}", file=sys.stderr)
    else:
        n = write_export(args.wxid, args.format, sys.stdout)
        print(f"\n[OK] {n} 条消息", file=sys.stderr)


if __name__ == "__main__":
    main()
