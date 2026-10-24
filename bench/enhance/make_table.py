#!/usr/bin/env python3
"""Summarise runs/enhance/results.json into a markdown table (stdout) + results.csv."""
import json, os, csv
import numpy as np
B = os.environ.get("B", "/mnt/flash/home/faeton/work/titler/bench")
R = f"{B}/runs/enhance"
res = json.load(open(f"{R}/results.json"))
CLIPS = ["video-34238", "video-34442", "video-34585"]


def mean(xs):
    xs = [x for x in xs if x is not None]
    return float(np.mean(xs)) if xs else None


def f(x, p=2):
    return "–" if x is None else f"{x:.{p}f}"


rows = []
for v, d in res.items():
    if v.startswith("_"):
        continue
    es = [d[c] for c in CLIPS if c in d]
    if not es:
        continue
    tm = [e.get("timing") or {} for e in es]
    tot_wall = sum(t.get("wall_s") or 0 for t in tm)
    tot_audio = sum(t.get("audio_s") or 0 for t in tm)
    row = {
        "variant": v,
        "sr": es[0].get("sr", 48000),
        "rtf": tot_wall / tot_audio if tot_audio else None,
        "load_s": mean([t.get("load_s") for t in tm]),
        "rss_mb": max([t.get("peak_rss_mb") or 0 for t in tm]) or None,
        "lag_ms": "/".join(f"{e['lag_ms']:+.1f}" for e in es),
        "len_diff": "/".join(str(e.get("len_diff", 0)) for e in es),
        "len_ok": all(e.get("len_ok", True) and e.get("residual_lag_samples", 0) == 0 for e in es),
        "sig": mean([e["dnsmos"]["sig"] for e in es]),
        "bak": mean([e["dnsmos"]["bak"] for e in es]),
        "ovrl": mean([e["dnsmos"]["ovrl"] for e in es]),
        "ovrl_noisy": mean([e.get("dnsmos_excerpt", {}).get("ovrl") for e in es]),
        "bak_noisy": mean([e.get("dnsmos_excerpt", {}).get("bak") for e in es]),
        "phase": mean([e.get("phase") for e in es]),
        "asr_cer": mean([e.get("asr_cer_vs_orig") for e in es]),
        "wer_ref": mean([e.get("wer_vs_ref") for e in es]),
        "cer_ref": mean([e.get("cer_vs_ref") for e in es]),
        "asr2_cer": mean([e.get("asr2", {}).get("cer_vs_orig") for e in es]),
        "asr2_wer_ref": mean([e.get("asr2", {}).get("wer_vs_ref") for e in es]),
    }
    rows.append(row)
rows.sort(key=lambda r: (r["variant"] != "original", r["variant"]))
with open(f"{R}/results.csv", "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)
has_ref = any(r["wer_ref"] is not None for r in rows)
hdr = ["variant", "sr", "RTF@8t", "load s", "peak RSS MB", "raw lag ms (3 clips)", "raw Δlen (samples)",
       "len/sync OK", "SIG", "BAK", "OVRL", "OVRL noisy10s", "BAK noisy10s", "phase", "ASR CER vs orig"]
if has_ref:
    hdr += ["WER vs silver ref (small)", "turbo: CER vs orig", "turbo: WER vs silver ref"]
print("| " + " | ".join(hdr) + " |")
print("|" + "---|" * len(hdr))
for r in rows:
    cells = [r["variant"], str(r["sr"] // 1000) + "k", f(r["rtf"], 3), f(r["load_s"], 1), f(r["rss_mb"], 0),
             r["lag_ms"], r["len_diff"], "yes" if r["len_ok"] else "NO", f(r["sig"]), f(r["bak"]), f(r["ovrl"]),
             f(r["ovrl_noisy"]), f(r["bak_noisy"]), f(r["phase"]), f(r["asr_cer"], 3)]
    if has_ref:
        cells += [f(r["wer_ref"], 3), f(r["asr2_cer"], 3), f(r["asr2_wer_ref"], 3)]
    print("| " + " | ".join(cells) + " |")
