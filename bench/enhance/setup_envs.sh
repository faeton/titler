#!/bin/bash
# Creates the venvs used by the enhancement benchmark.
set -x
. "$(dirname "$0")/env.sh"
UV=$HOME/.local/bin/uv
CPU=https://download.pytorch.org/whl/cpu
mk(){ [ -d $ENVS/$1 ] || $UV venv --seed -p 3.11 $ENVS/$1; }
(
 mk enh-metrics
 VIRTUAL_ENV=$ENVS/enh-metrics $UV pip install speechmos onnxruntime pyloudnorm soundfile scipy numpy faster-whisper jiwer librosa
) > $B/runs/enhance/logs/setup-metrics.log 2>&1 &
(
 mk enh-demucs
 VIRTUAL_ENV=$ENVS/enh-demucs $UV pip install --index-url $CPU --extra-index-url https://pypi.org/simple torch==2.5.1 torchaudio==2.5.1
 VIRTUAL_ENV=$ENVS/enh-demucs $UV pip install --index-url $CPU --extra-index-url https://pypi.org/simple torch==2.5.1 torchaudio==2.5.1 demucs soundfile
) > $B/runs/enhance/logs/setup-demucs.log 2>&1 &
(
 mk enh-cv
 VIRTUAL_ENV=$ENVS/enh-cv $UV pip install --index-url $CPU --extra-index-url https://pypi.org/simple torch==2.5.1 torchaudio==2.5.1
 VIRTUAL_ENV=$ENVS/enh-cv $UV pip install --index-url $CPU --extra-index-url https://pypi.org/simple torch==2.5.1 torchaudio==2.5.1 clearvoice
) > $B/runs/enhance/logs/setup-cv.log 2>&1 &
wait
