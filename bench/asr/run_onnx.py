"""onnx-asr runner: GigaAM v3 (ctc/rnnt/e2e), parakeet-tdt-0.6b-v3, T-one, Canary, Vosk...

All models get Silero VAD segmentation (GigaAM/parakeet are not meant for >~25-30 s input,
and it keeps the comparison uniform). Token timestamps -> approximate word timings.

usage: run_onnx.py --name NAME --model ONNX_ASR_MODEL [--quant int8] [--lang ru] [clips...]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import CLIPS, THREADS, Timer, duration, load_np, log, save, wav16, words_from_tokens  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True)
ap.add_argument("--model", required=True)
ap.add_argument("--quant", default=None)
ap.add_argument("--lang", default=None, help="only for canary/whisper")
ap.add_argument("--no-vad", action="store_true")
ap.add_argument("clips", nargs="*", default=CLIPS)
a = ap.parse_args()

import onnx_asr  # noqa: E402
import onnxruntime as rt  # noqa: E402

so = rt.SessionOptions()
so.intra_op_num_threads = THREADS
so.inter_op_num_threads = 1

with Timer() as tl:
    # real files in a local dir: onnxruntime refuses external-data (.onnx.data) reached via HF-cache symlinks
    local = Path("/mnt/flash/scratch/hf-cache/onnx-asr") / a.model.replace("/", "--")
    asr = onnx_asr.load_model(a.model, local, quantization=a.quant, sess_options=so, providers=["CPUExecutionProvider"])
    if not a.no_vad:
        vad = onnx_asr.load_vad("silero", sess_options=so, providers=["CPUExecutionProvider"])
        # max 20 s segments: GigaAM was trained on <=25 s utterances
        model = asr.with_vad(vad, min_silence_duration_ms=300, speech_pad_ms=200, max_speech_duration_s=20).with_timestamps()
    else:
        model = asr.with_timestamps()
    import numpy as np
    warm = np.zeros(32000, dtype=np.float32)
    r = model.recognize(warm, sample_rate=16000)
    if not a.no_vad:
        list(r)
log(f"load {tl.s:.1f}s")

kw = {}
if a.lang:
    kw["language"] = a.lang

for clip in a.clips:
    audio, sr = load_np(wav16(clip))
    with Timer() as ti:
        res = model.recognize(audio, sample_rate=sr, **kw)
        segs = list(res) if not a.no_vad else [res]
    words, texts, seg_meta = [], [], []
    for s in segs:
        off = getattr(s, "start", 0.0) or 0.0
        texts.append(s.text.strip())
        seg_meta.append({"start": round(off, 2), "end": round(getattr(s, "end", 0.0) or 0.0, 2), "text": s.text.strip()})
        if s.tokens and s.timestamps:
            end = getattr(s, "end", None) or duration(wav16(clip))
            words += words_from_tokens(s.tokens, [off + t for t in s.timestamps], end)
    text = " ".join(t for t in texts if t)
    save(a.name, clip, lang=a.lang or "n/a", text=text, words=words or None, load_s=tl.s, infer_s=ti.s,
         meta={"backend": f"onnx-asr {onnx_asr.__version__ if hasattr(onnx_asr, '__version__') else ''}",
               "model": a.model, "quant": a.quant, "vad": not a.no_vad, "segments": seg_meta,
               "word_timing_note": "token emission times; word end approximated"})
