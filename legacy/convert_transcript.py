"""
Convert whisper.cpp JSON (from `whisper-cli -ml 1 -sow -oj`) into the
word-level format our ASS generator consumes.
"""

import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])

raw = json.loads(src.read_text())
words = []
for entry in raw.get("transcription", []):
    text = entry.get("text", "").strip()
    if not text:
        continue
    offs = entry.get("offsets", {})
    start = offs.get("from", 0) / 1000.0
    end = offs.get("to", 0) / 1000.0
    if end <= start:
        end = start + 0.05
    words.append({"start": round(start, 3), "end": round(end, 3), "word": text, "prob": 1.0})

duration = words[-1]["end"] if words else 0
out = {
    "language": raw.get("result", {}).get("language", "auto"),
    "duration": duration,
    "segments": [
        {
            "start": words[0]["start"] if words else 0,
            "end": duration,
            "text": " ".join(w["word"] for w in words),
            "words": words,
        }
    ],
}

dst.write_text(json.dumps(out, ensure_ascii=False, indent=2))
print(f"wrote {dst} ({len(words)} words, lang={out['language']})")
