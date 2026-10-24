#!/bin/bash
# Convert antony66/whisper-large-v3-russian (HF transformers) to CTranslate2 int8 for faster-whisper.
set -eu
cd "$(dirname "$0")/.."
source asr/env.sh
OUT=/mnt/flash/scratch/hf-cache/ct2/whisper-large-v3-russian
mkdir -p "$(dirname "$OUT")"
envs/asr-fw/bin/ct2-transformers-converter --model antony66/whisper-large-v3-russian \
  --output_dir "$OUT" --quantization int8 --copy_files preprocessor_config.json --force
# repo ships no tokenizer.json; the fine-tune keeps the stock large-v3 vocab
envs/asr-fw/bin/python -c "from huggingface_hub import hf_hub_download as d; import shutil; shutil.copy(d('openai/whisper-large-v3','tokenizer.json'), '$OUT/tokenizer.json')"
