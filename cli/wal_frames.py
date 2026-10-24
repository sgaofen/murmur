"""wal_frames.py — dependency-free SQLite WAL frame walker.

Pure parsing helpers, deliberately kept free of `cryptography` so they can be
unit-tested on CI (which installs no third-party packages) and reused by both
the decrypt path (`decrypt_py.decrypt_wal`) and the live-sync poller.

SQLite WAL layout (https://www.sqlite.org/fileformat.html#the_write_ahead_log):

    header (32 bytes):
        0  magic          0x377f0682 / 0x377f0683
        4  format version
        8  page size
        12 checkpoint sequence
        16 salt-1         \\ copied into every frame header written during
        20 salt-2         /  this WAL "generation"
        24 checksum-1, 28 checksum-2
    frame header (24 bytes) + page data:
        0  page number
        4  db size in pages after commit (non-zero => commit frame)
        8  salt-1, 12 salt-2   (must equal the WAL header's salts)
        16 checksum-1, 20 checksum-2

After a checkpoint SQLite *reuses* the -wal file from the start with fresh
salts, so the tail of the file usually still holds frames from the previous
generation. Those stale frames are still valid SQLCipher pages (same key, page
HMAC does not cover the WAL salt), so the old Murmur walker happily replayed
them over newer data. A frame belongs to the live log only if its salts match
the header; the first mismatch ends the log. Frames after the last commit frame
belong to a transaction that has not committed yet and must be ignored too.

The cumulative frame checksums are not verified here: salt + commit boundary
already reject every stale/torn frame SQLite itself would, except bit-rot,
which the per-page SQLCipher HMAC catches.
"""
from __future__ import annotations

import struct
from typing import List, NamedTuple, Optional

WAL_HEADER_SIZE = 32
WAL_FRAME_HEADER_SIZE = 24
WAL_MAGIC_LE = 0x377F0682
WAL_MAGIC_BE = 0x377F0683


class WalHeader(NamedTuple):
    magic: int
    version: int
    page_size: int
    checkpoint_seq: int
    salt: bytes  # salt-1 + salt-2, 8 raw bytes


class WalFrame(NamedTuple):
    index: int        # 0-based frame index in the file
    offset: int       # byte offset of the frame header
    page_no: int
    commit_size: int  # non-zero on commit frames


def parse_wal_header(buf: bytes) -> Optional[WalHeader]:
    if len(buf) < WAL_HEADER_SIZE:
        return None
    magic, version, page_size, ckpt = struct.unpack(">IIII", buf[0:16])
    if magic not in (WAL_MAGIC_LE, WAL_MAGIC_BE):
        return None
    return WalHeader(magic, version, page_size, ckpt, bytes(buf[16:24]))


def valid_wal_frames(buf: bytes, page_size: Optional[int] = None) -> List[WalFrame]:
    """Return the committed frames of the *current* WAL generation, in order.

    - Stops at the first frame whose salt differs from the header salt (a
      frame left over from an earlier checkpoint cycle, or a torn write).
    - Drops trailing frames after the last commit frame (uncommitted txn).
    - `page_size` (optional) must match the header's page size, else [].
    """
    hdr = parse_wal_header(buf)
    if hdr is None:
        return []
    if page_size is not None and hdr.page_size != page_size:
        return []
    if hdr.page_size <= 0:
        return []
    frame_total = WAL_FRAME_HEADER_SIZE + hdr.page_size
    n_frames = (len(buf) - WAL_HEADER_SIZE) // frame_total
    committed: List[WalFrame] = []
    pending: List[WalFrame] = []
    for fi in range(n_frames):
        off = WAL_HEADER_SIZE + fi * frame_total
        page_no, commit_size = struct.unpack(">II", buf[off:off + 8])
        if bytes(buf[off + 8:off + 16]) != hdr.salt:
            break
        if page_no <= 0:
            break
        pending.append(WalFrame(fi, off, page_no, commit_size))
        if commit_size:
            committed.extend(pending)
            pending = []
    return committed
