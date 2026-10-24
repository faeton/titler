"""ElevenLabs Scribe v2 runner (cloud). Sends audio to ElevenLabs ONLY when
ELEVENLABS_API_KEY is set; otherwise exits without any network access.

Word timestamps, language auto-detect, keyterm biasing.
Stdlib only (urllib + hand-rolled multipart), so it runs from any of the bench venvs:
  ELEVENLABS_API_KEY=... python bench/asr/run_scribe.py [--lang ru] [clips...]

API: POST https://api.elevenlabs.io/v1/speech-to-text  (model_id=scribe_v2)
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import CLIPS, KEYTERMS, AUDIO_DIR, save  # noqa: E402

URL = "https://api.elevenlabs.io/v1/speech-to-text"


def multipart(fields, files):
    b = uuid.uuid4().hex
    out = []
    for k, v in fields:
        out += [f"--{b}".encode(), f'Content-Disposition: form-data; name="{k}"'.encode(), b"", str(v).encode()]
    for k, (fname, data, ctype) in files.items():
        out += [f"--{b}".encode(),
                f'Content-Disposition: form-data; name="{k}"; filename="{fname}"'.encode(),
                f"Content-Type: {ctype}".encode(), b"", data]
    out += [f"--{b}--".encode(), b""]
    return b"\r\n".join(out), f"multipart/form-data; boundary={b}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="scribe-v2")
    ap.add_argument("--lang", default=None, help="ISO code; omit for auto-detect (default)")
    ap.add_argument("--audio", default="48k", choices=["16k", "48k"])
    ap.add_argument("clips", nargs="*", default=CLIPS)
    a = ap.parse_args()

    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        print("ELEVENLABS_API_KEY not set - not sending audio anywhere. Skipping.", file=sys.stderr)
        return 0

    for clip in a.clips:
        path = AUDIO_DIR / f"{clip}.{a.audio}.wav"
        fields = [("model_id", "scribe_v2"), ("timestamps_granularity", "word"),
                  ("tag_audio_events", "false"), ("diarize", "false")]
        if a.lang:
            fields.append(("language_code", a.lang))
        for t in KEYTERMS:
            fields.append(("keyterms", t))
        body, ctype = multipart(fields, {"file": (path.name, path.read_bytes(), "audio/wav")})
        req = urllib.request.Request(URL, data=body, method="POST",
                                     headers={"xi-api-key": key, "Content-Type": ctype})
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=300) as r:
            resp = json.load(r)
        dt = time.perf_counter() - t0
        words = [{"w": w["text"], "start": w.get("start"), "end": w.get("end")}
                 for w in resp.get("words", []) if w.get("type") == "word"]
        save(a.name, clip, lang=resp.get("language_code"), text=resp.get("text", ""), words=words,
             load_s=0.0, infer_s=dt, threads=0,
             meta={"backend": "ElevenLabs API scribe_v2 (wall time incl. upload)",
                   "lang_prob": resp.get("language_probability"), "keyterms": KEYTERMS,
                   "raw_words": resp.get("words")})
    return 0


if __name__ == "__main__":
    sys.exit(main())
