"""Environment defaults and small audio helpers shared by the roles.

Imported first by __main__ so thread/cache env vars are set before torch/onnxruntime load.
"""
from __future__ import annotations

import os
import platform
import shutil
import struct
import sys
import wave
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# n5 keeps every cache on the flash pool. Elsewhere (the Mac) titler-only files go to
# ~/.cache/titler and HF/torch keep their library defaults (shared with other tools).
N5_SCRATCH = "/mnt/flash/scratch"
SCRATCH = os.environ.get("TITLER_SCRATCH") or (
    N5_SCRATCH if os.path.isdir(N5_SCRATCH) else os.path.expanduser("~/.cache/titler"))
ON_N5_LAYOUT = SCRATCH == N5_SCRATCH
APPLE_SILICON = sys.platform == "darwin" and platform.machine() == "arm64"

if ON_N5_LAYOUT:
    os.environ.setdefault("HF_HOME", f"{SCRATCH}/hf-cache")
    os.environ.setdefault("TORCH_HOME", f"{SCRATCH}/torch-hub")
    os.environ.setdefault("UV_CACHE_DIR", f"{SCRATCH}/uv-cache")
    os.environ.setdefault("XDG_CACHE_HOME", f"{SCRATCH}/hf-cache/xdg")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

THREADS = max(1, int(os.environ.get("TITLER_THREADS", "8")))
for _v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS",
           "RAYON_NUM_THREADS"):
    os.environ.setdefault(_v, str(THREADS))


def scratch(n5_rel: str, rel: str | None = None) -> str:
    """A titler cache dir: SCRATCH/n5_rel in the n5 layout, SCRATCH/rel (default n5_rel) elsewhere."""
    return os.path.join(SCRATCH, n5_rel if ON_N5_LAYOUT else (rel or n5_rel))


def ffmpeg_bin() -> str:
    for c in (os.environ.get("TITLER_FFMPEG"), os.path.expanduser("~/.local/bin/ffmpeg"), shutil.which("ffmpeg")):
        if c and os.path.exists(c):
            return c
    raise FileNotFoundError("ffmpeg not found (set TITLER_FFMPEG)")


def ms(seconds: float) -> int:
    return int(round(float(seconds) * 1000))


def read_wav(path: str):
    """-> (float32 array [N, C], sr). soundfile if installed, else stdlib wave (PCM16/32)."""
    import numpy as np
    try:
        import soundfile as sf
        x, sr = sf.read(path, dtype="float32", always_2d=True)
        return x, sr
    except ImportError:
        pass
    with wave.open(path) as w:
        sr, ch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        x = np.frombuffer(raw, "<i2").astype(np.float32) / 32768.0
    elif sw == 4:
        x = np.frombuffer(raw, "<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width {sw} in {path}")
    return x.reshape(-1, ch), sr


def wav_frames(path: str) -> int:
    """Sample count per channel without decoding (handles float WAV, which `wave` rejects)."""
    with open(path, "rb") as f:
        if f.read(4) != b"RIFF":
            raise ValueError("not a RIFF file")
        f.read(4)
        if f.read(4) != b"WAVE":
            raise ValueError("not a WAVE file")
        block = None
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                raise ValueError("no data chunk")
            cid, size = hdr[:4], struct.unpack("<I", hdr[4:])[0]
            if cid == b"fmt ":
                fmt = f.read(size)
                block = struct.unpack("<H", fmt[12:14])[0]
            elif cid == b"data":
                return size // block
            else:
                f.seek(size + (size & 1), 1)
