#!/usr/bin/env python3
"""Demucs v4 vocal-stem separation as a speech/background splitter (envs/enh-demucs).
usage: run_demucs.py htdemucs|htdemucs_ft
48k stereo -> 44.1k -> model -> 48k. Background stem = mix - vocals (exact complement),
so speech + k*background reconstructs the original exactly at k=1.
Outputs:
  raw/demucs-<m>-vocals/<clip>.wav          speech stem (strong preset candidate)
  raw/demucs-<m>-bg{-6,-12,-20}/<clip>.wav  speech + background at -6/-12/-20 dB (gentle candidates)
  stems/demucs-<m>/<clip>/{speech,background,bg_model}.wav + stems.json (reconstruction error)
"""
import json, os, sys, time, resource
import numpy as np, soundfile as sf, torch, torchaudio.functional as AF
torch.set_num_threads(8)
os.environ.setdefault("TORCH_HOME", "/mnt/flash/scratch/torch-hub")
from demucs.pretrained import get_model
from demucs.apply import apply_model, BagOfModels
B = "/mnt/flash/home/faeton/work/titler/bench"
R = f"{B}/runs/enhance"
CLIPS = ["video-34238", "video-34442", "video-34585"]
name = sys.argv[1]
get_model(name)  # download
t = time.perf_counter()
model = get_model(name)
model.eval()
srcs = list(model.sources); vi = srcs.index("vocals")
note = ""
if name == "htdemucs_ft" and isinstance(model, BagOfModels):
    # keep only the vocals specialist (weights are one-hot per source)
    k = [i for i, w in enumerate(model.weights) if w[vi] > 0][0]
    model = model.models[k]; note = f"vocals specialist sub-model #{k} only"
load_s = time.perf_counter() - t
tag = f"demucs-{name}"
def db(x, ref): return float(20 * np.log10(np.linalg.norm(x) / (np.linalg.norm(ref) + 1e-12) + 1e-12))
for c in CLIPS:
    x, sr = sf.read(f"{B}/samples/audio/{c}.48k.wav", dtype="float32", always_2d=True)
    n = len(x)
    t = time.perf_counter()
    wav = torch.from_numpy(x.T.copy())
    w44 = AF.resample(wav, 48000, model.samplerate)
    ref = w44.mean(0); mu, sd = ref.mean(), ref.std()
    with torch.no_grad():
        est = apply_model(model, ((w44 - mu) / sd)[None], shifts=1, split=True, overlap=0.25,
                          progress=False, num_workers=0)[0]
    est = est * sd + mu          # (S, C, T44)
    rec44 = db((w44 - est.sum(0)).numpy(), w44.numpy())
    est48 = AF.resample(est, model.samplerate, 48000)[..., :n]
    if est48.shape[-1] < n:
        est48 = torch.nn.functional.pad(est48, (0, n - est48.shape[-1]))
    wall = time.perf_counter() - t
    voc = est48[vi].numpy().T
    bg = x - voc
    bg_model = (est48.sum(0) - est48[vi]).numpy().T
    meta = {"wall_s": wall, "audio_s": n / 48000, "rtf": wall / (n / 48000), "load_s": load_s,
            "peak_rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, "note": note}
    sd_ = f"{R}/stems/{tag}/{c}"; os.makedirs(sd_, exist_ok=True)
    sf.write(f"{sd_}/speech.wav", voc, 48000, subtype="FLOAT")
    sf.write(f"{sd_}/background.wav", bg, 48000, subtype="FLOAT")
    sf.write(f"{sd_}/bg_model.wav", bg_model, 48000, subtype="FLOAT")
    st = {"recon_err_db_44k_sum_of_model_stems": rec44,
          "recon_err_db_48k_speech_plus_bgmodel": db(x - voc - bg_model, x),
          "recon_err_db_48k_speech_plus_residual": db(x - voc - bg, x),
          "speech_rel_db": db(voc, x), "background_rel_db": db(bg, x)}
    json.dump(st, open(f"{sd_}/stems.json", "w"), indent=1)
    for v, y in [("vocals", voc)] + [(f"bg{g}", voc + 10 ** (g / 20) * bg) for g in (-6, -12, -20)]:
        d = f"{R}/raw/{tag}-{v}"; os.makedirs(d, exist_ok=True)
        sf.write(f"{d}/{c}.wav", y, 48000, subtype="FLOAT")
        json.dump(meta, open(f"{d}/{c}.json", "w"), indent=1)
    print(tag, c, f"wall={wall:.1f}s rtf={meta['rtf']:.2f}", st, flush=True)
