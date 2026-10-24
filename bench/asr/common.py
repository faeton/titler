"""Shared helpers for the ASR bench runners (stdlib + numpy/soundfile only).

Normalised output schema, one file per model x clip:
  bench/runs/asr/<model>/<clip>.json
  {model, clip, lang, text, words:[{w,start,end}]|null,
   timing:{load_s, infer_s, rtf, threads, audio_s, peak_rss_mb}, meta:{...}}
plus <clip>.txt with the plain text.
"""
from __future__ import annotations

import json
import os
import resource
import sys
import time
import wave
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
AUDIO_DIR = BENCH / "samples" / "audio"
RUNS = Path(os.environ.get("ASR_RUNS_DIR", BENCH / "runs" / "asr"))
CLIPS = ["video-34238", "video-34442", "video-34585"]
THREADS = int(os.environ.get("ASR_THREADS", "8"))

# Terms we want the models to get right (also used as prompt / hotwords where supported).
KEYTERMS = ["Awerti", "Esports Charts", "Streams Charts"]


def wav16(clip: str) -> Path:
    return AUDIO_DIR / f"{clip}.16k.wav"


def duration(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def load_np(path: Path):
    import numpy as np
    import soundfile as sf

    a, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if a.ndim > 1:
        a = a.mean(axis=1)
    return np.ascontiguousarray(a), sr


def peak_rss_mb() -> float:
    # ru_maxrss is KiB on Linux; peak over the whole process lifetime (model + all clips so far)
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Timer:
    def __enter__(self):
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        self.s = time.perf_counter() - self.t0


def words_from_tokens(tokens, starts, total_end, frame=0.04):
    """Group subword tokens (SentencePiece '▁' / leading-space convention) into words.

    starts[i] is the token emission time. A word's end = start of the next word's first
    token (capped at last-token-start + 0.4 s) — i.e. approximate, CTC/TDT-style.
    """
    words = []
    cur = None
    for tok, t in zip(tokens, starts):
        new_word = tok.startswith("▁") or tok.startswith(" ") or cur is None
        piece = tok.replace("▁", " ")
        if new_word:
            if cur:
                words.append(cur)
            cur = {"w": piece.strip(), "start": float(t), "last": float(t)}
        else:
            cur["w"] += piece
            cur["last"] = float(t)
    if cur:
        words.append(cur)
    words = [w for w in words if w["w"]]
    out = []
    for i, w in enumerate(words):
        nxt = words[i + 1]["start"] if i + 1 < len(words) else total_end
        end = min(nxt, w["last"] + 0.4) if nxt > w["last"] else w["last"] + frame
        out.append({"w": w["w"], "start": round(w["start"], 3), "end": round(max(end, w["start"] + frame), 3)})
    return out


def save(model: str, clip: str, *, lang, text: str, words, load_s: float, infer_s: float,
         threads: int = THREADS, meta: dict | None = None):
    audio_s = duration(wav16(clip))
    d = RUNS / model
    d.mkdir(parents=True, exist_ok=True)
    rec = {
        "model": model,
        "clip": clip,
        "lang": lang,
        "text": text.strip(),
        "words": words,
        "timing": {
            "load_s": round(load_s, 2),
            "infer_s": round(infer_s, 2),
            "rtf": round(infer_s / audio_s, 3),
            "threads": threads,
            "audio_s": round(audio_s, 2),
            "peak_rss_mb": peak_rss_mb(),
        },
        "meta": meta or {},
    }
    (d / f"{clip}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1))
    (d / f"{clip}.txt").write_text(rec["text"] + "\n")
    log(f"[{model}] {clip}: infer {infer_s:.1f}s rtf {rec['timing']['rtf']} lang={lang} :: {text[:120]}")
    return rec
