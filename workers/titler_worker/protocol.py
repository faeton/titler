"""JSON-lines protocol (docs/worker-protocol.md).

stdout carries protocol lines only. Model libraries love to print (ClearVoice, tqdm,
onnx-asr...), so at startup the real stdout fd is duplicated for the protocol and fd 1
is pointed at stderr: anything else that writes to stdout - Python or C - lands in the
log instead of corrupting the stream.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback


class WorkerError(Exception):
    """A request-level failure reported as {"ok": false, "error", "retryable"}."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


class Channel:
    def __init__(self):
        fd = os.dup(1)
        os.dup2(2, 1)  # stray stdout writes (python or native) -> stderr
        sys.stdout = sys.stderr
        self._out = os.fdopen(fd, "w", encoding="utf-8", buffering=1)
        self._lock = threading.Lock()

    def send(self, msg: dict):
        line = json.dumps(msg, ensure_ascii=False, allow_nan=False, default=_default)
        with self._lock:
            self._out.write(line + "\n")
            self._out.flush()

    def ok(self, rid, result):
        self.send({"id": rid, "ok": True, "result": result})

    def error(self, rid, error: str, retryable: bool = False):
        self.send({"id": rid, "ok": False, "error": error, "retryable": bool(retryable)})

    def progress(self, rid, p: float, message: str | None = None):
        msg = {"id": rid, "progress": round(max(0.0, min(1.0, float(p))), 3)}
        if message:
            msg["message"] = message
        self.send(msg)


def _default(o):
    # numpy scalars etc.
    for attr in ("item", "tolist"):
        if hasattr(o, attr):
            return getattr(o, attr)()
    return str(o)


def serve(role: str, ops: dict, models_fn, chan: Channel):
    """Main loop: one request at a time; never dies on a bad request."""
    chan.send({"ready": True, "role": role, "pid": os.getpid()})
    log(f"[{role}] ready pid={os.getpid()}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise WorkerError("request must be a JSON object")
            rid = req.get("id")
            op = req.get("op")
            if op == "ping":
                chan.ok(rid, {"role": role, "models": models_fn()})
                continue
            fn = ops.get(op)
            if fn is None:
                raise WorkerError(f"unknown op {op!r} for role {role} (ops: ping, {', '.join(ops)})")
            t = time.perf_counter()
            result = fn(req, lambda p, m=None, _rid=rid: chan.progress(_rid, p, m))
            log(f"[{role}] {op} id={rid} ok in {time.perf_counter() - t:.2f}s")
            chan.ok(rid, result)
        except WorkerError as e:
            log(f"[{role}] id={rid} error: {e}")
            chan.error(rid, str(e), e.retryable)
        except json.JSONDecodeError as e:
            chan.error(None, f"bad JSON: {e}", False)
        except MemoryError as e:
            log(traceback.format_exc())
            chan.error(rid, f"out of memory: {e!r}", True)
        except Exception as e:  # noqa: BLE001 - keep the loop alive
            log(traceback.format_exc())
            chan.error(rid, f"{type(e).__name__}: {e}", False)
    log(f"[{role}] stdin closed, exiting")


# --- request helpers --------------------------------------------------------------
def need(req: dict, key: str, typ=None):
    if key not in req or req[key] is None:
        raise WorkerError(f"missing parameter {key!r}")
    v = req[key]
    if typ is not None and not isinstance(v, typ):
        raise WorkerError(f"parameter {key!r} has wrong type")
    return v


def need_file(req: dict, key: str) -> str:
    p = need(req, key, str)
    if not os.path.isabs(p):
        raise WorkerError(f"{key} must be an absolute path: {p}")
    if not os.path.isfile(p):
        raise WorkerError(f"{key} not found: {p}")
    return p


def need_out(req: dict, key: str, is_dir: bool = False) -> str:
    p = need(req, key, str)
    if not os.path.isabs(p):
        raise WorkerError(f"{key} must be an absolute path: {p}")
    d = p if is_dir else os.path.dirname(p)
    os.makedirs(d, exist_ok=True)
    return p
