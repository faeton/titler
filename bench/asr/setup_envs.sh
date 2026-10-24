#!/bin/bash
# Creates the per-family venvs. Run: bash bench/asr/setup_envs.sh <name>
set -euo pipefail
source "$(dirname "$0")/env.sh"
UV=~/.local/bin/uv
E=$BENCH/envs
mk() { [ -x "$E/$1/bin/python" ] || $UV venv --seed -p 3.11 "$E/$1"; }
case "$1" in
  fw)    mk asr-fw;    $UV pip install -p $E/asr-fw/bin/python faster-whisper ctranslate2 psutil "transformers<5" torch --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cpu ;;
  onnx)  mk asr-onnx;  $UV pip install -p $E/asr-onnx/bin/python "onnx-asr[cpu,hub]" onnxruntime psutil soundfile numpy ;;
  qwen)  mk asr-qwen;  $UV pip install -p $E/asr-qwen/bin/python qwen-asr psutil torch --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cpu ;;
esac
