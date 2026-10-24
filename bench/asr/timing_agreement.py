#!/usr/bin/env python3
"""Word-timing agreement between models (no ground-truth timings exist).

For every model that emits word timings, align its words to a reference model's words
(identical normalised tokens only) and report median / p90 |start difference| and the
median word duration. Stdlib only.

usage: timing_agreement.py [--ref fw-turbo-auto-novad,qwen3-asr-auto-aligned]
"""
import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from score import CLIPS, RUNS, all_models, edit_ops, normalise  # noqa: E402


def toks(rec):
    out = []
    for w in rec.get("words") or []:
        for t in normalise(w["w"]).split():
            out.append((t, w["start"], w["end"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="fw-turbo-auto-novad,qwen3-asr-auto-aligned")
    a = ap.parse_args()
    refs = a.ref.split(",")
    print(f"{'model':32s} " + " ".join(f"{'vs '+r[:22]:>36s}" for r in refs) + "   med.dur")
    for m in all_models():
        rows, durs, ok = [], [], True
        for r in refs:
            diffs = []
            for c in CLIPS:
                pm, pr = RUNS / m / f"{c}.json", RUNS / r / f"{c}.json"
                if not (pm.exists() and pr.exists()):
                    continue
                tm, tr = toks(json.loads(pm.read_text())), toks(json.loads(pr.read_text()))
                if not tm or not tr:
                    ok = False
                    break
                if r == refs[0]:
                    durs += [e - s for _, s, e in tm]
                _, _, _, pairs = edit_ops([t for t, *_ in tr], [t for t, *_ in tm])
                i = j = 0
                for x, y in pairs:
                    if x is not None and y is not None:
                        if x == y:
                            diffs.append(abs(tr[i][1] - tm[j][1]))
                        i, j = i + 1, j + 1
                    elif x is not None:
                        i += 1
                    else:
                        j += 1
            if not ok:
                break
            if diffs:
                diffs.sort()
                rows.append(f"med {statistics.median(diffs)*1000:5.0f}ms p90 {diffs[int(.9*len(diffs))]*1000:5.0f}ms n={len(diffs):3d}")
            else:
                rows.append("-")
        if not ok:
            print(f"{m:32s} (no word timings)")
            continue
        print(f"{m:32s} " + " ".join(f"{x:>36s}" for x in rows) + f"   {statistics.median(durs)*1000:5.0f}ms")


if __name__ == "__main__":
    main()
