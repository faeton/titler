# Titler v2 on the MacBook (m3max) — handoff

Titler must run fully on the laptop as well as on n5 (owner request 2026-10-24; see
"Two runtimes" in [PLAN-v2.md](PLAN-v2.md)). v2 was built on n5; the Mac port is done
(see "Done on the Mac" below).

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

## Done on the Mac (2026-10-24)

1. **setup.sh** works (idempotent). Homebrew core `ffmpeg` has no libass → one ffmpeg on the
   box: `ffmpeg-full`, linked (`brew link --force ffmpeg-full`). `grep -q` under `pipefail`
   SIGPIPE'd the capability checks — fixed.
2. **Encoder**: `vaapi | videotoolbox | software`, probed at startup (one-frame
   `h264_videotoolbox -allow_sw 0` encode), `/api/health` → `encoder`. VT path = CPU decode +
   CPU filters + `h264_videotoolbox`. No VT *decode*: HEVC VT decode + frame download is 3.5×
   slower than CPU decode on M3 Max. `-q:v 65` ≈ libx264 crf 18 (VMAF 99.43 vs 99.45).
3. **ASR**: `mlx-whisper` provider added (shared guards/schema) but **opt-in, not the Mac
   default**: mlx-whisper has no beam search, and greedy turbo translates the English tail of
   video-34238 into Russian and appends «Спасибо.» to 34442 (faster-whisper `beam_size=1` does
   the same — it is the decoding, not MLX). faster-whisper beam 5 on the M3 Max CPU matches n5
   (same English tail) and is faster than n5. Revisit if mlx-whisper gets beam search
   (or try whisper.cpp + Metal, which has it).
4. **torch devices**: aligner on Apple Silicon = `w2v_ru` fp32 on **CPU** (2× faster than
   int8/qnnpack, bit-identical to n5 fp32; identical aligned/unconfirmed decisions to n5 q8 on
   707 windows incl. 101 fake words — int8 itself differs between fbgemm and qnnpack). MPS:
   GigaAM slower, w2v conv1d unsupported. MossFormer2: **MPS** (ClearVoice's own choice), 2×
   faster, mps-vs-cpu difference at the same level as Mac-cpu vs n5-cpu.
5. **Paths**: `TITLER_SCRATCH` = `/mnt/flash/scratch` if present, else `~/.cache/titler`;
   HF/torch keep library defaults off n5; DFN binary by platform. n5 paths verified unchanged.
6. `pnpm test` (core 14, server 35 — libass test now runs on the Mac too, web 11),
   `workers/smoke.py` (0 failed), `apps/server/scripts/e2e.ts --compare` (22 s total),
   `apps/web/scripts/smoke-server.mjs` + `smoke.mjs` (headless mobile Chromium) all pass.
   Not done: the cycle from the phone over Tailscale (needs the phone; see below).

Phone access to the laptop: `pnpm --filter @titler/web build && pnpm --filter @titler/server start`,
then `tailscale serve --bg --https=8772 http://127.0.0.1:8772` on the Mac.

## Measured on the Mac

M3 Max (12P+4E), `TITLER_THREADS=8`, warm models. n5 = Ryzen AI / 890M numbers from the bench
reports and n5 runs of the same scripts. Clips: 34238 33 s, 34442 30 s, 34585 64 s.

| stage | n5 | Mac |
|---|---|---|
| ASR faster-whisper turbo, beam 5 (238/442/585) | 11.3 / 15.0 / 22.9 s | **8.3 / 8.7 / 14.2 s** (CPU) |
| ASR mlx-whisper turbo, greedy (opt-in) | — | 2.6 / 1.3 / 7.0 s (GPU) |
| align precompute, boundary + verifier | q8: 1.7+0.8 / 1.5+0.7 / 3.4+1.6 s | fp32: 1.2+0.4 / 1.0+0.3 / 2.2+0.7 s |
| align window (cached / uncached) | 2–3 ms / 0.30 s | 1.5–2 ms / 0.23 s |
| MF2 speech+background (442 / 585) | 11.3 s / — | **6.3 / 11.0 s** (MPS); CPU 12.8 / 23.1 s |
| DFN3 (442) | 2.8 s | 2.1–2.7 s |
| final encode 585, crop→1080×1920 | VAAPI 7.1 s, x264 veryfast 14.9 s | **VT 5.0 s**, x264 veryfast 9.4 s |
| proxy 585 (720p) | — | VT 3.1 s, x264 3.3 s (decode-bound) |
| e2e 34442: upload → ASR → edit → align → compare → render | — | 22.2 s (render captioned+clean 5.0 s) |
