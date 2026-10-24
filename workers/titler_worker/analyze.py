"""role analyze: waveform peaks (100/s) + Silero VAD regions from the 16 kHz wav.

Venv: align-main (torch + silero-vad 6.x).
"""
from __future__ import annotations

import json
import os
import time

import numpy as np

from .common import THREADS, ms, read_wav
from .protocol import need_file, need_out

PEAK_RATE = 100
_VAD = {}


def _vad_model():
    if "m" not in _VAD:
        import torch
        torch.set_num_threads(THREADS)
        from silero_vad import load_silero_vad  # bundled weights, no download
        _VAD["m"] = load_silero_vad()
    return _VAD["m"]


def loaded_models():
    return ["silero-vad"] if _VAD else []


def preload():
    _vad_model()


def peaks(x: np.ndarray, sr: int, rate: int = PEAK_RATE) -> list:
    hop = sr // rate
    n = -(-len(x) // hop)
    pad = np.zeros(n * hop, np.float32)
    pad[:len(x)] = x
    b = pad.reshape(n, hop)
    mn = np.clip(np.round(b.min(1) * 127), -127, 127).astype(int)
    mx = np.clip(np.round(b.max(1) * 127), -127, 127).astype(int)
    return np.stack([mn, mx], 1).tolist()


def op_analyze(req, progress):
    wav = need_file(req, "wav16")
    peaks_out = need_out(req, "peaks_out")
    vad_out = need_out(req, "vad_out")
    x, sr = read_wav(wav)
    x = x.mean(1).astype(np.float32)
    t = time.perf_counter()
    _atomic_json(peaks_out, {"rate": PEAK_RATE, "peaks": peaks(x, sr)})
    progress(0.2, "peaks")
    import torch
    from silero_vad import get_speech_timestamps
    model = _vad_model()
    if sr != 16000:
        import torchaudio.functional as AF
        x = AF.resample(torch.from_numpy(x), sr, 16000).numpy()
        sr = 16000
    ts = get_speech_timestamps(torch.from_numpy(x), model, sampling_rate=sr, return_seconds=False)
    regions = [{"startMs": ms(r["start"] / sr), "endMs": ms(r["end"] / sr)} for r in ts]
    _atomic_json(vad_out, {"regions": regions, "model": "silero-vad"})
    return {"speechMs": sum(r["endMs"] - r["startMs"] for r in regions), "regions": len(regions),
            "durationMs": ms(len(x) / sr), "ms": ms(time.perf_counter() - t)}


def _atomic_json(path, obj):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


OPS = {"analyze": op_analyze}
