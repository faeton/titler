"""OpenAI speech-to-text (POST /v1/audio/transcriptions).

Docs (checked 2026-10-24): https://developers.openai.com/api/docs/guides/speech-to-text
- gpt-transcribe (2026-07): $0.0045/min, prompt + keywords[] + languages[] (code-switching hint),
  returns text + detected languages. NO timestamps -> local forced alignment needed.
- gpt-4o-transcribe / -mini: prompt, include[]=logprobs; no timestamps. Deprecated, shutdown 2027-02-26.
- whisper-1: verbose_json + timestamp_granularities[]=word|segment (only model with word times);
  prompt <=224 tokens. Deprecated, shutdown 2027-02-26.
Upload limit 25 MB; formats mp3 mp4 mpeg mpga m4a wav webm.
"""
from __future__ import annotations

from pathlib import Path

from .common import (CONTEXT_RU, DEFAULT_KEYTERMS, EXPECTED_LANGS, Http, NormalizedResult, Stopwatch,
                     Word, audio_seconds, prepare_audio, require_key)

ENV = "OPENAI_API_KEY"
URL = "https://api.openai.com/v1/audio/transcriptions"
DEFAULT_MODEL = "gpt-transcribe"
MAX_BYTES = 25 * 1024 * 1024
PRICE_PER_MIN = {
    "gpt-transcribe": 0.0045,
    "gpt-4o-transcribe": 0.006,
    "gpt-4o-mini-transcribe": 0.003,
    "whisper-1": 0.006,
}
WORD_TIMESTAMPS = {"whisper-1"}


def _prompt(keyterms) -> str:
    terms = ", ".join(keyterms)
    return f"{CONTEXT_RU} Термины: {terms}." if terms else CONTEXT_RU


def transcribe(audio_path, *, language_hint=None, keyterms=DEFAULT_KEYTERMS, model=None,
               dry_run=False, clip=None, **_):
    model = model or DEFAULT_MODEL
    key = require_key(ENV, dry_run)
    path, mime = prepare_audio(Path(audio_path), max_bytes=MAX_BYTES, fallback="mp3")
    audio_s = audio_seconds(path)
    headers = {"Authorization": f"Bearer {key}"}

    # multipart form; list-valued fields are sent as repeated "name[]" parts
    form: list[tuple[str, str]] = [("model", model)]
    if model == "gpt-transcribe":
        form.append(("prompt", _prompt(keyterms)))
        for k in keyterms:
            form.append(("keywords[]", k))
        # `languages` replaces singular `language` for gpt-transcribe; send the expected mix
        langs = [language_hint] if language_hint else EXPECTED_LANGS
        for l in langs:
            form.append(("languages[]", l))
        form.append(("response_format", "json"))
    elif model == "whisper-1":
        form.append(("prompt", _prompt(keyterms)))   # 224-token cap; ours is ~80
        if language_hint:
            form.append(("language", language_hint))
        form += [("response_format", "verbose_json"),
                 ("timestamp_granularities[]", "word"), ("timestamp_granularities[]", "segment")]
    else:  # gpt-4o-transcribe / gpt-4o-mini-transcribe
        form.append(("prompt", _prompt(keyterms)))
        if language_hint:
            form.append(("language", language_hint))
        form += [("response_format", "json"), ("include[]", "logprobs")]

    http = Http(dry_run)
    with open(path, "rb") as fh, Stopwatch() as sw:
        # httpx accepts a list of tuples for repeated multipart fields via `files`
        files = [("file", (path.name, fh, mime))] + [(k, (None, v)) for k, v in form]
        r = http.request("POST", URL, headers=headers, files=files,
                         stub={"text": "", "languages": []})
        body = r.json()
    if dry_run:
        # make the plan readable: list the text fields separately from the file part
        http.plan[-1]["form"] = form
        http.plan[-1]["files"] = [p for p in http.plan[-1]["files"] if p["field"] == "file"]

    words = None
    lang = language_hint
    meta: dict = {"provider": "openai", "api_model": model}
    if model in WORD_TIMESTAMPS:
        words = [Word(w=w["word"].strip(), start=round(w["start"], 3), end=round(w["end"], 3))
                 for w in body.get("words", [])]
        lang = body.get("language") or lang
        meta["segments"] = [{"start": s["start"], "end": s["end"], "text": s["text"],
                             "avg_logprob": s.get("avg_logprob"), "no_speech_prob": s.get("no_speech_prob")}
                            for s in body.get("segments", [])]
    else:
        langs = [l.get("code") for l in body.get("languages", []) if l.get("code")]
        if langs:
            meta["languages"] = langs
            lang = langs[0]
        if body.get("logprobs"):
            meta["token_logprobs"] = [{"t": t.get("token"), "lp": t.get("logprob")} for t in body["logprobs"]]
    if dry_run:
        meta["plan"] = http.plan
        meta["dry_run"] = True

    price = PRICE_PER_MIN.get(model)
    return NormalizedResult(
        model=f"openai-{model}", clip=clip or Path(audio_path).name.split(".")[0], lang=lang,
        text=(body.get("text") or "").strip(), words=words,
        timing={"infer_s": sw.s, "audio_s": round(audio_s, 2), "upload_bytes": path.stat().st_size},
        cost_estimate_usd=round(price * audio_s / 60, 5) if price else None,
        meta=meta,
    )
