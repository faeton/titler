#!/usr/bin/env python3
"""Agreement + plausibility for runs/align/full/*.json -> runs/align/full_summary.{json,md}"""
import itertools
import json
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from silero_vad import get_speech_timestamps, load_silero_vad

BENCH = Path(__file__).resolve().parents[1]
FULL = BENCH / "runs/align/full"
ALIGNERS = ["whisper", "mms_fa", "cfa", "w2v_ru", "whisperx", "gigaam"]
vad = load_silero_vad()


def rms_db(x, sr=16000, hop=0.01):
    n = int(sr * hop)
    m = len(x) // n
    r = np.sqrt(np.mean(x[: m * n].reshape(m, n) ** 2, 1))
    return 20 * np.log10(r + 1e-6)


def stats(v):
    v = np.abs(np.asarray(v, float)) * 1000
    return (round(float(np.median(v))), round(float(np.percentile(v, 90))), len(v)) if len(v) else (None, None, 0)


rows_pair, rows_plaus, suspect_rows = {}, {}, {}
per_clip = {}
data = {p.stem: json.loads(p.read_text()) for p in sorted(FULL.glob("video-*.json"))}
pairs = list(itertools.combinations(ALIGNERS, 2))
acc = {pr: {"ds": [], "de": []} for pr in pairs}
plaus = {a: {"vad": [], "pre": [], "post": [], "short": 0, "long": 0, "n": 0} for a in ALIGNERS}
for clip, d in data.items():
    x, sr = sf.read(BENCH / f"samples/audio/{clip}.16k.wav", dtype="float32")
    sp = get_speech_timestamps(torch.from_numpy(x), vad, sampling_rate=16000, return_seconds=True)
    speech = np.zeros(int(len(x) / 160) + 1, bool)
    for s in sp:
        speech[int(s["start"] * 100): int(s["end"] * 100) + 1] = True
    db = rms_db(x)
    ws = d["words"]
    A = d["aligners"]
    for i, w in enumerate(ws):
        if w["suspect"]:
            continue
        for a, b in pairs:
            ra, rb = A[a][i], A[b][i]
            if ra and rb and ra.get("start") is not None and rb.get("start") is not None:
                acc[(a, b)]["ds"].append(ra["start"] - rb["start"])
                acc[(a, b)]["de"].append(ra["end"] - rb["end"])
        for a in ALIGNERS:
            r = A[a][i]
            if not r or r.get("start") is None:
                continue
            s, e = r["start"], r["end"]
            f0 = min(int(s * 100), len(db) - 2); f1 = min(max(f0 + 1, int(e * 100)), len(db) - 1)
            P = plaus[a]
            P["n"] += 1
            P["vad"].append(speech[f0:f1].mean())
            interior = np.median(db[f0:f1]) if f1 > f0 else db[f0]
            P["pre"].append(db[max(0, f0 - 2):f0 + 1].min() - interior)
            P["post"].append(db[f1 - 1:f1 + 2].min() - interior)
            P["short"] += (e - s) < 0.06
            P["long"] += (e - s) > 1.2
    # suspect region summary (whisper hallucination in 34238)
    for a in ALIGNERS:
        sus = [A[a][i] for i, w in enumerate(ws) if w["suspect"] and A[a][i]]
        ok = [A[a][i] for i, w in enumerate(ws) if not w["suspect"] and A[a][i]]
        if not sus:
            continue
        key = lambda r: r.get("lp", r.get("score", r.get("p")))  # noqa: E731
        suspect_rows.setdefault(a, {"sus": [], "ok": []})
        suspect_rows[a]["sus"] += [key(r) for r in sus if key(r) is not None]
        suspect_rows[a]["ok"] += [key(r) for r in ok if key(r) is not None]

summary = {"pairs": {}, "plausibility": {}, "suspect": {}}
md = ["| pair | n | median abs dStart ms | p90 abs dStart ms | median abs dEnd ms | p90 abs dEnd ms |", "|-|-|-|-|-|-|"]
for (a, b), v in acc.items():
    s1, s2 = stats(v["ds"]), stats(v["de"])
    summary["pairs"][f"{a}~{b}"] = {"start": s1, "end": s2}
    md.append(f"| {a} ~ {b} | {s1[2]} | {s1[0]} | {s1[1]} | {s2[0]} | {s2[1]} |")
md += ["", "| aligner | words | mean VAD-speech fraction | words <50% in VAD | median dB(pre-start)-dB(word) | median dB(post-end)-dB(word) | dur<60ms | dur>1.2s |",
       "|-|-|-|-|-|-|-|-|"]
for a, P in plaus.items():
    v = np.array(P["vad"])
    row = {"n": P["n"], "vad_mean": round(float(v.mean()), 3), "vad_lt50": int((v < 0.5).sum()),
           "pre_db": round(float(np.median(P["pre"])), 1), "post_db": round(float(np.median(P["post"])), 1),
           "short": int(P["short"]), "long": int(P["long"])}
    summary["plausibility"][a] = row
    md.append(f"| {a} | {row['n']} | {row['vad_mean']} | {row['vad_lt50']} | {row['pre_db']} | {row['post_db']} | {row['short']} | {row['long']} |")
md += ["", "Suspect region (34238 20-31 s: English speech of a Thai speaker that ru-auto whisper wrote as Cyrillic gibberish 'сэм сэм юбилейный…') — median word score, suspect vs normal words (whisper/whisperx: prob, others: mean token log-posterior; cfa: its own score)", ""]
for a, v in suspect_rows.items():
    summary["suspect"][a] = {"suspect_median": float(np.median(v["sus"])), "normal_median": float(np.median(v["ok"])),
                             "n_suspect": len(v["sus"])}
    md.append(f"- {a}: suspect {np.median(v['sus']):.3f} (n={len(v['sus'])}) vs normal {np.median(v['ok']):.3f}")
(BENCH / "runs/align/full_summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False))
(BENCH / "runs/align/full_summary.md").write_text("\n".join(md) + "\n")
print("\n".join(md))
