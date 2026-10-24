#!/usr/bin/env python3
"""Cloud ASR bench CLI.

  bench/envs/cloud/bin/python bench/cloud/run.py list
  bench/envs/cloud/bin/python bench/cloud/run.py transcribe openai --clip video-34238 [--model whisper-1] [--dry-run]
  bench/envs/cloud/bin/python bench/cloud/run.py transcribe all --dry-run          # every provider
  bench/envs/cloud/bin/python bench/cloud/run.py transcribe available              # only providers with keys
  bench/envs/cloud/bin/python bench/cloud/run.py review --clip video-34238 \
        --primary elevenlabs-scribe_v2 --alt openai-gpt-transcribe [--dry-run]

Keys come from the environment; titler/.env is read too (existing env wins).
Writes bench/runs/asr/<provider>-<model>/<clip>.json (+ .txt) — never in --dry-run, which
only prints the HTTP plan and sends nothing.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent
ROOT = BENCH.parent
sys.path.insert(0, str(HERE))

from titler_cloud import PROVIDERS, available, get, reviewer_available  # noqa: E402
from titler_cloud.common import DEFAULT_KEYTERMS, MissingKey  # noqa: E402

AUDIO = BENCH / "samples" / "audio"
RUNS = BENCH / "runs" / "asr"
CLIPS = ["video-34238", "video-34442", "video-34585"]


def load_dotenv(path: Path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip().removeprefix("export ").strip(), v.strip().strip('"').strip("'")
        if v and k not in os.environ:
            os.environ[k] = v


def cmd_list(_):
    have = set(available())
    for n, (_, env, model, words) in PROVIDERS.items():
        print(f"{n:11s} {'ON ' if n in have else 'off'}  {env:20s} default={model:24s} word_ts={'yes' if words else 'no (align locally)'}")
    print(f"{'claude':11s} {'ON ' if reviewer_available() else 'off'}  {'ANTHROPIC_API_KEY':20s} review/correction pass (text only)")


def cmd_transcribe(a):
    names = list(PROVIDERS) if a.provider == "all" else available() if a.provider == "available" else [a.provider]
    clips = a.clip or CLIPS
    keyterms = [] if a.no_keyterms else (a.keyterm or DEFAULT_KEYTERMS)
    rc = 0
    for n in names:
        mod = get(n)
        for clip in clips:
            wav = AUDIO / f"{clip}.16k.wav"
            try:
                res = mod.transcribe(wav, language_hint=a.lang, keyterms=keyterms, model=a.model,
                                     dry_run=a.dry_run, clip=clip, **({"mode": a.gemini_mode} if n == "gemini" else {}))
            except MissingKey as e:
                print(f"[{n}] skipped: {e}", file=sys.stderr)
                rc = 2
                break
            d = res.to_json()
            if a.dry_run:
                print(json.dumps({"provider": n, "clip": clip, "out": str(RUNS / res.model / f'{clip}.json'),
                                  "cost_estimate_usd": d["cost_estimate_usd"], "plan": d["meta"]["plan"]},
                                 ensure_ascii=False, indent=1))
                continue
            out = RUNS / res.model
            out.mkdir(parents=True, exist_ok=True)
            (out / f"{clip}.json").write_text(json.dumps(d, ensure_ascii=False, indent=1))
            (out / f"{clip}.txt").write_text(d["text"] + "\n")
            print(f"[{res.model}] {clip}: {d['timing']['infer_s']}s ${d['cost_estimate_usd']} :: {d['text'][:100]}",
                  file=sys.stderr)
    return rc


def cmd_review(a):
    from titler_cloud import claude_review
    clips = a.clip or CLIPS
    for clip in clips:
        def load(m):
            p = RUNS / m / f"{clip}.json"
            if p.exists():
                return json.loads(p.read_text())
            if a.dry_run:  # placeholder so the request shape can be inspected without runs
                return {"model": m, "clip": clip, "text": "пример текста", "words": [
                    {"w": "пример", "start": 0.0, "end": 0.4}, {"w": "текста", "start": 0.4, "end": 0.9}]}
            raise SystemExit(f"missing {p}")
        prim = load(a.primary)
        alts = [load(m) for m in a.alt]
        try:
            res = claude_review.review(prim, alts, model=a.model, dry_run=a.dry_run,
                                       keyterms=a.keyterm or DEFAULT_KEYTERMS)
        except MissingKey as e:
            print(f"[claude] skipped: {e}", file=sys.stderr)
            return 2
        if a.dry_run:
            print(json.dumps(res, ensure_ascii=False, indent=1)[:4000])
            continue
        out = RUNS / f"review-{res['model']}"
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{clip}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
        print(f"[review] {clip}: {len(res['result']['issues'])} issues ${res['cost_estimate_usd']}", file=sys.stderr)
    return 0


def main(argv=None):
    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    t = sub.add_parser("transcribe")
    t.add_argument("provider", choices=[*PROVIDERS, "all", "available"])
    t.add_argument("--clip", action="append")
    t.add_argument("--model")
    t.add_argument("--lang", help="language hint (ISO-639-1); default: none = auto / ru+uk+en hints")
    t.add_argument("--keyterm", action="append")
    t.add_argument("--no-keyterms", action="store_true")
    t.add_argument("--gemini-mode", choices=["words", "vocab"], default="words")
    t.add_argument("--dry-run", action="store_true")
    t.set_defaults(fn=cmd_transcribe)
    r = sub.add_parser("review")
    r.add_argument("--clip", action="append")
    r.add_argument("--primary", required=True, help="runs/asr subdir of the primary hypothesis")
    r.add_argument("--alt", action="append", default=[], help="runs/asr subdir(s) of alternative hypotheses")
    r.add_argument("--model")
    r.add_argument("--keyterm", action="append")
    r.add_argument("--dry-run", action="store_true")
    r.set_defaults(fn=cmd_review)
    a = p.parse_args(argv)
    return a.fn(a) or 0


if __name__ == "__main__":
    sys.exit(main())
