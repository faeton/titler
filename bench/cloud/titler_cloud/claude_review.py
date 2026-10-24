"""Claude text pass over ASR hypotheses (Claude has no audio input — text only).

Docs (checked 2026-10-24): Files API content types are PDF / text / images only
(https://platform.claude.com/docs/en/build-with-claude/files); pricing
https://platform.claude.com/docs/en/about-claude/pricing (no audio rate).

What it does for Titler (spec "Распознавание и выбор вариантов"):
- aligns 2+ hypotheses by time, lists ranges where they differ, picks/proposes a reading;
- separately flags context-only suggestions ("по смыслу") — never presented as heard;
- suggests dictionary spellings (Awerti, Esports Charts, ...) only where a hypothesis is
  phonetically close, never everywhere;
- keeps Ukrainian/English words as spoken, never translates; never touches locked words;
- proposes punctuation + paragraph breaks as a separate layer.
Output is JSON (structured outputs), word ids/times reference the PRIMARY hypothesis.
"""
from __future__ import annotations

import json
import os

from .common import DEFAULT_KEYTERMS, NormalizedResult, Stopwatch, require_key

ENV = "ANTHROPIC_API_KEY"
DEFAULT_MODEL = os.environ.get("TITLER_CLAUDE_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("TITLER_CLAUDE_EFFORT", "medium")
# $/MTok (input, output), platform.claude.com pricing page, 2026-10-24
PRICES = {"claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5-5": (2.0, 10.0), "claude-haiku-5-5": (0.10, 0.50)}

SYSTEM = """You review speech-recognition output for Titler, a captioning studio for smart-glasses POV video.
Speech is mostly Russian, sometimes Ukrainian mixed in mid-sentence, sometimes English. Noisy outdoor audio.

Rules:
- You cannot hear the audio. Only the hypotheses are evidence of what was said.
- Keep every word in the language it was spoken. Never translate Ukrainian or English into Russian, never "normalise" surzhyk.
- Words listed as locked were approved by the user: never change them.
- basis="acoustic": the reading is supported by at least one hypothesis. basis="context": your guess from meaning that no hypothesis contains — the UI labels these "по смыслу"; use sparingly, only when the hypotheses are clearly wrong.
- basis="vocabulary": a dictionary term whose sound matches what a hypothesis wrote (e.g. "аверти" -> "Awerti"). Do not insert dictionary terms where nothing sounds like them.
- Do not report differences that are only case or punctuation.
- Agreement of all hypotheses does not prove correctness, but do not invent issues there without a strong reason.
- Ranges are given as primary word indices [i_start, i_end] inclusive; for insertions of a missed word use i_end = i_start - 1 (insert before i_start).
Also return the primary transcript with proposed punctuation and paragraph breaks (word text unchanged except your listed fixes)."""

SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "i_start": {"type": "integer"},
                    "i_end": {"type": "integer"},
                    "variants": {"type": "array", "items": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}, "source": {"type": "string"}},
                        "required": ["text", "source"], "additionalProperties": False}},
                    "suggestion": {"type": "string"},
                    "basis": {"type": "string", "enum": ["acoustic", "context", "vocabulary"]},
                    "reason": {"type": "string", "enum": ["models_disagree", "dictionary_term",
                                                          "implausible_in_context", "possible_missed_words",
                                                          "language_switch"]},
                    "note": {"type": "string"},
                },
                "required": ["i_start", "i_end", "variants", "suggestion", "basis", "reason", "note"],
                "additionalProperties": False,
            },
        },
        "punctuated_text": {"type": "string"},
        "paragraph_starts": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["issues", "punctuated_text", "paragraph_starts"],
    "additionalProperties": False,
}


def _fmt_hyp(r: dict, with_index: bool) -> str:
    words = r.get("words")
    if not words:
        return r.get("text", "")
    if with_index:
        return " ".join(f"{i}:{w['w']}@{w['start']:.2f}" for i, w in enumerate(words))
    return " ".join(f"{w['w']}@{w['start']:.2f}" for w in words)


def build_request(primary: dict, others: list[dict], *, keyterms=DEFAULT_KEYTERMS, locked=(),
                  model=None) -> dict:
    model = model or DEFAULT_MODEL
    parts = [f"Dictionary terms: {', '.join(keyterms) or '-'}",
             f"Locked word indices (do not change): {list(locked) or '-'}",
             f"PRIMARY ({primary['model']}), format index:word@start_s:\n{_fmt_hyp(primary, True)}"]
    for o in others:
        parts.append(f"ALT ({o['model']}), format word@start_s (or plain text if no timings):\n{_fmt_hyp(o, False)}")
    kw = dict(
        model=model,
        max_tokens=16000,
        system=SYSTEM,
        output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": "\n\n".join(parts)}],
    )
    # Server-side refusal fallback (opt-in, Claude API only); default ON for Opus 5.5 / Sonnet 5.5.
    if model in ("claude-opus-5-5", "claude-sonnet-5-5") and os.environ.get("TITLER_CLAUDE_FALLBACK", "1") == "1":
        kw["betas"] = ["server-side-fallback-2026-07-01"]
        kw["fallbacks"] = "default"
    return kw


def review(primary: dict, others: list[dict], *, keyterms=DEFAULT_KEYTERMS, locked=(), model=None,
           dry_run=False) -> dict:
    """primary/others are normalised result dicts (bench/runs/asr/*/<clip>.json)."""
    kw = build_request(primary, others, keyterms=keyterms, locked=locked, model=model)
    if dry_run:
        require_key(ENV, True)
        # rough size estimate: Cyrillic ~ 2.5 chars/token in practice; measured later with count_tokens
        chars = len(kw["system"]) + len(kw["messages"][0]["content"])
        return {"dry_run": True, "request": kw, "approx_input_tokens": chars // 3}
    require_key(ENV, False)
    import anthropic
    client = anthropic.Anthropic()
    with Stopwatch() as sw:
        resp = client.beta.messages.create(**kw) if "betas" in kw else client.messages.create(**kw)
    if resp.stop_reason == "refusal":
        raise RuntimeError(f"claude refused: {getattr(resp, 'stop_details', None)}")
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("claude hit max_tokens; raise it or split the clip")
    text = next(b.text for b in resp.content if b.type == "text")
    out = json.loads(text)
    pin, pout = PRICES.get(resp.model, PRICES.get(kw["model"], (None, None)))
    u = resp.usage
    cost = None
    if pin is not None:
        cost = round((u.input_tokens * pin + u.output_tokens * pout) / 1e6, 5)
    return {"model": resp.model, "primary": primary["model"], "others": [o["model"] for o in others],
            "clip": primary["clip"], "result": out,
            "usage": {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens},
            "timing": {"infer_s": sw.s}, "cost_estimate_usd": cost}
