#!/usr/bin/env python3
"""Local re-alignment tests on 7-word windows (centre word c, neighbours ±3, 1 s padding).

For every window and backend:
  orig      true text (whisper words)                                   -> real-word stats
  del       centre word removed                                         -> neighbour drift/flags
  fake:<w>  a word NOT in the audio inserted before the centre word     -> rejection
  anc:*     words c-2 and c+1 anchored at the reference times; orig + fake
Each text variant is run raw (iterative=False: raw llr/lp of every word) and
final (iterative=True: the production rule incl. drop-worst re-alignment).
Latency: full align_window() calls from the file with a warm model.
Output: runs/align/local/<backend>.jsonl, runs/align/local/latency.json
"""
import json
import statistics
import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).parent))
import local_align as L  # noqa: E402

BENCH = Path(__file__).resolve().parents[1]
OUT = BENCH / "runs/align/local"
OUT.mkdir(parents=True, exist_ok=True)
FAKES = ["синий", "компьютер", "на", "и", "не", "вот"]
BACKENDS = [a for a in sys.argv[1:] if not a.startswith("-")] or ["mms_fa", "w2v_ru", "gigaam", "mms_fa_q8"]
STEP = 2
PAD = 1.0
N_LAT = int(__import__("os").environ.get("N_LAT", "15"))


def windows():
    for p in sorted((BENCH / "runs/align/full").glob("video-*.json")):
        d = json.loads(p.read_text())
        ws, ref = d["words"], d["aligners"]["mms_fa"]
        for c in range(3, len(ws) - 3, STEP):
            idx = list(range(c - 3, c + 4))
            if any(ws[i]["suspect"] or ref[i] is None for i in idx):
                continue
            yield d["clip"], c, [ws[i]["w"] for i in idx], [ref[i] for i in idx], \
                {b: [d["aligners"][b][i] for i in idx] for b in ("mms_fa", "w2v_ru", "gigaam", "whisperx")}


def run(backend):
    spec = backend
    backend, _, verifier = spec.partition("+")
    verifier = verifier or None
    models = [backend] + ([verifier] if verifier else [])
    for m in models:
        L.warmup(m)
    rows, lat = [], []
    for n, (clip, c, words, ref, glob) in enumerate(windows()):
        audio_path = str(BENCH / f"samples/audio/{clip}.16k.wav")
        t0, t1 = max(0.0, ref[0]["start"] - PAD), ref[-1]["end"] + PAD
        audio = L.load_audio(audio_path)
        a0, a1 = int(t0 * L.SR), min(len(audio), int(t1 * L.SR))
        t = time.perf_counter()
        em = {m: L.get_backend(m).emissions(torch.from_numpy(audio[a0:a1].copy())) for m in models}
        em_ms = (time.perf_counter() - t) * 1e3
        t0 = a0 / L.SR
        if n < N_LAT:  # end-to-end latency of the production call (warm model, cached audio)
            ts = []
            for _ in range(3):
                t = time.perf_counter()
                L.align_window(audio_path, t0, t1, words, backend=backend, verifier=verifier)
                ts.append((time.perf_counter() - t) * 1e3)
            lat.append({"clip": clip, "c": c, "audio_s": round(t1 - t0, 2), "emission_ms": round(em_ms, 1),
                        "total_ms_min": round(min(ts), 1), "total_ms_med": round(statistics.median(ts), 1)})
        variants = {"orig": (words, None), "del": (words[:3] + words[4:], None)}
        for f in FAKES:
            variants[f"fake:{f}"] = (words[:3] + [f] + words[3:], None)
        anc = {0: None}
        variants["anc:orig"] = (words, {1: (ref[1]["start"], ref[1]["end"]), 4: (ref[4]["start"], ref[4]["end"])})
        variants["anc:fake:синий"] = (words[:3] + ["синий"] + words[3:],
                                      {1: (ref[1]["start"], ref[1]["end"]), 5: (ref[4]["start"], ref[4]["end"])})
        variants["anc:fake:на"] = (words[:3] + ["на"] + words[3:],
                                   {1: (ref[1]["start"], ref[1]["end"]), 5: (ref[4]["start"], ref[4]["end"])})
        del anc
        for name, (wl, anchors) in variants.items():
            for it in (False, True):
                t = time.perf_counter()
                r = L.align_window(audio_path, t0, t1, wl, anchors=anchors, backend=backend, verifier=verifier,
                                   iterative=it, _emissions=em)
                al_ms = (time.perf_counter() - t) * 1e3
                rows.append({"clip": clip, "c": c, "variant": name, "iterative": it, "words": r,
                             "ref": ref, "glob": glob[backend if backend in glob else "mms_fa"],
                             "glob_mms": glob["mms_fa"], "align_ms": round(al_ms, 2), "emission_ms": round(em_ms, 1)})
        if n % 10 == 0:
            print(spec, n, clip, c, f"em {em_ms:.0f} ms", flush=True)
    with open(OUT / f"{spec}.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return lat


if __name__ == "__main__":
    latp = OUT / "latency.json"
    lat_all = json.loads(latp.read_text()) if latp.exists() else {}
    for b in BACKENDS:
        lat = run(b)
        if lat:
            lat_all[b] = lat
        latp.write_text(json.dumps(lat_all, indent=1))
