#!/usr/bin/env python3
"""Second ASR pass with a stronger faster-whisper model on selected variants.
usage: ASR_MODEL=large-v3-turbo asr2.py variant1 variant2 ...   (envs/enh-metrics)
Stores results[v][clip]["asr2"] = {model, text, cer_vs_orig, wer_vs_ref, cer_vs_ref}.
"""
import json, os, sys, time
import soundfile as sf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import postproc as P

R = P.R
res = json.load(open(f"{R}/results.json"))
model = os.environ.get("ASR_MODEL", "large-v3-turbo")
variants = ["original"] + [v for v in sys.argv[1:] if v != "original"]
for v in variants:
    for c in P.CLIPS:
        e = res.get(v, {}).get(c)
        if e is None or (e.get("asr2", {}).get("model") == model):
            continue
        p = f"{P.SAMPLES}/{c}.16k.wav" if v == "original" else f"{R}/aligned/{v}/{c}.16k.wav"
        x, _ = sf.read(p, dtype="float32")
        t = time.perf_counter()
        a = P.transcribe(x)
        a["model"] = model; a["time_s"] = time.perf_counter() - t
        e["asr2"] = a
        json.dump(res, open(f"{R}/results.json", "w"), indent=1, ensure_ascii=False)
        print(v, c, f"{a['time_s']:.1f}s", a["text"][:80], flush=True)
for v in variants:
    for c in P.CLIPS:
        e = res.get(v, {}).get(c)
        if not e or "asr2" not in e:
            continue
        e["asr2"]["cer_vs_orig"] = P.cer(res["original"][c]["asr2"]["text"], e["asr2"]["text"]) if v != "original" else 0.0
        rp = P.find_ref(c)
        if rp:
            ref = P.load_ref(rp)
            e["asr2"]["wer_vs_ref"] = P.wer(ref, e["asr2"]["text"])
            e["asr2"]["cer_vs_ref"] = P.cer(ref, e["asr2"]["text"])
json.dump(res, open(f"{R}/results.json", "w"), indent=1, ensure_ascii=False)
