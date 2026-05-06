"""global_config.py — 解析 WeChat 4.x 的 all_users/config/global_config。

这个文件保存了所有曾在本机登录的微信账号的元信息（昵称 / 头像 URL / wxid 等）。
WeFlow 的 dbPathService.ts 用同样的算法：

    AES-128-CFB(key='xwechat_crypt_key' padded to 16, iv=zeros) → MMKV blob
    MMKV: 每条 entry 是 <varint key_len><key><varint val_len><value>

我们抽取 mmkv_key_user_name / mmkv_key_nick_name / mmkv_key_head_img_url，
让 Murmur 多账号选择器可以显示昵称+头像，不用再让用户对着裸 wxid 猜。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional


_KEY = b"xwechat_crypt_key"


def _aes_cfb_decrypt(blob: bytes) -> bytes:
    """AES-128-CFB with the constant key padded to 16 bytes and a zero IV."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    key = _KEY.ljust(16, b"\x00")[:16]
    iv = b"\x00" * 16
    decryptor = Cipher(algorithms.AES(key), modes.CFB(iv)).decryptor()
    return decryptor.update(blob) + decryptor.finalize()


def _read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    """Decode an MMKV varint (LEB128). Returns (value, new_position)."""
    result = 0
    shift = 0
    while pos < len(buf):
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")
    return result, pos


def _iter_mmkv(buf: bytes):
    """Yield (key_bytes, value_bytes) for each entry in the MMKV blob.

    MMKV stores a 4-byte LE total-content-length header, followed by tightly
    packed `<varint klen><key><varint vlen><value>` records. We tolerate
    arbitrary trailing junk: stop the moment a varint runs past the end.
    """
    if len(buf) < 4:
        return
    total = int.from_bytes(buf[:4], "little")
    end = min(len(buf), 4 + total)
    pos = 4
    while pos < end:
        try:
            klen, pos = _read_varint(buf, pos)
        except ValueError:
            return
        if pos + klen > end:
            return
        key = buf[pos: pos + klen]
        pos += klen
        try:
            vlen, pos = _read_varint(buf, pos)
        except ValueError:
            return
        if pos + vlen > end:
            return
        value = buf[pos: pos + vlen]
        pos += vlen
        yield key, value


def parse_global_config(blob: bytes) -> dict:
    """Decrypt + parse the global_config bytes. Returns {wxid, nick_name, head_img_url}.

    Each top-level MMKV value is itself a length-prefixed UTF-8 string that
    happens to live inside another varint length wrapper, so we strip that
    inner length when present.
    """
    plain = _aes_cfb_decrypt(blob)
    out: dict[str, str] = {}
    for key, value in _iter_mmkv(plain):
        try:
            kname = key.decode("utf-8", errors="ignore")
        except Exception:
            continue
        if kname not in {"mmkv_key_user_name", "mmkv_key_nick_name", "mmkv_key_head_img_url"}:
            continue
        # MMKV strings are wrapped: <varint len><utf8>. Try to peel that;
        # fall back to raw value if the inner length is bogus.
        try:
            inner_len, pos = _read_varint(value, 0)
        except ValueError:
            inner_len, pos = -1, 0
        if 0 <= inner_len <= len(value) - pos:
            text = value[pos: pos + inner_len].decode("utf-8", errors="replace")
        else:
            text = value.decode("utf-8", errors="replace")
        short = {
            "mmkv_key_user_name": "wxid",
            "mmkv_key_nick_name": "nick_name",
            "mmkv_key_head_img_url": "head_img_url",
        }[kname]
        out[short] = text
    return out


def find_global_config_path(xwechat_files_root: Path) -> Optional[Path]:
    """The file lives at all_users/config/global_config under any xwechat_files."""
    candidate = xwechat_files_root / "all_users" / "config" / "global_config"
    return candidate if candidate.exists() else None


def parse_for_xwechat(xwechat_files_root: Path) -> dict:
    """Convenience wrapper: locate + parse in one shot."""
    p = find_global_config_path(xwechat_files_root)
    if not p:
        return {}
    try:
        return parse_global_config(p.read_bytes())
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("path", help="Path to either xwechat_files dir or the global_config file directly")
    args = p.parse_args()
    target = Path(args.path)
    if target.is_file():
        info = parse_global_config(target.read_bytes())
    else:
        info = parse_for_xwechat(target)
    import json
    print(json.dumps(info, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
