# Titler v2 — rebuild plan

Status: draft, 2026-10-24. Target: `docs/spec-workflow.md`. Evidence: `docs/review-codex.md`
(code review + architecture), `bench/REPORT-{asr,enhance,align,gpu,cloud-asr}.md`.

The old app (Fastify + React + Remotion, v0.1) is archived at tag `legacy-v1` and
removed from `main`. Nothing is migrated; lessons are carried over (below).

## Lessons carried from v1

- A finished ASR job replaced `project.transcript` wholesale → manual edits lost.
  **Workers never write the confirmed transcript.**
- No cache identity; render "done" was keyed by style name. → **Content-addressed artifacts.**
- Words had no IDs/status; editor used array indices. → **Stable word IDs + separate timing/review/source state.**
- In-memory job queue. → **Jobs persisted in SQLite with leases.**
- Remotion preview and ASS export were two implementations of captions and drifted.
  → **One cue compiler** feeds both the browser overlay and the ASS writer.
- ASS bugs (unescaped text, `0:00:60.00`, last word dropped). → unit-tested compiler.
- Face-track "crop" collapsed to a static median X. POV footage rarely wants a face crop anyway.
  → manual keyframed crop first, auto-ROI as a suggestion.
- Whisper large-v3 + `vad_filter=True` (the v1 default) was the *worst* Whisper config:
  dropped the English speaker and Russian function words.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Web | Vite + React + TS, mobile-first, no Remotion | Preview = `<video>` + caption overlay from the shared cue plan |
| API | Fastify + TS on Node 24, `node:sqlite` | Single owner, no native build, no Redis |
| Shared | `packages/core`: domain types, edit ops, cue compiler, time map | Used by web *and* server; unit-tested |
| Workers | Python `titler_worker`, JSON-lines over stdio, long-lived | Models stay resident; one process per device class |
| GPU | ROCm 7.2 torch + CT2 container on the 890M (MIOpen off, AOTriton on, fp16) | 3–50× vs CPU (REPORT-gpu) |
| Render | ffmpeg: VAAPI decode → CPU crop/scale/libass → `h264_vaapi`; libx264 fallback | 4× faster, 25× less CPU, same VMAF |
| Storage | `data/` (gitignored): `titler.db`, `sources/<sha256>`, `artifacts/<key>/` | Immutable files, metadata in SQLite |

Repo layout:

```
apps/web/          studio (features: upload, audio, transcript, review, frame, export, publish)
apps/server/       routes, services, jobs (scheduler + leases), providers, media
packages/core/     domain model, ops, cue compiler, timemap — pure TS, tested
workers/           titler_worker (adapters: enhance, asr, align, vad), Dockerfile.gpu
eval/              benchmark harness (moved from bench/), refs, scorers
docs/              spec-workflow.md, PLAN-v2.md, review-codex.md, operations.md
```

## Pipeline defaults (from benchmarks)

| Stage | Default | Alternatives / notes |
|---|---|---|
| Ingest | sha256 source, ffprobe, 48k WAV master, 16k mono, proxy MP4 (VAAPI), waveform peaks, Silero VAD regions | source never modified |
| Audio variants | **MossFormer2_SE_48K** speech; background = original − speech (exact residual). Gentle = speech + bg −12 dB, Voice = bg −20 dB, Strong = speech only. De-hum toggle (HP + 50/100/150 notch) | DeepFilterNet3 (CPU, `-a` strength) when GPU busy; measured latency compensation per model, stored with the artifact |
| Compare | loudness-matched (−16 LUFS) excerpts: calm / noisiest / other voices, same interval, A/B keeps position | full-length variants computed after the user picks |
| ASR #1 | **faster-whisper large-v3-turbo**, lang auto, **no VAD concatenation**, `hallucination_silence_threshold`, word timestamps (GPU CT2) | runs on original or gentle — never on strong |
| ASR #2 | **GigaAM-v3 e2e-rnnt** (whole clip, ~50× RT on GPU) | **parakeet-tdt-v3** on spans with Latin / transliteration; Qwen3-ASR optional |
| Cloud | ElevenLabs **Scribe v2** if `ELEVENLABS_API_KEY`; Gemini 3.5 Transcribe / Soniox / OpenAI `gpt-transcribe` if keys | adapters exist in `bench/cloud/`, enabled by env key, run only on request or policy |
| Disputes | time-aligned hypothesis diff → spans (different word counts allowed) with reasons: models differ / speech without text / weak boundary / dictionary term | confidences never compared across providers |
| LLM review | **Claude** (`ANTHROPIC_API_KEY`) over disputed spans: proposals with `basis: acoustic | context | dictionary`, punctuation/paragraph layer | never auto-applied; locked words untouchable; never translates |
| Alignment | **w2v2-xlsr-53-russian int8** boundaries + **GigaAM-CTC LLR verifier**; emissions cached per clip → 3–5 ms per edit | MMS for Latin words only if non-commercial (CC-BY-NC); digits verbalised first |
| Render | shared cue plan → ASS → VAAPI h264 CQP 21; captioned MP4, clean MP4, SRT, VTT; validation (duration, A/V sync, text bounds) | libx264 fallback |

Worker scheduling: one GPU job at a time; interactive work (comparison clips, local
alignment) jumps the queue; ASR output sanity-checked and retried once (the Ollama
co-run anomaly in REPORT-gpu §6).

## Data model (summary — full table in review-codex.md)

- `Project` → current `revision` pointers to: transcript doc, audio mix, framing, subtitle style, time map.
- `Artifact {key = sha256(stage, parent keys, params, producer+model version), path, meta}`.
- `AsrHypothesis` immutable per (audio artifact, provider, model, params).
- `Transcript` doc: paragraphs → words `{id, text, start?, end?, timing: unconfirmed|preliminary|aligned|manual, review: unreviewed|needs_review|confirmed, source: {kind: asr|user|llm, ref}, lang?, hidden?}`.
- `EditOp {opId, baseRev, kind, payload, inverse}` — every change; undo/redo; server dedupes `opId`, rejects stale `baseRev` only on conflicting ranges.
- `ReviewIssue {range, reason, candidates[{words[], source, audioVariant}], status}`.
- `TimeMap` (identity until cuts exist), `Framing {ratio, fit, keyframes[]}`, `SubtitleStyle`.
- `Job {id, kind, inputs, resourceClass, status, lease, attempts, progress, result}`; events table with cursor for SSE replay.

## Adjustments after Grok's review (2026-10-24)

- **Smaller core.** Confirmed state = SQLite transcript revisions (snapshot per edit, undo =
  revision stack) + immutable hypotheses. No inverse ops, no range-conflict merging, no leases:
  jobs are SQLite rows, single scheduler, restart = re-queue `running` rows; UI polls.
- **Editor engine: ProseMirror** (not a custom word-chip contenteditable). Paragraph text nodes,
  word id + timing as marks, composition handled by PM (`compositionend`), browse mode = tap to
  seek, edit mode = second tap / "Править". Player shortcuts only outside PM focus.
- **ASR always on the original** (turbo on `mf2-bg-12` shifted CER 0.31 via language flip).
- **A/B the same day with DFN3** (CPU, RTF ~0.1) — MossFormer2 stems become default only after the
  owner has listened (`bench/runs/enhance/listen/`) and the stem leak is confirmed low.
- **GigaAM only with the Latin-span → parakeet rule** in place (P5).
- **Numbers:** keep digits as typed in the transcript; verbalise only inside the aligner, and
  treat number words as `unconfirmed` when case is ambiguous.
- **Gold refs before locking defaults:** owner corrects `refs/*.draft.txt`; add clips with
  Ukrainian, brand terms, wind. Silver WER (turbo 5.6%) is self-referential — don't quote it.
- **Long clips:** process in 30 s chunks with overlap so a ready chunk is playable/editable
  before the whole clip finishes (contract defined in P3).

## Two runtimes: n5 and the laptop (owner request, 2026-10-24)

The owner always carries **m3max** (MacBook Pro, M3 Max), so Titler must run fully there as
well as on n5. Everything host-specific stays behind config:

| Concern | n5 (Linux, Radeon 890M) | m3max (macOS, Apple Silicon) |
|---|---|---|
| Video encode | VAAPI `h264_vaapi` via `ffmpeg-hw` | `h264_videotoolbox` |
| Whisper | faster-whisper (CT2 CPU / ROCm container) | faster-whisper on CPU (beam 5); mlx-whisper opt-in — greedy-only, loses code-switched English (docs/mac.md) |
| GigaAM / aligner / MossFormer2 | torch CPU / ROCm | aligner + GigaAM on CPU (w2v fp32), MossFormer2 on MPS (measured, docs/mac.md) |
| Workers | `bench/envs/*` venvs, later ROCm container | same `bench/envs/*` venvs (deploy/mac/setup.sh); caches in `~/.cache/titler` |
| Access | tailnet `https://n5.<tailnet>.ts.net:8772` | `localhost` (+ LAN/tailnet for the phone) |

Encoder choice is a capability probe (`hw` = vaapi | videotoolbox | none), ASR backend per
role from env, and the data dir is configurable. Projects are portable by content hash, so
a later "sync project n5 ↔ laptop" is possible but not planned.

## Phases

**P0 — foundation (now).** Tag `legacy-v1`, clear main. pnpm workspace, `packages/core` with
types + cue compiler + tests. SQLite schema. Persistent job table + scheduler (polling UI).
`titler_worker` skeleton (CPU venv) with `ping`, `probe`, `vad`. Move `bench/` → `eval/`.

First working cycle (P1–P4) is deliberately narrow: upload/proxy/play; original + DFN3
gentle/strong A/B; turbo on original; ProseMirror edit + insert with local alignment;
9:16 centre crop with manual offset; one caption style; VAAPI (x264 veryfast fallback) export + SRT.
Everything else waits for P5+.

**P1 — upload → playable.** Resumable upload (works from phone), sha256 dedupe, ingest
(proxy, WAV masters, waveform, VAD), project list, mobile shell (Audio → Text → Frame → Export tabs).

**P2 — audio choice.** MossFormer2 stems + DFN3 fallback, comparison excerpts, A/B/C player
(position-preserving, loop, back-to-original), "use for whole clip", loudness matching.

**P3 — transcript loop.** ASR #1 seeds an empty transcript atomically; editor: phrases/paragraphs,
tap = select+seek (no autoplay), Edit, insert before/after, range select, replace, delete,
hide-from-subtitles, undo/redo, composition-safe keyboard, follow-playback toggle.
Local alignment worker; inserted words get aligned/unconfirmed honestly.

**P4 — frame + export.** 9:16 / 16:9 / original, fill vs fit (blur/solid), manual keyframed crop,
platform safe-zone overlay, caption styles (Bold karaoke, Clean pill, Focus) from the cue compiler,
VAAPI render, SRT/VTT, output validation. → **first working cycle done.**

**P5 — hypotheses + review.** GigaAM/parakeet second pass, cloud adapters, dispute spans,
dictionary (Awerti, Esports Charts, Streams Charts, places), Claude review proposals,
review mode that jumps between disputes.

**P6 — advanced.** Waveform zoom + timing handles, regional audio presets with crossfades,
target-speaker mode (enrolment clip), cut-from-video with time map.

**P7 — publishing.** Telegram Bot API (channel/group) first; Meta (IG Reels/Stories, FB Page)
behind verified account capabilities; manual-completion path; per-destination idempotent jobs.

## Eval

`eval/refs/<clip>.txt` (owner-corrected) + `score.py` give real WER; the three current clips have
no Ukrainian, no brand terms, little wind — add clips that do. Track: WER overall / names /
language switches, boundary error, minutes of manual work per minute of video.

## Open questions

1. Commercial or personal? Decides MMS (CC-BY-NC) for English alignment.
2. GigaAM is Sber/Salute — fine to use locally? (Recommended second hypothesis.)
3. Where it runs for the phone: tailnet-only `https://n5.<tailnet>.ts.net:<port>` (assumed).
