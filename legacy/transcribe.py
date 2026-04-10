"""
Transcribe a video with faster-whisper large-v3 and emit a JSON with
word-level timings. Handles mixed RU/EN via auto-detect.
"""

import json
import sys
from pathlib import Path

from faster_whisper import WhisperModel

if len(sys.argv) < 3:
    print("usage: transcribe.py <audio_or_video> <out.json> [model]")
    sys.exit(1)

src = sys.argv[1]
out = Path(sys.argv[2])
model_size = sys.argv[3] if len(sys.argv) > 3 else "large-v3"

# CPU on Apple Silicon — ctranslate2 uses Accelerate; good enough for 60s.
# int8 keeps memory small.
print(f"loading model {model_size}...", flush=True)
model = WhisperModel(model_size, device="cpu", compute_type="int8")

print("transcribing...", flush=True)
segments_iter, info = model.transcribe(
    src,
    word_timestamps=True,
    vad_filter=True,
    vad_parameters={"min_silence_duration_ms": 300},
    beam_size=5,
    # let whisper auto-detect RU/EN
)

print(f"detected language: {info.language} ({info.language_probability:.2f})", flush=True)

segments = []
for seg in segments_iter:
    words = []
    if seg.words:
        for w in seg.words:
            words.append({
                "start": round(w.start, 3),
                "end": round(w.end, 3),
                "word": w.word,
                "prob": round(w.probability, 3),
            })
    segments.append({
        "start": round(seg.start, 3),
        "end": round(seg.end, 3),
        "text": seg.text.strip(),
        "words": words,
    })
    print(f"[{seg.start:6.2f} -> {seg.end:6.2f}] {seg.text.strip()}", flush=True)

out.write_text(json.dumps({
    "language": info.language,
    "duration": info.duration,
    "segments": segments,
}, ensure_ascii=False, indent=2))

print(f"\nwrote {out}")
