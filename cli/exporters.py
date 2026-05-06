"""exporters.py — 把单个朋友/群的聊天导出为 JSON / HTML / TXT。

所有渲染都基于 EchoStore.messages() 流式读取，不会把全量数据加载到内存。
HTTP 路由由 etcli.py 的 /api/export?wxid=&format= 调用；命令行入口便于测试：

    python exporters.py json --wxid wxid_xxx > out.json
    python exporters.py html --wxid wxid_xxx > out.html
    python exporters.py txt  --wxid wxid_xxx > out.txt
"""
from __future__ import annotations

import argparse
import html as _html
import json
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import IO, Iterator

CST = timezone(timedelta(hours=8))


def _fmt_ts(ts: int) -> str:
    try:
        return datetime.fromtimestamp(int(ts), CST).strftime("%Y-%m-%d %H:%M:%S")
    except (OSError, ValueError, OverflowError):
        return ""


def _store_and_meta(wxid: str):
    """Lazy-import etcli to avoid circular imports when this module is run directly."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from etcli import EchoStore  # noqa: E402
    from paths import discover_wechat_profiles, decrypted_root_for  # noqa: E402

    profs = discover_wechat_profiles()
    if not profs:
        raise SystemExit("找不到微信账号数据。")
    profile = profs[0]
    decrypted = decrypted_root_for(profile, must_exist=True)
    if not decrypted:
        raise SystemExit("没有已解密的数据库 — 请先运行 refresh.py 解密")
    store = EchoStore(decrypted)
    contact = store.contact(wxid)
    name = contact.display() if contact else wxid
    return store, name


def export_json(wxid: str, out: IO) -> int:
    """Stream-write a JSON document with all messages for `wxid`."""
    store, name = _store_and_meta(wxid)
    out.write(f'{{"wxid":{json.dumps(wxid, ensure_ascii=False)},')
    out.write(f'"name":{json.dumps(name, ensure_ascii=False)},')
    out.write('"format_version":1,"messages":[')
    first = True
    n = 0
    for m in store.messages(wxid, text_only=False):
        rec = {
            "ts": m.create_time,
            "time": _fmt_ts(m.create_time),
            "from_id": m.sender_wxid,
            "from": m.sender_name,
            "type": m.raw_type_label,
            "type_id": m.msg_type,
            "text": m.text,
        }
        if not first:
            out.write(",")
        out.write(json.dumps(rec, ensure_ascii=False))
        first = False
        n += 1
    out.write("]}")
    return n


def export_txt(wxid: str, out: IO) -> int:
    """Plain-text chat log. One message per line — readable on any device."""
    store, name = _store_and_meta(wxid)
    out.write(f"=== 与 {name} 的聊天记录 ({wxid}) ===\n")
    out.write(f"导出时间: {_fmt_ts(int(datetime.now(CST).timestamp()))}\n\n")
    n = 0
    for m in store.messages(wxid, text_only=False):
        ts = _fmt_ts(m.create_time)
        sender = m.sender_name or m.sender_wxid
        text = m.text or f"[{m.raw_type_label}]"
        # Indent multi-line text under the timestamp for readability
        lines = text.split("\n")
        out.write(f"[{ts}] {sender}: {lines[0]}\n")
        for ln in lines[1:]:
            out.write(f"    {ln}\n")
        n += 1
    return n


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
.day {{ text-align: center; margin: 22px 0 6px; font-size: 11px; color: var(--mute); }}
footer {{ margin-top: 30px; text-align: center; color: var(--mute); font-size: 11px; }}
</style></head><body><div class="wrap">
<header>
  <h1>与 {title} 的聊天记录</h1>
  <div class="meta">{wxid} · 导出于 {when}</div>
</header>
"""

_HTML_FOOTER = """<footer>本文件由 Murmur 离线导出，仅存储于本地。</footer></div></body></html>"""


def export_html(wxid: str, out: IO) -> int:
    store, name = _store_and_meta(wxid)
    out.write(_HTML_HEADER.format(
        title=_html.escape(name),
        wxid=_html.escape(wxid),
        when=_fmt_ts(int(datetime.now(CST).timestamp())),
    ))
    last_day: str | None = None
    n = 0
    for m in store.messages(wxid, text_only=False):
        day = _fmt_ts(m.create_time)[:10]
        if day != last_day:
            out.write(f'<div class="day">— {_html.escape(day)} —</div>\n')
            last_day = day
        is_self = (m.sender_wxid == "self")
        cls = "self" if is_self else "other"
        body_text = m.text if m.text else f"[{m.raw_type_label}]"
        time_short = _fmt_ts(m.create_time)[11:16]
        sender_label = "" if is_self else _html.escape(m.sender_name or m.sender_wxid)
        out.write(
            f'<div class="msg {cls}">'
            f'<div class="meta">{sender_label} {time_short}</div>'
            f'<div class="body">{_html.escape(body_text)}</div>'
            '</div>\n'
        )
        n += 1
    out.write(_HTML_FOOTER)
    return n


_FORMATS = {
    "json": (export_json, "application/json", "json"),
    "txt": (export_txt, "text/plain; charset=utf-8", "txt"),
    "html": (export_html, "text/html; charset=utf-8", "html"),
}


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
    out.write(meta["pack_md"])
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


_PAIR_FORMATS = {
    "json": (export_pair_json, "application/json", "json"),
    "txt":  (export_pair_txt,  "text/markdown; charset=utf-8", "md"),
    "html": (export_pair_html, "text/html; charset=utf-8", "html"),
}


def write_pair_export(a: str, b: str, fmt: str, out: IO,
                       store_dir: Path | None = None) -> int:
    if fmt not in _PAIR_FORMATS:
        raise ValueError(f"未知格式: {fmt} (支持 json / txt / html)")
    fn, _, _ = _PAIR_FORMATS[fmt]
    return fn(a, b, out, store_dir=store_dir)


def http_pair_export_meta(fmt: str) -> tuple[str, str]:
    if fmt not in _PAIR_FORMATS:
        raise ValueError(fmt)
    _, ct, ext = _PAIR_FORMATS[fmt]
    return ct, ext


def write_export(wxid: str, fmt: str, out: IO) -> int:
    if fmt not in _FORMATS:
        raise ValueError(f"未知格式: {fmt} (支持 json / txt / html)")
    fn, _, _ = _FORMATS[fmt]
    return fn(wxid, out)


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
    args = p.parse_args()
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            n = write_export(args.wxid, args.format, f)
        print(f"[OK] {n} 条消息 → {args.out}", file=sys.stderr)
    else:
        n = write_export(args.wxid, args.format, sys.stdout)
        print(f"\n[OK] {n} 条消息", file=sys.stderr)


if __name__ == "__main__":
    main()
