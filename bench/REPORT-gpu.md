# Titler on the n5 iGPU (Radeon 890M, gfx1150): what runs, how fast

Date: 2026-10-24. n5 (Ryzen AI 9 HX PRO 370, 96 GB, TrueNAS 25.10, kernel 6.12.105, host Mesa 25.0.4).
Scripts: `bench/gpu/`. Raw results: `bench/runs/gpu/`. Scratch (venvs, models, ~20 GB): `/mnt/flash/scratch/titler-gpu/`.

**Bottom line.** The 890M is usable for almost all of Titler, through three stacks:

| Stack | Works? | Use for |
|---|---|---|
| **ROCm 7.2 PyTorch** (pip wheels, gfx1150 native, **no `HSA_OVERRIDE`**) | yes, only with MIOpen off + AOTriton on | GigaAM-v3, Qwen3-ASR, wav2vec2/MMS alignment, ClearVoice MossFormer*, Demucs, HF Whisper |
| **CTranslate2 4.8.3 ROCm wheel** (official release asset) | yes | faster-whisper drop-in |
| **ggml Vulkan** (`ghcr.io/ggml-org/whisper.cpp:main-vulkan`, RADV) | yes, zero setup | whisper.cpp large-v3/turbo, **parakeet-tdt-v3** (`parakeet-cli`) |
| **VAAPI** (`~/.local/bin/ffmpeg-hw`) | yes (two driver bugs, workarounds) | HEVC decode, H.264/HEVC encode |
| XDNA NPU | **no** — kernel 6.12 lacks `amdxdna` (6.14+), TrueNAS can't build modules | — |

Speedups vs CPU@8 threads: ~**3×** Whisper-turbo, Qwen3-ASR, MossFormer2/GAN, MMS; **≥5×** GigaAM; ~**4×** render encode. **No gain**: faster-whisper large-v3, FRCRN, DeepFilterNet (keep DFN on CPU, rtf 0.09).

Timing caveat: three CPU benchmark agents ran concurrently (load 10–30); CPU numbers contended, GPU much less.

## 0. Environment findings
- **Ollama uses Vulkan, not ROCm** (`OLLAMA_VULKAN=1`, `OLLAMA_IGPU_ENABLE=1`, `/dev/dri` + `/dev/kfd`, no HSA override). Log: `Vulkan0 : AMD Radeon 890M Graphics (RADV GFX1150) (49127 MiB)`.
- Memory: 2 GiB VRAM carve-out + **46 GiB GTT** (system RAM). gemma4:12b holds 17.0 GiB GTT.
- Permissions: `/dev/dri/renderD128` has a hand-set ACL `user:faeton:rw-` → `ffmpeg-hw` works as faeton; **probably not persistent across reboot** (re-apply via POSTINIT or use a container with `--device /dev/dri --group-add 107`). render=107, video=44. `/dev/kfd` root:render 0660 → ROCm needs a container.
- NPU PCI `1022:17f0` present, no driver, no `/dev/accel`.

## 1. ASR (s per clip 34238 33.2 s / 34442 30.3 s / 34585 64.3 s, model loaded)
| Model / backend | CPU (s) | 890M (s) | 890M RTF | GTT peak | Notes |
|---|---|---|---|---|---|
| faster-whisper **large-v3-turbo**, beam 5 + VAD + word ts | 10.5 / 8.6 / 18.8 (int8) | **3.7 / 2.2 / 10.4** (fp16) | 0.07–0.16 | 2.1 GiB (int8_float16 1.3 GiB, same speed) | CT2 ROCm; text matches CPU |
| faster-whisper **large-v3** | 5.9 / 7.3 / 35.9 | 6.1 / 6.0 / 45.9 | 0.18–0.71 | 5.8 GiB | **No gain** (launch-latency bound) |
| HF Whisper-turbo fp16 greedy | – | **3.0 / 2.2 / 5.6** | 0.07–0.09 | 2.1 GiB | needs AOTriton (else 6.4/5.0/10.9) |
| whisper.cpp Vulkan **turbo** f16 beam 5 (incl. ~0.9 s load) | 36.0 / 35.2 / 46.4 (`-ng`) | 9.9 / 6.0 / 11.8 | 0.18 | 1.9 GiB | greedy 6.1/2.7/6.5; q8_0 6.0/4.9/10.8 @1.2 GiB |
| whisper.cpp Vulkan **large-v3** f16 | 40.5 / 31.0 / 133.7 | 17.1 / 10.7 / 28.1 | 0.35–0.52 | 4.0 GiB | q5_0 22.4/9.2/22.3 @2.1 GiB |
| **GigaAM-v3 e2e-rnnt** (torch, 20 s chunks) | 2.5 / 1.35 / 6.8 | **1.5 / 0.6 / 1.3** | 0.02–0.05 | 0.9 GiB | MIOpen on: 6.1/4.1/5.8 |
| **GigaAM-v3 e2e-ctc** | 2.8 / 1.3 / 6.1 | **0.56 / 0.35 / 1.13** | 0.012–0.018 | 0.85 GiB | |
| **parakeet-tdt-0.6b-v3** (whisper.cpp `parakeet-cli`, Vulkan f16) | 6.9 / 2.1 / 11.7 | wall incl. container: 4.1 / – / 5.0 (64 s: 2.9 s compute) | ~0.05 | ~1.3 GiB | `ggml-org/parakeet-GGUF` |
| **Qwen3-ASR-1.7B** bf16 | 26.1 / 14.1 / 85.0 | **8.4 / 4.8 / 28.1** | 0.16–0.44 | 4.9 GiB | default torch settings: slower than CPU (60/52/100) |

## 2. Speech enhancement
| Model | CPU wall (s) | 890M wall (s) | RTF | GTT peak | Notes |
|---|---|---|---|---|---|
| **MossFormer2_SE_48K** | 25.1 / 21.2 / 44.7 | **7.6 / 7.2 / 12.8** | 0.20–0.24 | 0.5 GiB | 3.4× |
| MossFormerGAN_SE_16K | 211 / 296 / 417 | 61 / 53 / 93 | 1.45–1.8 | 7.3 GiB | still slower than real time |
| FRCRN_SE_16K | 37.9 / 31.5 / 62.4 | 22.1 / 19.1 / 40.9 | 0.64–0.67 | 6.3 GiB | only 1.5× (im2col fallback) |
| Demucs htdemucs | 17.5 / 13.1 / 32.5 | 11.0 / 6.5 / 13.1 | 0.20–0.33 | 1.3 GiB | ~2× |
| DeepFilterNet3 (Rust) | rtf 0.09 | not tried | – | – | keep on CPU |

ClearVoice picks GPU via `nvidia-smi` and silently falls back to CPU → patch `clearvoice.networks.SpeechModel.get_free_gpu = lambda self: 0` (in `enh_gpu.py`). ClearVoice needs numpy<2 → separate `venv-cv` reusing ROCm torch via `.pth`.

## 3. Forced alignment (CTC emissions; Viterbi stays on CPU)
| Model | CPU fp32 (s) | 890M (s) | Notes |
|---|---|---|---|
| MMS-300m-1130 | 4.7 / 4.2 / 10.5 | **fp16+AOTriton 1.9 / 1.4 / 3.2** (rtf 0.05), 1.4 GiB | fp32 GPU ≈ CPU (fp32 GEMM 0.36 TFLOPS vs fp16 4.8). MIOpen on: 62/56/125 |
| wav2vec2-xlsr-53-russian | 4.8 / 4.5 / 10.9 | fp32 4.7 / 3.5 / 10.0 | fp16 not run; expect ~3× |

~2.7 s of 3.2 s is the conv feature extractor on torch's fallback conv; transformer ~0.4 s.

## 4. VAAPI render
Test: video-34585 (HEVC 1376×1840, HLG tags, 8-bit, 64.3 s). Chain: crop 9:16 → scale 1080×1920 → libass (CPU) → encode. Quality vs lossless render of the same chain.

| Variant | wall s | fps | CPU-s | MB | VMAF | PSNR-Y |
|---|---|---|---|---|---|---|
| libx264 medium crf18 (**current**) | 27.0 | 72 | 481 | 165 | 99.98 | 42.2 |
| libx264 veryfast crf18 | 14.9 | 129 | 186 | 160 | 99.95 | 41.4 |
| CPU decode → h264_vaapi CQP 20 | 7.1 | 271 | 49 | 194 | 99.97 | 42.6 |
| **VAAPI decode → CPU crop/scale/ass → h264_vaapi CQP 20** | **7.1** | **273** | **19** | 194 | 99.97 | 42.6 |
| same, h264_vaapi VBR 12M | 6.9 | 280 | 19 | 96 | 99.42 | 39.0 |
| same, hevc_vaapi CQP 22 (+bsf fix) | 6.6 | 290 | 19 | 198 | 99.99 | 44.8 |
| decode only CPU / VAAPI | 5.0 / 2.1 | | 26 / 0.3 | | | |

~4× wall, ~25× less CPU, same quality; h264_vaapi ~17% more bits — use CQP 21–22 or VBR ~16M. Under heavy CPU load, scale+ass becomes the bottleneck.

```
ffmpeg-hw -init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va \
  -hwaccel vaapi -hwaccel_device va -hwaccel_output_format vaapi -i in.mov \
  -vf "hwdownload,format=nv12,crop=…,scale=1080:1920,ass=subs.ass,format=nv12,hwupload" \
  -c:v h264_vaapi -rc_mode CQP -qp 20 -profile:v high [-c:a aac …] out.mp4
```
Gotchas:
1. **hevc_vaapi** writes SPS width 1088 with no conformance window → `-bsf:v hevc_metadata=crop_right=8`. h264_vaapi unaffected.
2. **`scale_vaapi` broken** (`SIVPE ERROR si_vpe_construct_blt` per frame) → scale on CPU.
3. `-hwaccel_output_format vaapi` needs `-init_hw_device … -filter_hw_device`.
4. 10-bit HEVC sources need `hwdownload,format=p010` + conversion (untested). HLG passed through without tonemapping (same as x264 path).
5. Two duplicate-pts frames re-timed in mp4 (harmless; align VMAF by frame index).

## 5. Required ROCm settings (gfx1150)
1. **Disable MIOpen** (`torch.backends.cudnn.enabled = False`; `NO_MIOPEN=1` in scripts): naive bf16/fp16 conv kernels (5 s/call in Qwen encoder), fp32 "find" takes minutes per shape (FRCRN hung >10 min).
2. **`TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1`**: HF-Whisper 2×, Qwen3-ASR 1.5–1.9×, MMS transformer ~10×.
3. **fp16/bf16 only** (fp32 matmul 0.36 TFLOPS vs 4.8).
4. No HSA override (torch 2.14.1+rocm7.2 lists gfx1150). First MIOpen/hipBLAS use costs seconds → keep models resident.

## 6. Coexistence with Ollama
- Memory fine: Titler resident set ~5 GiB GTT; largest single model 7.3 GiB; Ollama gemma4:12b 17 GiB; 46 GiB GTT total. Host RAM is the real limit (ARC 32 GiB).
- Ollama throughput 14.0 → 12.4–13.6 tok/s under Titler load; whisper.cpp Vulkan unaffected.
- **⚠ Anomaly:** 3 runs of faster-whisper (CT2-ROCm) during Ollama generation each had one clip stall ~40 s; once the output was garbage ("I'm - - - - -"). 6 solo runs deterministic and correct. torch GEMM consistency test under Ollama load: 0 mismatches; dmesg clean. Cause unknown (CT2/hipBLAS or ROCm↔Vulkan queue scheduling). **Mitigation:** serialize Titler GPU jobs vs Ollama generation, or validate ASR output (compression ratio, avg_logprob) and retry.
- No GPU hangs/resets over ~2 h of mixed ROCm/Vulkan/VAAPI load.

## 7. Recipes
**whisper.cpp / parakeet on Vulkan** (image has `whisper-server`, `whisper-cli`, `parakeet-cli`, `whisper-bench`):
```
sudo docker run --rm --device /dev/dri --group-add 107 \
  -v /mnt/flash/scratch/titler-gpu/models:/models:ro -v $PWD/audio:/audio:ro \
  --entrypoint whisper-cli ghcr.io/ggml-org/whisper.cpp:main-vulkan \
  -m /models/ggml-large-v3-turbo.bin -f /audio/x.16k.wav -l ru -t 8 -oj -of /audio/x
# parakeet: --entrypoint parakeet-cli … -m /models/ggml-parakeet-tdt-0.6b-v3-f16.bin -f …
```
Models in `/mnt/flash/scratch/titler-gpu/models/`. Fresh containers recompile Vulkan pipelines (1–3 s) → mount `MESA_SHADER_CACHE_DIR` for a server.

**ROCm PyTorch + CT2** (venv on scratch, tiny image `bench/gpu/rocm/image/Dockerfile` = python:3.12-slim-bookworm + libatomic1 libnuma1 libelf1 libdrm2 libgomp1 libsndfile1; runner `bench/gpu/rocm/run.sh`):
```
docker run --rm --device /dev/kfd --device /dev/dri --group-add 107 --group-add 44 \
  --security-opt seccomp=unconfined --ipc=host \
  -v /mnt/flash/scratch/titler-gpu/venv-rocm72:/venv \
  -e LD_LIBRARY_PATH=/venv/rocm-sonames:/venv/lib/python3.12/site-packages/torch/lib \
  -e TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1 -e NO_MIOPEN=1 \
  titler-gpu-rocm:py312 /venv/bin/python script.py
```
- venv: torch==2.14.1+rocm7.2 (`download.pytorch.org/whl/rocm7.2`), transformers 4.57.6, faster-whisper 1.2.1, demucs 4.1.0, gigaam 0.2.0, qwen-asr 0.0.6.
- CTranslate2 4.8.3 from GitHub release asset `rocm-python-wheels-Linux.zip` (`--no-deps --force-reinstall`); links `libamdhip64.so.7`, `libhipblas.so.3`, `libhiprand.so.1` → `rocm-sonames/` symlinks into torch's bundled libs. No system ROCm.
- torch wheel 6.2 GB; venv 8.3 GB.
- `bench/gpu/rocm/image/Dockerfile.worker` bakes it all in (**not built**, ~14 GB).
- Production: `--user 3000 --group-add 107 --group-add 44` (test containers ran as root).

Scripts: `rocm/asr_gpu.py`, `rocm/enh_gpu.py`, `rocm/align_gpu.py`, `rocm/smoke.py`, `rocm/ct2_smoke.py`, `rocm/consistency.py`, `rocm/qwen_diag.py`, `rocm/w2v_prof.py`, `rocm/batch_{asr,enh}.sh`, `whispercpp/run.sh`, `encode/bench_encode.sh`, `encode/vmaf.sh`, `coexist/ollama_gen.sh`, `gttpeak.sh`, `timeit.py`. In `runs/gpu/`: `*miopen*` = MIOpen on, `*-noaotriton*` = AOTriton off, unsuffixed = final settings; `fw-turbo-float16-cuda.jsonl` was overwritten by an Ollama-concurrency run (solo numbers in §1).

## 8. Recommendation for the new Titler
1. **One long-lived `titler-gpu` worker container** (ROCm torch + CT2): JSON-lines over stdin/stdout or a unix socket owned by the API; `--device /dev/kfd --device /dev/dri --group-add 107,44`, MIOpen off, AOTriton on, fp16/bf16. Resident: GigaAM-v3, fw-turbo, MMS/w2v fp16, MossFormer2_48K (~5 GiB). On demand with idle TTL: Qwen3-ASR, large-v3, MossFormerGAN, FRCRN. **One GPU job at a time.** Sanity-check ASR output and retry once.
2. Per stage: hypotheses GigaAM-v3 + fw-turbo fp16 (+ Qwen3-ASR optional); large-v3 if needed via whisper.cpp Vulkan. Enhancement: DFN3 on CPU, MossFormer2_48K on GPU; skip FRCRN/MossFormerGAN. Alignment fp16 on GPU.
3. Render: VAAPI decode → CPU crop/scale/ass → h264_vaapi (CQP 20–21 / VBR ~16M); libx264 fallback when no `/dev/dri` (Mac). HEVC output: always `hevc_metadata=crop_right=…`.
4. Ollama unchanged; add a shared lock if collisions are frequent.
5. NPU: ignore until kernel ≥6.14 with `amdxdna`.

## 9. Not done
ONNX Runtime ROCm/MIGraphX (not needed); FRCRN optimisation; wav2vec2 conv front end; 10-bit HEVC; building `Dockerfile.worker`. Images kept: `ghcr.io/ggml-org/whisper.cpp:main-vulkan` (674 MB), `titler-gpu-rocm:py312` (212 MB), `python:3.12-slim-bookworm`. No containers running; Ollama not reconfigured.
