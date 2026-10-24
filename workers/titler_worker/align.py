"""role align: local word re-alignment (w2v_ru_q8 boundaries + GigaAM-CTC verifier).

Venv: align-main. Engine in align_engine.py (vendored bench prototype, seconds);
this module converts the protocol's integer ms.
"""
from __future__ import annotations

import math
import time

from . import align_engine as E
from .common import ms
from .protocol import WorkerError, need, need_file

BACKEND = E.DEFAULT_BACKEND
VERIFIER = E.DEFAULT_VERIFIER


def _models():
    return [b for b in (BACKEND, VERIFIER) if b]


def loaded_models():
    return list(E._BACKENDS)


def preload():
    for b in _models():
        E.warmup(b)


def op_precompute(req, progress):
    wav = need_file(req, "wav16")
    t = time.perf_counter()
    models = _models()
    for k, b in enumerate(models):
        progress(k / len(models), f"emissions {b}")
        E.precompute(wav, b)
    return {"ms": ms(time.perf_counter() - t)}


def op_window(req, progress):
    wav = need_file(req, "wav16")
    t0, t1 = need(req, "t0", (int, float)), need(req, "t1", (int, float))
    words = need(req, "words", list)
    if not words or not all(isinstance(w, str) for w in words):
        raise WorkerError("words must be a non-empty list of strings")
    if t1 <= t0:
        raise WorkerError("t1 must be > t0")
    anchors = {}
    for k, v in (req.get("anchors") or {}).items():
        i = int(k)
        if not 0 <= i < len(words) or not isinstance(v, (list, tuple)) or len(v) != 2:
            raise WorkerError(f"bad anchor {k!r}: {v!r}")
        anchors[i] = (v[0] / 1000.0, v[1] / 1000.0)
    t = time.perf_counter()
    out = E.align_window(wav, t0 / 1000.0, t1 / 1000.0, words, anchors or None,
                         backend=req.get("backend") or BACKEND,
                         verifier=req.get("verifier", VERIFIER) or None)
    res = []
    for w, o in zip(words, out):
        r = {"text": w, "start": ms(o["start"]), "end": ms(o["end"]), "status": o["status"]}
        if o.get("reason"):
            r["reason"] = o["reason"]
        llr = o.get("v_llr", o.get("llr"))
        if llr is not None and math.isfinite(llr):
            r["llr"] = round(float(llr), 2)
        res.append(r)
    return {"words": res, "ms": ms(time.perf_counter() - t)}


def op_forget(req, progress):
    wav = need(req, "wav16", str)
    return {"forgotten": E.forget(wav)}


OPS = {"align_precompute": op_precompute, "align_window": op_window, "align_forget": op_forget}
