"""sns.py — Moments (朋友圈) extraction & analysis.

Reads sns.db (SnsTimeLine + SnsMessage_tmp3) and exposes:
- 朋友圈正文（XML 解析）
- 互动（点赞/评论）
- 关系信号补充：A 给 B 的朋友圈点赞次数 / 评论次数

用法：
    python sns.py info           # 朋友圈数据概览
    python sns.py timeline       # 列出所有朋友圈（JSONL）
    python sns.py interactions   # 列出所有互动（你点赞/评论谁，谁点赞/评论你）
"""
from __future__ import annotations
import argparse
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Iterator
import xml.etree.ElementTree as ET
ET  # used inside per_friend_signals

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import discover_wechat_profiles, decrypted_root_for  # noqa: E402

CST = timezone(timedelta(hours=8))


# ---------- SnsTimeLine XML parsing ----------

# Map ContentObject.type → human label
SNS_TYPE_MAP = {
    1: "图文",         # photo / multi-image post
    2: "纯文字",        # text-only
    3: "音乐分享",      # music
    4: "视频",         # video
    5: "链接分享",      # url share
    6: "公众号文章",    # article
    7: "投票",
    8: "我的位置",
    10: "视频号转发",
    14: "拍一拍",
    15: "短视频",
    18: "AR 红包",
    21: "音乐",
    23: "直播",
    24: "微小说",
    27: "投票",
    28: "卡券",
    33: "看一看",
    34: "微信视频通话",
    36: "视频号动态",
    42: "音频",
}


def parse_timeline_xml(xml_str: str) -> dict:
    """Parse a SnsTimeLine.content XML into a structured dict."""
    if not xml_str:
        return {}
    out: dict = {
        "id": None, "username": None, "create_time": 0,
        "content_desc": "", "type": None, "type_label": "未知",
        "media": [], "location": None, "comments": [], "likes": [],
        "source_username": None, "source_nickname": None,
    }
    try:
        # Many WeChat SNS XMLs use entity-encoded raw text inside; use .fromstring directly
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        return out
    # Find TimelineObject
    tl = root.find(".//TimelineObject") if root.tag != "TimelineObject" else root
    if tl is None:
        return out

    def text(tag):
        e = tl.find(tag)
        return (e.text or "").strip() if e is not None and e.text else ""

    out["id"] = text("id") or None
    out["username"] = text("username") or None
    try:
        out["create_time"] = int(text("createTime") or 0)
    except ValueError:
        out["create_time"] = 0
    out["content_desc"] = text("contentDesc")
    out["source_username"] = text("sourceUserName") or None
    out["source_nickname"] = text("sourceNickName") or None

    # ContentObject
    co = tl.find(".//ContentObject")
    if co is not None:
        try:
            out["type"] = int((co.find("type").text or "0").strip())
        except (AttributeError, ValueError):
            out["type"] = None
        out["type_label"] = SNS_TYPE_MAP.get(out["type"], f"type_{out['type']}")
        title = co.find("title")
        if title is not None and title.text:
            out["title"] = title.text.strip()
        desc = co.find("description")
        if desc is not None and desc.text:
            out["description"] = desc.text.strip()
        url = co.find("contentUrl")
        if url is not None and url.text:
            out["url"] = url.text.strip()
        # mediaList
        ml = co.find("mediaList")
        if ml is not None:
            for m in ml.findall("media"):
                item = {}
                for k in ("id", "type", "sub_type", "title", "description"):
                    e = m.find(k)
                    if e is not None and e.text:
                        item[k] = e.text.strip()
                # url (and thumb)
                u = m.find("url")
                if u is not None:
                    item["url"] = (u.text or "").strip()
                    item["url_md5"] = u.get("md5", "")
                    item["url_token"] = u.get("token", "")
                t = m.find("thumb")
                if t is not None:
                    item["thumb"] = (t.text or "").strip()
                out["media"].append(item)

    # Location
    loc = tl.find("location")
    if loc is not None:
        try:
            lat = float(loc.get("latitude", 0))
            lon = float(loc.get("longitude", 0))
            poi = loc.get("poiName") or loc.get("poiAddress") or loc.text or ""
            if lat or lon or poi:
                out["location"] = {"lat": lat, "lon": lon, "poi": poi}
        except (TypeError, ValueError):
            pass

    return out


# ---------- High-level access ----------

def open_sns_db(decrypted_dir: Path) -> sqlite3.Connection:
    db = decrypted_dir / "sns.db"
    if not db.exists():
        raise FileNotFoundError(f"sns.db not found at {db}")
    return sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)


def iter_timeline(decrypted_dir: Path, *, since: int | None = None,
                  until: int | None = None) -> Iterator[dict]:
    c = open_sns_db(decrypted_dir)
    try:
        for tid, user, content in c.execute(
            "SELECT tid, user_name, content FROM SnsTimeLine ORDER BY tid DESC"
        ):
            parsed = parse_timeline_xml(content)
            ct = parsed.get("create_time", 0)
            if since and ct < since: continue
            if until and ct > until: continue
            parsed["tid"] = tid
            parsed["raw_username"] = user
            yield parsed
    finally:
        c.close()


def iter_interactions(decrypted_dir: Path) -> Iterator[dict]:
    """Comments + likes from SnsMessage_tmp3."""
    c = open_sns_db(decrypted_dir)
    try:
        for row in c.execute(
            "SELECT local_id, create_time, type, feed_id, from_username, "
            "from_nickname, to_username, to_nickname, content "
            "FROM SnsMessage_tmp3 ORDER BY create_time DESC"
        ):
            yield {
                "local_id": row[0],
                "create_time": row[1],
                "type": row[2],   # 1=comment, 2=like (typical)
                "feed_id": row[3],
                "from_username": row[4],
                "from_nickname": row[5],
                "to_username": row[6],
                "to_nickname": row[7],
                "content": row[8] or "",
            }
    finally:
        c.close()


def per_friend_signals(decrypted_dir: Path, self_wxid: str) -> dict[str, dict]:
    """Compute per-friend Moments-based signals (extra evidence for closeness).

    For WeChat 4.x, the source of truth is the <LocalExtraInfo> block embedded inside
    each post's SnsTimeLine.content XML:

        <LocalExtraInfo>
          <like_user_list>
            <user_comment><type>1</type><username>{wxid}</username>...</user_comment>  ← like
          </like_user_list>
          <comment_user_list>
            <user_comment><type>2</type><username>{wxid}</username><content>...</content></user_comment>  ← comment
          </comment_user_list>
          <with_user_list>
            <user_comment><type>4</type>...</user_comment>  ← @mention / "with"
          </with_user_list>
        </LocalExtraInfo>

    SnsMessage_tmp3 is just an *incoming notification* table (only events directed at you);
    it cannot tell us about your outgoing likes. The XML parse is authoritative.
    """
    out: dict[str, dict] = defaultdict(lambda: {
        "they_posted_count": 0,
        "you_liked_them": 0,
        "you_commented_them": 0,
        "they_liked_you": 0,
        "they_commented_you": 0,
    })

    c = open_sns_db(decrypted_dir)
    try:
        for tid, user_name, content in c.execute(
            "SELECT tid, user_name, content FROM SnsTimeLine"
        ):
            if not content:
                continue
            try:
                root = ET.fromstring(content)
            except ET.ParseError:
                continue

            tl = root.find(".//TimelineObject") if root.tag != "TimelineObject" else root
            if tl is None:
                continue
            owner_e = tl.find("username")
            owner = owner_e.text.strip() if owner_e is not None and owner_e.text else None
            if not owner:
                continue
            if owner != self_wxid:
                out[owner]["they_posted_count"] += 1

            extra = root.find(".//LocalExtraInfo")
            if extra is None:
                continue

            def each_actor(parent_tag):
                el = extra.find(parent_tag)
                if el is None:
                    return
                for uc in el.findall("user_comment"):
                    un_e = uc.find("username")
                    un = un_e.text.strip() if un_e is not None and un_e.text else ""
                    if un:
                        yield un

            for un in each_actor("like_user_list"):
                if owner == self_wxid and un != self_wxid:
                    out[un]["they_liked_you"] += 1
                elif un == self_wxid and owner != self_wxid:
                    out[owner]["you_liked_them"] += 1

            for un in each_actor("comment_user_list"):
                if owner == self_wxid and un != self_wxid:
                    out[un]["they_commented_you"] += 1
                elif un == self_wxid and owner != self_wxid:
                    out[owner]["you_commented_them"] += 1
    finally:
        c.close()

    return dict(out)


def friend_to_friend_signals(decrypted_dir: Path, self_wxid: str) -> dict[tuple[str, str], dict]:
    """Friend-to-friend Moments interactions (NEITHER side is you).

    Strong signal of A↔B knowing each other: if A liked/commented on B's Moments,
    they interact independently of you. Returns symmetric pair → {
        a_liked_b, a_commented_b, b_liked_a, b_commented_a,
        examples: [{date, from, to, type, text}],
    }
    Pair key is sorted (a_wxid, b_wxid) — same regardless of order.
    """
    out: dict[tuple[str, str], dict] = {}

    def rec_for(a: str, b: str):
        key = tuple(sorted([a, b]))
        if key not in out:
            out[key] = {
                "a": key[0], "b": key[1],
                "a_liked_b": 0, "a_commented_b": 0,
                "b_liked_a": 0, "b_commented_a": 0,
                "examples": [],
            }
        return key, out[key]

    c = open_sns_db(decrypted_dir)
    try:
        for tid, user_name, content in c.execute(
            "SELECT tid, user_name, content FROM SnsTimeLine"
        ):
            if not content:
                continue
            try:
                root = ET.fromstring(content)
            except ET.ParseError:
                continue

            tl = root.find(".//TimelineObject") if root.tag != "TimelineObject" else root
            if tl is None:
                continue
            owner_e = tl.find("username")
            owner = owner_e.text.strip() if owner_e is not None and owner_e.text else None
            if not owner or owner == self_wxid:
                continue
            create_time = 0
            try:
                ct_e = tl.find("createTime")
                create_time = int(ct_e.text or 0) if ct_e is not None else 0
            except (TypeError, ValueError):
                create_time = 0

            extra = root.find(".//LocalExtraInfo")
            if extra is None:
                continue

            def each(parent_tag):
                el = extra.find(parent_tag)
                if el is None:
                    return
                for uc in el.findall("user_comment"):
                    un_e = uc.find("username")
                    un = un_e.text.strip() if un_e is not None and un_e.text else ""
                    nick_e = uc.find("nickname")
                    nick = nick_e.text.strip() if nick_e is not None and nick_e.text else ""
                    content_e = uc.find("content")
                    cmt = content_e.text.strip() if content_e is not None and content_e.text else ""
                    if un and un != self_wxid:
                        yield un, nick, cmt

            for un, nick, _ in each("like_user_list"):
                if un == owner:
                    continue
                key, rec = rec_for(un, owner)
                if un == key[0]:
                    rec["a_liked_b"] += 1
                else:
                    rec["b_liked_a"] += 1
                if len(rec["examples"]) < 4:
                    rec["examples"].append({
                        "ts": create_time, "type": "like",
                        "from_wxid": un, "from_name": nick,
                        "to_wxid": owner, "text": "",
                    })

            for un, nick, cmt in each("comment_user_list"):
                if un == owner:
                    continue
                key, rec = rec_for(un, owner)
                if un == key[0]:
                    rec["a_commented_b"] += 1
                else:
                    rec["b_commented_a"] += 1
                if len(rec["examples"]) < 6:
                    rec["examples"].append({
                        "ts": create_time, "type": "comment",
                        "from_wxid": un, "from_name": nick,
                        "to_wxid": owner, "text": cmt[:120],
                    })
    finally:
        c.close()

    return out


# ---------- CLI ----------

def _select_dir() -> Path:
    profs = discover_wechat_profiles()
    if not profs:
        raise SystemExit("找不到微信账号数据。")
    return decrypted_root_for(profs[0])


def cmd_info(args):
    d = _select_dir()
    c = open_sns_db(d)
    try:
        n_tl = c.execute("SELECT COUNT(*) FROM SnsTimeLine").fetchone()[0]
        n_msg = c.execute("SELECT COUNT(*) FROM SnsMessage_tmp3").fetchone()[0]
        # Top posters
        posters = Counter()
        for tid, user, content in c.execute("SELECT tid, user_name, content FROM SnsTimeLine LIMIT 5000"):
            tl = parse_timeline_xml(content)
            if tl.get("username"):
                posters[tl["username"]] += 1
    finally:
        c.close()
    print(f"=== Moments at {d / 'sns.db'} ===")
    print(f"  Timeline entries (你看到的所有人发的): {n_tl}")
    print(f"  Interactions (评论/点赞): {n_msg}")
    print(f"\nTop 10 posters in your timeline:")
    for u, n in posters.most_common(10):
        print(f"  {u:<30} {n:>4} 条")


def cmd_timeline(args):
    d = _select_dir()
    n = 0
    for tl in iter_timeline(d):
        out = {
            "tid": str(tl["tid"]),
            "user": tl.get("username"),
            "time": datetime.fromtimestamp(tl["create_time"], CST).isoformat() if tl["create_time"] else None,
            "type": tl.get("type_label"),
            "text": tl.get("content_desc", "")[:200],
            "media_count": len(tl.get("media", [])),
            "title": tl.get("title", ""),
            "location": tl.get("location"),
        }
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        n += 1
        if args.limit and n >= args.limit:
            break


def cmd_interactions(args):
    d = _select_dir()
    n = 0
    for it in iter_interactions(d):
        sys.stdout.write(json.dumps({
            "time": datetime.fromtimestamp(it["create_time"], CST).isoformat() if it["create_time"] else None,
            "type": "comment" if it["type"] == 1 else "like",
            "from_user": it["from_username"],
            "from_name": it["from_nickname"],
            "to_user": it["to_username"],
            "to_name": it["to_nickname"],
            "content": it["content"][:200],
        }, ensure_ascii=False) + "\n")
        n += 1
        if args.limit and n >= args.limit:
            break


def cmd_per_friend(args):
    d = _select_dir()
    profs = discover_wechat_profiles()
    self_wxid = profs[0].wxid_short if profs else "self"
    sigs = per_friend_signals(d, self_wxid)
    rows = sorted(sigs.items(), key=lambda kv: -(kv[1]["you_liked_them"] + kv[1]["you_commented_them"] +
                                                   kv[1]["they_liked_you"] + kv[1]["they_commented_you"]))
    print(f"{'wxid':<35}  你点赞他 / 你评论他 / 他点赞你 / 他评论你 / 他发圈")
    for wxid, s in rows[:30]:
        print(f"  {wxid:<33}  {s['you_liked_them']:>3} / {s['you_commented_them']:>3} "
              f"/ {s['they_liked_you']:>3} / {s['they_commented_you']:>3} / {s['they_posted_count']:>3}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("info");
    sp = sub.add_parser("timeline"); sp.add_argument("--limit", type=int, default=20)
    sp = sub.add_parser("interactions"); sp.add_argument("--limit", type=int, default=50)
    sp = sub.add_parser("per-friend")
    args = p.parse_args()
    funcs = {"info": cmd_info, "timeline": cmd_timeline,
             "interactions": cmd_interactions, "per-friend": cmd_per_friend}
    funcs[args.cmd](args)


if __name__ == "__main__":
    main()
