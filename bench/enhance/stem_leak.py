#!/usr/bin/env python3
"""Speech leakage into the background stem (envs/enh-metrics).
For every aligned 'speech-like' output S, background B = original - S (exact complement).
leak_db = 300-3400 Hz energy of B in the loudest-30% speech frames minus that in the
quietest-30% speech frames. ~0 dB: background stem is speech-free (level of B is independent
of talking); >>0 dB: the voice leaks into B, so 'speech + k*background' will still carry
(attenuated, phase-coherent) voice - not doubling, but less separation control.
Also reports speech_rel_db / bg_rel_db (level vs original)."""
import json, os, sys
import numpy as np, soundfile as sf
from scipy.signal import stft
B_ = "/mnt/flash/home/faeton/work/titler/bench"; R = f"{B_}/runs/enhance"
CLIPS = ["video-34238", "video-34442", "video-34585"]
VARS = sys.argv[1:] or ["dfn3-full", "dfn3-full-pf", "cv-MossFormer2_SE_48K", "cv-FRCRN_SE_16K",
                        "cv-MossFormerGAN_SE_16K", "demucs-htdemucs-vocals", "demucs-htdemucs_ft-vocals",
                        "melroformer-kim-speech", "bsroformer-1297-speech", "dsp-arnndn-sh"]
out = {}
for v in VARS:
    rows = []
    for c in CLIPS:
        x, _ = sf.read(f"{B_}/samples/audio/{c}.16k.wav", dtype="float32")
        s, _ = sf.read(f"{R}/aligned/{v}/{c}.16k.wav", dtype="float32")
        b = x - s
        f, _, S = stft(s, 16000, nperseg=512, noverlap=256)
        _, _, Bk = stft(b, 16000, nperseg=512, noverlap=256)
        band = (f >= 300) & (f <= 3400)
        es = (np.abs(S[band]) ** 2).sum(0); eb = (np.abs(Bk[band]) ** 2).sum(0)
        hi = es >= np.quantile(es, 0.7); lo = es <= np.quantile(es, 0.3)
        leak = 10 * np.log10(eb[hi].mean() / (eb[lo].mean() + 1e-12) + 1e-12)
        lv = lambda y: 20 * np.log10(np.linalg.norm(y) / np.linalg.norm(x))
        rows.append({"clip": c, "leak_db": float(leak), "speech_rel_db": float(lv(s)), "bg_rel_db": float(lv(b))})
    out[v] = rows
    print(f"{v:28s} leak_db=" + "/".join(f"{r['leak_db']:+.1f}" for r in rows) +
          "  bg_rel_db=" + "/".join(f"{r['bg_rel_db']:+.1f}" for r in rows), flush=True)
json.dump(out, open(f"{R}/stem_leak.json", "w"), indent=1)
