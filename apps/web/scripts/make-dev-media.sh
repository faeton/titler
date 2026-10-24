#!/bin/bash
# Builds dev-only media for VITE_MOCK=1 from bench/samples (gitignored):
# h264 proxy, thumbnail, loudness-matched compare excerpts, Montserrat fonts.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=../..
SRC=${SRC:-$ROOT/bench/samples/video-34585_singular_display.mov}
OUT=dev-media
mkdir -p "$OUT/compare" "$OUT/fonts"

if [ ! -f "$OUT/proxy.mp4" ]; then
  ffmpeg -v error -y -i "$SRC" -vf "scale=-2:960" -c:v libx264 -preset veryfast -crf 26 \
    -c:a aac -b:a 128k -movflags +faststart "$OUT/proxy.mp4"
fi
[ -f "$OUT/thumb.jpg" ] || ffmpeg -v error -y -ss 3 -i "$OUT/proxy.mp4" -frames:v 1 -vf scale=320:-2 "$OUT/thumb.jpg"

declare -A EXC=([calm]=2 [noisy]=24 [voices]=44)
declare -A FX=(
  [original]="anull"
  [gentle]="afftdn=nr=10:nf=-30"
  [voice]="highpass=f=120,afftdn=nr=20:nf=-35,acompressor=threshold=-20dB:ratio=3"
  [strong]="highpass=f=150,lowpass=f=7000,afftdn=nr=40:nf=-40"
)
for e in "${!EXC[@]}"; do
  for p in "${!FX[@]}"; do
    f="$OUT/compare/$e-$p.m4a"
    [ -f "$f" ] && continue
    ffmpeg -v error -y -ss "${EXC[$e]}" -t 10 -i "$OUT/proxy.mp4" -vn \
      -af "${FX[$p]},loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -c:a aac -b:a 160k "$f"
  done
done

for w in Regular Bold; do
  f="$OUT/fonts/Montserrat-$w.ttf"
  [ -s "$f" ] || curl -fsSL -o "$f" "https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-$w.ttf" || echo "font $w download failed"
done
echo "dev-media ready: $(du -sh $OUT | cut -f1)"
