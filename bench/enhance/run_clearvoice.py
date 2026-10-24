#!/usr/bin/env python3
"""ClearerVoice-Studio speech enhancement (envs/enh-cv).
usage: run_clearvoice.py MODEL_NAME   (one model per process for clean peak RSS)
48K model gets the 48k stereo file (channels processed independently),
16K models get the 16k mono file. Raw output -> runs/enhance/raw/cv-<model>/<clip>.wav
"""
import json, os, sys, time, resource
import numpy as np, soundfile as sf, torch
torch.set_num_threads(8)
B = "/mnt/flash/home/faeton/work/titler/bench"
CLIPS = ["video-34238", "video-34442", "video-34585"]
name = sys.argv[1]
work = "/mnt/flash/scratch/clearvoice"   # checkpoints/<model> are downloaded relative to cwd
os.makedirs(work, exist_ok=True); os.chdir(work)
from clearvoice import ClearVoice
# warm-up construction downloads the checkpoint if needed; time the second one
ClearVoice(task="speech_enhancement", model_names=[name])
t = time.perf_counter()
cv = ClearVoice(task="speech_enhancement", model_names=[name])
load_s = time.perf_counter() - t
m = cv.models[0]
sr_model = m.args.sampling_rate
var = "cv-" + name
out = f"{B}/runs/enhance/raw/{var}"; os.makedirs(out, exist_ok=True)
for c in CLIPS:
    inp = f"{B}/samples/audio/{c}.{'48k' if sr_model == 48000 else '16k'}.wav"
    info = sf.info(inp)
    t = time.perf_counter()
    y = cv(input_path=inp, online_write=False)
    wall = time.perf_counter() - t
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 1: y = y[None]
    sf.write(f"{out}/{c}.wav", y.T, sr_model, subtype="FLOAT")
    json.dump({"wall_s": wall, "audio_s": info.duration, "rtf": wall / info.duration, "load_s": load_s,
               "peak_rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
               "in": inp, "out_shape": list(y.shape)}, open(f"{out}/{c}.json", "w"), indent=1)
    print(var, c, f"wall={wall:.1f}s rtf={wall/info.duration:.2f}", y.shape, flush=True)
