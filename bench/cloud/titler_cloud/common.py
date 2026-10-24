"""Shared types and helpers for cloud ASR adapters.

Every provider adapter exposes

    transcribe(audio_path, *, language_hint=None, keyterms=(), model=None, dry_run=False, **opts)
        -> NormalizedResult

and never reads anything but its own env var for the credential. With dry_run=True no
network request is made: the adapter records the HTTP requests it *would* send
(credentials redacted, file bodies replaced by a size summary) in result.meta["plan"].
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# Terms Titler wants spelled right. Also the default bias list for adapters.
DEFAULT_KEYTERMS = ["Awerti", "Esports Charts", "Streams Charts"]

# Short natural-language context used by providers that accept a free-text prompt.
CONTEXT_RU = (
    "Видео с умных очков, разговорная речь от первого лица, улица, шум. "
    "В основном русский язык, местами украинский и английский: записывай каждое слово "
    "на том языке, на котором оно произнесено, ничего не переводи."
)

# Languages we expect, ISO-639-1. Titler: ~90% ru, some uk mixed in, some en.
EXPECTED_LANGS = ["ru", "uk", "en"]


@dataclass
class Word:
    w: str
    start: float
    end: float
    conf: float | None = None  # provider-native, NOT comparable across providers
    lang: str | None = None


@dataclass
class NormalizedResult:
    model: str                       # "<provider>-<model>", also the runs/ subdir name
    clip: str
    lang: str | None
    text: str
    words: list[Word] | None
    timing: dict = field(default_factory=dict)          # {infer_s, audio_s, upload_bytes}
    cost_estimate_usd: float | None = None
    meta: dict = field(default_factory=dict)            # provider extras, plan in dry-run

    def to_json(self) -> dict:
        d = asdict(self)
        if self.words is not None:
            d["words"] = [{k: v for k, v in asdict(w).items() if v is not None} for w in self.words]
        return d


class MissingKey(RuntimeError):
    pass


def require_key(env: str, dry_run: bool) -> str:
    v = os.environ.get(env, "").strip()
    if not v:
        if dry_run:
            return "<" + env + ">"
        raise MissingKey(f"{env} is not set")
    return v


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def audio_seconds(path: Path) -> float:
    path = Path(path)
    if path.suffix.lower() == ".wav":
        with wave.open(str(path)) as w:
            return w.getnframes() / w.getframerate()
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


MIME = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac",
        ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".webm": "audio/webm"}


def prepare_audio(src: Path, *, max_bytes: int, fallback: str = "flac") -> tuple[Path, str]:
    """Return (path, mime). Uses the 16 kHz mono wav as-is when under the provider's limit,
    otherwise transcodes (ffmpeg) to `fallback` ('flac' or 'mp3') in a temp dir."""
    src = Path(src)
    if src.stat().st_size <= max_bytes:
        return src, MIME.get(src.suffix.lower(), "application/octet-stream")
    ff = shutil.which("ffmpeg")
    if not ff:
        raise RuntimeError(f"{src} exceeds {max_bytes} bytes and ffmpeg is not on PATH")
    out = Path(tempfile.mkdtemp(prefix="titler-cloud-")) / (src.stem + "." + fallback)
    codec = ["-c:a", "flac"] if fallback == "flac" else ["-c:a", "libmp3lame", "-b:a", "64k"]
    subprocess.run([ff, "-v", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", *codec, str(out)],
                   check=True)
    if out.stat().st_size > max_bytes:
        raise RuntimeError(f"{out} still exceeds {max_bytes} bytes; split the clip")
    return out, MIME[out.suffix]


# --------------------------------------------------------------------------- HTTP

class _FakeResp:
    def __init__(self, payload: Any, headers: dict | None = None):
        self._p = payload
        self.headers = headers or {}
        self.status_code = 200
        self.text = json.dumps(payload) if not isinstance(payload, str) else payload

    def json(self):
        return self._p

    def raise_for_status(self):
        return None


def _redact(h: dict | None) -> dict:
    out = {}
    for k, v in (h or {}).items():
        lk = k.lower()
        if lk in ("authorization", "xi-api-key", "x-goog-api-key", "x-api-key"):
            out[k] = "<redacted>"
        else:
            out[k] = v
    return out


def _summarise_files(files) -> Any:
    if not files:
        return None
    items = files.items() if isinstance(files, dict) else files
    out = []
    for name, f in items:
        fn, fh, mime = (list(f) + [None, None, None])[:3]
        try:
            size = os.fstat(fh.fileno()).st_size
        except Exception:
            size = len(fh) if isinstance(fh, (bytes, bytearray)) else None
        out.append({"field": name, "filename": fn, "mime": mime, "bytes": size})
    return out


class Http:
    """Thin httpx wrapper. In dry-run mode it records the request and returns `stub`."""

    def __init__(self, dry_run: bool, timeout: float = 600.0):
        self.dry_run = dry_run
        self.plan: list[dict] = []
        self._client = None
        self.timeout = timeout

    def request(self, method: str, url: str, *, stub: Any = None, stub_headers: dict | None = None,
                headers=None, params=None, data=None, json_body=None, files=None, content=None):
        rec = {"method": method, "url": url, "headers": _redact(headers)}
        if params:
            rec["params"] = params
        if data:
            rec["form"] = data
        if json_body is not None:
            rec["json"] = json_body
        if files:
            rec["files"] = _summarise_files(files)
        if content is not None:
            rec["body_bytes"] = len(content)
        self.plan.append(rec)
        if self.dry_run:
            return _FakeResp({} if stub is None else stub, stub_headers)
        import httpx
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        r = self._client.request(method, url, headers=headers, params=params, data=data,
                                 json=json_body, files=files, content=content)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {url} -> HTTP {r.status_code}: {r.text[:500]}")
        return r


def merge_subword_tokens(tokens: list[dict]) -> list[Word]:
    """Soniox-style tokens: {'text', 'start_ms', 'end_ms', 'confidence', 'language'}; a token
    whose text starts with a space begins a new word. Punctuation-only tokens attach to the
    previous word's text without moving its end."""
    words: list[Word] = []
    for t in tokens:
        txt = t.get("text", "")
        if not txt or t.get("start_ms") is None:
            continue
        s, e = t["start_ms"] / 1000.0, t["end_ms"] / 1000.0
        stripped = txt.strip()
        if not stripped:
            continue
        new = txt.startswith(" ") or not words
        if not new and stripped and all(not c.isalnum() for c in stripped):
            words[-1].w += stripped
            continue
        if new:
            words.append(Word(w=stripped, start=s, end=e, conf=t.get("confidence"), lang=t.get("language")))
        else:
            w = words[-1]
            w.w += stripped
            w.end = e
            if t.get("confidence") is not None and w.conf is not None:
                w.conf = min(w.conf, t["confidence"])
    for w in words:
        w.start, w.end = round(w.start, 3), round(w.end, 3)
    return words


class Stopwatch:
    def __enter__(self):
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        self.s = round(time.perf_counter() - self.t0, 3)
