#!/usr/bin/env python3
"""Build silver draft references from several ASR hypotheses (ROVER-lite). Stdlib only.

For each clip:
  1. normalise every hypothesis (score.normalise) and pick a pivot = the model with the
     lowest mean pairwise WER to the others;
  2. align each hypothesis to the pivot word-by-word; every pivot word and every gap between
     pivot words becomes a slot, each model contributes a (possibly multi-word / empty) string;
  3. majority vote per slot; ties go to the pivot. Any slot where models disagree is a
     dispute; neighbouring disputes are merged into one region so multi-word alternatives
     ("на самоа" vs "насамоа") stay together;
  4. write refs/<clip>.draft.txt:  majority text, disputes as [majority|alt|alt] (alt may be
     empty: [|word] = only a minority heard "word"), <mm:ss> markers from the pivot's timings.
     Also runs/asr/_silver/<clip>.disputes.json with per-model variants.

usage: build_draft.py --models a,b,c,d
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from score import CLIPS, REFS, RUNS, edit_ops, errors, normalise  # noqa: E402


def tokens_with_times(rec):
    toks, times = [], []
    if rec.get("words"):
        for w in rec["words"]:
            for t in normalise(w["w"]).split():
                toks.append(t)
                times.append(w["start"])
        if toks:
            return toks, times
    toks = normalise(rec["text"]).split()
    return toks, [None] * len(toks)


def pick_pivot(seqs, models):
    texts = {m: " ".join(seqs[m]) for m in models}
    score = {m: sum(errors(texts[o], texts[m])["w_err"] / max(len(seqs[o]), 1) for o in models if o != m)
             for m in models}
    return min(models, key=lambda m: score[m])


def rover(seqs, models, pivot, times=None, depth=0):
    """Return pieces: (time|None, str) for agreed text or (time|None, [alts]) for disputes.

    seqs: model -> token list. Majority per slot; ties -> earlier in `order` (pivot first).
    A disputed region in which the pivot is silent but >=2 other models produced text is
    re-voted recursively around a sub-pivot chosen among the non-empty variants.
    """
    ptoks = seqs[pivot]
    n = len(ptoks)
    times = times or [None] * n
    slots = {m: [[] for _ in range(2 * n + 1)] for m in models}
    for m in models:
        _, _, _, pairs = edit_ops(ptoks, seqs[m])
        k = 0
        for r, h in pairs:
            if r is None:
                slots[m][2 * k].append(h)
            else:
                if h is not None:
                    slots[m][2 * k + 1].append(h)
                k += 1
    order = [pivot] + [m for m in models if m != pivot]
    disputed = [len({" ".join(slots[m][s]) for m in models}) > 1 for s in range(2 * n + 1)]
    pieces, s, N = [], 0, 2 * n + 1
    while s < N:
        t = times[s // 2] if s % 2 == 1 else (times[min(s // 2, n - 1)] if n else None)
        if not disputed[s]:
            txt = " ".join(slots[pivot][s])
            if txt:
                pieces.append((t if s % 2 == 1 else None, txt))
            s += 1
            continue
        e = s
        # merge neighbouring disputes, but cap a region at ~4 pivot words so long
        # disagreements stay readable as several local [..] spots
        while e + 1 < N and (e - s) < 8 and (disputed[e + 1] or (e + 2 < N and disputed[e + 2]
                                                                 and not " ".join(slots[pivot][e + 1]))):
            e += 1
        reg = {m: [tok for k in range(s, e + 1) for tok in slots[m][k]] for m in models}
        nonempty = [m for m in order if reg[m]]
        if depth < 3 and not reg[pivot] and len(nonempty) >= 2 and max(len(reg[m]) for m in nonempty) >= 3:
            # models silent here abstain; note them on a comment line (score.py ignores '#')
            silent = [m for m in models if not reg[m]]
            sub = pick_pivot(reg, nonempty)
            pieces.append((None, "\n# only " + ", ".join(nonempty) + " heard speech here; silent: "
                           + ", ".join(silent) + "\n"))
            pieces += rover({m: reg[m] for m in nonempty}, [sub] + [m for m in nonempty if m != sub], sub, None, depth + 1)
            pieces.append((None, "\n"))
        else:
            variants = {m: " ".join(reg[m]) for m in models}
            votes = Counter(variants[m] for m in order)
            alts = sorted(votes, key=lambda v: (-votes[v], [variants[m] for m in order].index(v)))
            pieces.append((t, alts, {v: [m for m in models if variants[m] == v] for v in alts}))
        s = e + 1
    return pieces


def build(clip, models):
    recs = {m: json.loads((RUNS / m / f"{clip}.json").read_text()) for m in models}
    hyps = {m: tokens_with_times(r) for m, r in recs.items()}
    seqs = {m: hyps[m][0] for m in models}
    pivot = pick_pivot(seqs, models)
    pieces = rover(seqs, [pivot] + [m for m in models if m != pivot], pivot, hyps[pivot][1])
    out, disputes, last_mark = [], [], -99.0
    for pc in pieces:
        t = pc[0]
        if t is not None and t - last_mark >= 8.0:
            out.append(f"\n<{int(t // 60):02d}:{t % 60:04.1f}>")
            last_mark = t
        if isinstance(pc[1], str):
            out.append(pc[1])
        else:
            alts, who = pc[1], pc[2]
            out.append("[" + "|".join(alts) + "]")
            disputes.append({"t": t, "alternatives": [{"text": v, "models": who[v]} for v in alts]})
    n = len(seqs[pivot])
    body = re.sub(r" *\n *", "\n", " ".join(out)).strip()
    header = (f"# SILVER DRAFT for {clip} - machine majority vote, NOT ground truth.\n"
              f"# Models: {', '.join(models)}; pivot (best mutual agreement): {pivot}\n"
              f"# [a|b|c] = models disagreed; a = majority (ties -> pivot). Empty alt = word absent.\n"
              f"# <mm:ss> = time marker (ignored by score.py). Lines starting with # are ignored.\n"
              f"# To finalise: listen, resolve each [..] to the spoken words, save as {clip}.txt\n"
              f"# (Ukrainian/English words: write as actually spoken; digits vs words: pick one, score.py does not convert).\n")
    (REFS / f"{clip}.draft.txt").write_text(header + body + "\n")
    sil = RUNS / "_silver"
    sil.mkdir(parents=True, exist_ok=True)
    (sil / f"{clip}.disputes.json").write_text(json.dumps(
        {"clip": clip, "models": models, "pivot": pivot, "pivot_words": n, "disputes": disputes},
        ensure_ascii=False, indent=1))
    print(f"{clip}: pivot={pivot} words={n} disputes={len(disputes)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    a = ap.parse_args()
    REFS.mkdir(exist_ok=True)
    for c in CLIPS:
        build(c, a.models.split(","))


if __name__ == "__main__":
    main()
