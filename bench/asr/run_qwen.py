"""Qwen3-ASR-1.7B runner (transformers backend, CPU) + optional Qwen3-ForcedAligner-0.6B
for word timestamps.

ASR weights are read from the existing read-only cache /mnt/flash/whisper-models/hub.
The aligner is downloaded into $HF_HOME (scratch).

usage: run_qwen.py --name NAME [--lang Russian] [--context TEXT] [--align] [--dtype float32|bfloat16]
"""
import argparse
import glob
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import CLIPS, THREADS, Timer, log, save, wav16  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True)
ap.add_argument("--lang", default=None)
ap.add_argument("--context", default="")
ap.add_argument("--align", action="store_true")
ap.add_argument("--dtype", default="float32")
ap.add_argument("clips", nargs="*", default=CLIPS)
a = ap.parse_args()

import torch  # noqa: E402

torch.set_num_threads(THREADS)
torch.set_num_interop_threads(1)
from qwen_asr import Qwen3ASRModel  # noqa: E402

ASR_DIR = glob.glob("/mnt/flash/whisper-models/hub/models--Qwen--Qwen3-ASR-1.7B/snapshots/*/")[0]
dtype = getattr(torch, a.dtype)

with Timer() as tl:
    m = Qwen3ASRModel.from_pretrained(
        ASR_DIR, dtype=dtype, device_map="cpu", max_inference_batch_size=4, max_new_tokens=1024,
        forced_aligner="Qwen/Qwen3-ForcedAligner-0.6B" if a.align else None,
        forced_aligner_kwargs={"dtype": dtype, "device_map": "cpu"} if a.align else None,
    )
    import numpy as np
    m.transcribe((np.zeros(32000, dtype=np.float32), 16000), language="Russian")
log(f"load {tl.s:.1f}s")

for clip in a.clips:
    with Timer() as ti:
        r = m.transcribe(str(wav16(clip)), context=a.context, language=a.lang, return_time_stamps=a.align)[0]
    words = None
    if a.align and r.time_stamps is not None:
        words = [{"w": it.text, "start": round(float(it.start_time), 3), "end": round(float(it.end_time), 3)}
                 for it in r.time_stamps]
    save(a.name, clip, lang=r.language, text=r.text, words=words, load_s=tl.s, infer_s=ti.s,
         meta={"backend": f"qwen-asr transformers {a.dtype}", "forced_lang": a.lang, "context": a.context,
               "aligner": "Qwen3-ForcedAligner-0.6B" if a.align else None,
               "word_timing_note": "forced alignment of the (unpunctuated) words; timings in s" if a.align else None})
