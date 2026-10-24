#!/usr/bin/env python3
"""Mixed-language / numbers checks with align_window().  Output: runs/align/mixed.json + .md

Cases are phrases from the benchmark clips, so they live next to the clip drafts in the
gitignored bench/refs/mixed_cases.json: [name, clip, t0, t1, words, expectation].
A  34238 20-31 s is English (a second speaker).  The clip-level auto language was ru, so
   whisper wrote it as Cyrillic sound-alike gibberish.  We align (a) the English transcript
   (whisper language=en) and (b) the Cyrillic mis-transcription, per phrase, with every backend.
B  a loanword typed in Cyrillic vs Latin.
C  digits: "3" with and without verbalisation ("C digit raw" turns verbalisation off).
D  Ukrainian: same-sounding Ukrainian spelling must align; a Ukrainian *translation* must be flagged.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import local_align as L  # noqa: E402

BENCH = Path(__file__).resolve().parents[1]
A = lambda c: str(BENCH / f"samples/audio/{c}.16k.wav")  # noqa: E731
BACKENDS = ["mms_fa", "w2v_ru", "gigaam", "w2v_ru+gigaam"]

CASES = [tuple(c) for c in json.loads((BENCH / "refs/mixed_cases.json").read_text())]

if __name__ == "__main__":
    res, md = [], []
    for be in BACKENDS:
        b, _, v = be.partition("+")
        for m in (b, v):
            if m:
                L.warmup(m)
        for name, clip, t0, t1, words, exp in CASES:
            r = L.align_window(A(clip), t0, t1, words, backend=b, verifier=v or None,
                               verbalize_numbers=(name != "C digit raw"))
            res.append({"backend": be, "case": name, "expect": exp, "words": r})
            md.append(f"| {be} | {name} | " + " ".join(
                f"{x['w']}[{x['start'] if x['start'] is not None else '-'}–{x['end'] if x['end'] is not None else '-'}"
                f" {'✓' if x['status'] == 'aligned' else '✗'} llr={x.get('llr')}]" for x in r) + " |")
            print(md[-1], flush=True)
    (BENCH / "runs/align/mixed.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    (BENCH / "runs/align/mixed.md").write_text("| backend | case | words [start–end status llr] |\n|-|-|-|\n" + "\n".join(md) + "\n")
