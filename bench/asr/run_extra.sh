#!/bin/bash
# Extra probes: whisper without VAD (does it keep the English tail of 34238?), Qwen bf16 speed.
set -u
cd "$(dirname "$0")/.."
source asr/env.sh
F=envs/asr-fw/bin/python
$F asr/run_fw.py --name fw-large-v3-auto-novad --model large-v3 --lang auto --no-vad
$F asr/run_fw.py --name fw-turbo-auto-novad --model large-v3-turbo --lang auto --no-vad
envs/asr-qwen/bin/python asr/run_qwen.py --name qwen3-asr-auto-bf16 --dtype bfloat16
