# Titler v2 on the MacBook (m3max) — handoff

Titler must run fully on the laptop as well as on n5 (owner request 2026-10-24; see
"Two runtimes" in [PLAN-v2.md](PLAN-v2.md)). v2 was built and tested on n5 only. Nothing
below has been run on macOS yet.

## Status when handed off (2026-10-24)

- Works end to end on n5: resumable upload → ingest (VAAPI proxy) → Silero VAD/peaks →
  faster-whisper turbo transcript → ProseMirror editing with local re-alignment → DFN3/MF2
  comparison → VAAPI render (captioned/clean MP4, SRT/VTT). Tests: core 14, server 33, web 11.
- Host-specific bits that need a Mac path:
  1. **Encoder**: `apps/server/src/config.ts` + `media/commands.ts` know `vaapi` or software
     (`libx264`). Add `videotoolbox` (`h264_videotoolbox`, `-b:v`/`-q:v`; CPU crop/scale/libass,
     no hwupload) as a probed capability.
  2. **ASR**: `workers/titler_worker/asr.py` uses faster-whisper (CT2, CPU-only on macOS).
     Add provider `mlx-whisper` (`mlx-community/whisper-large-v3-turbo`, word timestamps,
     same output schema, same hallucination/degenerate guards) and make it the default
     when running on Apple Silicon. v1 used mlx-whisper (see `git show legacy-v1:scripts/transcribe.py`).
  3. **torch device**: aligner (`align_engine.py`), GigaAM, ClearVoice run on CPU. Try MPS;
     keep CPU where MPS is slower or numerically off (CTC log-probs must match CPU within
     tolerance — compare LLR decisions on the same windows).
  4. **Paths**: worker defaults mention `/mnt/flash/scratch/...` (HF/torch caches, DFN
     binary, ClearVoice dir, smoke output). Every one has an env override (`workers/README.md`);
     make the defaults platform-aware (`~/.cache/titler` on macOS).
  5. **deploy**: `deploy/n5/start.sh` is n5-only. On the Mac: `pnpm dev`, or a launchd plist
     later. The phone reaches the laptop over Tailscale (`tailscale serve` on the Mac) or LAN.

## Setup

```bash
git clone https://github.com/faeton/titler.git && cd titler   # or git pull
./deploy/mac/setup.sh        # brew ffmpeg w/ libass, uv venvs in bench/envs/*, pnpm install
```

The benchmark clips are gitignored. Copy them from n5 if you want the same test data:
`rsync -a n5:/mnt/flash/home/faeton/work/titler/bench/samples/ bench/samples/`.

## Prompt for Claude Code on the Mac

Paste this into Claude Code in the repo on the MacBook:

---

Titler v2 was rebuilt on n5 (Linux, AMD iGPU) and now has to run fully on this MacBook (M3 Max)
too. Both runtimes stay supported: keep every n5 path working and put host differences behind
capability probes and env config, not forks.

Read first: `docs/mac.md` (this handoff, the 5 host-specific items), `docs/PLAN-v2.md`
(architecture; "Two runtimes" section), `docs/worker-protocol.md`, `workers/README.md`,
`bench/REPORT-asr.md` and `bench/REPORT-align.md` (why these models and settings).

Do:
1. Run `./deploy/mac/setup.sh`; fix it until it completes (it was written blind on Linux).
   Copy `bench/samples/` from n5 via rsync if missing.
2. Add the `videotoolbox` encoder path in the server (probe at startup, `/api/health` reports
   it) with libx264 fallback. Update the command tests.
3. Add an `mlx-whisper` ASR provider in the worker (large-v3-turbo, language auto, word
   timestamps, no VAD concatenation, `condition_on_previous_text=True`, same guards and output
   schema). Default to it on Apple Silicon. Compare its transcript with the n5 faster-whisper
   output in `bench/runs/asr/fw-turbo-auto-novad/` on all three clips, and especially check
   that the English tail of video-34238 (18–32 s) is kept as English.
4. Try MPS for the aligner, GigaAM and MossFormer2. Keep whichever device is faster *and*
   gives the same results: for the aligner, the same aligned/unconfirmed decisions on
   `workers/smoke.py` windows, including a fake inserted word.
5. Make worker path defaults platform-aware (no `/mnt/flash/...` on macOS).
6. Run `pnpm test`, `workers/smoke.py` and `apps/server/scripts/e2e.ts` on the Mac. Then open
   the studio and do one full cycle (upload → compare → edit a word → insert a word → export)
   from the laptop browser and from the phone over Tailscale.
7. Write timings (ASR, align precompute, MF2, render) into a `docs/mac.md` "Measured" section
   next to the n5 numbers.

Constraints: don't break n5 (its tests and defaults must keep passing), small focused commits,
and don't add cloud calls. Cloud providers stay key-gated, and the keys aren't set yet.

---

## Measured on the Mac

_(fill in)_
