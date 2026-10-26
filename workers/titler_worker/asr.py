"""role asr: faster-whisper (default), mlx-whisper (opt-in, Apple Silicon) and onnx-asr
providers (gigaam, parakeet).

Venv: asr-fw (faster-whisper; onnx-asr 0.12 was added to it so all providers work in the
default process; on the Mac it also has mlx-whisper). Every provider's library is imported
lazily: if it is missing in the current venv the request fails with a clear, non-retryable
error naming the venv to use.
"""
from __future__ import annotations

import os
import re
import time
import zlib

from .common import THREADS, download_heartbeat, ms, read_wav, scratch
from .protocol import WorkerError, log, need_file

FW_DEFAULT = os.environ.get("TITLER_FW_MODEL", "large-v3-turbo")
FW_COMPUTE = os.environ.get("TITLER_FW_COMPUTE", "int8")
FW_BEAM = int(os.environ.get("TITLER_FW_BEAM", "5"))
HALLU_SILENCE = float(os.environ.get("TITLER_FW_HALLU_SILENCE", "2.0"))
VAD_GUARD = os.environ.get("TITLER_FW_VAD_GUARD", "1") != "0"
# Protocol says condition_on_previous_text=False, but on the bench clips False made turbo
# *translate* the English speaker of video-34238 into Russian and hallucinate
# "Продолжение следует..." at the end of video-34442; True (the bench's winning
# fw-turbo-auto-novad config) gets both right. Default True; the degenerate-output retry
# flips it to False (the classic remedy for repetition loops). Override per request.
FW_COND_PREV = os.environ.get("TITLER_FW_CONDITION_PREV", "1") != "0"
# mlx-whisper runs whisper on the Apple GPU (CT2/faster-whisper is CPU-only on macOS), 2-3x
# faster than faster-whisper on M3 Max, but greedy only (no beam search in mlx-whisper 0.4).
# Greedy turbo translates the English speaker of video-34238 into Russian and appends
# "Спасибо." to video-34442 — faster-whisper with beam_size=1 does the same, so it is the
# decoding, not MLX. Hence opt-in; faster-whisper (beam 5) stays the default on the Mac too.
MLX_DEFAULT = os.environ.get("TITLER_MLX_MODEL", "large-v3-turbo")
MLX_REPOS = {"large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
             "large-v3": "mlx-community/whisper-large-v3-mlx"}
DEFAULT_PROVIDER = os.environ.get("TITLER_ASR_PROVIDER", "faster-whisper")
ONNX_DEFAULTS = {"gigaam": "gigaam-v3-e2e-rnnt", "parakeet": "nemo-parakeet-tdt-0.6b-v3"}
ONNX_LOCAL = os.environ.get("TITLER_ONNX_ASR_DIR", scratch("hf-cache/onnx-asr", "onnx-asr"))
ONNX_LANG = {"gigaam": "ru", "parakeet": None}  # GigaAM-v3 is Russian-only

_VOWELS = re.compile(r"[аеёиоуыэюяіїєaeiouy]")
_MODELS: dict = {}  # (provider, model) -> model object


def loaded_models():
    return [f"{p}:{m}" for p, m in _MODELS]


def preload():
    _mlx(MLX_DEFAULT) if DEFAULT_PROVIDER == "mlx-whisper" else _fw(FW_DEFAULT)


# --- degenerate-output check ---------------------------------------------------------
def compression_ratio(text: str) -> float:
    b = text.encode("utf-8")
    return len(b) / len(zlib.compress(b)) if b else 0.0


def max_repeat(words: list[str]) -> int:
    best, run, prev = 0, 0, None
    for w in words:
        k = re.sub(r"[^\w]+", "", w.lower())
        run = run + 1 if k and k == prev else 1
        prev = k
        best = max(best, run)
    return best


def degenerate(words: list[dict]) -> str | None:
    toks = [w["text"] for w in words]
    text = " ".join(toks)
    cr = compression_ratio(text)
    if len(text) > 40 and cr > 2.4:
        return f"compression ratio {cr:.2f}"
    rep = max_repeat(toks)
    if rep > 8:
        return f"token repeated {rep}x"
    return None


# --- faster-whisper --------------------------------------------------------------------
def _fw(model: str):
    key = ("faster-whisper", model)
    if key not in _MODELS:
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise WorkerError(f"faster-whisper is not installed in this venv ({e}); "
                              "run the asr role with bench/envs/asr-fw/bin/python") from e
        t = time.perf_counter()
        _MODELS[key] = WhisperModel(model, device="cpu", compute_type=FW_COMPUTE, cpu_threads=THREADS,
                                    num_workers=1)
        log(f"[asr] loaded faster-whisper {model} in {time.perf_counter() - t:.1f}s")
    return _MODELS[key]


def _speech_regions(wav: str):
    """Silero VAD (bundled with faster-whisper) as [(start_s, end_s)], lenient settings.
    Only used to *guard* whisper output, never to cut/concatenate the audio."""
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    a = decode_audio(wav, sampling_rate=16000)
    ts = get_speech_timestamps(a, VadOptions(threshold=0.35, min_silence_duration_ms=300, speech_pad_ms=300))
    return [(t["start"] / 16000, t["end"] / 16000) for t in ts]


def _overlap(a0, a1, regions) -> float:
    return sum(max(0.0, min(a1, r1) - max(a0, r0)) for r0, r1 in regions)


def _whisper_words(segs, wav: str, dur: float, progress, base: float, span: float):
    """Whisper segments -> (words, dropped), shared by faster-whisper and mlx-whisper.
    `segs` yields (id, start, end, text, [(word, start, end, probability)]) in seconds."""
    regions = _speech_regions(wav) if VAD_GUARD else None
    words, dropped = [], []
    dur = max(dur, 1e-3)
    for sid, s0, s1, text, ws in segs:
        progress(base + span * min(1.0, s1 / dur), "decoding")
        sw = [w for w in ws if w[0].strip()]
        if not sw:
            continue
        seg_d = max(s1 - s0, 1e-3)
        nv = len(_VOWELS.findall(text.lower()))
        if nv >= 4 and nv / seg_d > 15:  # >15 syllables/s cannot be speech
            dropped.append({"text": text.strip(), "start": ms(s0), "end": ms(s1),
                            "reason": "implausible-rate"})
            continue
        if regions is not None:
            if _overlap(s0, s1, regions) / seg_d < 0.1:
                # text over audio Silero calls non-speech: the classic whisper
                # hallucination ("Продолжение следует...", "Субтитры ...")
                dropped.append({"text": text.strip(), "start": ms(s0), "end": ms(s1),
                                "reason": "no-speech"})
                continue
        for word, w0, w1, prob in sw:
            t = word.strip()  # punctuation stays attached ("Привет," / "так.")
            if (words and words[-1].get("_seg") == sid and not word[:1].isspace()
                    and (not t[0].isalnum() or words[-1]["text"].endswith("-"))):
                # continuation piece without a leading space ("как" + "-то", "по" + "-другому")
                p = words[-1]
                p["text"] += t
                p["end"] = ms(w1)
                p["conf"] = min(p["conf"], round(float(prob), 3))
                continue
            words.append({"text": t, "start": ms(w0), "end": ms(w1),
                          "conf": round(float(prob), 3), "_seg": sid})
    for w in words:
        w.pop("_seg", None)
    return words, dropped


def _run_fw(wav: str, model: str, language: str | None, progress, base: float, span: float,
            cond_prev: bool = FW_COND_PREV):
    m = _fw(model)
    segs, info = m.transcribe(
        wav, language=language, task="transcribe", beam_size=FW_BEAM,
        vad_filter=False, word_timestamps=True, condition_on_previous_text=cond_prev,
        hallucination_silence_threshold=HALLU_SILENCE)
    words, dropped = _whisper_words(
        ((s.id, s.start, s.end, s.text, [(w.word, w.start, w.end, w.probability) for w in (s.words or [])])
         for s in segs), wav, info.duration, progress, base, span)
    return words, info.language, round(float(info.language_probability), 3), dropped


# --- mlx-whisper (Apple GPU) -------------------------------------------------------------
def _mlx_repo(model: str) -> str:
    return MLX_REPOS.get(model, model)


def _mlx(model: str):
    key = ("mlx-whisper", model)
    if key not in _MODELS:
        try:
            import mlx.core as mx
            from mlx_whisper.transcribe import ModelHolder
        except ImportError as e:
            raise WorkerError(f"mlx-whisper is not installed in this venv ({e}); it needs Apple Silicon "
                              "and bench/envs/asr-fw from deploy/mac/setup.sh") from e
        t = time.perf_counter()
        # mlx_whisper.transcribe() takes the model from this one-slot cache
        for k in [k for k in _MODELS if k[0] == "mlx-whisper"]:
            del _MODELS[k]
        ModelHolder.get_model(_mlx_repo(model), mx.float16)
        _MODELS[key] = _mlx_repo(model)
        log(f"[asr] loaded mlx-whisper {model} in {time.perf_counter() - t:.1f}s")
    return _MODELS[key]


def _run_mlx(wav: str, model: str, language: str | None, progress, base: float, span: float,
             cond_prev: bool = FW_COND_PREV):
    import mlx_whisper
    repo = _mlx(model)
    x, sr = read_wav(wav)
    if sr != 16000:
        raise WorkerError(f"wav16 must be 16 kHz, got {sr}")
    audio = x.mean(1)
    progress(base, "decoding")
    out = mlx_whisper.transcribe(
        audio, path_or_hf_repo=repo, language=language, task="transcribe", verbose=None,
        word_timestamps=True, condition_on_previous_text=cond_prev,
        hallucination_silence_threshold=HALLU_SILENCE)
    words, dropped = _whisper_words(
        ((s["id"], s["start"], s["end"], s["text"],
          [(w["word"], w["start"], w["end"], w["probability"]) for w in s.get("words", [])])
         for s in out["segments"]), wav, len(audio) / sr, progress, base, span)
    return words, out.get("language"), None, dropped


# --- onnx-asr (GigaAM / parakeet) -----------------------------------------------------
def _onnx(provider: str, model: str):
    key = (provider, model)
    if key not in _MODELS:
        try:
            import onnx_asr
            import onnxruntime as rt
        except ImportError as e:
            raise WorkerError(f"provider {provider!r} needs onnx-asr, not installed in this venv ({e}); "
                              "use bench/envs/asr-onnx/bin/python or asr-fw (has onnx-asr)") from e
        so = rt.SessionOptions()
        so.intra_op_num_threads = THREADS
        so.inter_op_num_threads = 1
        # real files in a local dir: onnxruntime refuses external data reached via HF-cache symlinks
        local = os.path.join(ONNX_LOCAL, model.replace("/", "--"))
        t = time.perf_counter()
        asr = onnx_asr.load_model(model, local, sess_options=so, providers=["CPUExecutionProvider"])
        vad = onnx_asr.load_vad("silero", sess_options=so, providers=["CPUExecutionProvider"])
        # GigaAM/parakeet are trained on <=25-30 s utterances -> VAD segments, max 20 s
        _MODELS[key] = asr.with_vad(vad, min_silence_duration_ms=300, speech_pad_ms=200,
                                    max_speech_duration_s=20).with_timestamps()
        log(f"[asr] loaded onnx-asr {model} in {time.perf_counter() - t:.1f}s")
    return _MODELS[key]


def words_from_tokens(tokens, starts, total_end, frame=0.04):
    """Group subword tokens ('▁'/leading-space convention) into words. Word end =
    next word's start, capped at last token + 0.4 s (approximate, CTC/TDT-style)."""
    raw, cur = [], None
    for tok, t in zip(tokens, starts):
        if tok.startswith(("▁", " ")) or cur is None:
            if cur:
                raw.append(cur)
            cur = {"w": tok.replace("▁", " ").strip(), "start": float(t), "last": float(t)}
        else:
            cur["w"] += tok.replace("▁", " ")
            cur["last"] = float(t)
    if cur:
        raw.append(cur)
    raw = [w for w in raw if w["w"].strip()]
    out = []
    for i, w in enumerate(raw):
        nxt = raw[i + 1]["start"] if i + 1 < len(raw) else total_end
        end = min(nxt, w["last"] + 0.4) if nxt > w["last"] else w["last"] + frame
        out.append({"text": w["w"].strip(), "start": ms(w["start"]), "end": ms(max(end, w["start"] + frame))})
    return out


def _run_onnx(wav: str, provider: str, model: str, language: str | None, progress, base, span):
    m = _onnx(provider, model)
    x, sr = read_wav(wav)
    x = x.mean(1)
    if sr != 16000:
        raise WorkerError(f"wav16 must be 16 kHz, got {sr}")
    total = len(x) / sr
    lang = ONNX_LANG.get(provider)
    words = []
    for s in m.recognize(x, sample_rate=sr):
        off = getattr(s, "start", 0.0) or 0.0
        end = getattr(s, "end", None) or total
        if s.tokens and s.timestamps:
            ws = words_from_tokens(s.tokens, [off + t for t in s.timestamps], end)
            if lang:
                for w in ws:
                    w["lang"] = lang
            words += ws
        progress(base + span * min(1.0, end / max(total, 1e-3)), "decoding")
    return words, lang, None, []


# --- op ---------------------------------------------------------------------------------
def op_asr(req, progress):
    wav = need_file(req, "wav16")
    provider = req.get("provider") or DEFAULT_PROVIDER
    language = req.get("language") or None
    if provider == "faster-whisper":
        model = req.get("model") or FW_DEFAULT
        cond = req.get("condition_on_previous_text")
        cond = FW_COND_PREV if cond is None else bool(cond)
        run = lambda b, s, retry=False: _run_fw(wav, model, language, progress, b, s,  # noqa: E731
                                                cond and not retry)
    elif provider == "mlx-whisper":
        model = req.get("model") or MLX_DEFAULT
        cond = req.get("condition_on_previous_text")
        cond = FW_COND_PREV if cond is None else bool(cond)
        run = lambda b, s, retry=False: _run_mlx(wav, model, language, progress, b, s,  # noqa: E731
                                                 cond and not retry)
    elif provider in ONNX_DEFAULTS:
        model = req.get("model") or ONNX_DEFAULTS[provider]
        run = lambda b, s, retry=False: _run_onnx(wav, provider, model, language, progress, b, s)  # noqa: E731
    else:
        raise WorkerError(f"unknown provider {provider!r} (faster-whisper, mlx-whisper, gigaam, parakeet)")

    t = time.perf_counter()
    if (provider, model) not in _MODELS:
        progress(0.0, "loading model")
        with download_heartbeat(progress, roots=(ONNX_LOCAL,)):
            (_fw(model) if provider == "faster-whisper" else _mlx(model) if provider == "mlx-whisper"
             else _onnx(provider, model))
        progress(0.0, "model loaded")  # ends the server watchdog's load phase
    load_ms = ms(time.perf_counter() - t)

    t = time.perf_counter()
    words, lang, lang_prob, dropped = run(0.0, 1.0)
    bad = degenerate(words)
    retried = False
    if bad:
        log(f"[asr] degenerate output ({bad}), retrying once")
        progress(0.0, f"retry: {bad}")
        retried = True
        words, lang, lang_prob, dropped = run(0.0, 1.0, retry=True)
        bad = degenerate(words)
    res = {"lang": lang, "words": words, "model": model, "provider": provider,
           "timing": {"load_ms": load_ms, "infer_ms": ms(time.perf_counter() - t)}}
    if lang_prob is not None:
        res["langProb"] = lang_prob
    if dropped:
        res["dropped"] = dropped  # segments removed by the VAD guard (for review, not shown)
    if retried:
        res["retried"] = True
    if bad:
        res["degenerate"] = bad  # still degenerate after the retry: server should flag it
    return res


OPS = {"asr": op_asr}
