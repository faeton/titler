#!/bin/bash
# Titler v2 — first-time setup on the MacBook (Apple Silicon). UNTESTED on macOS:
# written on n5 from the n5 setup; the Mac session is expected to fix it up.
# Creates the worker venvs at the same paths the server defaults to (bench/envs/*),
# so no TITLER_WORKER_* overrides are needed.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
E=bench/envs
mkdir -p "$E"
export UV_CACHE_DIR="${UV_CACHE_DIR:-$HOME/.cache/uv}"

need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)"; exit 1; }; }
need brew "https://brew.sh"
need uv "brew install uv"
need pnpm "corepack enable && corepack prepare pnpm@10.29.3 --activate"
# ffmpeg with libass + videotoolbox: core `ffmpeg` has no libass, `ffmpeg-full` (keg-only) does.
# One ffmpeg on the box: brew uninstall ffmpeg && brew install ffmpeg-full && brew link --force ffmpeg-full
# (capture first: `grep -q` under pipefail SIGPIPEs ffmpeg and fails the check)
filters=$(ffmpeg -hide_banner -filters 2>/dev/null || true)
encoders=$(ffmpeg -hide_banner -encoders 2>/dev/null || true)
if ! grep -q " ass " <<<"$filters"; then
  echo "ffmpeg without libass: brew uninstall ffmpeg; brew install ffmpeg-full && brew link --force ffmpeg-full"; exit 1
fi
grep -q h264_videotoolbox <<<"$encoders" || echo "WARN: no h264_videotoolbox encoder"

mk() { [ -x "$E/$1/bin/python" ] || uv venv --seed -p 3.11 "$E/$1"; }

# asr: mlx-whisper (Apple GPU) + faster-whisper (CPU fallback, same code path as n5) + onnx-asr (GigaAM/parakeet)
mk asr-fw
uv pip install -p "$E/asr-fw/bin/python" mlx-whisper faster-whisper "onnx-asr[cpu,hub]" onnxruntime soundfile numpy psutil

# align + analyze: torch (MPS-capable wheels on macOS), wav2vec2, GigaAM, Silero VAD
mk align-main
uv pip install -p "$E/align-main/bin/python" torch==2.5.1 torchaudio==2.5.1 transformers==4.46.3 \
  uroman silero-vad soundfile numpy num2words
uv pip install -p "$E/align-main/bin/python" "git+https://github.com/salute-developers/GigaAM"

# enhance: ClearVoice (MossFormer2_SE_48K); DeepFilterNet3 binary for macOS arm64
mk enh-cv
uv pip install -p "$E/enh-cv/bin/python" torch==2.5.1 torchaudio==2.5.1 clearvoice soundfile numpy
mkdir -p "$E/enh-dfn-bin"
dfn="$E/enh-dfn-bin/deep-filter-0.5.6-aarch64-apple-darwin"
[ -x "$dfn" ] || { curl -fL -o "$dfn" https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-aarch64-apple-darwin && chmod +x "$dfn"; }

pnpm install
cat <<MSG

Done. Suggested ~/.zshenv / .env additions for the Mac:
  export TITLER_DFN_BIN=$repo/$dfn
  export TITLER_FFMPEG=\$(command -v ffmpeg) TITLER_FFPROBE=\$(command -v ffprobe)
  export HF_HOME=\$HOME/.cache/huggingface TORCH_HOME=\$HOME/.cache/torch
  export TITLER_ONNX_ASR_DIR=\$HOME/.cache/titler/onnx-asr TITLER_CLEARVOICE_DIR=\$HOME/.cache/titler/clearvoice
Then: pnpm --filter @titler/server dev   (and pnpm --filter @titler/web dev)
MSG
