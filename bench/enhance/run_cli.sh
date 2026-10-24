#!/bin/bash
# DSP (ffmpeg) baselines + DeepFilterNet3 (Rust deep-filter binary, 48 kHz).
# Raw outputs -> runs/enhance/raw/<variant>/<clip>.wav (+ .json timing).
set -e
. "$(dirname "$0")/env.sh"
M="python3 $B/enhance/measure.py"
RAW=$B/runs/enhance/raw
DF=$ENVS/enh-dfn-bin/deep-filter-0.5.6-x86_64-unknown-linux-musl
RN=$ENVS/rnnoise-models
CLIPS=${CLIPS:-"video-34238 video-34442 video-34585"}
dur(){ $HOME/.local/bin/ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
ff(){ # variant filter
  local v=$1 f=$2; mkdir -p $RAW/$v
  for c in $CLIPS; do in=$B/samples/audio/$c.48k.wav
    $M $RAW/$v/$c.json $(dur $in) -- $FFMPEG -nostdin -hide_banner -loglevel error -y -threads 8 -i $in -af "$f" -c:a pcm_f32le $RAW/$v/$c.wav
  done; }
DEHUM="highpass=f=70:poles=2,bandreject=f=50:width_type=q:w=8,bandreject=f=100:width_type=q:w=8,bandreject=f=150:width_type=q:w=8"
ff dsp-hp-dehum   "$DEHUM"
# afftdn: nf=-40 (and -25) removed ~0 dB on this material (noise far above the floor); -20 is the max floor
ff dsp-afftdn20   "$DEHUM,afftdn=nr=20:nf=-20:tn=1"
# arnndn: needs planar float input, otherwise NaN bursts / blow-ups (seen with packed f32 and mono)
ff dsp-arnndn-sh  "$DEHUM,aformat=sample_fmts=fltp,arnndn=m=$RN/sh.rnnn"
# arnndn mix=0.5 dropped: NaN in the first 480 samples per channel + unstable output
# ff dsp-arnndn-sh-mix50 "$DEHUM,aformat=sample_fmts=fltp,arnndn=m=$RN/sh.rnnn:mix=0.5"
[ -n "$SKIP_DFN" ] && exit 0
dfn(){ # variant args...
  local v=$1; shift; mkdir -p $RAW/$v
  for c in $CLIPS; do in=$B/samples/audio/$c.48k.wav; tmp=$RAW/$v/.tmp; mkdir -p $tmp
    RAYON_NUM_THREADS=8 $M $RAW/$v/$c.json $(dur $in) -- $DF "$@" -o $tmp $in
    mv $tmp/$c.48k.wav $RAW/$v/$c.wav; rmdir $tmp
  done; }
dfn dfn3-nocomp
dfn dfn3-a6   -D -a 6
dfn dfn3-a12  -D -a 12
dfn dfn3-a20  -D -a 20
dfn dfn3-full -D
dfn dfn3-full-pf -D --pf
