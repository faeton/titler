"""wav2vec2 CTC emissions (the expensive half of forced alignment) on the 890M vs CPU.

usage: align_gpu.py <hf-repo> [--device cuda|cpu]
Whole-clip forward (no chunking). The Viterbi/trellis step is cheap and stays on CPU.
"""
import argparse, glob, json, os, time
import numpy as np, soundfile as sf, torch
if os.environ.get("NO_MIOPEN"):  # MIOpen has only naive bf16/fp16 conv kernels for gfx1150
    torch.backends.cudnn.enabled = False

ap = argparse.ArgumentParser(); ap.add_argument("repo"); ap.add_argument("--device", default="cuda")
ap.add_argument("--fp16", action="store_true")
a = ap.parse_args(); dev = a.device
torch.set_num_threads(8)
from transformers import AutoModelForCTC

snap = (glob.glob(f"/hf/hub/models--{a.repo.replace('/', '--')}/snapshots/*/") or [a.repo])[0]
t0 = time.perf_counter()
dt = torch.float16 if a.fp16 else torch.float32
m = AutoModelForCTC.from_pretrained(snap, torch_dtype=dt).to(dev).eval()
with torch.inference_mode():
    m(torch.zeros(1, 16000, device=dev, dtype=dt))
if dev == "cuda":
    torch.cuda.synchronize()
load_s = time.perf_counter() - t0
os.makedirs("/bench/runs/gpu/align", exist_ok=True)
tag = a.repo.split("/")[-1] + ("-fp16" if a.fp16 else "")
with open(f"/bench/runs/gpu/align/{tag}-{dev}.jsonl", "w") as fo:
    for c in ["video-34238", "video-34442", "video-34585"]:
        x, sr = sf.read(f"/bench/samples/audio/{c}.16k.wav", dtype="float32")
        x = (x - x.mean()) / (x.std() + 1e-7)
        t = time.perf_counter()
        with torch.inference_mode():
            em = torch.log_softmax(m(torch.from_numpy(x)[None].to(dev, dt)).logits.float(), -1).cpu()
        wall = time.perf_counter() - t
        rec = {"model": tag, "device": dev, "clip": c, "audio_s": round(len(x) / sr, 2), "load_s": round(load_s, 2),
               "wall_s": round(wall, 3), "rtf": round(wall / (len(x) / sr), 4), "frames": em.shape[1],
               "gpu_peak_alloc_mib": torch.cuda.max_memory_allocated() // 2**20 if dev == "cuda" else None}
        fo.write(json.dumps(rec) + "\n"); print(rec, flush=True)
