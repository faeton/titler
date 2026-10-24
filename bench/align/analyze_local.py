#!/usr/bin/env python3
"""Summarise runs/align/local/*.jsonl -> runs/align/local_summary.{json,md}"""
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

BENCH = Path(__file__).resolve().parents[1]
LOC = BENCH / "runs/align/local"
SHORT = {"на", "и", "не"}


def ms(v):
    v = np.abs(np.asarray([x for x in v if x is not None], float)) * 1000
    return f"{np.median(v):.0f} / {np.percentile(v, 90):.0f}" if len(v) else "-"


def pct(a, b):
    return f"{100 * a / b:.0f}% ({a}/{b})" if b else "-"


out_md, summary = [], {}
# ASR-consensus labels; GigaAM's own ASR variants excluded so GigaAM is not favoured
CONS = json.loads((BENCH / "runs/align" / __import__("os").environ.get("CONS", "consensus_nogigaam.json")).read_text())
sup = lambda clip, g: CONS[clip]["support"][g]  # noqa: E731
lat = json.loads((LOC / "latency.json").read_text()) if (LOC / "latency.json").exists() else {}
for p in sorted(LOC.glob("*.jsonl")):
    be = p.stem
    rows = [json.loads(x) for x in p.open()]
    by = defaultdict(dict)  # (clip,c) -> (variant,iter) -> row
    for r in rows:
        by[(r["clip"], r["c"])][(r["variant"], r["iterative"])] = r
    S = {"windows": len(by)}
    # ---- raw signal distributions at the insertion slot (index 3) ----
    real = [w[("orig", False)]["words"][3] for w in by.values()]
    fakes = defaultdict(list)
    for w in by.values():
        for (v, it), r in w.items():
            if v.startswith("fake:") and not it:
                fakes[v[5:]].append(r["words"][3])
    allreal = [x for w in by.values() for x in w[("orig", False)]["words"]]

    def q(xs, k):
        v = [x.get(k) for x in xs if x.get(k) is not None]
        return np.percentile(v, [5, 25, 50, 75, 95]).round(2).tolist() if v else None
    S["dist"] = {"real_centre": {k: q(real, k) for k in ("llr", "lp", "gop", "dur")},
                 "real_all": {k: q(allreal, k) for k in ("llr", "lp", "gop", "dur")}}
    for f, xs in fakes.items():
        S["dist"][f"fake:{f}"] = {k: q(xs, k) for k in ("llr", "lp", "gop", "dur")}
    # ---- threshold sweep (raw, single pass) ----
    sweep = []
    for lt in (-5, -2, 0, 1, 2, 3, 5, 8):
        for pt in (-1.5, -2.0, -2.5, -3.0, -99):
            acc = lambda x: (x.get("llr") is None or x["llr"] >= lt) and (x.get("lp") is not None and x["lp"] >= pt)  # noqa
            tpr = np.mean([acc(x) for x in allreal])
            tpr_c = np.mean([acc(x) for x in real])
            tnr = {f: float(np.mean([not acc(x) for x in xs])) for f, xs in fakes.items()}
            sweep.append({"llr_min": lt, "lp_min": pt, "real_all_accept": round(float(tpr), 3),
                          "real_centre_accept": round(float(tpr_c), 3),
                          "fake_reject": {f: round(v, 3) for f, v in tnr.items()},
                          "fake_reject_long": round(float(np.mean([tnr[f] for f in tnr if f not in SHORT])), 3),
                          "fake_reject_short": round(float(np.mean([tnr[f] for f in tnr if f in SHORT])), 3)})
    S["sweep"] = sweep
    # ---- production rule (iterative=True) ----
    fin = {}
    o = [w[("orig", True)] for w in by.values()]
    fin["real_centre_aligned"] = pct(sum(r["words"][3]["status"] == "aligned" for r in o), len(o))
    fin["real_all_aligned"] = pct(sum(x["status"] == "aligned" for r in o for x in r["words"]), sum(len(r["words"]) for r in o))
    # local (window) vs global (full-clip) boundaries of the centre word
    fin["centre_vs_global_same_backend_ms(start med/p90)"] = ms([r["words"][3]["start"] - r["glob"][3]["start"] for r in o if r["glob"][3]])
    fin["centre_vs_global_same_backend_ms(end med/p90)"] = ms([r["words"][3]["end"] - r["glob"][3]["end"] for r in o if r["glob"][3]])
    fin["centre_vs_mms_global_ms(start)"] = ms([r["words"][3]["start"] - r["glob_mms"][3]["start"] for r in o])
    fin["centre_vs_mms_global_ms(end)"] = ms([r["words"][3]["end"] - r["glob_mms"][3]["end"] for r in o])
    for f in fakes:
        fr = [w[(f"fake:{f}", True)] for w in by.values()]
        rej = sum(r["words"][3]["status"] != "aligned" for r in fr)
        others = [(x, y) for r, oo in zip(fr, o) for x, y in zip(r["words"][:3] + r["words"][4:], oo["words"])]
        keep = sum(x["status"] == "aligned" for x, y in others if y["status"] == "aligned")
        base = sum(y["status"] == "aligned" for x, y in others)
        drift = [x["start"] - y["start"] for x, y in others if x["status"] == "aligned" and y["status"] == "aligned"]
        fin[f"fake:{f}"] = {"rejected": pct(rej, len(fr)), "real_words_still_aligned": pct(keep, base),
                            "real_word_start_drift_ms(med/p90)": ms(drift)}
    # fake insertion into a pause (gap >= 0.25 s between c-1 and c in the reference) vs. into running speech
    for gname, cond in (("pause>=250ms", lambda g: g >= 0.25), ("no-pause", lambda g: g < 0.25)):
        n = rj = 0
        for w in by.values():
            ref = w[("orig", True)]["ref"]
            if not cond(ref[3]["start"] - ref[2]["end"]):
                continue
            for f in fakes:
                n += 1; rj += w[(f"fake:{f}", True)]["words"][3]["status"] != "aligned"
        fin[f"fake_rejected_{gname}"] = pct(rj, n)
    # deletion: c removed -> neighbours c-1, c+1 (positions 2, 3 in the shortened list)
    dl = [(w[("del", True)], w[("orig", True)]) for w in by.values()]
    flagged = sum(d["words"][2]["status"] != "aligned" or d["words"][3]["status"] != "aligned" for d, _ in dl)
    fin["delete_centre:neighbour_flagged"] = pct(flagged, len(dl))
    fin["delete_centre:prev_end_drift_ms"] = ms([d["words"][2]["end"] - oo["words"][2]["end"] for d, oo in dl])
    fin["delete_centre:next_start_drift_ms"] = ms([d["words"][3]["start"] - oo["words"][4]["start"] for d, oo in dl])
    # reinsertion = orig vs del: does the re-inserted word restore neighbour boundaries? (trivially yes,
    # deterministic) -> report how much the deletion had moved them, and the re-inserted word's own error
    # anchors
    ao = [w[("anc:orig", True)] for w in by.values()]
    fin["anchored:anchors_untouched"] = pct(sum(r["words"][1]["start"] == r["ref"][1]["start"] and
                                               r["words"][4]["start"] == r["ref"][4]["start"] for r in ao), len(ao))
    fin["anchored:centre_aligned"] = pct(sum(r["words"][3]["status"] == "aligned" for r in ao), len(ao))
    fin["anchored:centre_vs_unanchored_start_ms"] = ms([a["words"][3]["start"] - b["words"][3]["start"] for a, b in zip(ao, o)])
    for f in ("синий", "на"):
        af = [w[(f"anc:fake:{f}", True)] for w in by.values()]
        fin[f"anchored:fake:{f}:rejected"] = pct(sum(r["words"][3]["status"] != "aligned" for r in af), len(af))
        fin[f"anchored:fake:{f}:inside_gap"] = pct(sum(r["words"][3]["start"] is not None and
                                                       r["words"][1]["end"] <= r["words"][3]["start"] <= r["words"][5]["start"]
                                                       for r in af), len(af))
    # real-word acceptance split by ASR-consensus support and word length
    cat = defaultdict(lambda: [0, 0])
    raw_cat = defaultdict(list)
    for (clip, c), w in by.items():
        for k, x in enumerate(w[("orig", True)]["words"]):
            spv = sup(clip, c - 3 + k)
            grp = ("confirmed" if spv >= 0.5 else "disputed" if spv < 0.3 else "mid") + \
                  ("/short<=2" if len(x["w"]) <= 2 else "/long")
            cat[grp][0] += x["status"] == "aligned"; cat[grp][1] += 1
            xr = w[("orig", False)]["words"][k]
            if xr.get("llr") is not None:
                raw_cat[grp].append(xr["llr"])
    fin["accept_by_group"] = {g: pct(a, b) for g, (a, b) in sorted(cat.items())}
    S["raw_llr_by_group"] = {g: np.percentile(v, [5, 10, 25, 50]).round(1).tolist() for g, v in sorted(raw_cat.items())}
    S["final"] = fin
    al = [r["align_ms"] for r in rows if r["iterative"]]
    em = sorted({(r["clip"], r["c"]): r["emission_ms"] for r in rows}.values())
    S["latency"] = {"viterbi_llr_ms_med": round(float(np.median(al)), 1), "viterbi_llr_ms_p90": round(float(np.percentile(al, 90)), 1),
                    "window_emission_ms_med": round(float(np.median(em)), 0), "window_emission_ms_p90": round(float(np.percentile(em, 90)), 0)}
    if be in lat and lat[be]:
        S["latency"]["end_to_end_ms_min_med"] = round(float(np.median([x["total_ms_min"] for x in lat[be]])), 0)
        S["latency"]["end_to_end_ms_med_med"] = round(float(np.median([x["total_ms_med"] for x in lat[be]])), 0)
        S["latency"]["window_audio_s_med"] = round(float(np.median([x["audio_s"] for x in lat[be]])), 2)
    summary[be] = S
    out_md.append(f"## {be}  ({S['windows']} windows)\n")
    out_md.append("latency: " + json.dumps(S["latency"]))
    out_md.append("\nraw distributions (p5,p25,p50,p75,p95):")
    for k, v in S["dist"].items():
        out_md.append(f"- {k}: " + json.dumps(v, ensure_ascii=False))
    out_md.append("- raw llr by group (p5,p10,p25,p50): " + json.dumps(S["raw_llr_by_group"], ensure_ascii=False))
    out_md.append("\nproduction rule (iterative):")
    for k, v in fin.items():
        out_md.append(f"- {k}: {json.dumps(v, ensure_ascii=False) if isinstance(v, dict) else v}")
    out_md.append("\nsweep (llr_min, lp_min -> real_all, real_centre | fake long, short):")
    for s in sweep:
        if s["lp_min"] in (-2.0, -2.5, -3.0, -99):
            out_md.append(f"- {s['llr_min']:>3} {s['lp_min']:>5}: {s['real_all_accept']:.2f} {s['real_centre_accept']:.2f} | "
                          f"{s['fake_reject_long']:.2f} {s['fake_reject_short']:.2f}  {json.dumps(s['fake_reject'], ensure_ascii=False)}")
    out_md.append("")
(BENCH / "runs/align/local_summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False))
(BENCH / "runs/align/local_summary.md").write_text("\n".join(out_md))
print("\n".join(out_md))
