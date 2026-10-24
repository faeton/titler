"""role enhance: DeepFilterNet3 (Rust binary) and MossFormer2_SE_48K (ClearVoice) stems.

Venv: enh-cv (ClearVoice, torch, soundfile, scipy). All outputs are 48 kHz 32-bit float
WAV with exactly the input's sample count and channel count, latency compensated
(bench/REPORT-enhance.md "Latency / length findings").
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time
from contextlib import contextmanager

import numpy as np

from .common import APPLE_SILICON, REPO, THREADS, ffmpeg_bin, ms, read_wav, scratch
from .protocol import WorkerError, log, need, need_file, need_out

SR = 48000
DFN_BIN = os.environ.get("TITLER_DFN_BIN", str(
    REPO / "bench/envs/enh-dfn-bin" / ("deep-filter-0.5.6-aarch64-apple-darwin" if APPLE_SILICON
                                       else "deep-filter-0.5.6-x86_64-unknown-linux-musl")))
# `deep-filter -D` (compensate delay) removes the 30 ms lookahead from the start but
# returns 1440 samples fewer -> pad the tail. Measured with GCC-PHAT on all bench clips.
DFN_LATENCY = 1440
DFN_ATTEN = {"gentle": 12, "voice": 20, "strong": None}  # dB attenuation limit; None = unlimited
CV_WORKDIR = os.environ.get("TITLER_CLEARVOICE_DIR", scratch("clearvoice"))
MF2 = "MossFormer2_SE_48K"
DEHUM_HP = float(os.environ.get("TITLER_DEHUM_HP", "60"))
DEHUM = (f"highpass=f={DEHUM_HP:g}:poles=2,"
         "bandreject=f=50:width_type=q:w=8,bandreject=f=100:width_type=q:w=8,"
         "bandreject=f=150:width_type=q:w=8")

_CV = {}


def loaded_models():
    return [MF2] if _CV else []


def preload():
    _clearvoice()


@contextmanager
def _cwd(path):
    old = os.getcwd()
    os.makedirs(path, exist_ok=True)
    os.chdir(path)  # ClearVoice resolves checkpoints/<model> relative to cwd
    try:
        yield
    finally:
        os.chdir(old)


def _clearvoice():
    if "cv" not in _CV:
        import torch
        torch.set_num_threads(THREADS)
        try:
            from clearvoice import ClearVoice
        except ImportError as e:
            raise WorkerError(f"engine mf2 needs ClearVoice ({e}); run with bench/envs/enh-cv/bin/python") from e
        t = time.perf_counter()
        with _cwd(CV_WORKDIR):
            _CV["cv"] = ClearVoice(task="speech_enhancement", model_names=[MF2])
        log(f"[enhance] loaded {MF2} in {time.perf_counter() - t:.1f}s")
    return _CV["cv"]


def fit(x: np.ndarray, n: int, lag: int = 0) -> np.ndarray:
    """Remove `lag` samples of delay (positive = output late) and fit to n samples."""
    if lag > 0:
        x = x[lag:]
    elif lag < 0:
        x = np.concatenate([np.zeros((-lag,) + x.shape[1:], x.dtype), x])
    if len(x) >= n:
        return x[:n]
    return np.concatenate([x, np.zeros((n - len(x),) + x.shape[1:], x.dtype)])


def write_f32(path: str, x: np.ndarray, sr: int = SR):
    import soundfile as sf
    tmp = f"{path}.tmp{os.getpid()}.wav"
    sf.write(tmp, x.astype(np.float32), sr, subtype="FLOAT")
    os.replace(tmp, path)


def _dehum(src: str, dst: str):
    subprocess.run([ffmpeg_bin(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-threads", str(THREADS),
                    "-i", src, "-af", DEHUM, "-c:a", "pcm_f32le", dst], check=True, capture_output=True)


def _dfn3(src: str, tmp: str, strength: str) -> np.ndarray:
    if not os.access(DFN_BIN, os.X_OK):
        raise WorkerError(f"deep-filter binary not found/executable: {DFN_BIN} (set TITLER_DFN_BIN)")
    if strength not in DFN_ATTEN:
        raise WorkerError(f"strength must be one of {list(DFN_ATTEN)}")
    od = os.path.join(tmp, "dfn")
    os.makedirs(od, exist_ok=True)
    cmd = [DFN_BIN, "-D"]
    if DFN_ATTEN[strength] is not None:
        cmd += ["-a", str(DFN_ATTEN[strength])]
    cmd += ["-o", od, src]
    env = dict(os.environ, RAYON_NUM_THREADS=str(THREADS))
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if p.returncode != 0:
        raise WorkerError(f"deep-filter failed ({p.returncode}): {p.stderr.strip()[-500:]}")
    outs = [f for f in os.listdir(od) if f.endswith(".wav")]
    if len(outs) != 1:
        raise WorkerError(f"deep-filter produced {outs}")
    y, sr = read_wav(os.path.join(od, outs[0]))
    if sr != SR:
        raise WorkerError(f"deep-filter output is {sr} Hz")
    return y


def _mf2(src: str, channels: int) -> np.ndarray:
    cv = _clearvoice()
    with _cwd(CV_WORKDIR):
        y = cv(input_path=src, online_write=False)
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 1:
        y = y[None]
    if y.shape[0] in (1, 2) and y.shape[0] < y.shape[-1]:
        y = y.T  # (C, N) -> (N, C)
    if y.shape[1] != channels:
        y = np.repeat(y.mean(1, keepdims=True), channels, 1)
    return y


def op_enhance(req, progress):
    wav = need_file(req, "wav48")
    out_dir = need_out(req, "out_dir", is_dir=True)
    engine = need(req, "engine", str)
    strength = req.get("strength") or "voice"
    dehum = bool(req.get("dehum"))
    x, sr = read_wav(wav)
    if sr != SR:
        raise WorkerError(f"wav48 must be 48 kHz, got {sr}")
    n, ch = x.shape
    t = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix=".enh-", dir=out_dir) as tmp:
        src = wav
        if dehum:
            progress(0.05, "dehum")
            src = os.path.join(tmp, "dehum.wav")
            _dehum(wav, src)
            x, _ = read_wav(src)
            x = fit(x, n)  # zero-latency IIR; guard length anyway
        if engine == "dfn3":
            progress(0.1, f"deepfilternet3 {strength}")
            y = fit(_dfn3(src, tmp, strength), n)  # -D already removed the delay; pad the cut tail
            write_f32(os.path.join(out_dir, "out.wav"), y)
            files = {"out": os.path.join(out_dir, "out.wav")}
            latency, model = DFN_LATENCY, "DeepFilterNet3 (deep-filter 0.5.6)"
            extra = {"strength": strength, "attenLimDb": DFN_ATTEN[strength]}
        elif engine == "mf2":
            progress(0.1, "mossformer2")
            speech = fit(_mf2(src, ch), n)  # zero latency, lib trims to input length
            bg = x.astype(np.float32) - speech  # exact residual: speech + bg == input
            progress(0.9, "writing stems")
            files = {"speech": os.path.join(out_dir, "speech.wav"),
                     "background": os.path.join(out_dir, "background.wav")}
            write_f32(files["speech"], speech)
            write_f32(files["background"], bg)
            latency, model, extra = 0, MF2, {}
        else:
            raise WorkerError(f"unknown engine {engine!r} (dfn3, mf2)")
    return {"files": files, "latencyMs": ms(latency / SR), "samples": n, "channels": ch, "engine": engine,
            "model": model, "dehum": dehum, "ms": ms(time.perf_counter() - t), **extra}


OPS = {"enhance": op_enhance}
