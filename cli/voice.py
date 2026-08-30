"""voice.py — WeChat 语音消息提取与转文字

两步流程:
  1. silk → mp3   (Windows: echotrace 自带的 silk_v3_decoder.exe；macOS/Linux: pilk 本地解码 + ffmpeg 转 mp3)
  2. mp3 → 文字   (用本地 Whisper, 可选)

使用:
    python voice.py info                # 当前语音覆盖统计
    python voice.py extract             # 把所有 silk 转 mp3
    python voice.py transcribe          # 把所有 mp3 用 Whisper 转文字 (需先 pip install openai-whisper)
    python voice.py transcribe --wxid xxx  # 只转某个朋友的语音
"""
from __future__ import annotations
import argparse
import json
import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterator

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import (  # noqa: E402
    discover_wechat_profiles, decrypted_root_for, media_root_for,
    IS_WINDOWS, native_dir,
)


# ---------- silk decoder (Windows: silk_v3_decoder.exe from echotrace) ----------

def _find_silk_decoder() -> Path | None:
    """Find silk_v3_decoder.exe — bundled with echotrace, or our native dir."""
    # 1. Murmur native dir
    nd = native_dir()
    cand = nd / "silk_v3_decoder.exe"
    if cand.exists():
        return cand
    # 2. echotrace download (legacy)
    et = Path(r"C:\Users\YY\Downloads\echotrace-main\echotrace-main\assets\silk_v3_decoder.exe")
    if et.exists():
        return et
    # 3. echotrace install dir
    et2 = Path(r"C:\Users\YY\Downloads\echotrace-windows-v3.0.2\silk_v3_decoder.exe")
    if et2.exists():
        return et2
    return None


def _silk_to_mp3_windows(silk_path: Path, mp3_path: Path) -> bool:
    decoder = _find_silk_decoder()
    if not decoder:
        raise RuntimeError("silk_v3_decoder.exe not found. Get it from echotrace project.")
    # silk_v3_decoder takes input + output paths
    r = subprocess.run([str(decoder), str(silk_path), str(mp3_path)],
                       capture_output=True, timeout=60)
    return r.returncode == 0 and mp3_path.exists() and mp3_path.stat().st_size > 0


def _silk_to_mp3_pilk(silk_path: Path, mp3_path: Path) -> bool:
    """macOS/Linux: decode via `pilk` (pip install pilk — pure C SILK v3 codec,
    builds locally with a C compiler, no Windows binary needed), then transcode
    the PCM wav to mp3 with ffmpeg so the output stays a drop-in .mp3 file."""
    try:
        import pilk
    except ImportError:
        raise RuntimeError("pilk not installed. Run: pip install pilk (needs a C compiler).")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found on PATH; needed to transcode wav -> mp3.")
    wav_path = mp3_path.with_suffix(".wav")
    try:
        pilk.silk_to_wav(str(silk_path), str(wav_path))
        if not wav_path.exists() or wav_path.stat().st_size == 0:
            return False
        r = subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(wav_path), str(mp3_path)],
                           capture_output=True, timeout=60)
        return r.returncode == 0 and mp3_path.exists() and mp3_path.stat().st_size > 0
    finally:
        try:
            wav_path.unlink()
        except OSError:
            pass


def silk_to_mp3(silk_path: Path, mp3_path: Path) -> bool:
    """Decode a single .silk → .mp3. Returns True on success."""
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    if IS_WINDOWS:
        return _silk_to_mp3_windows(silk_path, mp3_path)
    return _silk_to_mp3_pilk(silk_path, mp3_path)


# ---------- Locating voice payloads in WeChat 4.x ----------
#
# message_*.db's `Msg_<md5>` rows of type=34 do NOT contain the audio. Their
# `message_content` is zstd-compressed XML metadata only, e.g.:
#   <msg><voicemsg voiceformat="4" length="6554" voicelength="3850" .../></msg>
# `length` there is exactly the byte length of the real payload, which lives
# in a SEPARATE db, media_*.db, table `VoiceInfo(chat_name_id, create_time,
# local_id, svr_id, voice_data, data_index)` — `voice_data` is the raw
# Tencent-flavoured SILK stream (`\x02#!SILK_V3...`), ready for pilk as-is.
# `local_id` alone collides across different Msg_<hash> tables (each has its
# own AUTOINCREMENT), so the join key is (local_id, create_time) together.

VOICE_TYPE = 34


def _load_voice_data_index(decrypted_dir: Path) -> dict[tuple[int, int], bytes]:
    """{(local_id, create_time): raw_silk_bytes} from every media_*.db's VoiceInfo table."""
    index: dict[tuple[int, int], bytes] = {}
    for p in sorted(decrypted_dir.glob("media_*.db")):
        c = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True)
        try:
            has_table = c.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='VoiceInfo'"
            ).fetchone()
            if not has_table:
                continue
            for local_id, ts, data in c.execute(
                "SELECT local_id, create_time, voice_data FROM VoiceInfo"
            ):
                if data:
                    index[(local_id, ts)] = data
        except sqlite3.OperationalError:
            continue
        finally:
            c.close()
    return index


def find_voice_messages(decrypted_dir: Path, *, wxid_filter: str | None = None) -> Iterator[dict]:
    """Yield {db, table, local_id, create_time, sender, voice_data} for every voice message.

    voice_data is the raw SILK payload pulled from media_*.db's VoiceInfo table
    (None if this particular message's audio wasn't found there)."""
    import hashlib
    voice_index = _load_voice_data_index(decrypted_dir)
    for p in sorted(decrypted_dir.glob("message_*.db")):
        if any(skip in p.name for skip in ("_fts", "_resource", "biz_")):
            continue
        c = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True)
        c.text_factory = bytes  # critical: get binary, not decoded str
        try:
            tables = [r[0].decode("utf-8") for r in c.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
            ).fetchall()]
            for t in tables:
                if wxid_filter:
                    target = f"Msg_{hashlib.md5(wxid_filter.encode()).hexdigest()}"
                    if t != target:
                        continue
                try:
                    rows = c.execute(
                        f"SELECT local_id, create_time, real_sender_id, message_content, "
                        f"compress_content, packed_info_data "
                        f"FROM {t} WHERE local_type=?",
                        (VOICE_TYPE,)
                    ).fetchall()
                except sqlite3.OperationalError:
                    continue
                for local_id, ts, sid, content, compress, packed in rows:
                    yield {
                        "db": p.name, "table": t,
                        "local_id": local_id, "create_time": ts,
                        "sender_id": sid, "content": content,
                        "compress": compress, "packed": packed,
                        "voice_data": voice_index.get((local_id, ts)),
                    }
        finally:
            c.close()


def extract_silk_from_blob(blob: bytes) -> bytes | None:
    """Extract raw SILK audio bytes from the WeChat blob.

    WeChat 4.x voice messages are zstd-compressed. The SILK header starts with `#!SILK_V3`
    (bytes: 0x23 0x21 0x53 0x49 0x4C 0x4B 0x5F 0x56 0x33).
    """
    if not blob:
        return None
    try:
        import zstandard as zstd
    except ImportError:
        sys.stderr.write("[voice] zstandard not installed: pip install zstandard\n")
        return None
    SILK_MAGIC = b"#!SILK_V3"
    # Try direct (some blobs may not be zstd)
    if blob.startswith(SILK_MAGIC):
        return blob
    # Try zstd decompress
    try:
        dctx = zstd.ZstdDecompressor()
        decoded = dctx.decompress(blob, max_output_size=10 * 1024 * 1024)
        if decoded.startswith(SILK_MAGIC):
            return decoded
        # Some blobs have a header before SILK
        idx = decoded.find(SILK_MAGIC)
        if idx >= 0:
            return decoded[idx:]
    except Exception:
        pass
    # Fallback: search for magic in raw blob
    idx = blob.find(SILK_MAGIC)
    if idx >= 0:
        return blob[idx:]
    return None


# ---------- Bulk extract ----------

def cmd_info(args):
    profs = discover_wechat_profiles()
    if not profs:
        print("[X] No WeChat profile found.")
        return
    decrypted = decrypted_root_for(profs[0])
    media = media_root_for(profs[0])

    n_db = sum(1 for _ in find_voice_messages(decrypted))
    et_dirs = [Path.home() / "Documents" / "EchoTrace" / "voice",
                Path.home() / "OneDrive" / "Documents" / "EchoTrace" / "voice"]
    if sys.platform.startswith("win"):
        et_dirs.append(Path("D:/Documents/EchoTrace/voice"))
    et_mp3 = sum(sum(1 for _ in d.rglob("*.mp3")) for d in et_dirs if d.exists())
    mr_voice_root = media / "voice"
    mr_mp3 = sum(1 for _ in mr_voice_root.rglob("*.mp3")) if mr_voice_root.exists() else 0
    transcribed_root = _find_voice_mp3_root()
    transcript_count = 0
    if transcribed_root:
        tp = transcribed_root / "_transcripts.json"
        if tp.exists():
            try:
                transcript_count = len(json.loads(tp.read_text(encoding="utf-8")))
            except Exception:
                pass

    print(f"=== Voice messages ===")
    print(f"  DB rows (type=34):     {n_db}")
    print(f"  echotrace mp3 (legacy): {et_mp3}  (search: {[str(d) for d in et_dirs]})")
    print(f"  Murmur mp3:            {mr_mp3}  ({mr_voice_root})")
    print(f"  Transcribed:           {transcript_count}")
    print(f"  silk_v3_decoder.exe:   {_find_silk_decoder()}")
    print(f"")
    print(f"NOTE: WeChat 4.x uses per-message AES keys for voices (stored in XML metadata)")
    print(f"      and CDN-hosted .silk files. Direct extraction is non-trivial — see")
    print(f"      voice.py find_voice_messages() docstring. For now, leverage echotrace's")
    print(f"      pre-extracted mp3s + Whisper transcription via `voice.py transcribe`.")


def cmd_extract(args):
    profs = discover_wechat_profiles()
    if not profs:
        print("[X] No WeChat profile found.")
        return
    decrypted = decrypted_root_for(profs[0])
    out_root = media_root_for(profs[0]) / "voice"
    out_root.mkdir(parents=True, exist_ok=True)

    n_total = ok = skipped = failed = 0
    t0 = time.time()
    for v in find_voice_messages(decrypted, wxid_filter=args.wxid):
        n_total += 1
        # The real payload lives in media_*.db's VoiceInfo table (see
        # find_voice_messages docstring) — message_content is just XML
        # metadata. Fall back to the old direct-blob scan in case some
        # message predates VoiceInfo or media_*.db is missing.
        silk_bytes = v.get("voice_data")
        if not silk_bytes:
            for blob in (v["compress"], v["content"]):
                if isinstance(blob, bytes):
                    silk_bytes = extract_silk_from_blob(blob)
                    if silk_bytes:
                        break
        if not silk_bytes:
            failed += 1
            continue

        # Write silk to a temp .silk file, then decode to mp3
        out_dir = out_root / v["table"][:30]
        out_dir.mkdir(parents=True, exist_ok=True)
        silk_path = out_dir / f"{v['create_time']}_{v['local_id']}.silk"
        mp3_path = out_dir / f"{v['create_time']}_{v['local_id']}.mp3"
        if mp3_path.exists():
            skipped += 1
            continue
        silk_path.write_bytes(silk_bytes)
        try:
            if silk_to_mp3(silk_path, mp3_path):
                ok += 1
            else:
                failed += 1
        except Exception as e:
            sys.stderr.write(f"[voice] decode failed for {silk_path}: {e}\n")
            failed += 1
        finally:
            try: silk_path.unlink()
            except: pass

        if n_total % 50 == 0:
            print(f"  [{n_total}] ok={ok}, skipped={skipped}, failed={failed}, elapsed={time.time()-t0:.1f}s")
        if args.limit and n_total >= args.limit:
            break

    print(f"\n[DONE] total={n_total}, ok={ok}, skipped={skipped}, failed={failed}, "
          f"elapsed={time.time()-t0:.1f}s")
    print(f"  output: {out_root}")


def _find_voice_mp3_root() -> Path | None:
    """Find the directory holding extracted voice .mp3 files.
    Try Murmur's location first, then fall back to legacy echotrace dirs."""
    profs = discover_wechat_profiles()
    if not profs:
        return None
    candidates = [
        media_root_for(profs[0]) / "voice",
        Path.home() / "Documents" / "EchoTrace" / "voice",
        Path.home() / "OneDrive" / "Documents" / "EchoTrace" / "voice",
    ]
    if sys.platform.startswith("win"):
        candidates.append(Path("D:/Documents/EchoTrace/voice"))
    for c in candidates:
        if c.exists() and any(c.rglob("*.mp3")):
            return c
    return None


def cmd_transcribe(args):
    """Transcribe extracted .mp3 voices to text using Whisper (local)."""
    try:
        import whisper  # type: ignore
    except ImportError:
        print("[X] whisper not installed. Install: pip install -U openai-whisper")
        print("    Also need ffmpeg on PATH (https://ffmpeg.org/)")
        sys.exit(2)

    out_root = _find_voice_mp3_root()
    if not out_root:
        print("[X] No voice mp3 found anywhere. Voice extraction blocked by per-message key issue;")
        print("    use echotrace once to populate ~/Documents/EchoTrace/voice/, then re-run.")
        return

    print(f"[*] Loading Whisper {args.model}...")
    model = whisper.load_model(args.model)

    # Index existing transcripts
    transcript_path = out_root / "_transcripts.json"
    transcripts: dict = json.loads(transcript_path.read_text(encoding="utf-8")) if transcript_path.exists() else {}

    mp3s = list(out_root.rglob("*.mp3"))
    if args.limit:
        mp3s = mp3s[:args.limit]
    print(f"[*] {len(mp3s)} mp3 to transcribe (already have {len(transcripts)})...")

    n_done = 0; t0 = time.time()
    for mp3 in mp3s:
        rel = str(mp3.relative_to(out_root)).replace("\\", "/")
        if rel in transcripts:
            continue
        try:
            r = model.transcribe(str(mp3), language="zh")
            transcripts[rel] = {
                "text": r["text"].strip(),
                "duration": r.get("duration", 0),
            }
            n_done += 1
        except Exception as e:
            transcripts[rel] = {"error": str(e)}
        if n_done % 5 == 0 and n_done > 0:
            transcript_path.write_text(json.dumps(transcripts, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"  [{n_done}] elapsed={time.time()-t0:.1f}s")
    transcript_path.write_text(json.dumps(transcripts, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[DONE] transcribed {n_done} files in {time.time()-t0:.1f}s")
    print(f"  saved → {transcript_path}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("info")
    sp = sub.add_parser("extract")
    sp.add_argument("--wxid", help="Only extract voices from this friend's chat")
    sp.add_argument("--limit", type=int)
    sp = sub.add_parser("transcribe")
    sp.add_argument("--model", default="base", choices=["tiny", "base", "small", "medium", "large"],
                    help="Whisper model size (base = ~140MB, good balance)")
    sp.add_argument("--limit", type=int)
    args = p.parse_args()
    funcs = {"info": cmd_info, "extract": cmd_extract, "transcribe": cmd_transcribe}
    funcs[args.cmd](args)


if __name__ == "__main__":
    main()
