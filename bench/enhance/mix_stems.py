#!/usr/bin/env python3
"""Build 'speech + k*background' presets from an already-aligned enhancer output
(background = original - speech, exact complement). envs/enh-metrics.
usage: mix_stems.py SRC_VARIANT TAG GAIN_DB [GAIN_DB...]"""
import json, os, sys
import numpy as np, soundfile as sf
B = "/mnt/flash/home/faeton/work/titler/bench"; R = f"{B}/runs/enhance"
src, tag, gains = sys.argv[1], sys.argv[2], [float(g) for g in sys.argv[3:]]
for c in ["video-34238", "video-34442", "video-34585"]:
    x, _ = sf.read(f"{B}/samples/audio/{c}.48k.wav", dtype="float32", always_2d=True)
    s, _ = sf.read(f"{R}/aligned/{src}/{c}.48k.wav", dtype="float32", always_2d=True)
    bg = x - s
    meta = json.load(open(f"{R}/raw/{src}/{c}.json")); meta["note"] = f"mix of {src} + background"
    sd_ = f"{R}/stems/{tag}/{c}"; os.makedirs(sd_, exist_ok=True)
    sf.write(f"{sd_}/speech.wav", s, 48000, subtype="FLOAT"); sf.write(f"{sd_}/background.wav", bg, 48000, subtype="FLOAT")
    for g in gains:
        d = f"{R}/raw/{tag}-bg{int(g)}"; os.makedirs(d, exist_ok=True)
        sf.write(f"{d}/{c}.wav", s + 10 ** (g / 20) * bg, 48000, subtype="FLOAT")
        json.dump(meta, open(f"{d}/{c}.json", "w"), indent=1)
