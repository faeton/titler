import glob, os, time, torch, soundfile as sf
torch.backends.cudnn.enabled = False
from transformers import AutoModelForCTC
p = glob.glob("/hf/hub/models--MahmoudAshraf--mms-300m-1130-forced-aligner/snapshots/*/")[0]
m = AutoModelForCTC.from_pretrained(p, torch_dtype=torch.float16).cuda().eval()
x, _ = sf.read("/bench/samples/audio/video-34585.16k.wav", dtype="float32")
xt = torch.from_numpy(x)[None].cuda().half()
with torch.inference_mode():
    m(xt[:, :16000 * 5]); torch.cuda.synchronize()
    for attn in ("sdpa", "eager"):
        t = time.perf_counter(); fe = m.wav2vec2.feature_extractor(xt); torch.cuda.synchronize(); a = time.perf_counter() - t
        t = time.perf_counter(); m(xt); torch.cuda.synchronize(); b = time.perf_counter() - t
        print(f"conv feature extractor {a:.2f}s, full forward {b:.2f}s", attn)
        break
