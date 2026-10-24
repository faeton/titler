#!/usr/bin/env python3
"""WER / CER of ASR runs against reference transcripts. Stdlib only.

References: bench/refs/<clip>.txt  (owner-corrected, final)
            bench/refs/<clip>.draft.txt (silver draft; use --draft)
Reference syntax:
  - lines starting with '#' are comments
  - <mm:ss> time markers are ignored
  - [a|b|c] disagreement spots: the FIRST alternative is used (may be empty: [|word])
Normalisation (both sides): lowercase, ё->е, ʼ/’ -> ', hyphens/dashes -> space,
all other punctuation removed, whitespace collapsed. Digits are NOT spelled out,
so "5" vs "пять" counts as an error (whisper writes digits, GigaAM/T-one words).

usage:
  score.py [--draft] [--models m1,m2] [--json out.json]
  score.py --pairwise [--models ...]     # model-vs-model disagreement (no reference needed)
"""
from __future__ import annotations

import argparse
import itertools
import json
import re
import sys
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
RUNS = BENCH / "runs" / "asr"
REFS = BENCH / "refs"
CLIPS = ["video-34238", "video-34442", "video-34585"]

_ALT = re.compile(r"\[([^\[\]]*)\]")
_TIME = re.compile(r"<\d+:\d+(?:\.\d+)?>")


def normalise(text: str) -> str:
    t = text.lower().replace("ё", "е")
    t = t.replace("ʼ", "'").replace("’", "'").replace("`", "'")
    t = re.sub(r"[-‐‑‒–—―]", " ", t)
    t = re.sub(r"[^\w\s']", " ", t)
    t = re.sub(r"(?<!\w)'|'(?!\w)", " ", t)  # quotes, keep in-word apostrophes (Ukrainian)
    t = t.replace("_", " ")
    return re.sub(r"\s+", " ", t).strip()


def read_ref(path: Path, alt: int = 0) -> str:
    lines = [ln for ln in path.read_text().splitlines() if not ln.lstrip().startswith("#")]
    s = _TIME.sub(" ", "\n".join(lines))

    def pick(m):
        opts = m.group(1).split("|")
        return opts[alt] if alt < len(opts) else opts[0]

    return _ALT.sub(pick, s)


def edit_ops(ref: list, hyp: list):
    """Levenshtein alignment. Returns (S, D, I, pairs) with pairs = [(ref_tok|None, hyp_tok|None)]."""
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        ri = ref[i - 1]
        row, prev = d[i], d[i - 1]
        for j in range(1, m + 1):
            c = 0 if ri == hyp[j - 1] else 1
            row[j] = min(prev[j - 1] + c, prev[j] + 1, row[j - 1] + 1)
    i, j, S, D, I, pairs = n, m, 0, 0, 0, []
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            S += ref[i - 1] != hyp[j - 1]
            pairs.append((ref[i - 1], hyp[j - 1]))
            i, j = i - 1, j - 1
        elif i > 0 and d[i][j] == d[i - 1][j] + 1:
            D += 1
            pairs.append((ref[i - 1], None))
            i -= 1
        else:
            I += 1
            pairs.append((None, hyp[j - 1]))
            j -= 1
    return S, D, I, pairs[::-1]


def errors(ref_text: str, hyp_text: str):
    r, h = normalise(ref_text).split(), normalise(hyp_text).split()
    S, D, I, _ = edit_ops(r, h)
    rc, hc = list(normalise(ref_text).replace(" ", "")), list(normalise(hyp_text).replace(" ", ""))
    cS, cD, cI, _ = edit_ops(rc, hc)
    return {"w_err": S + D + I, "w_ref": len(r), "S": S, "D": D, "I": I,
            "c_err": cS + cD + cI, "c_ref": len(rc)}


def hyp_text(model: str, clip: str) -> str | None:
    p = RUNS / model / f"{clip}.json"
    return json.loads(p.read_text())["text"] if p.exists() else None


def all_models():
    return sorted(p.name for p in RUNS.iterdir() if p.is_dir() and not p.name.startswith("_") and any(p.glob("*.json")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--draft", action="store_true", help="score against refs/<clip>.draft.txt (provisional)")
    ap.add_argument("--models", default=None)
    ap.add_argument("--pairwise", action="store_true")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    models = a.models.split(",") if a.models else all_models()

    if a.pairwise:
        out = {}
        print(f"{'pair':60s} " + " ".join(f"{c[-5:]:>7s}" for c in CLIPS) + "   mean")
        for m1, m2 in itertools.combinations(models, 2):
            rates = []
            for c in CLIPS:
                t1, t2 = hyp_text(m1, c), hyp_text(m2, c)
                if t1 is None or t2 is None:
                    rates.append(None)
                    continue
                e12, e21 = errors(t1, t2), errors(t2, t1)
                rates.append((e12["w_err"] / max(e12["w_ref"], 1) + e21["w_err"] / max(e21["w_ref"], 1)) / 2)
            ok = [r for r in rates if r is not None]
            mean = sum(ok) / len(ok) if ok else None
            out[f"{m1} vs {m2}"] = {"per_clip": rates, "mean": mean}
            cells = " ".join(f"{r*100:6.1f}%" if r is not None else "      -" for r in rates)
            print(f"{m1+' vs '+m2:60s} {cells}  {mean*100:5.1f}%" if mean is not None else f"{m1} vs {m2}: n/a")
        if a.json:
            Path(a.json).write_text(json.dumps(out, indent=1))
        return 0

    suffix = ".draft.txt" if a.draft else ".txt"
    refs = {c: REFS / f"{c}{suffix}" for c in CLIPS}
    missing = [str(p) for p in refs.values() if not p.exists()]
    if missing:
        print("missing references: " + ", ".join(missing), file=sys.stderr)
    if a.draft:
        print("# PROVISIONAL: scored against silver draft references (majority of models, first alternative).")
        print("# Models that voted in the draft are biased towards low WER here.")
    res = {}
    print(f"{'model':32s} " + " ".join(f"{'WER '+c[-5:]:>10s}" for c in CLIPS) + f" {'WER all':>8s} {'CER all':>8s}")
    for m in models:
        row, tw, tr, tcw, tcr = {}, 0, 0, 0, 0
        for c, rp in refs.items():
            h = hyp_text(m, c)
            if h is None or not rp.exists():
                row[c] = None
                continue
            e = errors(read_ref(rp), h)
            row[c] = e
            tw, tr, tcw, tcr = tw + e["w_err"], tr + e["w_ref"], tcw + e["c_err"], tcr + e["c_ref"]
        res[m] = {"clips": row, "wer": tw / tr if tr else None, "cer": tcw / tcr if tcr else None}
        cells = " ".join(f"{row[c]['w_err']/max(row[c]['w_ref'],1)*100:9.1f}%" if row[c] else f"{'-':>10s}"
                         for c in CLIPS)
        if tr:
            print(f"{m:32s} {cells} {tw/tr*100:7.1f}% {tcw/tcr*100:7.1f}%")
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
