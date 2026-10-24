#!/bin/bash
# Second timing pass for headline configs (outputs to runs/asr/_timing2/, text ignored).
# The first pass ran while two other benchmark agents loaded the box (load avg 15-27).
set -u
cd "$(dirname "$0")/.."
source asr/env.sh
export ASR_RUNS_DIR=$BENCH/runs/asr/_timing2
uptime
envs/asr-onnx/bin/python asr/run_onnx.py --name gigaam-v3-e2e-rnnt --model gigaam-v3-e2e-rnnt
envs/asr-onnx/bin/python asr/run_onnx.py --name parakeet-tdt-0.6b-v3 --model nemo-parakeet-tdt-0.6b-v3
uptime
envs/asr-fw/bin/python asr/run_fw.py --name fw-turbo-auto-novad --model large-v3-turbo --no-vad
envs/asr-fw/bin/python asr/run_fw.py --name fw-large-v3-auto-novad --model large-v3 --no-vad
uptime
envs/asr-qwen/bin/python asr/run_qwen.py --name qwen3-asr-auto-bf16-aligned --dtype bfloat16 --align
uptime
