"""Soniox async STT (stt-async-v5).

Docs (checked 2026-10-24): https://soniox.com/docs/stt/async/async-transcription ,
context https://soniox.com/docs/stt/concepts/context , timestamps
https://soniox.com/docs/stt/concepts/timestamps , pricing https://soniox.com/pricing ($0.10/h async).
- ru + uk supported; language_hints + per-token language id (good for ru/uk code-switching).
- context.terms / context.general / context.text for vocabulary (<= 8k tokens).
- token-level start_ms/end_ms (sub-word tokens -> merged into words here), per-token confidence.
- Flow: upload file -> create transcription -> poll -> fetch transcript -> delete both.
"""
from __future__ import annotations

import time
from pathlib import Path

from .common import (CONTEXT_RU, DEFAULT_KEYTERMS, EXPECTED_LANGS, Http, NormalizedResult, Stopwatch,
                     audio_seconds, merge_subword_tokens, prepare_audio, require_key)

ENV = "SONIOX_API_KEY"
BASE = "https://api.soniox.com/v1"
DEFAULT_MODEL = "stt-async-v5"
MAX_BYTES = 500 * 1024 * 1024
PRICE_PER_H = 0.10


def transcribe(audio_path, *, language_hint=None, keyterms=DEFAULT_KEYTERMS, model=None,
               dry_run=False, clip=None, **_):
    model = model or DEFAULT_MODEL
    key = require_key(ENV, dry_run)
    path, mime = prepare_audio(Path(audio_path), max_bytes=MAX_BYTES)
    audio_s = audio_seconds(path)
    H = {"Authorization": f"Bearer {key}"}
    http = Http(dry_run)

    with open(path, "rb") as fh, Stopwatch() as sw:
        f = http.request("POST", f"{BASE}/files", headers=H, files={"file": (path.name, fh, mime)},
                         stub={"id": "file-dry-run"}).json()
        req = {
            "model": model,
            "file_id": f["id"],
            "language_hints": [language_hint] if language_hint else EXPECTED_LANGS,
            "enable_language_identification": True,
            "context": {
                "general": [{"key": "domain", "value": "POV smart-glasses vlog, outdoor"},
                            {"key": "instruction", "value": "transcribe as spoken, do not translate"}],
                "text": CONTEXT_RU,
                "terms": list(keyterms),
            },
        }
        t = http.request("POST", f"{BASE}/transcriptions", headers=H, json_body=req,
                         stub={"id": "tr-dry-run", "status": "completed"}).json()
        while t.get("status") not in ("completed", "error") and not dry_run:
            time.sleep(1.0)
            t = http.request("GET", f"{BASE}/transcriptions/{t['id']}", headers=H).json()
        if t.get("status") == "error":
            raise RuntimeError(f"soniox error: {t}")
        tr = http.request("GET", f"{BASE}/transcriptions/{t['id']}/transcript", headers=H,
                          stub={"text": "", "tokens": []}).json()
        http.request("DELETE", f"{BASE}/transcriptions/{t['id']}", headers=H)
        http.request("DELETE", f"{BASE}/files/{f['id']}", headers=H)

    tokens = tr.get("tokens", [])
    words = merge_subword_tokens(tokens)
    langs = [w.lang for w in words if w.lang]
    main_lang = max(set(langs), key=langs.count) if langs else language_hint
    text = tr.get("text") or "".join(t.get("text", "") for t in tokens)
    meta = {"provider": "soniox", "api_model": model, "conf_kind": "token_confidence_min",
            "lang_counts": {l: langs.count(l) for l in set(langs)}}
    if dry_run:
        meta["plan"] = http.plan
        meta["dry_run"] = True
    return NormalizedResult(
        model=f"soniox-{model}", clip=clip or Path(audio_path).name.split(".")[0], lang=main_lang,
        text=text.strip(), words=words or None,
        timing={"infer_s": sw.s, "audio_s": round(audio_s, 2), "upload_bytes": path.stat().st_size},
        cost_estimate_usd=round(PRICE_PER_H * audio_s / 3600, 5), meta=meta,
    )
