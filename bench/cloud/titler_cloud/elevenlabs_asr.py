"""ElevenLabs Scribe v2 (POST /v1/speech-to-text).

Docs (checked 2026-10-24): https://elevenlabs.io/docs/api-reference/speech-to-text/convert ,
OpenAPI https://api.elevenlabs.io/openapi.json , pricing https://elevenlabs.io/pricing/api
- word timestamps (default granularity 'word'), per-word logprob, language auto-detect
  (+ language_probability), keyterms (<=1000, each <50 chars / <=5 words, +20% surcharge;
  >100 keyterms => 20 s minimum billed duration), file < 5 GB.
- Zero-retention: query enable_logging=false, enterprise accounts only (else the API rejects it).
Price used for the estimate: $0.22/h base + $0.05/h keyterms (API pricing page; plans include hours).
"""
from __future__ import annotations

import os
from pathlib import Path

from .common import (DEFAULT_KEYTERMS, Http, NormalizedResult, Stopwatch, Word, audio_seconds,
                     prepare_audio, require_key)

ENV = "ELEVENLABS_API_KEY"
URL = "https://api.elevenlabs.io/v1/speech-to-text"
DEFAULT_MODEL = "scribe_v2"
MAX_BYTES = 1024 * 1024 * 1024  # real cap is 5 GB; we never send anything near this
PRICE_PER_H = 0.22
KEYTERM_PER_H = 0.05


def transcribe(audio_path, *, language_hint=None, keyterms=DEFAULT_KEYTERMS, model=None,
               dry_run=False, clip=None, **_):
    model = model or DEFAULT_MODEL
    key = require_key(ENV, dry_run)
    path, mime = prepare_audio(Path(audio_path), max_bytes=MAX_BYTES)
    audio_s = audio_seconds(path)

    form: list[tuple[str, str]] = [
        ("model_id", model),
        ("timestamps_granularity", "word"),
        ("tag_audio_events", "false"),   # keep '(laughter)' etc. out of caption text
        ("diarize", "false"),
    ]
    # Leave language_code unset by default: auto-detect keeps ru/uk code-switching intact.
    if language_hint:
        form.append(("language_code", language_hint))
    for k in keyterms:
        form.append(("keyterms", k))     # array field -> repeated multipart part
    params = {}
    if os.environ.get("ELEVENLABS_ZERO_RETENTION") == "1":
        params["enable_logging"] = "false"

    http = Http(dry_run)
    with open(path, "rb") as fh, Stopwatch() as sw:
        files = [("file", (path.name, fh, mime))] + [(k, (None, v)) for k, v in form]
        r = http.request("POST", URL, headers={"xi-api-key": key}, params=params or None, files=files,
                         stub={"text": "", "words": [], "language_code": None})
        body = r.json()
    if dry_run:
        http.plan[-1]["form"] = form
        http.plan[-1]["files"] = [p for p in http.plan[-1]["files"] if p["field"] == "file"]

    words = []
    events = []
    for w in body.get("words", []):
        if w.get("type") == "word":
            words.append(Word(w=w["text"], start=round(w["start"], 3), end=round(w["end"], 3),
                              conf=w.get("logprob")))
        elif w.get("type") == "audio_event":
            events.append({"text": w["text"], "start": w.get("start"), "end": w.get("end")})
    meta = {"provider": "elevenlabs", "api_model": model,
            "language_probability": body.get("language_probability"),
            "transcription_id": body.get("transcription_id"),
            "conf_kind": "logprob"}
    if events:
        meta["audio_events"] = events
    if dry_run:
        meta["plan"] = http.plan
        meta["dry_run"] = True

    per_h = PRICE_PER_H + (KEYTERM_PER_H if keyterms else 0.0)
    billed_s = max(audio_s, 20.0) if len(keyterms) > 100 else audio_s
    return NormalizedResult(
        model=f"elevenlabs-{model}", clip=clip or Path(audio_path).name.split(".")[0],
        lang=body.get("language_code") or language_hint, text=(body.get("text") or "").strip(),
        words=words if (words or not dry_run) else None,
        timing={"infer_s": sw.s, "audio_s": round(audio_s, 2), "upload_bytes": path.stat().st_size},
        cost_estimate_usd=round(per_h * billed_s / 3600, 5), meta=meta,
    )
