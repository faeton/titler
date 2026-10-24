#!/usr/bin/env python3
"""Smoke test: spawn every worker role with its protocol command and run one real request.

    python3 workers/smoke.py [--roles analyze,asr,align,enhance] [--clip video-34442]

Stdlib only (numpy/soundfile, if importable, enable extra enhance checks). Commands come
from TITLER_WORKER_<ROLE> (JSON array) or the defaults in docs/worker-protocol.md.
Outputs go to $TITLER_SMOKE_OUT (default /mnt/flash/scratch/titler/smoke on n5, ~/.cache/titler/smoke elsewhere).
Exit code 0 only if every check passed.
"""
from __future__ import annotations

import argparse
import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "workers"))
from titler_worker.common import wav_frames  # noqa: E402  (stdlib-only module)

DEFAULTS = {
    "analyze": ["bench/envs/align-main/bin/python", "-m", "titler_worker", "--role", "analyze"],
    "asr": ["bench/envs/asr-fw/bin/python", "-m", "titler_worker", "--role", "asr"],
    "align": ["bench/envs/align-main/bin/python", "-m", "titler_worker", "--role", "align"],
    "enhance": ["bench/envs/enh-cv/bin/python", "-m", "titler_worker", "--role", "enhance"],
}
FAILS: list[str] = []


def check(cond, what):
    print(f"    [{'PASS' if cond else 'FAIL'}] {what}", flush=True)
    if not cond:
        FAILS.append(what)
    return cond


class Worker:
    def __init__(self, role: str, log_dir: Path):
        cmd = json.loads(os.environ[f"TITLER_WORKER_{role.upper()}"]) if os.environ.get(
            f"TITLER_WORKER_{role.upper()}") else DEFAULTS[role]
        env = dict(os.environ, PYTHONPATH=str(REPO / "workers"))
        self.role = role
        self.err = open(log_dir / f"{role}.stderr.log", "w")
        t = time.perf_counter()
        self.p = subprocess.Popen(cmd, cwd=REPO, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=self.err, text=True, bufsize=1)
        self.next_id = 0
        ready = self._read(120)
        self.ready_s = time.perf_counter() - t
        if not ready.get("ready"):
            raise RuntimeError(f"{role}: not ready: {ready}")
        print(f"  {role}: ready in {self.ready_s:.1f}s pid={ready.get('pid')} ({' '.join(cmd[:1])})", flush=True)

    def _read(self, timeout):
        r, _, _ = select.select([self.p.stdout], [], [], timeout)
        if not r:
            raise TimeoutError(f"{self.role}: no output in {timeout}s")
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError(f"{self.role}: worker exited (rc={self.p.poll()}), see stderr log")
        return json.loads(line)

    def call(self, op, timeout=900, **params):
        self.next_id += 1
        rid = self.next_id
        self.p.stdin.write(json.dumps({"id": rid, "op": op, **params}, ensure_ascii=False) + "\n")
        self.p.stdin.flush()
        t, nprog = time.perf_counter(), 0
        while True:
            msg = self._read(timeout)
            if msg.get("id") != rid:
                raise RuntimeError(f"{self.role}: unexpected id in {msg}")
            if "progress" in msg:
                nprog += 1
                continue
            msg["_s"] = time.perf_counter() - t
            msg["_progress"] = nprog
            return msg

    def close(self):
        self.p.stdin.close()
        try:
            self.p.wait(30)
        except subprocess.TimeoutExpired:
            self.p.kill()
        self.err.close()


def ok_result(msg, what):
    if not check(msg.get("ok") is True, f"{what} ok ({msg.get('_s', 0):.2f}s, {msg.get('_progress', 0)} progress)"):
        print("      ", msg.get("error"))
        return None
    return msg["result"]


def smoke_analyze(w, wav16, out):
    r = ok_result(w.call("analyze", wav16=wav16, peaks_out=str(out / "peaks.json"),
                         vad_out=str(out / "vad.json")), "analyze")
    if r is None:
        return
    pk = json.loads((out / "peaks.json").read_text())
    vad = json.loads((out / "vad.json").read_text())
    n16 = wav_frames(wav16)
    check(pk["rate"] == 100 and len(pk["peaks"]) == -(-n16 // 160), f"peaks: {len(pk['peaks'])} @100/s")
    check(all(-127 <= a <= b <= 127 for a, b in pk["peaks"]), "peaks int8 range, min<=max")
    check(vad["model"] == "silero-vad" and len(vad["regions"]) == r["regions"] > 0,
          f"vad: {r['regions']} regions, speech {r['speechMs']} ms")
    check(all(isinstance(x["startMs"], int) and x["startMs"] < x["endMs"] for x in vad["regions"]), "vad ms ints")


def smoke_asr(w, wav16):
    r = ok_result(w.call("asr", wav16=wav16, provider="faster-whisper"), "asr faster-whisper")
    words = []
    if r:
        words = r["words"]
        print(f"      lang={r['lang']} words={len(words)} timing={r['timing']} retried={r.get('retried', False)}")
        print("      " + " ".join(x["text"] for x in words)[:160])
        check(len(words) > 5, "asr returned words")
        check(all(isinstance(x["start"], int) and isinstance(x["end"], int) and x["start"] <= x["end"]
                  for x in words), "word times are ms ints")
        check(all(x["text"] == x["text"].strip() and x["text"] for x in words), "no leading/trailing spaces")
    for prov in ("gigaam", "parakeet"):
        m = w.call("asr", wav16=wav16, provider=prov)
        if m.get("ok"):
            rr = m["result"]
            print(f"    [info] {prov}: {len(rr['words'])} words, timing={rr['timing']} :: "
                  + " ".join(x["text"] for x in rr["words"])[:100])
        else:
            print(f"    [info] {prov}: unavailable: {m.get('error')}")
    return words


def smoke_align(w, wav16, asr_words):
    r = ok_result(w.call("align_precompute", wav16=wav16), "align_precompute")
    if r:
        print(f"      precompute {r['ms']} ms")
    # a 7-word window from the ASR output, with «синий» inserted in the middle
    ws = asr_words[2:9] if len(asr_words) >= 9 else [
        {"text": t, "start": s, "end": e} for t, s, e in [
            ("мы", 2580, 2700), ("идём", 2700, 3040), ("вдоль", 3040, 3280), ("реки", 3280, 3460),
            ("и", 3460, 3580), ("смотрим", 3580, 3860), ("вокруг", 3860, 4420)]]
    texts = [x["text"] for x in ws]
    fake_at = len(texts) // 2
    texts.insert(fake_at, "синий")
    t0, t1 = max(0, ws[0]["start"] - 1000), ws[-1]["end"] + 1000
    # anchor the first word at its ASR time: must come back untouched
    anchors = {"0": [ws[0]["start"], ws[0]["end"]]}
    m = w.call("align_window", wav16=wav16, t0=t0, t1=t1, words=texts, anchors=anchors)
    r = ok_result(m, "align_window (cached emissions)")
    if r:
        print(f"      window {t0}-{t1} ms, engine {r['ms']} ms")
        for t, o in zip(texts, r["words"]):
            print(f"        {t:>12} {o['start']:>6}-{o['end']:<6} {o['status']:<11} {o.get('reason', '')} llr={o.get('llr')}")
        out = r["words"]
        check(len(out) == len(texts), "one result per word")
        check(all(isinstance(o["start"], int) and isinstance(o["end"], int) for o in out), "ms ints")
        check(out[fake_at]["status"] == "unconfirmed", "fake «синий» is unconfirmed")
        check(out[0]["status"] == "anchor" and [out[0]["start"], out[0]["end"]] == anchors["0"], "anchor untouched")
        real = [o for i, o in enumerate(out) if i not in (0, fake_at)]
        check(sum(o["status"] == "aligned" for o in real) >= len(real) - 1, "real words aligned (>= n-1)")
    m = w.call("align_forget", wav16=wav16)
    ok_result(m, "align_forget")
    r = ok_result(w.call("align_window", wav16=wav16, t0=t0, t1=t1, words=texts), "align_window (uncached)")
    if r:
        print(f"      uncached window engine {r['ms']} ms; fake={r['words'][fake_at]['status']}")


def smoke_enhance(w, wav48, out):
    n = wav_frames(wav48)
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        np = sf = None
    for engine, strength, dehum in (("dfn3", "gentle", False), ("dfn3", "strong", True), ("mf2", None, False)):
        d = out / f"enh-{engine}-{strength or 'stems'}{'-dehum' if dehum else ''}"
        params = dict(wav48=wav48, out_dir=str(d), engine=engine, dehum=dehum)
        if strength:
            params["strength"] = strength
        r = ok_result(w.call("enhance", **params), f"enhance {engine} {strength or ''} dehum={dehum}")
        if not r:
            continue
        print(f"      engine {r['ms']} ms, latencyMs={r['latencyMs']} files={list(r['files'])}")
        for k, p in r["files"].items():
            check(wav_frames(p) == n, f"{k}: {wav_frames(p)} samples == input {n}")
        if np is not None and engine == "mf2":
            x, _ = sf.read(wav48, dtype="float32", always_2d=True)
            s, _ = sf.read(r["files"]["speech"], dtype="float32", always_2d=True)
            b, _ = sf.read(r["files"]["background"], dtype="float32", always_2d=True)
            err = float(np.abs(s + b - x).max())
            check(err < 1e-6, f"speech + background == input (max err {err:.1e})")
        if np is not None and engine == "dfn3":
            x, _ = sf.read(wav48, dtype="float32", always_2d=True)
            y, _ = sf.read(r["files"]["out"], dtype="float32", always_2d=True)
            a, c = x.mean(1), y.mean(1)
            nf = 1 << (len(a) * 2 - 1).bit_length()
            W = np.fft.rfft(c, nf) * np.conj(np.fft.rfft(a, nf))
            cc = np.fft.irfft(W / (np.abs(W) + 1e-12), nf)
            m = 4800
            lag = int(np.argmax(np.abs(np.concatenate([cc[-m:], cc[:m + 1]])))) - m
            check(abs(lag) <= 1, f"dfn3 residual lag {lag} samples (GCC-PHAT)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roles", default="analyze,asr,align,enhance")
    ap.add_argument("--clip", default="video-34442")
    a = ap.parse_args()
    audio = REPO / "bench/samples/audio"
    wav16, wav48 = str(audio / f"{a.clip}.16k.wav"), str(audio / f"{a.clip}.48k.wav")
    n5 = "/mnt/flash/scratch"
    default = f"{n5}/titler/smoke" if os.path.isdir(n5) else os.path.expanduser("~/.cache/titler/smoke")
    out = Path(os.environ.get("TITLER_SMOKE_OUT") or default) / a.clip
    out.mkdir(parents=True, exist_ok=True)
    roles = a.roles.split(",")
    asr_words: list = []
    t_all = time.perf_counter()
    for role in roles:
        print(f"== {role}", flush=True)
        try:
            w = Worker(role, out)
        except Exception as e:  # noqa: BLE001
            check(False, f"{role} worker start: {e}")
            continue
        try:
            m = w.call("ping")
            check(m.get("ok") and m["result"]["role"] == role, "ping")
            m = w.call("no_such_op")
            check(m.get("ok") is False and "error" in m, "bad op -> error, loop alive")
            if role == "analyze":
                smoke_analyze(w, wav16, out)
            elif role == "asr":
                asr_words = smoke_asr(w, wav16)
            elif role == "align":
                smoke_align(w, wav16, asr_words)
            elif role == "enhance":
                smoke_enhance(w, wav48, out)
            print(f"    models: {w.call('ping')['result']['models']}")
        except Exception as e:  # noqa: BLE001
            check(False, f"{role}: {type(e).__name__}: {e}")
        finally:
            w.close()
    print(f"\n{len(FAILS)} failed checks, total {time.perf_counter() - t_all:.0f}s; logs in {out}")
    for f in FAILS:
        print("  FAIL:", f)
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
