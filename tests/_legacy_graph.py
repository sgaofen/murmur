"""Frozen copy of build_relationship_graph as it was before #24 (one-pass, always hits the DB).

Used only as a reference oracle by test_graph_raw_cache.py: the split
collect_graph_raw + build_graph_from_raw path must reproduce this output
exactly. Do not "fix" or refactor this file — it is a snapshot.
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import etcli
from etcli import (  # noqa: F401
    CST,
    EchoStore,
    _CACHE_TTL,
    _FF_MOMENTS_CACHE,
    _compute_friend_topology,
    _time,
    fast_message_count,
    get_friend_mentions_cached,
    get_sns_signals_cached,
)

# sns is imported relative to etcli's own directory inside the function.
__file__ = etcli.__file__  # noqa: A001


def legacy_build_relationship_graph(store: EchoStore, *,
                               scope: str = "private",
                               min_private: int = 10,
                               recent_days: int = 365,
                               top_n: int = 100,
                               show_clusters: bool = False) -> dict:
    """Build the relationship graph: nodes = people, edges with real interaction signals.

    scope filters:
      "private" (default) — Only people you have a 1-on-1 with msg_count >= min_private,
                            OR who you've been recently active with (last `recent_days`).
                            Strangers from groups are dropped. <= ~115 nodes for typical user.
      "recent"            — Same as private but with stricter recent_days threshold.
      "all"               — Everyone who appeared anywhere (the old behavior, ~575+ nodes).

    Edge types:
    - private: self ↔ each friend you have a 1-on-1 with (weight = msg count)
    - co_group: friend ↔ friend who appear in same group (lightest signal)
    - mutual_reply: friend A replied to friend B's group msg within 5 min (real interaction)

    Also nodes carry: msgs_in_groups (their public activity), sns_interaction (Moments back/out)
    """
    contacts = store.contacts()
    sessions = store.sessions()

    # Step 1: For each group, scan messages to find:
    #   (a) which wxids spoke (active members)
    #   (b) mutual replies — who replied to whom within 5 min
    group_members: dict[str, set[str]] = {}
    group_msg_count: dict[str, dict[str, int]] = {}  # group → {wxid: msg count}
    mutual_reply: dict[tuple[str, str], int] = {}  # (a,b) sorted → reply count

    # Track per-pair, per-group counts so we can dampen large-group noise after collection.
    mutual_reply_per_group: dict[str, dict[tuple[str, str], int]] = {}

    # Time-bound group message reads to `recent_days` window. For 10GB+ QQ
    # nt_msg.db this turns "scan every message in every group ever" into a
    # bounded window. Mutual-reply detection only needs recent activity to
    # surface live relationships; ancient history doesn't change the graph.
    _now_ts = int(datetime.now(CST).timestamp())
    _msg_since = _now_ts - recent_days * 86400 if recent_days else None
    # Per-group message cap: protect against pathological 500K+ message groups.
    # Mutual-reply counts are capped later anyway (per_pair_cap ~20), so reading
    # the first 50K recent messages already captures every meaningful pair.
    _PER_GROUP_MAX = 50000
    for s in sessions:
        if not s.is_group:
            continue
        senders: set[str] = set()
        per_user: dict[str, int] = {}
        prev_msgs: list[tuple[int, str]] = []
        per_group_pairs: dict[tuple[str, str], int] = {}
        msgs_processed = 0

        for m in store.messages(s.username, text_only=False, since=_msg_since):
            if m.sender_wxid == "self" or not m.sender_wxid:
                continue
            senders.add(m.sender_wxid)
            per_user[m.sender_wxid] = per_user.get(m.sender_wxid, 0) + 1

            cutoff = m.create_time - 300  # 5 min
            prev_msgs = [(t, w) for t, w in prev_msgs if t >= cutoff]
            for t, prev_wxid in prev_msgs:
                if prev_wxid != m.sender_wxid:
                    a, b = sorted([m.sender_wxid, prev_wxid])
                    per_group_pairs[(a, b)] = per_group_pairs.get((a, b), 0) + 1
            prev_msgs.append((m.create_time, m.sender_wxid))

            msgs_processed += 1
            if msgs_processed >= _PER_GROUP_MAX:
                break

        if senders:
            group_members[s.username] = senders
            group_msg_count[s.username] = per_user
            mutual_reply_per_group[s.username] = per_group_pairs

    # Aggregate mutual_reply with size-aware dampening.
    # Big groups (50+ members) inflate co-presence noise: 2 random people in a 200-person
    # group will cross paths often. Cap each group's contribution by a logarithmic factor.
    import math
    for gname, pair_counts in mutual_reply_per_group.items():
        size = len(group_members.get(gname, ()))
        # Damp factor: 1.0 for ≤10 members, fades to ~0.3 for 200+ members.
        damp = 1.0 if size <= 10 else max(0.3, 10 / size)
        # Also cap each individual pair's contribution to keep the strongest groups from dominating
        per_pair_cap = max(20, 200 // max(1, size // 10))
        for pair, n in pair_counts.items():
            contribution = min(n, per_pair_cap) * damp
            mutual_reply[pair] = mutual_reply.get(pair, 0) + contribution
    # Round (was floats now)
    mutual_reply = {p: int(round(v)) for p, v in mutual_reply.items() if v >= 1}

    # Step 2: Private chat strengths
    private_strength: dict[str, int] = {}
    for s in sessions:
        if s.is_group:
            continue
        cnt = fast_message_count(store, s.username)
        if cnt > 0:
            private_strength[s.username] = cnt

    # Step 4: Aggregate per-person group activity
    msgs_in_groups: dict[str, int] = {}
    groups_per_friend: dict[str, int] = {}
    for g, per_user in group_msg_count.items():
        for w, n in per_user.items():
            msgs_in_groups[w] = msgs_in_groups.get(w, 0) + n
            groups_per_friend[w] = groups_per_friend.get(w, 0) + 1

    # Step 5: Pull SNS (Moments) signals
    sns_per_friend = get_sns_signals_cached(store)

    # Step 5b: Friend-to-friend mention extraction (deep relationship inference)
    # When you and A talk about B, that's the strongest evidence A↔B know each other.
    try:
        # If the graph asks for all nodes (top_n <= 0), also scan all eligible private
        # friends for mention edges. Otherwise match the graph's visible candidate scale
        # while keeping a floor of 50 so small graphs still get useful cross-links.
        mention_top_n = 0 if top_n <= 0 else max(50, top_n)
        mention_pairs = get_friend_mentions_cached(store, top_n=mention_top_n, min_mention_count=3)
    except Exception as e:
        sys.stderr.write(f"[mentions] failed: {e}\n")
        mention_pairs = {}

    # Step 5c: Friend-to-friend Moments interactions (A liked/commented B's post — without you).
    # Strong independent evidence of A↔B relationship. Cached: scanning SnsTimeLine
    # is the slowest part of build_relationship_graph (~5s on a typical user).
    if _FF_MOMENTS_CACHE["data"] is not None and (_time.time() - _FF_MOMENTS_CACHE["ts"]) < _CACHE_TTL:
        ff_moments = _FF_MOMENTS_CACHE["data"]
    else:
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import sns as _sns_mod
            ff_moments = _sns_mod.friend_to_friend_signals(store.dir, store.me or "")
            _FF_MOMENTS_CACHE["data"] = ff_moments
            _FF_MOMENTS_CACHE["ts"] = _time.time()
        except Exception as e:
            sys.stderr.write(f"[ff_moments] failed: {e}\n")
            ff_moments = {}

    # Step 6: Build nodes — apply scope filter to keep graph focused
    now_ts = datetime.now(CST).timestamp()
    sessions_by_wxid = {s.username: s for s in store.sessions()}
    cutoff = now_ts - recent_days * 86400

    def keep_wxid(w: str) -> bool:
        if w == store.me:
            return False
        if w not in contacts:
            return False
        c = contacts[w]
        # **Filter out chatroom strangers** (people you've never added) — addresses
        # 用户的「不要把我没有的好友列进去」complaint.
        if not c.is_real_friend:
            return False
        priv = private_strength.get(w, 0)
        if scope == "all":
            return True
        if priv >= min_private:
            return True
        if priv > 0:
            s = sessions_by_wxid.get(w)
            if s and s.last_timestamp >= cutoff:
                return True
        if scope == "recent":
            return False
        # Also keep real friends with strong group activity (after dampening)
        if scope == "private":
            for (a, b), n in mutual_reply.items():
                if (a == w or b == w) and n >= 100:
                    return True
        return False

    candidate_wxids: set[str] = set(private_strength.keys())
    if scope == "all":
        for members in group_members.values():
            candidate_wxids.update(members)
    all_wxids = {w for w in candidate_wxids if keep_wxid(w)}

    # Compute combined "weight" per friend = private + group_activity + moments_interaction
    nodes = []
    nodes.append({
        "id": "self", "wxid": store.me or "self", "name": "你",
        "is_self": True, "tier": "self", "size": 100,
        "private_msgs": 0, "group_msgs": 0, "groups": len(group_members),
        "moments_back": 0, "moments_out": 0,
    })
    for w in sorted(all_wxids):
        if w == store.me:
            continue
        c = contacts.get(w)
        priv = private_strength.get(w, 0)
        gmsgs = msgs_in_groups.get(w, 0)
        ngroups = groups_per_friend.get(w, 0)
        sns = sns_per_friend.get(w, {}) if sns_per_friend else {}
        moments_back = (sns.get("they_liked_you", 0) + sns.get("they_commented_you", 0))
        moments_out = (sns.get("you_liked_them", 0) + sns.get("you_commented_them", 0))

        # Combined cross-context weight — this is the new "true closeness" score
        combined = (
            priv +                     # private chat (strong signal)
            gmsgs * 0.3 +              # group activity (weaker per-msg signal)
            ngroups * 50 +             # being in many shared groups
            moments_back * 30 +        # they engage with your Moments
            moments_out * 30           # you engage with theirs
        )

        # Tier from combined score (more nuanced than before)
        if combined >= 4000 or (priv >= 1500 and (moments_back + moments_out) >= 5):
            tier = "A"   # 老朋友 / 真朋友
        elif combined >= 1500 or priv >= 800 or ngroups >= 5:
            tier = "B"   # 常聊
        elif combined >= 400 or priv >= 100 or ngroups >= 2:
            tier = "C"
        elif combined >= 50 or priv > 0 or ngroups >= 1:
            tier = "D"
        else:
            tier = "E"
        size = max(8, min(60, int(combined ** 0.4)))
        nodes.append({
            "id": w, "wxid": w,
            "name": (c.display() if c else w),
            "is_self": False, "tier": tier, "size": size,
            "private_msgs": priv, "group_msgs": gmsgs, "groups": ngroups,
            "moments_back": moments_back, "moments_out": moments_out,
            "combined_score": round(combined),
        })

    # Cap nodes before constructing edges. Edges never influence node scoring, so this
    # keeps large groups from generating thousands of pairs that the final top-N filter
    # would throw away anyway.
    self_node = next((n for n in nodes if n.get("is_self")), None)
    other_nodes = [n for n in nodes if not n.get("is_self")]
    other_nodes.sort(key=lambda n: -n.get("combined_score", 0))
    if top_n > 0:
        other_nodes = other_nodes[:top_n]
    nodes = ([self_node] if self_node else []) + other_nodes
    node_id_set = {n["id"] for n in nodes}

    # Step 7: Edges
    edges = []
    edge_index: dict[tuple[str, str], dict] = {}

    def _pair_key(a: str, b: str) -> tuple[str, str]:
        return tuple(sorted([a, b]))

    def _add_edge(edge: dict) -> dict:
        edges.append(edge)
        if edge["source"] != "self" and edge["target"] != "self":
            edge_index[_pair_key(edge["source"], edge["target"])] = edge
        return edge

    # private (self ↔ friend)
    for w, cnt in private_strength.items():
        if w == store.me:
            continue
        if w not in node_id_set:
            continue
        _add_edge({"source": "self", "target": w, "type": "private", "weight": cnt})

    # mutual_reply (HIGH-VALUE: real friend-to-friend interaction in groups)
    for (a, b), n in mutual_reply.items():
        if a == store.me or b == store.me or a not in contacts or b not in contacts:
            continue
        if a not in node_id_set or b not in node_id_set:
            continue
        if n < 3:
            continue  # filter out trivial co-presence
        _add_edge({
            "source": a, "target": b, "type": "mutual_reply", "weight": n,
        })

    # mention edges (when YOU and A talked ABOUT B — strongest LLM-inferable signal of A↔B)
    for pair_key, rec in mention_pairs.items():
        a, b = rec["wxid_a"], rec["wxid_b"]
        cnt = rec["total_mentions"]
        if a not in node_id_set or b not in node_id_set:
            continue
        # If pair already has mutual_reply edge: ATTACH mention_count instead of dropping
        existing = edge_index.get(_pair_key(a, b))
        if existing is not None:
            existing["mention_count"] = cnt
            continue
        # Else add mention edge
        weight = min(1.0, cnt / 30.0)
        _add_edge({
            "source": a, "target": b, "type": "mention", "weight": weight,
            "mention_count": cnt,
        })

    # Co-group edges (light signal — same group). Build this after top-N selection
    # so large groups only produce pairs that can actually be rendered.
    co_group: dict[tuple[str, str], list[str]] = {}
    for group_username, members in group_members.items():
        members_list = sorted(w for w in members if w in node_id_set and w != "self")
        for i in range(len(members_list)):
            for j in range(i + 1, len(members_list)):
                co_group.setdefault((members_list[i], members_list[j]), []).append(group_username)

    # co_group (light: just same group, no actual interaction)
    for (a, b), groups in co_group.items():
        if a == store.me or b == store.me:
            continue
        if len(groups) < 2:
            continue
        # Attach to existing edge if any (so mutual_reply also shows shared_group_count)
        existing = edge_index.get(_pair_key(a, b))
        if existing is not None:
            existing["shared_group_count"] = len(groups)
            continue
        _add_edge({
            "source": a, "target": b, "type": "co_group",
            "shared_group_count": len(groups), "weight": len(groups),
        })

    # moments_cross — A and B interacted on each other's Moments (strong evidence,
    # entirely independent of your private/group chats).
    for (a, b), s in ff_moments.items():
        if a == store.me or b == store.me or a not in contacts or b not in contacts:
            continue
        if a not in node_id_set or b not in node_id_set:
            continue
        total = s["a_liked_b"] + s["a_commented_b"] + s["b_liked_a"] + s["b_commented_a"]
        if total < 2:
            continue
        # If pair already has another edge, augment its meta (and keep the edge)
        existing = edge_index.get(_pair_key(a, b))
        if existing is not None:
            existing["moments_cross"] = total
            continue
        # Otherwise add a new edge of type moments_cross
        _add_edge({
            "source": a, "target": b, "type": "moments_cross",
            "weight": min(1.0, total / 30.0),
            "moments_cross": total,
            "moments_a_to_b": s["a_liked_b"] + s["a_commented_b"],
            "moments_b_to_a": s["b_liked_a"] + s["b_commented_a"],
        })

    # Drop edges to filtered-out nodes as a final defensive pass.
    edges = [e for e in edges
             if e["source"] in node_id_set and e["target"] in node_id_set]

    # ---- Real core-circle + bridge detection on the friend-friend subgraph ----
    # 1) Cluster ("核心圈") via weighted label-propagation. Gives natural communities
    #    of friends who interact among themselves more than with the rest. Avoids
    #    NetworkX as a dependency — keeps the PyInstaller bundle small.
    # 2) Bridge ("桥梁人物") via betweenness centrality (Brandes' algorithm).
    #    Top 12% of friend nodes by betweenness, capped at 8.
    cluster_map, bridge_set, named_clusters = _compute_friend_topology(
        nodes, edges, contacts,
    )
    for n in nodes:
        if n.get("is_self"):
            n["cluster"] = None
            n["bridge"] = False
            continue
        n["cluster"] = cluster_map.get(n["id"])
        n["bridge"] = n["id"] in bridge_set

    if show_clusters:
        # Legacy: group-based clusters (pre-topology). Kept under explicit query
        # flag so any external callers expecting that shape still work.
        legacy_clusters = []
        for gname, members in group_members.items():
            kept = [m for m in members if m in node_id_set]
            if len(kept) < 2:
                continue
            c = contacts.get(gname)
            legacy_clusters.append({
                "id": gname,
                "label": (c.display() if c else gname),
                "members": kept + ["self"],
            })
        legacy_clusters.sort(key=lambda c: -len(c["members"]))
        clusters_out = legacy_clusters[:8]
    else:
        clusters_out = named_clusters

    return {
        "nodes": nodes,
        "edges": edges,
        "clusters": clusters_out,
        "stats": {
            "total_people": len(nodes) - 1,
            "total_edges": len(edges),
            "private_count": len(private_strength),
            "groups": len(group_members),
            "scope": scope,
            "filters": {"min_private": min_private, "recent_days": recent_days},
            "core_circles": len(named_clusters),
            "bridges": len(bridge_set),
        },
    }
