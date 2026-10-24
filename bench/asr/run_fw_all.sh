#!/bin/bash
# All faster-whisper variants, sequential (8 threads each).
set -u
cd "$(dirname "$0")/.."
source asr/env.sh
PY=envs/asr-fw/bin/python
$PY asr/run_fw.py --name fw-large-v3-auto  --model large-v3 --lang auto
$PY asr/run_fw.py --name fw-large-v3-ru    --model large-v3 --lang ru
$PY asr/run_fw.py --name fw-turbo-auto     --model large-v3-turbo --lang auto
$PY asr/run_fw.py --name fw-turbo-ru       --model large-v3-turbo --lang ru
$PY asr/run_fw.py --name fw-large-v3-multi --model large-v3 --multilingual
$PY asr/run_fw.py --name fw-large-v3-ru-prompt --model large-v3 --lang ru --prompt "Awerti, Esports Charts, Streams Charts."
CT2=/mnt/flash/scratch/hf-cache/ct2/whisper-large-v3-russian
[ -f "$CT2/model.bin" ] && $PY asr/run_fw.py --name fw-antony66-ru --model "$CT2" --lang ru
