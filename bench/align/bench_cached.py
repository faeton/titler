#!/usr/bin/env python3
"""Cached-emission path: compute CTC emissions for the whole clip ONCE (text-independent),
then every local re-alignment is just a Viterbi over a slice of them.

Compares, per window, the cached-slice result with the per-window-emission result from
bench_local (same backend): centre-word boundary difference, real-word acceptance,
fake rejection, and Viterbi+LLR time.   Output: runs/align/cached_<backend>.json
"""
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).parent))
import local_align as L  # noqa: E402

BENCH = Path(__file__).resolve().parents[1]
be_name = sys.argv[1] if len(sys.argv) > 1 else "mms_fa"
backend, _, verifier = be_name.partition("+")
verifier = verifier or None
models = [backend] + ([verifier] if verifier else [])
rows = [json.loads(x) for x in open(BENCH / f"runs/align/local/{be_name}.jsonl")]
win = defaultdict(dict)
for r in rows:
    if r["iterative"]:
        win[(r["clip"], r["c"])][r["variant"]] = r
full_em, full_t = {}, {}
for clip in sorted({k[0] for k in win}):
    audio = L.load_audio(str(BENCH / f"samples/audio/{clip}.16k.wav"))
    t = time.perf_counter()
    full_em[clip] = {m: L.get_backend(m).emissions(torch.from_numpy(audio)) for m in models}
    full_t[clip] = round(time.perf_counter() - t, 2)
    print(clip, "full-clip emissions", full_t[clip], "s", flush=True)

PAD = 1.0
d_start, d_end, ms_al = [], [], []
acc = defaultdict(lambda: [0, 0])
for (clip, c), V in win.items():
    ref = V["orig"]["ref"]
    t0, t1 = max(0.0, ref[0]["start"] - PAD), ref[-1]["end"] + PAD
    em = {}
    for m, (lp, frame) in full_em[clip].items():  # slice every model at the same start time
        f0 = int(round(t0 / frame))
        em[m] = (lp[f0:min(lp.shape[0], int(round(t1 / frame)))], frame)
    lp, frame = full_em[clip][backend]
    f0, f1 = int(round(t0 / frame)), min(lp.shape[0], int(round(t1 / frame)))
    for v, r in V.items():
        if v.startswith("anc"):
            continue
        words = [x["w"] for x in r["words"]]
        t = time.perf_counter()
        out = L.align_window(None, f0 * frame, f1 * frame, words, backend=backend, verifier=verifier, _emissions=em)
        ms_al.append((time.perf_counter() - t) * 1e3)
        if v == "orig":
            a, b = out[3], r["words"][3]
            if a["start"] is not None and b["start"] is not None:
                d_start.append(a["start"] - b["start"]); d_end.append(a["end"] - b["end"])
            for x, y in zip(out, r["words"]):
                acc["real_aligned_cached"][0] += x["status"] == "aligned"
                acc["real_aligned_window"][0] += y["status"] == "aligned"
                acc["real_aligned_cached"][1] += 1; acc["real_aligned_window"][1] += 1
        elif v.startswith("fake:"):
            acc["fake_rejected_cached"][0] += out[3]["status"] != "aligned"; acc["fake_rejected_cached"][1] += 1
            acc["fake_rejected_window"][0] += r["words"][3]["status"] != "aligned"; acc["fake_rejected_window"][1] += 1
res = {"backend": be_name, "full_clip_emission_s": full_t,
       "centre_start_diff_ms_med_p90": [round(float(np.median(np.abs(d_start)) * 1e3)), round(float(np.percentile(np.abs(d_start), 90) * 1e3))],
       "centre_end_diff_ms_med_p90": [round(float(np.median(np.abs(d_end)) * 1e3)), round(float(np.percentile(np.abs(d_end), 90) * 1e3))],
       "viterbi_llr_ms_med_p90": [round(float(np.median(ms_al)), 1), round(float(np.percentile(ms_al, 90)), 1)],
       "rates": {k: f"{a}/{b} = {a / b:.3f}" for k, (a, b) in acc.items()}}
print(json.dumps(res, indent=1, ensure_ascii=False))
(BENCH / f"runs/align/cached_{be_name}.json").write_text(json.dumps(res, indent=1, ensure_ascii=False))
