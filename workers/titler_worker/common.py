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


# --- model downloads vs. the server's hang watchdog --------------------------------------
def _hub_cache() -> str:
    if os.environ.get("HF_HUB_CACHE"):
        return os.environ["HF_HUB_CACHE"]
    if os.environ.get("HF_HOME"):
        return os.path.join(os.environ["HF_HOME"], "hub")
    xdg = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(xdg, "huggingface", "hub")


def _partial_bytes(roots) -> int:
    """Total size of in-flight HF downloads (`*.incomplete`) under the given dirs."""
    n = 0
    for root in roots:
        for d, _, files in os.walk(root):
            for f in files:
                if f.endswith(".incomplete"):
                    try:
                        n += os.path.getsize(os.path.join(d, f))
                    except OSError:
                        pass
    return n


class download_heartbeat:
    """While a model loads, re-send the "loading model" progress line every `every` s, but
    only if a download is visibly growing. The server treats a silent load as a hang
    (SIGUSR1 + restart), so a first-run download must not look silent, and a load that is
    stuck (no bytes arriving) must stay silent.
    """

    def __init__(self, progress, roots=(), every: float = 20.0):
        import threading
        self.progress = progress
        self.roots = [r for r in (_hub_cache(), *roots) if r]
        self.every = every
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="download-heartbeat", daemon=True)

    def _run(self):
        last = _partial_bytes(self.roots)
        while not self._stop.wait(self.every):
            now = _partial_bytes(self.roots)
            if self._stop.is_set():  # the walk can outlive __exit__'s join; never report "loading" after it
                return
            if now != last:
                self.progress(0.0, f"loading model (downloading, {now >> 20} MB)")
            last = now

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=1)
        return False
