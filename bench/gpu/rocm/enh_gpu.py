"""Speech enhancement on the 890M (ROCm). Timing only (outputs written to scratch, not judged here).

usage: enh_gpu.py cv:<ClearVoiceModel> | demucs:<htdemucs|htdemucs_ft>   [--device cuda|cpu]
  cv:*     run with PY=/venvcv/bin/python (ClearVoice needs numpy<2)
Appends records to /bench/runs/gpu/enhance/<tag>-<device>.jsonl
"""
import argparse, json, os, sys, time
import numpy as np, soundfile as sf, torch
if os.environ.get("NO_MIOPEN"):  # MIOpen has only naive bf16/fp16 conv kernels for gfx1150
    torch.backends.cudnn.enabled = False

ap = argparse.ArgumentParser(); ap.add_argument("spec"); ap.add_argument("--device", default="cuda")
a = ap.parse_args()
torch.set_num_threads(8)
CLIPS = ["video-34238", "video-34442", "video-34585"]
AUD = "/bench/samples/audio"; OUT = "/bench/runs/gpu/enhance"; SCR = "/scratch/enh-out"
os.makedirs(OUT, exist_ok=True); os.makedirs(SCR, exist_ok=True)
kind, name = a.spec.split(":")
dev = a.device
if dev == "cpu":
    # ClearVoice picks cuda whenever it is visible; hide it for the CPU baseline
    torch.cuda.is_available = lambda: False


def sync():
    if dev == "cuda":
        torch.cuda.synchronize()


t0 = time.perf_counter()
if kind == "cv":
    os.chdir("/scratch/clearvoice")  # checkpoints/<model> relative to cwd (copied from the CPU bench)
    from clearvoice import ClearVoice
    import clearvoice.networks as _N
    if dev == "cuda":  # ClearVoice picks the GPU via nvidia-smi; there is none on ROCm
        _N.SpeechModel.get_free_gpu = lambda self: 0
    cv = ClearVoice(task="speech_enhancement", model_names=[name])
    srm = cv.models[0].args.sampling_rate
    print("clearvoice use_cuda =", getattr(cv.models[0].args, "use_cuda", "?"), "sr", srm, flush=True)

    def run(c):
        inp = f"{AUD}/{c}.{'48k' if srm == 48000 else '16k'}.wav"
        y = np.asarray(cv(input_path=inp, online_write=False), dtype=np.float32)
        return y, srm, sf.info(inp).duration
elif kind == "demucs":
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    import torchaudio.functional as AF
    model = get_model(name).eval().to(dev)

    def run(c):
        x, sr = sf.read(f"{AUD}/{c}.48k.wav", dtype="float32", always_2d=True)
        w = AF.resample(torch.from_numpy(x.T.copy()), 48000, model.samplerate)
        ref = w.mean(0); mu, sd = ref.mean(), ref.std()
        with torch.no_grad():
            est = apply_model(model, ((w - mu) / sd)[None].to(dev), shifts=1, split=True, overlap=0.25,
                              progress=False, num_workers=0, device=dev)[0]
        est = est.cpu() * sd + mu
        voc = est[list(model.sources).index("vocals")]
        return voc.numpy(), model.samplerate, len(x) / 48000
else:
    sys.exit("bad spec")
sync(); load_s = time.perf_counter() - t0
tag = f"{kind}-{name}"
with open(f"{OUT}/{tag}-{dev}.jsonl", "w") as fo:
    for c in CLIPS:
        t = time.perf_counter(); y, sr, dur = run(c); sync(); wall = time.perf_counter() - t
        sf.write(f"{SCR}/{tag}-{dev}-{c}.wav", np.atleast_2d(y).T, sr)
        rec = {"tag": tag, "device": dev, "clip": c, "audio_s": round(dur, 2), "load_s": round(load_s, 2),
               "wall_s": round(wall, 2), "rtf": round(wall / dur, 3),
               "gpu_peak_alloc_mib": torch.cuda.max_memory_allocated() // 2**20 if dev == "cuda" else None}
        fo.write(json.dumps(rec) + "\n")
        print(rec, flush=True)
