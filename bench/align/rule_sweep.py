#!/usr/bin/env python3
"""Sweep length-dependent llr thresholds on raw (single-pass) signals.
real = ASR-consensus-confirmed words (support>=0.5) in 'orig'; fake = inserted words at slot 3."""
import json, sys
from collections import defaultdict
from pathlib import Path
import numpy as np
BENCH = Path(__file__).resolve().parents[1]
CONS = json.loads((BENCH / "runs/align" / __import__("os").environ.get("CONS", "consensus_nogigaam.json")).read_text())
be = sys.argv[1] if len(sys.argv) > 1 else "mms_fa"
rows = [json.loads(x) for x in open(BENCH / f"runs/align/local/{be}.jsonl")]
real_s, real_l, fakes = [], [], defaultdict(list)
for r in rows:
    if r["iterative"]:
        continue
    if r["variant"] == "orig":
        for k, x in enumerate(r["words"]):
            if CONS[r["clip"]]["support"][r["c"] - 3 + k] >= 0.5 and x.get("llr") is not None:
                (real_s if len(x["w"]) <= 2 else real_l).append((x["llr"], x["lp"]))
    elif r["variant"].startswith("fake:"):
        x = r["words"][3]; fakes[r["variant"][5:]].append((x["llr"], x["lp"]))
print(be, "n real short/long", len(real_s), len(real_l))
print("short_thr long_thr lp_min | real_short real_long | fake reject: " + " ".join(fakes))
for st in (-4, -3, -2, -1, 0):
    for lt in (-2, 0, 1, 2):
        for lpm in (-4.0, -99):
            ok = lambda v, t: v[0] >= t and v[1] >= lpm
            rs = np.mean([ok(v, st) for v in real_s]); rl = np.mean([ok(v, lt) for v in real_l])
            fr = [np.mean([not ok(v, st if len(f) <= 2 else lt) for v in fakes[f]]) for f in fakes]
            print(f"{st:>4} {lt:>4} {lpm:>5} | {rs:.2f} {rl:.2f} | " + " ".join(f"{x:.2f}" for x in fr))
