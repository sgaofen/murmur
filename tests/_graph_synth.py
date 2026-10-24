"""Synthetic decrypted QQ / WeChat databases for relationship-graph tests (#24).

Both builders write the minimal schema the real stores read (QQStore: nt_msg.db +
profile_info.db + group_info.db; EchoStore: session.db + contact.db +
message_0.db). Data is deterministic per seed and is shaped to hit every graph
branch: private-only friends, group-only real friends, strangers, small chatty
groups (mutual_reply >= 100), friends mentioning each other in private chats,
stale sessions outside the 365-day window.

No timestamp falls within a day of the 365-day cutoff, so two builds a few
seconds apart see exactly the same data.
"""
from __future__ import annotations

import hashlib
import random
import sqlite3
import time
from pathlib import Path

DAY = 86400
_SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜"
_GIVEN = "伟芳娜敏静丽强磊军洋勇艳杰涛明超秀霞平刚桂英华建国志红"


def _people(rng: random.Random, n_friends: int, n_strangers: int):
    names: set[str] = set()
    friends, strangers = [], []
    for i in range(n_friends + n_strangers):
        while True:
            nm = rng.choice(_SURNAMES) + rng.choice(_GIVEN) + rng.choice(_GIVEN)
            if nm not in names:
                names.add(nm)
                break
        (friends if i < n_friends else strangers).append(nm)
    return friends, strangers


def _ts(rng: random.Random, now: int, *, old: bool = False) -> int:
    """A timestamp either well inside (<= 360d) or well outside (>= 370d) the window."""
    days = rng.uniform(370, 900) if old else rng.uniform(0.01, 360)
    return int(now - days * DAY)


def _plan(seed: int, n_friends: int, n_strangers: int, n_groups: int,
          group_msgs: int, private_msgs: int):
    """Platform-neutral plan: people, private chats, groups with message streams."""
    rng = random.Random(seed)
    now = int(time.time())
    friends, strangers = _people(rng, n_friends, n_strangers)
    people = [("f", i, nm) for i, nm in enumerate(friends)] + \
             [("s", i, nm) for i, nm in enumerate(strangers)]

    # Private chats: list of (friend_idx, [(ts, from_self, text)])
    private = []
    for i in range(n_friends):
        r = rng.random()
        heavy = i < 12  # a core of heavy chats so friend-mention edges appear
        if heavy:
            r = 1.0
        if r < 0.15:
            continue  # group-only friend
        if r < 0.25:
            n = rng.randint(1, 6)  # light contact
        else:
            n = max(1, int(rng.paretovariate(1.2) * private_msgs / 10))
            n = min(n, private_msgs * 5)
            if heavy:
                n = max(n, 60)
        stale = rng.random() < 0.2
        msgs = []
        for _ in range(n):
            text = rng.choice(["在吗", "吃了吗", "哈哈哈", "好的", "明天见", "收到"])
            if rng.random() < 0.08:
                text = f"昨天碰到{rng.choice(friends[:8])}了"
            msgs.append((_ts(rng, now, old=stale), rng.random() < 0.5, text))
        msgs.sort()
        private.append((i, msgs))

    # Groups: (group_idx, name, [(ts, person_key or None for self, text)])
    groups = []
    for g in range(n_groups):
        small = g % 4 == 0
        size = rng.randint(3, 6) if small else rng.randint(8, 60)
        members = rng.sample(people, min(size, len(people)))
        n = group_msgs * (3 if small else 1)
        base = _ts(rng, now, old=(g % 7 == 6))
        msgs = []
        t = base
        for _ in range(n):
            # Bursty: mostly seconds apart, sometimes hour-long gaps.
            t += rng.choice([5, 20, 60, 90]) if rng.random() < 0.9 else rng.randint(3600, 3 * DAY)
            if t > now - 60:
                t = base
            who = None if rng.random() < 0.05 else rng.choice(members)
            msgs.append((t, who, rng.choice(["+1", "哈哈", "同意", "在的", "收到"])))
        # Keep clear of the 365-day cutoff so build-time drift can't matter.
        lo, hi = now - 366 * DAY, now - 364 * DAY
        msgs = [m for m in msgs if not (lo <= m[0] <= hi)]
        msgs.sort(key=lambda m: m[0])
        groups.append((g, f"测试群{g}", msgs))
    return {"now": now, "people": people, "friends": friends,
            "private": private, "groups": groups}


# ---------------- QQ ----------------

def _varint(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _pb(fn: int, wire: int, payload) -> bytes:
    key = _varint((fn << 3) | wire)
    if wire == 0:
        return key + _varint(payload)
    return key + _varint(len(payload)) + payload


def _qq_body(text: str) -> bytes:
    elem = _pb(45002, 0, 1) + _pb(45101, 2, text.encode("utf-8"))
    return _pb(40800, 2, elem)


def build_qq_dir(root: Path, *, seed: int = 7, n_friends: int = 60, n_strangers: int = 40,
                 n_groups: int = 12, group_msgs: int = 150, private_msgs: int = 120) -> Path:
    plan = _plan(seed, n_friends, n_strangers, n_groups, group_msgs, private_msgs)
    qq_number = "10001"
    d = Path(root) / qq_number
    d.mkdir(parents=True)
    self_uid = "u_self000"

    def uid(kind: str, i: int) -> str:
        return f"u_{kind}{i:05d}"

    c = sqlite3.connect(str(d / "profile_info.db"))
    c.execute('CREATE TABLE profile_info_v6 ("1000" TEXT, "1002" INTEGER, "20002" TEXT, "20009" TEXT)')
    c.execute('CREATE TABLE buddy_list ("1000" TEXT)')
    c.execute('INSERT INTO profile_info_v6 VALUES (?,?,?,?)', (self_uid, int(qq_number), "我自己", ""))
    for kind, i, nm in plan["people"]:
        c.execute('INSERT INTO profile_info_v6 VALUES (?,?,?,?)', (uid(kind, i), 20000 + i + (0 if kind == "f" else 50000), nm, ""))
        if kind == "f":
            c.execute('INSERT INTO buddy_list VALUES (?)', (uid(kind, i),))
    c.commit()
    c.close()

    c = sqlite3.connect(str(d / "group_info.db"))
    c.execute('CREATE TABLE group_detail_info_ver1 ("60001" INTEGER, "60007" TEXT, "60002" TEXT, "60006" TEXT)')
    for g, name, _ in plan["groups"]:
        c.execute('INSERT INTO group_detail_info_ver1 VALUES (?,?,?,?)', (900000 + g, name, self_uid, ""))
    c.commit()
    c.close()

    cols = '("40001" INTEGER, "40020" TEXT, "40050" INTEGER, "40005" INTEGER, "40800" BLOB, "40090" TEXT, "40021" TEXT)'
    c = sqlite3.connect(str(d / "nt_msg.db"))
    c.execute(f"CREATE TABLE c2c_msg_table {cols}")
    c.execute(f"CREATE TABLE group_msg_table {cols}")
    msg_id = 1
    rows = []
    for i, msgs in plan["private"]:
        peer = uid("f", i)
        for ts, from_self, text in msgs:
            rows.append((msg_id, self_uid if from_self else peer, ts, 1, _qq_body(text), "", peer))
            msg_id += 1
    c.executemany("INSERT INTO c2c_msg_table VALUES (?,?,?,?,?,?,?)", rows)
    rows = []
    for g, _name, msgs in plan["groups"]:
        for ts, who, text in msgs:
            sender = self_uid if who is None else uid(who[0], who[1])
            disp = "" if who is None else who[2]
            rows.append((msg_id, sender, ts, 1, _qq_body(text), disp, str(900000 + g)))
            msg_id += 1
    c.executemany("INSERT INTO group_msg_table VALUES (?,?,?,?,?,?,?)", rows)
    c.commit()
    c.close()
    return d


# ---------------- WeChat ----------------

def build_wechat_dir(root: Path, *, seed: int = 11, n_friends: int = 60, n_strangers: int = 40,
                     n_groups: int = 12, group_msgs: int = 150, private_msgs: int = 120) -> Path:
    plan = _plan(seed, n_friends, n_strangers, n_groups, group_msgs, private_msgs)
    me = "wxid_me000"
    d = Path(root) / me
    d.mkdir(parents=True)

    def wxid(kind: str, i: int) -> str:
        return f"wxid_{kind}{i:05d}"

    def room(g: int) -> str:
        return f"{1000 + g}@chatroom"

    c = sqlite3.connect(str(d / "contact.db"))
    c.execute("CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, alias TEXT, local_type INTEGER)")
    c.execute("CREATE TABLE chat_room (username TEXT)")
    for kind, i, nm in plan["people"]:
        c.execute("INSERT INTO contact VALUES (?,?,?,?,?)",
                  (wxid(kind, i), "", nm, "", 1 if kind == "f" else 3))
    for g, name, _ in plan["groups"]:
        c.execute("INSERT INTO contact VALUES (?,?,?,?,?)", (room(g), "", name, "", 2))
        c.execute("INSERT INTO chat_room VALUES (?)", (room(g),))
    c.commit()
    c.close()

    sessions = []
    c = sqlite3.connect(str(d / "message_0.db"))
    c.execute("CREATE TABLE Name2Id (user_name TEXT)")
    name_ids: dict[str, int] = {}

    def nid(u: str) -> int:
        if u not in name_ids:
            cur = c.execute("INSERT INTO Name2Id (user_name) VALUES (?)", (u,))
            name_ids[u] = cur.lastrowid
        return name_ids[u]

    def table_for(u: str) -> str:
        t = f"Msg_{hashlib.md5(u.encode()).hexdigest()}"
        c.execute(f"CREATE TABLE {t} (local_id INTEGER PRIMARY KEY, create_time INTEGER, "
                  f"real_sender_id INTEGER, local_type INTEGER, message_content TEXT)")
        return t

    for i, msgs in plan["private"]:
        peer = wxid("f", i)
        t = table_for(peer)
        c.executemany(f"INSERT INTO {t} (create_time, real_sender_id, local_type, message_content) VALUES (?,?,?,?)",
                      [(ts, nid(me if from_self else peer), 1, text) for ts, from_self, text in msgs])
        sessions.append((peer, msgs[-1][0]))
    for g, _name, msgs in plan["groups"]:
        t = table_for(room(g))
        rows = []
        for ts, who, text in msgs:
            sender = me if who is None else wxid(who[0], who[1])
            rows.append((ts, nid(sender), 1, f"{sender}:\n{text}"))
        c.executemany(f"INSERT INTO {t} (create_time, real_sender_id, local_type, message_content) VALUES (?,?,?,?)", rows)
        sessions.append((room(g), msgs[-1][0]))
    c.commit()
    c.close()

    c = sqlite3.connect(str(d / "session.db"))
    c.execute("CREATE TABLE SessionTable (username TEXT, last_timestamp INTEGER, summary TEXT)")
    c.executemany("INSERT INTO SessionTable VALUES (?,?,?)", [(u, ts, "") for u, ts in sessions])
    c.commit()
    c.close()
    return d


def fake_sns_signals(ids: list[str], seed: int = 3) -> dict:
    """Deterministic per-friend Moments signals in get_sns_signals_cached's shape."""
    rng = random.Random(seed)
    out = {}
    for w in ids:
        if rng.random() < 0.4:
            out[w] = {"you_liked_them": rng.randint(0, 8), "you_commented_them": rng.randint(0, 3),
                      "they_liked_you": rng.randint(0, 8), "they_commented_you": rng.randint(0, 3),
                      "they_posted_count": rng.randint(0, 20)}
    return out


def fake_ff_moments(ids: list[str], seed: int = 5) -> dict:
    """Deterministic friend↔friend Moments pairs in sns.friend_to_friend_signals' shape."""
    rng = random.Random(seed)
    out = {}
    for _ in range(len(ids) * 2):
        a, b = sorted(rng.sample(ids, 2))
        out[(a, b)] = {"a": a, "b": b, "a_liked_b": rng.randint(0, 4), "a_commented_b": rng.randint(0, 2),
                       "b_liked_a": rng.randint(0, 4), "b_commented_a": rng.randint(0, 2), "examples": []}
    return out
