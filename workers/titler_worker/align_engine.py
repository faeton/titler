"""Local word re-alignment engine (CTC forced alignment), vendored from
bench/align/local_align.py (see bench/REPORT-align.md for the calibration).

Units here are SECONDS; the protocol layer (align.py) converts to/from integer ms.

    align_window(audio_path, t0, t1, words, anchors=None, backend, verifier)
        -> [{w, start, end, score, status: aligned|unconfirmed|anchor, reason?, llr, lp, ...}]

* Padding around the edited phrase is absorbed by an edge "filler" token.
* Anchored words are returned untouched and act as hard walls.
* Failure detection: likelihood ratio llr = Viterbi(text) - Viterbi(text without the word);
  the verifier (GigaAM-v3 CTC) decides aligned/unconfirmed, the backend
  (w2v_ru_q8) gives the boundaries.
* Emissions are text-independent: precompute(audio) once per clip (chunked, so RSS
  stays bounded on long clips), then each edit costs a few ms.

Changes vs the bench prototype: defaults w2v_ru_q8 + gigaam, threads from
TITLER_THREADS, chunked whole-clip precompute, forget(), no CLI/worker loop.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np
import torch
import torchaudio
import torchaudio.functional as AF

SR = 16000
THREADS = int(os.environ.get("TITLER_THREADS", "8"))
torch.set_num_threads(THREADS)
CHUNK_S = float(os.environ.get("TITLER_ALIGN_CHUNK_S", "30"))  # precompute chunk (core)
CTX_S = 1.0  # context added on both sides of every chunk, discarded after inference

# --- thresholds (calibrated in bench/REPORT-align.md, backend mms_fa) -------
THRESHOLDS = {
    # backend: (llr_min for words of >=3 letters, llr_min for 1-2 letter words,
    #           min mean token log-posterior).  llr in nats; calibrated on 88 windows
    #           x 6 inserted fake words in bench/REPORT-align.md.
    "mms_fa": (1.0, -3.0, -4.0),
    "mms_fa_q8": (1.0, -3.0, -4.0),
    "mms1130": (1.0, -3.0, -4.0),
    "w2v_ru": (1.0, -3.0, -99.0),
    "w2v_ru_q8": (1.0, -3.0, -99.0),
    "gigaam": (1.0, 0.0, -99.0),
}
DEFAULT_BACKEND = os.environ.get("TITLER_ALIGN_BACKEND", "w2v_ru_q8")
DEFAULT_VERIFIER = os.environ.get("TITLER_ALIGN_VERIFIER", "gigaam") or None
FILLER_PENALTY = 1.0  # nats/frame below best non-blank for the edge filler

# --- text normalisation -----------------------------------------------------
_UK = set("іїєґ")
_PUNCT = re.compile(r"[^\w'’\-]+", re.U)
_LAT2CYR = [  # crude, only so ru-only vocabularies see *something* plausible
    ("shch", "щ"), ("sch", "ш"), ("ch", "ч"), ("sh", "ш"), ("zh", "ж"),
    ("kh", "х"), ("ts", "ц"), ("yu", "ю"), ("ya", "я"), ("yo", "ё"),
    ("th", "з"), ("ph", "ф"), ("oo", "у"), ("ee", "и"), ("ck", "к"),
    ("a", "а"), ("b", "б"), ("c", "к"), ("d", "д"), ("e", "е"), ("f", "ф"),
    ("g", "г"), ("h", "х"), ("i", "и"), ("j", "дж"), ("k", "к"), ("l", "л"),
    ("m", "м"), ("n", "н"), ("o", "о"), ("p", "п"), ("q", "к"), ("r", "р"),
    ("s", "с"), ("t", "т"), ("u", "у"), ("v", "в"), ("w", "в"), ("x", "кс"),
    ("y", "й"), ("z", "з"),
]
_UK2RU = {"і": "и", "ї": "йи", "є": "е", "ґ": "г", "'": "", "’": ""}


def clean_word(w: str) -> str:
    w = unicodedata.normalize("NFC", w).lower().strip()
    w = _PUNCT.sub("", w).strip("-'’")
    return w


def verbalize(w: str, lang: str = "ru") -> str:
    """'3' -> 'три', '2026' -> 'две тысячи двадцать шесть'."""
    if not re.search(r"\d", w):
        return w
    try:
        from num2words import num2words
        return re.sub(r"\d+(?:[.,]\d+)?",
                      lambda m: " " + num2words(float(m.group().replace(",", ".")) if
                                                re.search(r"[.,]", m.group()) else int(m.group()),
                                                lang=lang) + " ", w).strip()
    except Exception:
        return w


def guess_lang(w: str) -> str:
    if re.search(r"[a-z]", w):
        return "eng"
    if any(c in _UK for c in w):
        return "ukr"
    return "rus"


def lat2cyr(w: str) -> str:
    out, i = [], 0
    while i < len(w):
        for a, b in _LAT2CYR:
            if w.startswith(a, i):
                out.append(b); i += len(a); break
        else:
            out.append(w[i]); i += 1
    return "".join(out)


# --- backends -----------------------------------------------------------------
@dataclass(eq=False)
class Backend:
    name: str
    blank: int
    delim: int | None  # word-delimiter token or None
    vocab: dict = field(default_factory=dict)

    def emissions(self, wav: torch.Tensor) -> tuple[torch.Tensor, float]:
        raise NotImplementedError

    def tokens(self, w: str) -> list[int]:
        raise NotImplementedError


class MMSBackend(Backend):
    """torchaudio MMS_FA (uroman romanisation, 28 latin chars, no delimiter)."""

    def __init__(self, q8: bool = False):
        b = torchaudio.pipelines.MMS_FA
        self.model = b.get_model(with_star=False).eval()
        if q8:  # dynamic int8 for Linear layers (transformer FFN/attention projections)
            self.model = torch.ao.quantization.quantize_dynamic(self.model, {torch.nn.Linear}, dtype=torch.qint8)
        super().__init__("mms_fa_q8" if q8 else "mms_fa", 0, None, b.get_dict(star=None))
        self._cache = {}
        from uroman import Uroman
        self.uroman = Uroman()

    def emissions(self, wav):
        with torch.inference_mode():
            em, _ = self.model(wav.unsqueeze(0))
        return torch.log_softmax(em[0], -1), wav.shape[-1] / SR / em.shape[1]

    def romanize(self, w):
        if w in self._cache:
            return self._cache[w]
        r = self.uroman.romanize_string(w, lcode=guess_lang(w)).lower().replace("’", "'")
        r = "".join(c for c in r if c in self.vocab and c != "-")
        # uroman doubles letters that are not two sounds in speech ("ый" -> "yy");
        # a CTC path must then emit the letter twice -> collapse repeats.
        self._cache[w] = re.sub(r"(.)\1+", r"\1", r)
        return self._cache[w]

    def tokens(self, w):
        return [self.vocab[c] for c in self.romanize(w)]


class HFBackend(Backend):
    """transformers wav2vec2-CTC (mms-300m-1130-forced-aligner or ru xlsr)."""

    def __init__(self, name, repo, q8: bool = False):
        from transformers import AutoModelForCTC, Wav2Vec2CTCTokenizer
        self.model = AutoModelForCTC.from_pretrained(repo).eval()
        if q8:  # dynamic int8 for Linear layers
            self.model = torch.ao.quantization.quantize_dynamic(self.model, {torch.nn.Linear}, dtype=torch.qint8)
        tok = Wav2Vec2CTCTokenizer.from_pretrained(repo)
        vocab = {k.lower(): v for k, v in tok.get_vocab().items()}
        blank = vocab.get("<blank>", tok.pad_token_id)
        super().__init__(name, blank, vocab.get("|"), vocab)
        self._cache = {}
        self.cyr = "а" in vocab
        if not self.cyr:
            from uroman import Uroman
            self.uroman = Uroman()

    def emissions(self, wav):
        x = (wav - wav.mean()) / (wav.std() + 1e-7)
        with torch.inference_mode():
            lg = self.model(x.unsqueeze(0)).logits[0]
        return torch.log_softmax(lg, -1), wav.shape[-1] / SR / lg.shape[0]

    def _tok(self, w0):
        w = w0
        if w0 in self._cache:
            return self._cache[w0]
        if self.cyr:
            w = lat2cyr("".join(_UK2RU.get(c, c) for c in w))
        else:
            w = self.uroman.romanize_string(w, lcode=guess_lang(w)).lower()
        self._cache[w0] = tuple(self.vocab[c] for c in w if c in self.vocab and c not in "|-")
        return self._cache[w0]

    def tokens(self, w):
        return list(self._tok(w))


class GigaAMBackend(Backend):
    """GigaAM-v3 CTC (Russian char vocab, 40 ms frames)."""

    def __init__(self):
        import gigaam
        self.model = gigaam.load_model("v3_ctc", fp16_encoder=False, device="cpu",
                                       download_root="/mnt/flash/scratch/gigaam-cache").eval()
        voc = list(self.model.decoding.tokenizer.vocab)
        super().__init__("gigaam", len(voc), voc.index(" "), {c: i for i, c in enumerate(voc)})

    def emissions(self, wav):
        with torch.inference_mode():
            x = wav.unsqueeze(0)
            enc, enc_len = self.model.forward(x, torch.tensor([x.shape[-1]]))
            lp = self.model.head(enc)[0]
        return lp.float(), wav.shape[-1] / SR / lp.shape[0]

    def tokens(self, w):
        w = lat2cyr("".join(_UK2RU.get(c, c) for c in w)).replace("ё", "е")
        return [self.vocab[c] for c in w if c in self.vocab and c != " "]


_BACKENDS: dict[str, Backend] = {}


def get_backend(name: str) -> Backend:
    if name not in _BACKENDS:
        _BACKENDS[name] = {
            "mms_fa": lambda: MMSBackend(),
            "mms_fa_q8": lambda: MMSBackend(q8=True),
            "mms1130": lambda: HFBackend("mms1130", "MahmoudAshraf/mms-300m-1130-forced-aligner"),
            "w2v_ru": lambda: HFBackend("w2v_ru", "jonatasgrosman/wav2vec2-large-xlsr-53-russian"),
            "w2v_ru_q8": lambda: HFBackend("w2v_ru_q8", "jonatasgrosman/wav2vec2-large-xlsr-53-russian", q8=True),
            "gigaam": lambda: GigaAMBackend(),
        }[name]()
    return _BACKENDS[name]


# --- audio ------------------------------------------------------------------------
@lru_cache(maxsize=8)
def _load(path: str, mtime: float) -> np.ndarray:
    try:
        import soundfile as sf
        x, sr = sf.read(path, dtype="float32", always_2d=True)
        if sr == SR:
            return x.mean(1)
    except Exception:
        pass
    ff = os.path.expanduser("~/.local/bin/ffmpeg")
    raw = subprocess.run([ff if os.path.exists(ff) else "ffmpeg", "-nostdin", "-v", "error", "-i", path,
                          "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def load_audio(path: str) -> np.ndarray:
    return _load(path, os.path.getmtime(path))


# --- core alignment ---------------------------------------------------------------
def _viterbi(lp: torch.Tensor, targets: list[int], blank: int):
    """lp [T, C] log-probs. Returns (frame labels, frame scores) or None."""
    T = lp.shape[0]
    rep = sum(1 for a, b in zip(targets, targets[1:]) if a == b)
    if not targets or T < len(targets) + rep:
        return None
    ali, sc = AF.forced_align(lp.unsqueeze(0).float(), torch.tensor([targets], dtype=torch.int32), blank=blank)
    return ali[0], sc[0]


def _spans(ali: torch.Tensor, blank: int) -> list[tuple[int, int]]:
    """One (start, end_excl) per emitted target token, in order."""
    out, prev = [], blank
    for t, lab in enumerate(ali.tolist()):
        if lab != blank and lab == prev:
            out[-1][1] = t + 1
        elif lab != blank:
            out.append([t, t + 1])
        prev = lab
    return [tuple(s) for s in out]


def align_run(lp: torch.Tensor, frame: float, toks: list[list[int]], be: Backend,
              lead_filler: bool, tail_filler: bool, with_llr: bool = True,
              filler_penalty: float = FILLER_PENALTY):
    """Align words `toks` (token id lists) to all of `lp`. Returns per-word dicts
    with frame-relative times, or None if impossible."""
    T, C = lp.shape
    em = lp
    filler = None
    if lead_filler or tail_filler:
        nb = torch.ones(C, dtype=torch.bool); nb[be.blank] = False
        if be.delim is not None:
            nb[be.delim] = False
        col = lp[:, nb].max(1).values - filler_penalty
        em = torch.cat([lp, col.unsqueeze(1)], 1)
        filler = C

    def build(skip: int | None):
        tg, owner = [], []
        if lead_filler:
            tg.append(filler); owner.append(-1)
        first = True
        for i, tk in enumerate(toks):
            if i == skip or not tk:
                continue
            if not first and be.delim is not None:
                tg.append(be.delim); owner.append(-2)
            tg += tk; owner += [i] * len(tk)
            first = False
        if tail_filler:
            tg.append(filler); owner.append(-1)
        return tg, owner

    tg, owner = build(None)
    res = _viterbi(em, tg, be.blank)
    if res is None:
        return None
    ali, sc = res
    total = float(sc.sum())
    spans = _spans(ali, be.blank)
    if len(spans) != len(tg):  # should not happen
        return None
    words = []
    best = lp.max(1).values
    tg_t = torch.tensor(tg)
    # frame -> target index (or -1 for blank frames)
    fidx = torch.full((T,), -1, dtype=torch.long)
    for k, (a, b) in enumerate(spans):
        fidx[a:b] = k
    frames = torch.nonzero(fidx >= 0).squeeze(1)
    flp = em[frames, tg_t[fidx[frames]]]  # log-prob of the emitted token on each token frame
    fown = torch.tensor(owner)[fidx[frames]]
    for i, tk in enumerate(toks):
        m = fown == i
        if not bool(m.any()):
            words.append(None); continue
        ks = [k for k, o in enumerate(owner) if o == i]
        lps = flp[m]
        words.append({"f0": spans[ks[0]][0], "f1": spans[ks[-1]][1], "lp": float(lps.mean()),
                      "gop": float((lps - best[frames[m]]).mean()), "ntok": len(tk)})
    if with_llr:
        for i, w in enumerate(words):
            if w is None:
                continue
            tg2, _ = build(i)
            if not [t for t in tg2 if t != filler]:
                w["llr"] = float("inf"); continue
            r2 = _viterbi(em, tg2, be.blank)
            w["llr"] = total - float(r2[1].sum()) if r2 is not None else float("inf")
    for w in words:
        if w:
            w["start"], w["end"] = w["f0"] * frame, w["f1"] * frame
    return words


def _norm_anchors(anchors) -> dict[int, tuple[float, float]]:
    if not anchors:
        return {}
    if isinstance(anchors, dict):
        return {int(k): (float(v[0]), float(v[1])) if not isinstance(v, dict) else (v["start"], v["end"])
                for k, v in anchors.items()}
    return {int(a["i"]): (float(a["start"]), float(a["end"])) for a in anchors}


_FULL: dict = {}  # (path, mtime, backend) -> (log-probs [T, C], frame_s) for the whole clip


def _chunked_emissions(be: Backend, audio: np.ndarray):
    """Whole-clip emissions computed in CHUNK_S pieces with CTX_S context on each side
    (bounded RSS: a 64 s single pass peaked at 4.7 GB). Frames are stitched on the
    model's nominal stride, so frame k always means time k * stride."""
    n = len(audio)
    if n <= int((CHUNK_S + 2 * CTX_S) * SR):
        return be.emissions(torch.from_numpy(audio.copy()))
    core, ctx = int(CHUNK_S * SR), int(CTX_S * SR)
    parts, stride = [], None
    for c0 in range(0, n, core):
        c1 = min(n, c0 + core)
        a0, a1 = max(0, c0 - ctx), min(n, c1 + ctx)
        lp, frame = be.emissions(torch.from_numpy(audio[a0:a1].copy()))
        if stride is None:
            stride = round(frame, 3)  # 0.02 (wav2vec2) / 0.04 (GigaAM)
        f0 = int(round((c0 - a0) / SR / stride))
        nf = int(round((c1 - c0) / SR / stride))
        parts.append(lp[f0:f0 + nf])
    return torch.cat(parts, 0), stride


def precompute(audio_path: str, backend: str = DEFAULT_BACKEND):
    """Compute and cache whole-clip emissions (text-independent). Later align_window()
    calls on this file only run Viterbi over a slice: a few ms instead of ~0.5-1 s."""
    key = (audio_path, os.path.getmtime(audio_path), backend)
    if key not in _FULL:
        for k in [k for k in _FULL if k[0] == audio_path and k[2] == backend]:
            del _FULL[k]  # stale mtime
        _FULL[key] = _chunked_emissions(get_backend(backend), load_audio(audio_path))
    return _FULL[key]


def forget(audio_path: str) -> int:
    ks = [k for k in _FULL if k[0] == audio_path]
    for k in ks:
        del _FULL[k]
    _load.cache_clear()
    return len(ks)


def cached() -> list:
    return [{"path": k[0], "backend": k[2], "frames": int(v[0].shape[0])} for k, v in _FULL.items()]


def _window_emissions(audio_path, t0, t1, backend):
    key = (audio_path, os.path.getmtime(audio_path), backend) if audio_path else None
    if key in _FULL:
        lp, frame = _FULL[key]
        f0, f1 = max(0, int(round(t0 / frame))), min(lp.shape[0], int(round(t1 / frame)))
        return lp[f0:f1], frame, f0 * frame
    audio = load_audio(audio_path)
    a0, a1 = max(0, int(t0 * SR)), min(len(audio), int(t1 * SR))
    lp, frame = get_backend(backend).emissions(torch.from_numpy(audio[a0:a1].copy()))
    return lp, frame, a0 / SR


def align_window(audio_path: str, t0: float, t1: float, words, anchors=None,
                 backend: str = DEFAULT_BACKEND, verifier: str | None = None,
                 verbalize_numbers: bool = True, edge_filler: bool = True, thresholds=None,
                 with_llr: bool = True, iterative: bool = True, exclude=(), _emissions=None):
    """See module docstring. Returns one dict per input word.

    backend   model whose CTC posteriors give the word boundaries
    verifier  optional second model that decides aligned/unconfirmed (e.g. "gigaam");
              words it rejects are removed before the boundary pass.
    _emissions (lp, frame) for `backend`, or {backend: (lp, frame)} with t0 = slice start.
    """
    words = [w["w"] if isinstance(w, dict) else w for w in words]
    if verifier and verifier != backend:
        em = _emissions if isinstance(_emissions, dict) else {}
        # The verifier only answers "is this word in the audio?".  Its CTC timing drifts
        # (GigaAM: +-0.1-0.25 s depending on context), so it must not be squeezed between
        # anchor walls taken from another model / the user: align all words freely.
        ver = align_window(audio_path, t0, t1, words, None, backend=verifier,
                           verbalize_numbers=verbalize_numbers, edge_filler=edge_filler,
                           _emissions=em.get(verifier))
        bad = {i for i, o in enumerate(ver) if o["status"] == "unconfirmed"}
        bnd = align_window(audio_path, t0, t1, words, anchors, backend=backend,
                           verbalize_numbers=verbalize_numbers, edge_filler=edge_filler,
                           with_llr=False, exclude=bad, _emissions=em.get(backend))
        for b, v in zip(bnd, ver):
            if b["status"] == "anchor":
                continue
            b.update(status=v["status"], v_llr=v.get("llr"), v_lp=v.get("lp"))
            if v.get("reason"):
                b["reason"] = v["reason"]
        return bnd
    be = get_backend(backend)
    llr_long, llr_short, lp_min = thresholds or THRESHOLDS[backend]
    anc = _norm_anchors(anchors)
    if isinstance(_emissions, dict):
        _emissions = _emissions.get(backend)
    if _emissions is None:
        lp, frame, t0 = _window_emissions(audio_path, t0, t1, backend)
    else:
        lp, frame = _emissions
    T = lp.shape[0]
    norm = [clean_word(w) for w in words]
    if verbalize_numbers:
        norm = [verbalize(w) for w in norm]
    toks = [sum((be.tokens(p) for p in w.split()), []) for w in norm]
    llr_req = [llr_short if len(w.replace(" ", "")) <= 2 else llr_long for w in norm]

    out = [{"w": w, "start": None, "end": None, "score": None, "status": "unconfirmed"} for w in words]
    for i, (s, e) in anc.items():
        out[i].update(start=s, end=e, score=1.0, status="anchor")

    # split into runs of free words between anchors
    runs, cur = [], []
    for i in range(len(words)):
        if i in anc:
            if cur: runs.append(cur)
            cur = []
        else:
            cur.append(i)
    if cur: runs.append(cur)
    for run in runs:
        prev_a = max((k for k in anc if k < run[0]), default=None)
        next_a = min((k for k in anc if k > run[-1]), default=None)
        f0 = 0 if prev_a is None else max(0, int(round((anc[prev_a][1] - t0) / frame)))
        f1 = T if next_a is None else min(T, int(round((anc[next_a][0] - t0) / frame)))
        rtoks = [toks[i] if i not in exclude else [] for i in run]
        dropped: dict[int, dict] = {}  # run position -> metrics when it was dropped
        while True:
            rw = align_run(lp[f0:f1], frame, rtoks, be,
                           lead_filler=edge_filler and prev_a is None,
                           tail_filler=edge_filler and next_a is None, with_llr=with_llr) if f1 > f0 else None
            if rw is None or not with_llr:
                break
            bad = [(r["llr"] - llr_req[run[k]], k) for k, r in enumerate(rw)
                   if r is not None and (r["llr"] < llr_req[run[k]] or r["lp"] < lp_min)]
            if not iterative or not bad or len(dropped) >= max(1, len(run) // 2):
                break
            # the worst offender is treated as "not in the audio"; re-align without it
            _, k = min(bad)
            dropped[k] = dict(rw[k], reason="low-llr" if rw[k]["llr"] < llr_req[run[k]] else "low-posterior")
            rtoks = [tk if j != k else [] for j, tk in enumerate(rtoks)]
        if rw is None:  # impossible -> proportional provisional timing
            s0, s1 = t0 + f0 * frame, t0 + f1 * frame
            L = [max(1, len(norm[i])) for i in run]
            acc = s0
            for i, l in zip(run, L):
                d = (s1 - s0) * l / sum(L)
                out[i].update(start=round(acc, 3), end=round(acc + d, 3), status="unconfirmed", reason="no-fit")
                acc += d
            continue
        base = t0 + f0 * frame
        for k, (i, r) in enumerate(zip(run, rw)):
            if i in exclude:
                out[i].update(status="unconfirmed", reason="verifier")
                continue
            if k in dropped:
                r = dropped[k]
                out[i].update(lp=round(r["lp"], 3), gop=round(r["gop"], 3), llr=round(r["llr"], 2),
                              score=round(float(np.exp(r["lp"])), 3), status="unconfirmed", reason=r["reason"],
                              start=None, end=None)
                continue
            if r is None:
                out[i].update(status="unconfirmed", reason="no-alignable-chars")
                continue
            llr_min = llr_req[i]
            ok = (not with_llr or r["llr"] >= llr_min) and r["lp"] >= lp_min
            llr = r.get("llr")
            out[i].update(start=round(base + r["start"], 3), end=round(base + r["end"], 3),
                          score=round(float(np.exp(r["lp"])), 3), lp=round(r["lp"], 3), gop=round(r["gop"], 3),
                          llr=round(llr, 2) if llr is not None and np.isfinite(llr) else None,
                          dur=round(r["end"] - r["start"], 3), status="aligned" if ok else "unconfirmed")
            if not ok:
                out[i]["reason"] = "low-llr" if with_llr and r["llr"] < llr_min else "low-posterior"
    # dropped / unalignable words: provisional timing = gap between neighbours
    for i, o in enumerate(out):
        if o["start"] is None:
            p = next((out[j]["end"] for j in range(i - 1, -1, -1) if out[j]["end"] is not None), t0)
            n = next((out[j]["start"] for j in range(i + 1, len(out)) if out[j]["start"] is not None), t1)
            o.update(start=round(p, 3), end=round(max(p, n), 3))
    return out


def warmup(backend: str = DEFAULT_BACKEND):
    be = get_backend(backend)
    be.emissions(torch.zeros(SR))


