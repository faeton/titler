"""
Unified transcription script. Emits word-level JSON.

usage:
  transcribe.py <audio_or_video> <out.json>

Backend selection:
  1. env TITLER_WHISPER_BACKEND="mlx" | "faster"    (explicit override)
  2. otherwise: try mlx-whisper first (Apple Silicon), fall back to
     faster-whisper (cross-platform; CPU on Linux/Mac, CUDA on Linux
     when compute_type supports it).

Output shape (same regardless of backend):
  {
    "language": "en",
    "duration": 12.345,
    "backend": "mlx" | "faster",
    "words": [{ "start": 0.0, "end": 0.42, "text": "hello", "prob": 0.98 }, ...]
  }

Progress lines go to stderr. The final line on stdout is "DONE".
"""

import json
import os
import sys
import time
from pathlib import Path
from typing import Optional


DEFAULT_MLX_MODEL = "mlx-community/whisper-large-v3-mlx"
DEFAULT_FASTER_MODEL = "large-v3"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def transcribe_mlx(audio: str) -> Optional[dict]:
    try:
        import mlx_whisper  # noqa
    except ImportError:
        return None
    model = os.environ.get("TITLER_WHISPER_MODEL") or DEFAULT_MLX_MODEL
    log(f"backend=mlx model={model}")
    t0 = time.time()
    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=model,
        word_timestamps=True,
    )
    log(f"mlx transcribe done in {time.time() - t0:.1f}s")

    words: list[dict] = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []) or []:
            text = (w.get("word") or "").strip()
            if not text:
                continue
            words.append({
                "start": round(float(w["start"]), 3),
                "end": round(float(w["end"]), 3),
                "text": text,
                "prob": round(float(w.get("probability", 0.0)), 3),
            })
    duration = float(result.get("duration") or 0.0)
    if words:
        duration = max(duration, words[-1]["end"])
    return {
        "language": result.get("language", "unknown"),
        "duration": round(duration, 3),
        "backend": "mlx",
        "words": words,
    }


def transcribe_faster(audio: str) -> Optional[dict]:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None
    model_name = os.environ.get("TITLER_WHISPER_MODEL") or DEFAULT_FASTER_MODEL
    device = os.environ.get("TITLER_WHISPER_DEVICE") or "auto"
    compute_type = os.environ.get("TITLER_WHISPER_COMPUTE_TYPE") or "int8"
    log(f"backend=faster model={model_name} device={device} compute_type={compute_type}")
    t0 = time.time()
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments_iter, info = model.transcribe(
        audio,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
        beam_size=5,
    )
    words: list[dict] = []
    for seg in segments_iter:
        if not seg.words:
            continue
        for w in seg.words:
            text = (w.word or "").strip()
            if not text:
                continue
            words.append({
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "text": text,
                "prob": round(float(w.probability), 3),
            })
        log(f"[{seg.start:6.2f} -> {seg.end:6.2f}] {seg.text.strip()[:80]}")
    log(f"faster-whisper done in {time.time() - t0:.1f}s, lang={info.language}")
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    if words:
        duration = max(duration, words[-1]["end"])
    return {
        "language": info.language,
        "duration": round(duration, 3),
        "backend": "faster",
        "words": words,
    }


def main() -> int:
    if len(sys.argv) < 3:
        log("usage: transcribe.py <audio_or_video> <out.json>")
        return 2

    src = sys.argv[1]
    out_path = Path(sys.argv[2])

    override = os.environ.get("TITLER_WHISPER_BACKEND", "").strip().lower()
    if override == "mlx":
        result = transcribe_mlx(src)
        if result is None:
            log("mlx-whisper not installed; cannot honor TITLER_WHISPER_BACKEND=mlx")
            return 1
    elif override == "faster":
        result = transcribe_faster(src)
        if result is None:
            log("faster-whisper not installed; cannot honor TITLER_WHISPER_BACKEND=faster")
            return 1
    else:
        result = transcribe_mlx(src)
        if result is None:
            log("mlx-whisper not available, trying faster-whisper")
            result = transcribe_faster(src)
        if result is None:
            log("no supported whisper backend installed "
                "(expected mlx-whisper or faster-whisper)")
            return 1

    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    log(
        f"wrote {out_path} ({len(result['words'])} words, "
        f"{result['duration']:.1f}s, backend={result['backend']})"
    )
    print("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
