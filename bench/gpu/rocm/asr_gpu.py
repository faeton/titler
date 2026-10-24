"""ASR on the 890M via ROCm (torch 2.14.1+rocm7.2, CTranslate2 4.8.3 ROCm wheel).

usage: asr_gpu.py BACKEND [--device cuda|cpu] [--ct float16]
  fw-turbo / fw-large-v3   faster-whisper (CTranslate2 ROCm), beam 5, VAD, word timestamps
                           (same decode params as bench/asr/run_fw.py)
  hf-turbo                 transformers Whisper large-v3-turbo, fp16, greedy, long-form
  gigaam-rnnt / gigaam-ctc GigaAM-v3 (torch), fixed 20 s chunks (timing only)
  qwen                     Qwen3-ASR-1.7B (qwen-asr, transformers backend), bf16
Writes /bench/runs/gpu/asr/<backend>-<device>.jsonl (one record per clip).
"""
import argparse, glob, json, os, sys, time
import numpy as np, soundfile as sf, torch
if os.environ.get("NO_MIOPEN"):  # MIOpen has only naive bf16/fp16 conv kernels for gfx1150
    torch.backends.cudnn.enabled = False

CLIPS = ["video-34238", "video-34442", "video-34585"]
AUD = "/bench/samples/audio"
OUT = "/bench/runs/gpu/asr"
ap = argparse.ArgumentParser()
ap.add_argument("backend"); ap.add_argument("--device", default="cuda"); ap.add_argument("--ct", default=None)
a = ap.parse_args()
torch.set_num_threads(8)
dev = a.device


def snap(repo):
    for root in ("/hf/hub", "/whisper-models/hub", "/scratch/hf-home/hub"):
        g = glob.glob(f"{root}/models--{repo.replace('/', '--')}/snapshots/*/")
        if g:
            return g[0]
    return repo  # will download into HF_HOME (scratch)


def sync():
    if dev == "cuda":
        torch.cuda.synchronize()


def gpu_peak():
    return torch.cuda.max_memory_allocated() // 2**20 if dev == "cuda" and torch.cuda.is_available() else None


t0 = time.perf_counter()
b = a.backend
if b.startswith("fw-"):
    from faster_whisper import WhisperModel
    repo = {"fw-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "fw-large-v3": "Systran/faster-whisper-large-v3"}[b]
    ct = a.ct or ("float16" if dev == "cuda" else "int8")
    m = WhisperModel(snap(repo), device=dev, compute_type=ct, cpu_threads=8, num_workers=1)
    kw = dict(word_timestamps=True, vad_filter=True, vad_parameters={"min_silence_duration_ms": 300}, beam_size=5, language="ru")
    list(m.transcribe(np.zeros(32000, dtype=np.float32), language="ru")[0])

    def run(x):
        segs, _ = m.transcribe(x, **kw)
        return " ".join(s.text.strip() for s in segs)
    b = f"{b}-{ct}"
elif b == "hf-turbo":
    from transformers import WhisperForConditionalGeneration, WhisperProcessor
    repo = snap("openai/whisper-large-v3-turbo")
    dt = torch.float16 if dev == "cuda" else torch.float32
    proc = WhisperProcessor.from_pretrained(repo)
    m = WhisperForConditionalGeneration.from_pretrained(repo, torch_dtype=dt).to(dev).eval()

    def run(x):
        f = proc(x, sampling_rate=16000, return_tensors="pt", truncation=False, padding="longest",
                 return_attention_mask=True)
        if f.input_features.shape[-1] < 3000:
            f = proc(x, sampling_rate=16000, return_tensors="pt", return_attention_mask=True)
        with torch.inference_mode():
            ids = m.generate(f.input_features.to(dev, dt), attention_mask=f.attention_mask.to(dev),
                             language="ru", task="transcribe", return_timestamps=True, num_beams=1)
        return proc.batch_decode(ids, skip_special_tokens=True)[0]
    run(np.zeros(32000, dtype=np.float32))
elif b.startswith("gigaam"):
    import gigaam, gigaam.model
    # gigaam shells out to ffmpeg for decoding; our clips are already 16 kHz mono wav
    gigaam.model.load_audio = lambda p, sample_rate=16000: torch.from_numpy(sf.read(p, dtype="float32")[0])
    name = {"gigaam-rnnt": "v3_e2e_rnnt", "gigaam-ctc": "v3_e2e_ctc"}[b]
    m = gigaam.load_model(name, fp16_encoder=(dev == "cuda"), device=dev, download_root="/scratch/gigaam")

    def run(x):
        import tempfile
        parts = []
        for i in range(0, len(x), 20 * 16000):
            seg = x[i:i + 20 * 16000]
            if len(seg) < 8000:
                continue
            with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
                sf.write(tf.name, seg, 16000)
                parts.append(m.transcribe(tf.name))
        return " ".join(p if isinstance(p, str) else getattr(p, "text", str(p)) for p in parts)
    run(np.zeros(32000, dtype=np.float32))
elif b == "qwen":
    from qwen_asr import Qwen3ASRModel
    dt = getattr(torch, os.environ.get("QWEN_DTYPE", "bfloat16")) if dev == "cuda" else torch.float32
    m = Qwen3ASRModel.from_pretrained(snap("Qwen/Qwen3-ASR-1.7B"), dtype=dt, device_map=dev,
                                      max_inference_batch_size=4, max_new_tokens=1024)
    m.transcribe((np.zeros(32000, dtype=np.float32), 16000), language="Russian")

    def run(x):
        return m.transcribe((x, 16000), language="Russian")[0].text
    b = f"qwen-{str(dt).split('.')[-1]}"
else:
    sys.exit(f"unknown backend {b}")
sync()
load_s = time.perf_counter() - t0
os.makedirs(OUT, exist_ok=True)
outf = f"{OUT}/{b}-{dev}.jsonl"
with open(outf, "w") as fo:
    for c in CLIPS:
        x, sr = sf.read(f"{AUD}/{c}.16k.wav", dtype="float32")
        t = time.perf_counter()
        text = run(x)
        sync()
        dt_ = time.perf_counter() - t
        rec = {"backend": b, "device": dev, "clip": c, "audio_s": round(len(x) / sr, 2), "load_s": round(load_s, 2),
               "infer_s": round(dt_, 2), "rtf": round(dt_ / (len(x) / sr), 3), "gpu_peak_alloc_mib": gpu_peak(),
               "text": text.strip()}
        fo.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"[{b}/{dev}] {c}: {dt_:.2f}s rtf {rec['rtf']} :: {text.strip()[:100]}", flush=True)
