#!/bin/bash
# onnx-asr family, then Qwen3-ASR variants. Sequential, 8 threads each.
set -u
cd "$(dirname "$0")/.."
source asr/env.sh
O=envs/asr-onnx/bin/python
for m in gigaam-v3-e2e-rnnt gigaam-v3-e2e-ctc gigaam-v3-rnnt gigaam-v3-ctc nemo-parakeet-tdt-0.6b-v3 t-tech/t-one; do
  n=$(echo "$m" | sed 's#t-tech/t-one#t-one#; s#nemo-##')
  $O asr/run_onnx.py --name "$n" --model "$m"
done
$O asr/run_onnx.py --name canary-1b-v2-ru --model nemo-canary-1b-v2 --lang ru
$O asr/run_onnx.py --name gigaam-multilingual-large-ctc --model gigaam-multilingual-large-ctc
$O asr/run_onnx.py --name vosk-ru --model alphacep/vosk-model-ru
Q=envs/asr-qwen/bin/python
$Q asr/run_qwen.py --name qwen3-asr-auto-aligned --align
$Q asr/run_qwen.py --name qwen3-asr-ru --lang Russian
$Q asr/run_qwen.py --name qwen3-asr-auto-context --context "Awerti, Esports Charts, Streams Charts"
