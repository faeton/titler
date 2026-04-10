#!/usr/bin/env bash
# Benchmark the whole titler pipeline on the current machine.
# Usage:
#   bench.sh <source.mov> <workdir> <transcript.json> <pillow_render.py> <whisper_cli> <whisper_model>
#
# Stages timed:
#   1. extract audio (ffmpeg)
#   2. transcribe (whisper-cli large-v3)
#   3. crop 9:16 (ffmpeg)
#   4. render hormozi overlay + composite (pillow_render.py)
#
# Prints a single CSV row per stage: stage,seconds

set -euo pipefail

SRC="${1:?source video}"
WORK="${2:?workdir}"
TRANSCRIPT="${3:?transcript.json}"
RENDER_PY="${4:?pillow_render.py}"
WHISPER="${5:?whisper-cli}"
MODEL="${6:?whisper ggml model path}"
PY="${7:-python3}"

mkdir -p "$WORK"

t() {
  # cross-platform wall-clock: seconds with ms resolution
  if command -v gdate >/dev/null 2>&1; then gdate +%s.%N
  else date +%s.%N 2>/dev/null || python3 -c 'import time; print(time.time())'
  fi
}

stage() {
  local name="$1"; shift
  local start end dur
  start=$(t)
  "$@" > "$WORK/${name}.log" 2>&1
  end=$(t)
  dur=$(awk -v s="$start" -v e="$end" 'BEGIN{printf "%.3f\n", e - s}')
  printf "%-14s %8s s\n" "$name" "$dur"
}

echo "=== bench on $(uname -s) $(uname -m) ==="
echo "cpu: $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- || sysctl -n machdep.cpu.brand_string 2>/dev/null)"
echo "cores: $(nproc 2>/dev/null || sysctl -n hw.ncpu)"
echo "ram:  $(free -h 2>/dev/null | awk '/^Mem:/{print $2}' || echo $(($(sysctl -n hw.memsize)/1024/1024/1024))G)"
echo

stage "audio_extract" ffmpeg -y -i "$SRC" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/audio.wav"

stage "transcribe" "$WHISPER" -m "$MODEL" -f "$WORK/audio.wav" -l auto -ml 1 -sow -oj -of "$WORK/transcript_raw"

stage "crop_9x16"  ffmpeg -y -i "$SRC" -vf "crop=1035:1840:(iw-1035)/2:0,scale=1080:1920:flags=lanczos" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k "$WORK/base_9x16.mp4"

stage "render_hormozi" "$PY" "$RENDER_PY" "$TRANSCRIPT" "$WORK/base_9x16.mp4" hormozi "$WORK/hormozi.mp4"

echo
echo "outputs:"
ls -la "$WORK/hormozi.mp4" "$WORK/base_9x16.mp4" 2>/dev/null
