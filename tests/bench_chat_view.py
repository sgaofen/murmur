"""Before/after timing for the chat page's paging (#46 review item 4). Not a unit test.

    python3 tests/bench_chat_view.py [--messages 100000] [--baseline 9f790ce] [--repeat 5]

Builds one synthetic WeChat 4.x chat (same Msg_<md5> schema and indexes as
the real client, rolled over into two message_*.db files, ~15% wide image /
link XML rows) and times what the chat page asks /api/chat/messages for:

  open            newest 80 messages + chat meta (count / first / last)
  scroll up x5    five `before=` pages of 60, walking back from the newest
  search hit      `around=` a message in the middle (+ meta)
  jump to date    `at=` a day in the middle (+ meta)
  scroll down     one `after=` page of 60 from the middle

`baseline` is the chat_view.py at that git revision (default: the #46 merge,
before the sort-key cache); `current` is the working tree. Both run on the
same store and data. Medians over --repeat runs; `current` also shows its
very first open (cold cache, includes building the sort-key index).
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import random
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

from etcli import EchoStore  # noqa: E402

ME = "wxid_me"
PEER = "wxid_peer"
START = 1_640_966_400  # 2022-01-01 00:00 +08:00

# WeChat 4.x Msg_<md5> layout (columns and indexes as created by the client).
SCHEMA = """
CREATE TABLE {t} (local_id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, local_type INTEGER,
  sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER, status INTEGER, upload_status INTEGER,
  download_status INTEGER, server_seq INTEGER, origin_source INTEGER, source TEXT, message_content TEXT,
  compress_content TEXT, packed_info_data BLOB, WCDB_CT_message_content INTEGER DEFAULT NULL,
  WCDB_CT_source INTEGER DEFAULT NULL);
CREATE INDEX {t}_SENDERID ON {t}(real_sender_id);
CREATE INDEX {t}_SERVERID ON {t}(server_id);
CREATE INDEX {t}_SORTSEQ ON {t}(sort_seq);
CREATE INDEX {t}_TYPE_SEQ ON {t}(local_type, sort_seq);
"""

SOURCE_XML = ("<msgsource><signature>V1_" + "x" * 48 + "</signature><tmp_node><publisher-id></publisher-id>"
              "</tmp_node><sec_msg_node><uuid>" + "f" * 32 + "</uuid></sec_msg_node></msgsource>")
WORDS = "今天 晚上 一起 吃饭 好的 哈哈哈 到家了吗 周末 加班 电影 火锅 晚安 下雨 地铁 猫 咖啡".split()


def _content(rng: random.Random, i: int) -> tuple:
    r = rng.random()
    if r < 0.10:
        md5 = hashlib.md5(str(i).encode()).hexdigest()
        body = (f'<msg><img aeskey="{md5}" encryver="1" cdnthumbaeskey="{md5}" cdnthumburl="{"3057" * 60}" '
                f'cdnthumblength="5120" length="88000" md5="{md5}" hevc_mid_size="64000" /></msg>')
        return 3, body
    if r < 0.15:
        body = ("<msg><appmsg appid=\"\" sdkver=\"0\"><title>" + "分享的链接标题" * 3 + "</title><des>"
                + "这是一段比较长的描述文字" * 20 + "</des><type>5</type><url>https://example.com/"
                + "a" * 300 + "</url></appmsg></msg>")
        return (5 << 32) | 49, body
    return 1, " ".join(rng.choice(WORDS) for _ in range(rng.randint(1, 12)))


def build(root: Path, n: int) -> Path:
    d = root / ME
    d.mkdir(parents=True)
    c = sqlite3.connect(str(d / "session.db"))
    c.execute("CREATE TABLE SessionTable (username TEXT, last_timestamp INTEGER, summary TEXT)")
    c.execute("INSERT INTO SessionTable VALUES (?, ?, '')", (PEER, START + n * 600))
    c.commit()
    c.close()
    c = sqlite3.connect(str(d / "contact.db"))
    c.execute("CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, alias TEXT, local_type INTEGER)")
    c.execute("CREATE TABLE chat_room (username TEXT)")
    c.execute("INSERT INTO contact VALUES (?,?,?,?,?)", (PEER, "老朋友", "peer", "", 1))
    c.commit()
    c.close()

    t = f"Msg_{hashlib.md5(PEER.encode()).hexdigest()}"
    rng = random.Random(46)
    split = int(n * 0.6)  # the first 60% sit in the rolled-over message_0.db
    when = START
    for fname, lo, hi in (("message_0.db", 0, split), ("message_1.db", split, n)):
        c = sqlite3.connect(str(d / fname))
        c.execute("CREATE TABLE Name2Id (user_name TEXT)")
        c.executemany("INSERT INTO Name2Id(user_name) VALUES (?)", [(ME,), (PEER,)])
        c.executescript(SCHEMA.format(t=t))
        rows = []
        for i in range(lo, hi):
            when += rng.choice((1, 3, 20, 60, 300, 900, 3600, 20000))
            mtype, body = _content(rng, i)
            rows.append((i, mtype, when * 1000 + i % 1000, 1 + (i % 3 == 0), when, 2, 0, 0, i, 0,
                         SOURCE_XML, body, None, b"\x08\x01\x12\x10" + bytes(40)))
        c.executemany(f"INSERT INTO {t} (server_id, local_type, sort_seq, real_sender_id, create_time, status, "
                      "upload_status, download_status, server_seq, origin_source, source, message_content, "
                      "compress_content, packed_info_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        c.commit()
        c.close()
    return d


def load_baseline(rev: str, into: Path):
    src = subprocess.run(["git", "-C", str(ROOT), "show", f"{rev}:cli/chat_view.py"],
                         check=True, capture_output=True).stdout
    p = into / "chat_view_baseline.py"
    p.write_bytes(src)
    spec = importlib.util.spec_from_file_location("chat_view_baseline", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def timed(fn) -> float:
    t0 = time.perf_counter()
    fn()
    return (time.perf_counter() - t0) * 1000


def scenarios(cv, store, mid_id: str, mid_day: str):
    def scroll_up():
        r = cv.chat_page(store, PEER, limit=80)
        cur = r["messages"][0]["id"]
        for _ in range(5):
            cur = cv.chat_page(store, PEER, before=cur, limit=60)["messages"][0]["id"]
    return [
        ("open", lambda: cv.chat_page(store, PEER, limit=80)),
        ("scroll up x5", scroll_up),
        ("search hit", lambda: cv.chat_page(store, PEER, around=mid_id, limit=80)),
        ("jump to date", lambda: cv.chat_page(store, PEER, at=mid_day, limit=80)),
        ("scroll down", lambda: cv.chat_page(store, PEER, after=mid_id, limit=60)),
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--messages", type=int, default=100_000)
    ap.add_argument("--baseline", default="9f790ce")
    ap.add_argument("--repeat", type=int, default=5)
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="murmur-chat-bench-"))
    try:
        t0 = time.perf_counter()
        store = EchoStore(build(tmp / "data", args.messages))
        size = sum(p.stat().st_size for p in (tmp / "data" / ME).glob("message_*.db"))
        print(f"synthetic chat: {args.messages:,} messages in 2 DB files, {size / 1e6:.0f} MB "
              f"(built in {time.perf_counter() - t0:.1f}s)")

        import chat_view as current
        baseline = load_baseline(args.baseline, tmp)
        # Same middle message / day for both versions.
        r = current.chat_page(store, PEER, at=START + 1, limit=1)
        walk = current.chat_page(store, PEER, limit=200)
        mid = current.chat_page(store, PEER, at=(r["chat"]["first_ts"] + r["chat"]["last_ts"]) // 2, limit=1)
        mid_id = mid["anchor"]
        mid_day = int(mid["messages"][0]["ts"])
        assert walk["messages"], "empty synthetic chat"

        # Cold first open for the new code (sort-key index not built yet).
        if hasattr(current, "_KEY_CACHE"):
            current._KEY_CACHE.clear()
        cold = timed(lambda: current.chat_page(store, PEER, limit=80))

        results = {}
        for label, mod in (("baseline", baseline), ("current", current)):
            for name, fn in scenarios(mod, store, mid_id, mid_day):
                fn()  # warm the OS page cache / module caches
                results[(label, name)] = statistics.median(timed(fn) for _ in range(args.repeat))

        print(f"\n{'scenario':<16}{'baseline ' + args.baseline:>22}{'current':>12}{'speed-up':>10}")
        for name, _ in scenarios(current, store, mid_id, mid_day):
            b, c = results[("baseline", name)], results[("current", name)]
            print(f"{name:<16}{b:>19.1f} ms{c:>9.1f} ms{b / c:>9.1f}x")
        print(f"\ncurrent, first open with a cold cache: {cold:.1f} ms")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
