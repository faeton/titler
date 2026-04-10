#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

BASE="work/base_9x16.mp4"
TRANSCRIPT="work/transcript.json"

if [[ ! -f "$TRANSCRIPT" ]]; then
  echo "transcript.json not found — run transcribe.py first"
  exit 1
fi

mkdir -p out

for style in hormozi karaoke minimal; do
  echo "→ building ASS for $style"
  .venv/bin/python ass_gen.py "$TRANSCRIPT" "$style" "work/${style}.ass"

  echo "→ rendering $style"
  # Escape the ass filter path for ffmpeg
  ffmpeg -y -i "$BASE" \
    -vf "ass=work/${style}.ass" \
    -c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p \
    -c:a copy \
    "out/${style}.mp4" 2>&1 | tail -3
done

echo
echo "done. outputs:"
ls -la out/
