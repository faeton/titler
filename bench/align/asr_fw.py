"""faster-whisper large-v3 transcript with word timings (Whisper DTW baseline).
Writes bench/runs/align/asr/<clip>.json (same shape as bench/runs/asr if present)."""
import json, sys, time, os
from pathlib import Path
from faster_whisper import WhisperModel

BENCH = Path(__file__).resolve().parents[1]
OUT = BENCH / "runs/align/asr"; OUT.mkdir(parents=True, exist_ok=True)
clips = sys.argv[1:] or ["video-34238", "video-34442", "video-34585"]
t = time.time()
m = WhisperModel("large-v3", device="cpu", compute_type="int8", cpu_threads=8)
print("load", time.time() - t, flush=True)
for c in clips:
    t = time.time()
    segs, info = m.transcribe(str(BENCH / f"samples/audio/{c}.16k.wav"), language=None,
                              word_timestamps=True, beam_size=5, vad_filter=False)
    out = {"clip": c, "language": info.language, "language_probability": info.language_probability,
           "segments": []}
    for s in segs:
        out["segments"].append({"start": s.start, "end": s.end, "text": s.text,
            "words": [{"w": w.word, "start": w.start, "end": w.end, "p": w.probability} for w in s.words]})
    out["wall_s"] = time.time() - t
    (OUT / f"{c}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(c, info.language, round(out["wall_s"], 1), " ".join(s["text"] for s in out["segments"])[:300], flush=True)
