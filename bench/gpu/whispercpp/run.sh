#!/bin/bash
# whisper.cpp (ggml Vulkan backend, RADV) on the Radeon 890M vs the same binary on CPU.
# Usage: run.sh <model-name> [gpu|cpu] [extra whisper-cli args...]
# Image: ghcr.io/ggml-org/whisper.cpp:main-vulkan (Ubuntu 24.04, Mesa 25.2 RADV).
set -u
M=${1:?model e.g. large-v3-turbo}; MODE=${2:-gpu}; shift 2 || true
IMG=${IMG:-ghcr.io/ggml-org/whisper.cpp:main-vulkan}
REPO=/mnt/flash/home/faeton/work/titler
MODELS=/mnt/flash/scratch/titler-gpu/models
OUT=${REPO}/bench/runs/gpu/whispercpp/${M}-${MODE}
THREADS=${THREADS:-8}
mkdir -p "${OUT}"
NG=""; [ "${MODE}" = cpu ] && NG="-ng"
for wav in "${REPO}"/bench/samples/audio/*.16k.wav; do
  b=$(basename "${wav}" .16k.wav)
  "${REPO}/bench/gpu/gttpeak.sh" "${OUT}/${b}.gtt" &
  GP=$!
  "${REPO}/bench/gpu/timeit.py" "${OUT}/${b}.time" sudo docker run --rm --device /dev/dri --group-add "$(getent group render | cut -d: -f3)" \
    -v "${MODELS}:/models:ro" -v "${REPO}/bench/samples/audio:/audio:ro" -v "${OUT}:/out" \
    --entrypoint whisper-cli "${IMG}" \
     -m "/models/ggml-${M}.bin" -f "/audio/${b}.16k.wav" -l ru -t "${THREADS}" ${NG} \
      -oj -of "/out/${b}" "$@" > "${OUT}/${b}.log" 2>&1 \
  || echo "FAIL ${b} (see ${OUT}/${b}.log)"
  kill ${GP} 2>/dev/null; wait ${GP} 2>/dev/null
  wall=$(cut -d' ' -f1 "${OUT}/${b}.time")
  gtt=$(cat "${OUT}/${b}.gtt" 2>/dev/null)
  tot=$(grep -m1 'total time' "${OUT}/${b}.log" | awk '{print $(NF-1)}')
  echo "${M},${MODE},${b},wall=${wall},whisper_total_ms=${tot},gtt_peak_mib=${gtt}"
done | tee -a "${OUT}/summary.txt"
