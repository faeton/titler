"""Google Gemini 3.5 Transcribe via the Gemini API Interactions endpoint.

Docs (checked 2026-10-24): https://ai.google.dev/gemini-api/docs/transcribe ,
model page https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe ,
pricing https://ai.google.dev/gemini-api/docs/pricing (~$0.005/min blended, paid tier).
- 85+ locales incl. ru-RU and uk-UA, automatic language detection with code-switching.
- word timestamps (verbatim mode, timestamp_granularities=["word"]) — docs warn they may
  degrade accuracy; custom_vocabulary (<=1000, ~100 best) CANNOT be combined with word
  timestamps or diarization. So: mode="words" (default) -> timestamps, no vocab;
  mode="vocab" -> vocab biasing, text only (align locally).
- Audio goes through the Files API (resumable upload; files auto-delete after 48 h; we
  delete right after use). Free tier data "used to improve our products" -> use a paid key.
"""
from __future__ import annotations

from pathlib import Path

from .common import (DEFAULT_KEYTERMS, Http, NormalizedResult, Stopwatch, Word, audio_seconds,
                     prepare_audio, require_key)

ENV = "GEMINI_API_KEY"
BASE = "https://generativelanguage.googleapis.com"
DEFAULT_MODEL = "gemini-3.5-transcribe"
MAX_BYTES = 2 * 1024 ** 3
PRICE_PER_MIN = {"gemini-3.5-transcribe": 0.005}
LOCALES = {"ru": "ru-RU", "uk": "uk-UA", "en": "en-US"}


def _secs(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return float(str(v).rstrip("s"))


def transcribe(audio_path, *, language_hint=None, keyterms=DEFAULT_KEYTERMS, model=None,
               dry_run=False, clip=None, mode="words", **_):
    model = model or DEFAULT_MODEL
    key = require_key(ENV, dry_run)
    path, mime = prepare_audio(Path(audio_path), max_bytes=MAX_BYTES)
    audio_s = audio_seconds(path)
    size = path.stat().st_size
    http = Http(dry_run)
    H = {"x-goog-api-key": key}

    with Stopwatch() as sw:
        # 1) resumable upload: start -> upload,finalize
        r = http.request("POST", f"{BASE}/upload/v1beta/files",
                         headers={**H, "X-Goog-Upload-Protocol": "resumable",
                                  "X-Goog-Upload-Command": "start",
                                  "X-Goog-Upload-Header-Content-Length": str(size),
                                  "X-Goog-Upload-Header-Content-Type": mime,
                                  "Content-Type": "application/json"},
                         json_body={"file": {"display_name": path.name}},
                         stub_headers={"x-goog-upload-url": f"{BASE}/upload/v1beta/files?upload_id=<dry-run>"})
        upload_url = r.headers.get("x-goog-upload-url")
        data = path.read_bytes()
        r = http.request("POST", upload_url,
                         headers={"Content-Length": str(size), "X-Goog-Upload-Offset": "0",
                                  "X-Goog-Upload-Command": "upload, finalize"},
                         content=data,
                         stub={"file": {"uri": f"{BASE}/v1beta/files/dry-run", "name": "files/dry-run"}})
        finfo = r.json()["file"]

        # 2) transcription interaction
        tc: dict = {}
        if language_hint:
            tc["language_codes"] = [LOCALES.get(language_hint, language_hint)]
        else:
            tc["language_codes"] = []          # auto-detect, keeps ru/uk switching
        if mode == "vocab":
            tc["custom_vocabulary"] = list(keyterms)
            tc["mode"] = {"type": "verbatim"}
        else:
            tc["mode"] = {"type": "verbatim", "timestamp_granularities": ["word"]}
        body = {"model": model,
                "input": [{"type": "audio", "uri": finfo["uri"], "mime_type": mime}],
                "generation_config": {"transcription_config": tc}}
        r = http.request("POST", f"{BASE}/v1beta/interactions", headers={**H, "Content-Type": "application/json"},
                         json_body=body, stub={"status": "completed", "steps": []})
        inter = r.json()
        # Interactions can come back in progress; poll until done.
        import time
        while inter.get("status") not in (None, "completed", "failed", "cancelled") and not dry_run:
            time.sleep(1.0)
            inter = http.request("GET", f"{BASE}/v1beta/{inter['id']}", headers=H).json()
        if inter.get("status") == "failed":
            raise RuntimeError(f"gemini interaction failed: {inter}")

        # 3) clean up the uploaded audio right away
        http.request("DELETE", f"{BASE}/v1beta/{finfo['name']}", headers=H)

    text_parts, words = [], []
    for step in inter.get("steps", []) or []:
        for c in step.get("content", []) or []:
            if c.get("type") == "text":
                text_parts.append(c.get("text", ""))
            for a in c.get("annotations", []) or []:
                if a.get("type") == "word_info" and a.get("start_offset") is not None:
                    words.append(Word(w=a["text"], start=round(_secs(a["start_offset"]), 3),
                                      end=round(_secs(a["end_offset"]), 3)))
    text = (inter.get("output_text") or " ".join(text_parts)).strip()
    meta = {"provider": "gemini", "api_model": model, "mode": mode,
            "note": "word timestamps requested; custom_vocabulary not sent" if mode == "words"
            else "custom_vocabulary sent; no timestamps (align locally)"}
    if dry_run:
        meta["plan"] = http.plan
        meta["dry_run"] = True
    price = PRICE_PER_MIN.get(model)
    return NormalizedResult(
        model=f"gemini-{model}" + ("-vocab" if mode == "vocab" else ""),
        clip=clip or Path(audio_path).name.split(".")[0], lang=language_hint, text=text,
        words=words or None,
        timing={"infer_s": sw.s, "audio_s": round(audio_s, 2), "upload_bytes": size},
        cost_estimate_usd=round(price * audio_s / 60, 5) if price else None, meta=meta,
    )
