#!/usr/bin/env python3
"""MDX/Roformer/VR separators via python-audio-separator (envs/enh-demucs).
usage: run_uvr.py MODEL_FILENAME SHORT_TAG SPEECH_STEM_NAME
Speech stem is rescaled by the single gain that best fits (speech+other) to the original
(audio-separator peak-normalises outputs), then background = original - speech.
"""
import json, os, sys, time, resource, glob
import numpy as np, soundfile as sf, torch
torch.set_num_threads(8)
from audio_separator.separator import Separator
B = "/mnt/flash/home/faeton/work/titler/bench"; R = f"{B}/runs/enhance"
CLIPS = ["video-34238", "video-34442", "video-34585"]
model, tag, speech_stem = sys.argv[1:4]
tmp = f"/mnt/flash/scratch/uvr-out/{tag}"; os.makedirs(tmp, exist_ok=True)
mk = lambda: Separator(output_dir=tmp, model_file_dir="/mnt/flash/scratch/audio-separator-models",
                       output_format="WAV", sample_rate=48000, use_soundfile=True, log_level=30)
s = mk(); s.load_model(model)          # download
t = time.perf_counter(); s = mk(); s.load_model(model); load_s = time.perf_counter() - t
def db(x, ref): return float(20 * np.log10(np.linalg.norm(x) / (np.linalg.norm(ref) + 1e-12) + 1e-12))
for c in CLIPS:
    x, _ = sf.read(f"{B}/samples/audio/{c}.48k.wav", dtype="float32", always_2d=True); n = len(x)
    for f in glob.glob(f"{tmp}/*"): os.remove(f)
    t = time.perf_counter(); files = s.separate(f"{B}/samples/audio/{c}.48k.wav"); wall = time.perf_counter() - t
    files = [f if os.path.isabs(f) else os.path.join(tmp, f) for f in files]
    stems = {}
    for f in files:
        y, sr = sf.read(f, dtype="float32", always_2d=True); assert sr == 48000, sr
        y = y[:n] if len(y) >= n else np.pad(y, ((0, n - len(y)), (0, 0)))
        name = f.rsplit("(", 1)[-1].split(")")[0]; stems[name] = y
    sp_key = [k for k in stems if k.lower() == speech_stem.lower()][0]
    other = [k for k in stems if k != sp_key]
    tot = sum(stems.values())
    g = float((tot * x).sum() / ((tot * tot).sum() + 1e-12))
    voc = stems[sp_key] * g; bg = x - voc
    meta = {"wall_s": wall, "audio_s": n / 48000, "rtf": wall / (n / 48000), "load_s": load_s,
            "peak_rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, "model": model}
    sd_ = f"{R}/stems/{tag}/{c}"; os.makedirs(sd_, exist_ok=True)
    sf.write(f"{sd_}/speech.wav", voc, 48000, subtype="FLOAT"); sf.write(f"{sd_}/background.wav", bg, 48000, subtype="FLOAT")
    st = {"gain_fit": g, "stems": list(stems), "recon_err_db_model_stems": db(x - g * tot, x),
          "speech_rel_db": db(voc, x), "background_rel_db": db(bg, x)}
    json.dump(st, open(f"{sd_}/stems.json", "w"), indent=1)
    for v, y in [("speech", voc)] + [(f"bg{gg}", voc + 10 ** (gg / 20) * bg) for gg in (-12,)]:
        d = f"{R}/raw/{tag}-{v}"; os.makedirs(d, exist_ok=True)
        sf.write(f"{d}/{c}.wav", y, 48000, subtype="FLOAT"); json.dump(meta, open(f"{d}/{c}.json", "w"), indent=1)
    print(tag, c, f"wall={wall:.1f}s rtf={meta['rtf']:.2f}", st, flush=True)
