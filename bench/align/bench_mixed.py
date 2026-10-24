#!/usr/bin/env python3
"""Mixed-language / numbers checks with align_window().  Output: runs/align/mixed.json + .md

A  34238 20-31 s is English (a Thai speaker: "same same ... you've been in Thailand
   recently ... they do same same there all the time").  The clip-level auto language
   was ru, so whisper wrote it in Cyrillic ("сэм сэм юбилейный талант ... таллинн").
   We align (a) the English transcript (whisper language=en) and (b) the Cyrillic
   mis-transcription, per phrase, with every backend.
B  loanword "эко-воркинги" typed in Cyrillic vs Latin ("eco workings").
C  digits: "за 3 дня" with and without verbalisation.
D  Ukrainian: same-sounding Ukrainian spelling ("ні щуканом", "трильйон") must align;
   a Ukrainian *translation* ("цілком місцевий мешканець") must be flagged.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import local_align as L  # noqa: E402

BENCH = Path(__file__).resolve().parents[1]
A = lambda c: str(BENCH / f"samples/audio/{c}.16k.wav")  # noqa: E731
BACKENDS = ["mms_fa", "w2v_ru", "gigaam", "w2v_ru+gigaam"]

CASES = [
    # (name, clip, t0, t1, words, expectation)
    ("A1 en phrase 1", "video-34238", 20.4, 22.9, "same same you've been in thailand recently".split(), "align"),
    ("A1 ru-translit phrase 1", "video-34238", 20.4, 22.9, "сэм сэм юбилейный талант и".split(), "partly wrong"),
    ("A2 en phrase 2", "video-34238", 25.3, 28.3, "thailand they do same same there all the time".split(), "align"),
    ("A2 ru-translit phrase 2", "video-34238", 25.3, 28.3, "таллинн дэйду сэм сэм дэйр олд и time".split(), "partly wrong"),
    ("A3 en phrase 3", "video-34238", 27.9, 31.2, "same same you and same same same same".split(), "align"),
    ("A3 ru-translit phrase 3", "video-34238", 27.9, 31.2, "сэм сэм юэн сэм сэм сэм сэм".split(), "sound-alike"),
    ("B cyr loanword", "video-34585", 22.6, 25.8, "какие то даже эко воркинги я присматриваю".split(), "align"),
    ("B latin loanword", "video-34585", 22.6, 25.8, "какие то даже eco workings я присматриваю".split(), "align"),
    ("B latin coworking", "video-34585", 22.6, 25.8, "какие то даже coworking я присматриваю".split(), "align?"),
    ("C words", "video-34585", 10.0, 14.5, "в глинялге за три дня вполне местный житель".split(), "align"),
    ("C digit verbalised", "video-34585", 10.0, 14.5, "в глинялге за 3 дня вполне местный житель".split(), "align"),
    ("C digit raw", "video-34585", 10.0, 14.5, "в глинялге за 3 дня вполне местный житель".split(), "raw"),
    ("D ru", "video-34442", 6.5, 10.0, "никто еще не прыгнул ни щуканом ни".split(), "align"),
    ("D uk spelling", "video-34442", 6.5, 10.0, "никто еще не прыгнул ні щуканом ні".split(), "align"),
    ("D uk spelling 2", "video-34585", 20.5, 23.0, "кафешек трильйон просто".split(), "align"),
    ("D uk translation", "video-34585", 12.5, 14.5, "цілком місцевий мешканець".split(), "flag"),
]

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
