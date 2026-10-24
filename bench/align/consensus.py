#!/usr/bin/env python3
"""Text-only ASR consensus label for each word of our reference transcript.

support[i] = fraction of the other ASR systems in runs/asr/*/<clip>.txt whose
word sequence contains word i at the matching position (difflib alignment).
Words with support >= 0.5 are treated as "real" (very likely spoken); words
with support < 0.3 are "disputed" (likely an ASR error / hallucination).
Output: runs/align/consensus.json
"""
import difflib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import local_align as L  # noqa: E402

BENCH = Path(__file__).resolve().parents[1]
EXCLUDE = [e for e in __import__("os").environ.get("EXCLUDE", "").split(",") if e]
OUTF = __import__("os").environ.get("OUTF", "consensus.json")


def norm_tokens(text):
    out = []
    for t in re.split(r"[\s\-]+", text):
        c = L.clean_word(t).replace("ё", "е")
        if c:
            out.append(c)
    return out


res = {}
for p in sorted((BENCH / "runs/align/full").glob("video-*.json")):
    d = json.loads(p.read_text())
    clip = d["clip"]
    ours = [w["w"].replace("ё", "е") for w in d["words"]]
    systems = sorted(x.parent.name for x in (BENCH / "runs/asr").glob(f"*/{clip}.txt")
                     if not any(x.parent.name.startswith(e) for e in EXCLUDE))
    hits = [0] * len(ours)
    for s in systems:
        theirs = norm_tokens((BENCH / f"runs/asr/{s}/{clip}.txt").read_text())
        sm = difflib.SequenceMatcher(a=ours, b=theirs, autojunk=False)
        for blk in sm.get_matching_blocks():
            for k in range(blk.size):
                hits[blk.a + k] += 1
    res[clip] = {"systems": systems, "support": [round(h / max(1, len(systems)), 2) for h in hits],
                 "words": ours}
    disputed = [(w, s) for w, s in zip(ours, res[clip]["support"]) if s < 0.3]
    print(clip, len(systems), "systems; disputed:", disputed)
(BENCH / "runs/align" / OUTF).write_text(json.dumps(res, ensure_ascii=False, indent=1))
