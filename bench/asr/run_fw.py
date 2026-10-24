"""faster-whisper runner (same decode params as scripts/transcribe.py: int8, beam 5,
silero VAD min_silence 300 ms, word_timestamps).

usage: run_fw.py --name NAME --model MODEL_OR_CT2_DIR [--lang ru|auto] [--multilingual]
                 [--prompt TEXT] [clips...]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import CLIPS, THREADS, Timer, log, save, wav16  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True)
ap.add_argument("--model", required=True)
ap.add_argument("--lang", default="auto")
ap.add_argument("--multilingual", action="store_true", help="per-segment language detection")
ap.add_argument("--prompt", default=None)
ap.add_argument("--no-vad", action="store_true")
ap.add_argument("clips", nargs="*", default=CLIPS)
a = ap.parse_args()

from faster_whisper import WhisperModel  # noqa: E402
import numpy as np  # noqa: E402

with Timer() as tl:
    m = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=THREADS, num_workers=1)
    # warm-up (counted in load time): 2 s of silence
    list(m.transcribe(np.zeros(32000, dtype=np.float32), language="ru")[0])
log(f"load {tl.s:.1f}s")

for clip in a.clips:
    kw = dict(word_timestamps=True, vad_filter=not a.no_vad, vad_parameters={"min_silence_duration_ms": 300},
              beam_size=5)
    if a.lang != "auto":
        kw["language"] = a.lang
    if a.multilingual:
        kw["multilingual"] = True
    if a.prompt:
        kw["initial_prompt"] = a.prompt
    with Timer() as ti:
        segs, info = m.transcribe(str(wav16(clip)), **kw)
        segs = list(segs)
    words, seg_meta = [], []
    for s in segs:
        seg_meta.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip(),
                         "avg_logprob": round(s.avg_logprob, 3), "no_speech_prob": round(s.no_speech_prob, 3)})
        for w in s.words or []:
            t = w.word.strip()
            if t:
                words.append({"w": t, "start": round(w.start, 3), "end": round(w.end, 3),
                              "p": round(w.probability, 3)})
    top = sorted(info.all_language_probs or [], key=lambda x: -x[1])[:4] if info.all_language_probs else None
    save(a.name, clip, lang=info.language, text=" ".join(s.text.strip() for s in segs), words=words,
         load_s=tl.s, infer_s=ti.s,
         meta={"backend": "faster-whisper int8", "model": a.model, "forced_lang": a.lang,
               "multilingual": a.multilingual, "vad": not a.no_vad, "lang_prob": round(info.language_probability, 3),
               "lang_top": [[l, round(p, 3)] for l, p in top] if top else None, "segments": seg_meta})
