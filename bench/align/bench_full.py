#!/usr/bin/env python3
"""Full-clip word alignment with every candidate, same transcript (faster-whisper
large-v3 auto, runs/align/asr/<clip>.json).  Output: runs/align/full/<clip>.json

aligners:
  whisper   faster-whisper cross-attention/DTW word timestamps (baseline)
  mms_fa    torchaudio MMS_FA via local_align engine (uroman, whole-clip Viterbi, edge filler)
  w2v_ru    jonatasgrosman/wav2vec2-large-xlsr-53-russian via local_align engine
  whisperx  whisperx.align() (3.8.6) with its default ru model (same jonatasgrosman weights)
  cfa       ctc-forced-aligner 0.3 official pipeline (MMS-300m-1130, uroman, <star> per word)
  gigaam    GigaAM-v3 CTC emissions via local_align engine (40 ms frames)
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).parent))
import local_align as L  # noqa: E402

BENCH = Path(__file__).resolve().parents[1]
OUT = BENCH / "runs/align/full"
OUT.mkdir(parents=True, exist_ok=True)
CLIPS = [a for a in sys.argv[1:] if not a.startswith("--")] or ["video-34238", "video-34442", "video-34585"]
# 34238 20-31 s is English speech ("same same ... Thailand") that ru-auto whisper wrote as Cyrillic
# gibberish ("сэм сэм юбилейный талант"): excluded from agreement, analysed separately
SUSPECT = {"video-34238": (20.0, 31.0)}


def words_of(clip):
    d = json.loads((BENCH / f"runs/align/asr/{clip}.json").read_text())
    ws = []
    for si, s in enumerate(d["segments"]):
        for w in s["words"]:
            c = L.clean_word(w["w"])
            if not c:
                continue
            sus = clip in SUSPECT and SUSPECT[clip][0] <= w["start"] < SUSPECT[clip][1]
            ws.append({"w": c, "raw": w["w"].strip(), "seg": si, "start": w["start"], "end": w["end"],
                       "p": w["p"], "suspect": sus})
    return d, ws


def engine(clip, ws, backend):
    audio = L.load_audio(str(BENCH / f"samples/audio/{clip}.16k.wav"))
    be = L.get_backend(backend)
    t = time.perf_counter()
    lp, frame = be.emissions(torch.from_numpy(audio))
    t_em = time.perf_counter() - t
    toks = [be.tokens(L.verbalize(w["w"])) for w in ws]
    t = time.perf_counter()
    res = L.align_run(lp, frame, toks, be, lead_filler=True, tail_filler=True, with_llr=True)
    t_al = time.perf_counter() - t
    out = []
    for r in res:
        out.append(None if r is None else {"start": round(r["start"], 3), "end": round(r["end"], 3),
                                           "lp": round(r["lp"], 3), "gop": round(r["gop"], 3),
                                           "llr": round(r["llr"], 2) if np.isfinite(r["llr"]) else None})
    return out, {"emission_s": round(t_em, 2), "align_s": round(t_al, 2), "frame_s": frame}


def whisperx_run(clip, d, ws):
    import whisperx
    from whisperx.alignment import align, load_align_model
    model, meta = load_align_model("ru", "cpu")
    audio = L.load_audio(str(BENCH / f"samples/audio/{clip}.16k.wav"))
    segs = [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in d["segments"]]
    t = time.perf_counter()
    r = align(segs, model, meta, audio, "cpu", return_char_alignments=False)
    dt = time.perf_counter() - t
    # map whisperx words (segment order) onto our cleaned word list
    wx = [w for s in r["segments"] for w in s["words"]]
    wx = [w for w in wx if L.clean_word(w["word"])]
    # whisperx splits on spaces ("как-то" = 1 word); our list follows whisper tokens
    # ("как", "-то").  Greedy char-stream match: one whisperx word -> k of ours.
    key = lambda t: L.clean_word(t).replace("-", "")  # noqa: E731
    out = [None] * len(ws)
    i = 0
    for x in wx:
        kx = key(x["word"])
        for k in (1, 2, 3):
            if "".join(key(w["w"]) for w in ws[i:i + k]) == kx:
                if x.get("start") is not None:
                    if k == 1:
                        out[i] = {"start": x["start"], "end": x["end"], "score": x.get("score")}
                    else:  # split a hyphen compound proportionally to length
                        tot = sum(len(key(w["w"])) for w in ws[i:i + k]); acc = x["start"]
                        for j in range(i, i + k):
                            dd = (x["end"] - x["start"]) * len(key(ws[j]["w"])) / tot
                            out[j] = {"start": acc, "end": acc + dd, "score": x.get("score"), "split": True}
                            acc += dd
                i += k
                break
    return out, {"total_s": round(dt, 2)}


def cfa_run(clip, ws):
    from ctc_forced_aligner import (generate_emissions, get_alignments, get_spans,
                                    postprocess_results, preprocess_text)
    from transformers import AutoModelForCTC, AutoTokenizer
    repo = "MahmoudAshraf/mms-300m-1130-forced-aligner"
    model = AutoModelForCTC.from_pretrained(repo).eval()
    tok = AutoTokenizer.from_pretrained(repo)
    audio = torch.from_numpy(L.load_audio(str(BENCH / f"samples/audio/{clip}.16k.wav")))
    t = time.perf_counter()
    em, stride = generate_emissions(model, audio, batch_size=4)
    text = " ".join(w["w"] for w in ws)
    ts, txt = preprocess_text(text, romanize=True, language="rus")
    segments, scores, blank = get_alignments(em, ts, tok)
    spans = get_spans(ts, segments, blank)
    res = postprocess_results(txt, spans, stride, scores)
    dt = time.perf_counter() - t
    assert len(res) == len(ws), (len(res), len(ws))
    return [{"start": round(r["start"], 3), "end": round(r["end"], 3), "score": float(r["score"])} for r in res], \
        {"total_s": round(dt, 2)}


if __name__ == "__main__":
    only_wx = "--whisperx-only" in sys.argv
    CLIPS = [c for c in CLIPS if not c.startswith("--")]
    for clip in CLIPS:
        if only_wx:
            d, ws = words_of(clip)
            res = json.loads((OUT / f"{clip}.json").read_text())
            res["aligners"]["whisperx"], res["timing"]["whisperx"] = whisperx_run(clip, d, ws)
            print(clip, sum(r is not None for r in res["aligners"]["whisperx"]), len(ws))
            (OUT / f"{clip}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
            continue
        d, ws = words_of(clip)
        res = {"clip": clip, "words": ws, "aligners": {}, "timing": {}}
        res["aligners"]["whisper"] = [{"start": w["start"], "end": w["end"], "p": w["p"]} for w in ws]
        for be in ["mms_fa", "w2v_ru", "gigaam"]:
            res["aligners"][be], res["timing"][be] = engine(clip, ws, be)
            print(clip, be, res["timing"][be], flush=True)
        res["aligners"]["whisperx"], res["timing"]["whisperx"] = whisperx_run(clip, d, ws)
        print(clip, "whisperx", res["timing"]["whisperx"], flush=True)
        res["aligners"]["cfa"], res["timing"]["cfa"] = cfa_run(clip, ws)
        print(clip, "cfa", res["timing"]["cfa"], flush=True)
        (OUT / f"{clip}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
