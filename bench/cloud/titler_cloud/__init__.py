"""Cloud ASR adapters for Titler — one interface, enabled by the presence of an env key.

    from titler_cloud import available, get
    for name in available():                 # e.g. ["openai", "elevenlabs"]
        res = get(name).transcribe("clip.16k.wav", keyterms=["Awerti"])   # -> NormalizedResult

Claude is not an ASR (no audio input); it is the text-review pass in `claude_review`.
"""
from __future__ import annotations

import importlib
import os

from .common import DEFAULT_KEYTERMS, MissingKey, NormalizedResult, Word  # noqa: F401

# name -> (module, env var, default model, word timestamps by default?)
PROVIDERS = {
    "openai":     ("openai_asr",     "OPENAI_API_KEY",     "gpt-transcribe",        False),
    "elevenlabs": ("elevenlabs_asr", "ELEVENLABS_API_KEY", "scribe_v2",             True),
    "gemini":     ("gemini_asr",     "GEMINI_API_KEY",     "gemini-3.5-transcribe", True),
    "soniox":     ("soniox_asr",     "SONIOX_API_KEY",     "stt-async-v5",          True),
}
REVIEWERS = {"claude": ("claude_review", "ANTHROPIC_API_KEY")}


def get(name: str):
    return importlib.import_module(f".{PROVIDERS[name][0]}", __name__)


def available() -> list[str]:
    """Providers whose API key is present in the environment (feature auto-enable)."""
    return [n for n, (_, env, _, _) in PROVIDERS.items() if os.environ.get(env, "").strip()]


def reviewer_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
