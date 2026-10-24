#!/usr/bin/env python3
"""Markdown summary table of all runs (timing, memory, features). Stdlib only.

usage: summarize.py [--runs DIR]
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from score import CLIPS, RUNS  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--runs", default=str(RUNS))
ap.add_argument("--scores", default=str(RUNS / "_scores_provisional.json"))
a = ap.parse_args()
runs = Path(a.runs)
scores = json.loads(Path(a.scores).read_text()) if Path(a.scores).exists() else {}

print("| model | load s | infer s (238/442/585) | RTF | thr | peak RSS GB | words | punct/case | lang reported | prov. WER | prov. CER |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
for d in sorted(p for p in runs.iterdir() if p.is_dir() and not p.name.startswith("_")):
    recs = [json.loads((d / f"{c}.json").read_text()) for c in CLIPS if (d / f"{c}.json").exists()]
    if not recs:
        continue
    inf = [r["timing"]["infer_s"] for r in recs]
    aud = sum(r["timing"]["audio_s"] for r in recs)
    rss = max(r["timing"].get("peak_rss_mb", 0) for r in recs) / 1024
    words = "yes" if all(r["words"] for r in recs) else "no"
    txt = " ".join(r["text"] for r in recs)
    punct = ("P" if re.search(r"[.,?!]", txt) else "-") + ("C" if re.search(r"[А-ЯA-Z]", txt) else "-")
    langs = ",".join(sorted({str(r["lang"]) for r in recs}))
    sc = scores.get(d.name, {})
    wer = f"{sc['wer']*100:.1f}%" if sc.get("wer") is not None else "-"
    cer = f"{sc['cer']*100:.1f}%" if sc.get("cer") is not None else "-"
    print(f"| {d.name} | {recs[0]['timing']['load_s']:.1f} | {'/'.join(f'{x:.1f}' for x in inf)} | "
          f"{sum(inf)/aud:.2f} | {recs[0]['timing']['threads']} | {rss:.1f} | {words} | {punct} | {langs} | {wer} | {cer} |")
