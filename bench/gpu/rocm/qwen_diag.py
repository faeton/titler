"""Why is Qwen3-ASR slow on the 890M? Profile one clip."""
import glob, os, time, numpy as np, soundfile as sf, torch
if os.environ.get("NO_MIOPEN"):
    torch.backends.cudnn.enabled = False
from qwen_asr import Qwen3ASRModel
p = glob.glob("/whisper-models/hub/models--Qwen--Qwen3-ASR-1.7B/snapshots/*/")[0]
m = Qwen3ASRModel.from_pretrained(p, dtype=torch.bfloat16, device_map="cuda", max_inference_batch_size=4, max_new_tokens=1024)
print(type(m), [a for a in dir(m) if not a.startswith('__')][:40])
mods = [v for v in vars(m).values() if isinstance(v, torch.nn.Module)]
for mod in mods:
    ps = list(mod.parameters()); print(type(mod).__name__, {str(q.device) for q in ps}, {q.dtype for q in ps}, sum(q.numel() for q in ps) / 1e9)
x, _ = sf.read("/bench/samples/audio/video-34442.16k.wav", dtype="float32")
m.transcribe((x[:16000 * 5], 16000), language="Russian")
from torch.profiler import profile, ProfilerActivity
with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA]) as prof:
    t = time.perf_counter(); r = m.transcribe((x[:16000 * 10], 16000), language="Russian"); torch.cuda.synchronize()
    print("10s clip", time.perf_counter() - t, r[0].text)

print(prof.key_averages().table(sort_by="self_cuda_time_total", row_limit=10))
