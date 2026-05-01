"""transcribe_voice.py — Whisper-transcribe all echotrace mp3s.

Output: ~/Desktop/Murmur/voice_transcripts/<wxid_or_chatroom>/<basename>.txt
        + a per-friend index ~/Desktop/Murmur/voice_transcripts/_index.json
"""
from __future__ import annotations
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

def _find_voice_root() -> Path | None:
    """Echotrace's mp3s can sit in several places depending on how user installed it.

    Priority: env var → Documents/Murmur/voice → Documents/EchoTrace/voice → D: legacy
    """
    env = os.environ.get("MURMUR_VOICE_ROOT")
    if env and Path(env).exists():
        return Path(env)
    candidates = [
        Path.home() / "Documents" / "Murmur" / "voice",
        Path.home() / "Documents" / "EchoTrace" / "voice",
        Path.home() / "OneDrive" / "Documents" / "EchoTrace" / "voice",
    ]
    if sys.platform.startswith("win"):
        candidates += [
            Path("D:/Documents/EchoTrace/voice"),
            Path("D:/Documents/Murmur/voice"),
        ]
    for p in candidates:
        if p.exists() and any(p.rglob("*.mp3")):
            return p
    return None


VOICE_ROOT = _find_voice_root() or Path.home() / "Documents" / "EchoTrace" / "voice"
OUT_ROOT = Path.home() / "Desktop" / "Murmur" / "voice_transcripts"

MODEL_NAME = "small"          # 244M params; good Chinese; ~5x realtime on CPU
LANGUAGE = "zh"
WORKERS = 1                   # faster-whisper is multi-threaded internally; 1 process = enough


def collect_files() -> list[tuple[Path, Path]]:
    """Returns list of (mp3, out_txt). Skips already-transcribed."""
    pairs: list[tuple[Path, Path]] = []
    for mp3 in VOICE_ROOT.rglob("*.mp3"):
        rel = mp3.relative_to(VOICE_ROOT)
        out = (OUT_ROOT / rel).with_suffix(".txt")
        if out.exists() and out.stat().st_size > 0:
            continue
        pairs.append((mp3, out))
    return pairs


def transcribe_batch(jobs: list[tuple[Path, Path]]) -> None:
    from faster_whisper import WhisperModel
    print(f"[whisper] loading model {MODEL_NAME}...")
    model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    print(f"[whisper] model ready, transcribing {len(jobs)} files")

    for i, (mp3, out) in enumerate(jobs, 1):
        out.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        try:
            segs, info = model.transcribe(str(mp3), language=LANGUAGE, beam_size=5,
                                           vad_filter=True)
            text = " ".join(s.text.strip() for s in segs).strip()
            elapsed = time.time() - t0
            duration = info.duration or 0
            speedup = duration / elapsed if elapsed > 0 else 0
            out.write_text(text, encoding="utf-8")
            print(f"  [{i}/{len(jobs)}] {mp3.parent.name}/{mp3.name} "
                  f"({duration:.1f}s audio, {elapsed:.1f}s, {speedup:.1f}x): "
                  f"{text[:60]!r}")
        except Exception as e:
            print(f"  [{i}/{len(jobs)}] ERR {mp3.name}: {e}")


def build_per_friend_index() -> None:
    """Aggregate per-friend transcripts: voice_transcripts/<wxid>/*.txt → index entry."""
    if not OUT_ROOT.exists():
        return
    index: dict[str, dict] = {}
    for sub in OUT_ROOT.iterdir():
        if not sub.is_dir():
            continue
        # Filename pattern: <unix_ts>_<msg_id>_<sender_wxid>.mp3 → .txt
        clips = []
        total_chars = 0
        for txt in sorted(sub.glob("*.txt")):
            try:
                content = txt.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if not content:
                continue
            # Try to parse timestamp from filename
            stem = txt.stem
            ts = 0
            sender = ""
            parts = stem.split("_", 2)
            if parts and parts[0].isdigit():
                ts = int(parts[0])
            if len(parts) >= 3:
                sender = parts[2]
            clips.append({"ts": ts, "sender": sender,
                          "file": txt.name, "text": content})
            total_chars += len(content)
        if clips:
            clips.sort(key=lambda c: c["ts"])
            index[sub.name] = {
                "scope": sub.name,
                "clips_count": len(clips),
                "total_chars": total_chars,
                "clips": clips,
            }
    (OUT_ROOT / "_index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n[index] {len(index)} scopes, "
          f"{sum(s['clips_count'] for s in index.values())} clips total")


def main():
    if not VOICE_ROOT.exists():
        print(f"[X] voice root not found: {VOICE_ROOT}")
        sys.exit(1)
    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    jobs = collect_files()
    print(f"[*] {len(jobs)} mp3 to transcribe")
    if not jobs:
        print("[*] all done already")
    else:
        transcribe_batch(jobs)

    build_per_friend_index()
    print("[done]")


if __name__ == "__main__":
    main()
