# Cloud ASR for Titler: options and recommendation (2026-10-24)

Scope: ~90% Russian, some Russian/Ukrainian mixing that must stay as spoken, some English. Noisy outdoor POV audio, clips from 30 s to a few minutes. Spec section: `docs/spec-workflow.md`, "Распознавание и выбор вариантов". Everything below was checked against vendor docs on 2026-10-24, with links. **No audio was sent anywhere** because no keys exist on n5. The adapters in `bench/cloud/` have only been dry-run and parse-tested against fake responses.

## TL;DR
- **Primary cloud second hypothesis: ElevenLabs Scribe v2.** The only option with all of these in one call: word timestamps, per-word logprob, keyterms, and automatic language detection that handles mixed languages. ~$0.0045/min with keyterms. Leads the independent AA-WER leaderboard (mostly English).
- **Optional third voice: Gemini 3.5 Transcribe** (`gemini-3.5-transcribe`), ~$0.005/min, ru-RU and uk-UA with code-switching, word timestamps — but custom vocabulary cannot be combined with timestamps in one call. **Soniox stt-async-v5** is a cheaper alternative ($0.10/h): per-token language ID, context terms, timestamps.
- **OpenAI `gpt-transcribe`**: cheap ($0.0045/min), prompt + keywords + multi-language hint, but **no timestamps** — needs the local forced aligner. `whisper-1` (only OpenAI model with word timestamps) is **deprecated (shutdown 2027-02-26)**.
- **Claude cannot take audio** (Messages/Files APIs: text, PDF, images). Role: text pass — compare hypotheses, separately-labelled "по смыслу" fixes, dictionary terms, punctuation/paragraphs. Est. per minute of speech: ~$0.06 `claude-opus-5-5`, ~$0.03 `claude-sonnet-5-5`, ~$0.002 `claude-haiku-5-5`; Batch API halves these.
- **Keys (minimum):** `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`. Nice to have: `GEMINI_API_KEY` (billing-enabled project), then `OPENAI_API_KEY` or `SONIOX_API_KEY`.

## Comparison
List API prices per minute of audio. "Word ts" = word-level timestamps returned by the API.

| Provider / model | Russian evidence | Word ts | Vocab / prompt | ru/uk switching | $/min | Retention / training | Max input | Credential |
|---|---|---|---|---|---|---|---|---|
| **ElevenLabs `scribe_v2`** | Vendor: Scribe v1 RU FLEURS 3.1%, CV 5.5% WER [1]. AA-WER v2: 2.2–2.3%, #1–2, English-centric [2]. Soniox's table: EL 8.3% RU [3] | **Yes** + per-word logprob | `keyterms` ≤1000 (+20%; >100 terms ⇒ 20 s min bill) [4] | Auto-detect; mixed-language supported [5] | 0.0037, **0.0045 w/ keyterms** [6] | Logging on by default; zero-retention **enterprise-only** [7] | 5 GB | `ELEVENLABS_API_KEY`, paid plan |
| **Gemini `gemini-3.5-transcribe`** | No published RU WER; ru-RU, uk-UA listed [8] | **Yes** (may cost accuracy) | `custom_vocabulary` ≤1000, **not with timestamps/diarization** [8] | Intra-sentence switching [8] | **~0.005** [9] | Paid tier not used for training; **free tier is** [9]. Files deleted ≤48 h (adapter deletes at once) | 1 h (30 min w/ ts) | `GEMINI_API_KEY` on billing project |
| Gemini 2.5/3.x Flash/Pro (generic audio) | Good text, timestamp drift reported [10] | No | Prompt | Prompt | ~0.002–0.004 | as above | 9.5 h | same |
| **OpenAI `gpt-transcribe`** | 22-lang CV avg ~19% vs whisper-1 ~40% (3rd party) [11] | **No** | `prompt` + `keywords[]` + `languages[]` [12] | `languages[]` hint | **0.0045** [13] | Not used for training; ZDR-eligible [14] | 25 MB | `OPENAI_API_KEY` |
| OpenAI `gpt-4o-transcribe` / `-mini` | older | No | prompt; logprobs | `language` | 0.006 / 0.003 | same | 25 MB | deprecated 2027-02-26 |
| OpenAI `whisper-1` | weakest | **Yes** (`verbose_json`) | prompt ≤224 tok | `language` | 0.006 | same | 25 MB | deprecated 2027-02-26 |
| **Soniox `stt-async-v5`** | Vendor: RU WER 6.2% vs Deepgram 8.0, EL 8.3, OpenAI 10.1, Google 16.7 [3] | **Yes**, per-token confidence | `context` ≤8k tokens [15] | hints + **per-token language id** | **0.0017** [16] | DELETE endpoints (adapter deletes) | ~5 h | `SONIOX_API_KEY` |
| Deepgram Nova-3 | ru, uk mono; `multi` lacks uk [17] | Yes | keyterm; ru unconfirmed [18] | weak | ? | ? | ? | — |
| AssemblyAI | ru falls back to Universal-2 [19] | Yes | 200 keyterms | supported | 0.0025 | ? | ? | not recommended |
| Speechmatics Enhanced | RU WER unchecked | Yes | dictionary | ? | 0.0125 [20] | ≤7 days | ? | pricier |
| Yandex SpeechKit | native RU; no public WER | ? | v3 | ? | ~0.005 [21] | ? | ? | jurisdiction/billing friction |
| Groq whisper-large-v3(-turbo) | = local large-v3 | Yes | prompt | `language` | 0.0019 / 0.0007 [22] | ? | 25–100 MB | adds nothing |
| Google Chirp 3 | ru-RU, uk-UA GA | Optional, degraded [23] | adaptation ≤1000 | `auto` | GCP | GCP | — | more setup, no gain |

Latency not measured (no keys); bench records `timing.infer_s` on first real run.

**Caveat:** every RU number is vendor-published or English-centric. Only our own `bench/refs` + the shared WER script settles it.

## How Claude fits
- No audio input: Files API takes PDF, text, images [24]; no audio pricing [25].
- `bench/cloud/titler_cloud/claude_review.py`:
  - Disagreement review: primary hypothesis (indices + timings) + alternatives → `issues[]` with index range, variants with sources (different word counts allowed), suggestion, `basis`, `reason`.
  - `basis: "context"` required when no hypothesis contains the reading → UI labels "по смыслу".
  - Dictionary terms only where a hypothesis is phonetically close.
  - Never translates ru/uk/en; locked (user-approved) indices are passed in and must not change.
  - Punctuation/paragraphs as a separate layer (`punctuated_text`, `paragraph_starts`).
- Default `claude-opus-5-5`, adaptive thinking effort `medium`, structured JSON, refusal fallback. Override `TITLER_CLAUDE_MODEL`. A/B Sonnet 5.5 for routine clips, Haiku 5.5 for punctuation-only.
- Cost per minute of speech (~130 words, ~3k in / 2–3k out): Opus ~$0.05–0.07, Sonnet ~$0.03, Haiku ~$0.002; Batch halves. Confirm with `count_tokens`.
- API data not used for training without permission; ZDR by arrangement [26].

## Proposed pipeline
1. Local first pass → text + provisional timings.
2. ElevenLabs Scribe v2 on the whole clip, keyterms on (~$0.0045/min).
3. Time-align hypotheses → disputed ranges. Never compare confidences across providers (`conf_kind` recorded).
4. Claude review on disputed ranges + punctuation/paragraphs.
5. Local forced aligner refines timings (also makes timestamp-less providers usable).

3-minute clip: ~$0.014 ElevenLabs + ~$0.18 Opus review (or ~$0.09 Sonnet).

## Keys (`titler/.env`, git-ignored; template `bench/cloud/env.example`)
| Env var | Needed for | Notes |
|---|---|---|
| `ELEVENLABS_API_KEY` | required: Scribe v2 | paid plan; `ELEVENLABS_ZERO_RETENTION=1` enterprise only |
| `ANTHROPIC_API_KEY` | required: review pass | optional `TITLER_CLAUDE_MODEL` / `TITLER_CLAUDE_EFFORT` |
| `GEMINI_API_KEY` | optional third voice | billing-enabled project |
| `OPENAI_API_KEY` | optional text-only voice | project key with credits |
| `SONIOX_API_KEY` | optional cheapest third voice | Soniox console |

## Code (`bench/cloud/`)
- `titler_cloud/`: one adapter per provider, `transcribe(audio_path, *, language_hint=None, keyterms=[...], model=None, dry_run=False) -> NormalizedResult` → `{model, clip, lang, text, words:[{w,start,end,conf?,lang?}]|null, timing:{infer_s,audio_s,upload_bytes}, cost_estimate_usd, meta}`. `available()` lists providers whose key is set (auto-enable hook). Adapters: `openai_asr`, `elevenlabs_asr`, `gemini_asr` (modes `words`/`vocab`), `soniox_asr`, `claude_review`. httpx for ASR, `anthropic` SDK for Claude; oversized audio transcoded; uploads deleted after use.
- `run.py`: `list`, `transcribe <provider|all|available> [--clip] [--model] [--dry-run]`, `review --primary <dir> --alt <dir> [--dry-run]`. Writes `bench/runs/asr/<provider>-<model>/<clip>.{json,txt}`.
- venv `bench/envs/cloud` (Py 3.11, httpx 0.28.1, anthropic 2.3.0).
- Verified: py_compile, dry-runs, offline parse test with fake responses. **Not verified:** real API responses — run each provider once on `video-34238` when keys arrive.

## Sources
1. https://elevenlabs.io/speech-to-text/russian
2. https://artificialanalysis.ai/speech-to-text/batch · https://the-decoder.com/elevenlabs-and-google-dominate-artificial-analysis-updated-speech-to-text-benchmark/
3. https://soniox.com/compare-stt/soniox-vs-elevenlabs/russian · https://soniox.com/soniox-app/for/journalists-dictate-articles-in-russian
4. https://elevenlabs.io/docs/api-reference/speech-to-text/convert · https://api.elevenlabs.io/openapi.json
5. https://elevenlabs.io/blog/introducing-scribe-v2
6. https://elevenlabs.io/pricing/api
7. https://elevenlabs.io/docs/developers/resources/zero-retention-mode
8. https://ai.google.dev/gemini-api/docs/transcribe · https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe
9. https://ai.google.dev/gemini-api/docs/pricing
10. https://discuss.ai.google.dev/t/bug-gemini-3-flash-and-3-1-pro-progressive-timestamp-drift-in-audio-transcription/129501
11. https://gigazine.net/gsc_news/en/20260729-gpt-live-transcribe · https://spokenly.app/blog/gpt-transcribe
12. https://developers.openai.com/api/docs/guides/speech-to-text
13. https://developers.openai.com/api/docs/pricing · https://developers.openai.com/api/docs/models/gpt-transcribe
14. https://developers.openai.com/api/docs/guides/your-data
15. https://soniox.com/docs/stt/concepts/context · https://soniox.com/docs/stt/async/async-transcription · https://soniox.com/docs/stt/concepts/supported-languages
16. https://soniox.com/pricing
17. https://developers.deepgram.com/docs/models-languages-overview
18. https://developers.deepgram.com/docs/keyterm
19. https://www.assemblyai.com/docs/getting-started/models
20. https://www.speechmatics.com/pricing
21. https://aistudio.yandex.ru/docs/en/speechkit/pricing
22. https://console.groq.com/docs/speech-to-text
23. https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3
24. https://platform.claude.com/docs/en/build-with-claude/files
25. https://platform.claude.com/docs/en/about-claude/pricing
26. https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
