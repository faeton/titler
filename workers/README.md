# titler_worker — Python model workers

Long-lived processes, one per **role**, speaking the JSON-lines protocol in
`docs/worker-protocol.md` (that file is the contract). Models load lazily on the first
request that needs them and stay resident; `ping` lists what is loaded.

```
cd <repo> && PYTHONPATH=workers <venv>/bin/python -m titler_worker --role <role> [--preload]
```

| role | venv (n5, CPU) | ops | models |
|---|---|---|---|
| `analyze` | `bench/envs/align-main` | `analyze` | Silero VAD (silero-vad 6.x, bundled weights) |
| `asr` | `bench/envs/asr-fw` | `asr` | faster-whisper `large-v3-turbo` int8; onnx-asr `gigaam-v3-e2e-rnnt` / `nemo-parakeet-tdt-0.6b-v3` |
| `align` | `bench/envs/align-main` | `align_precompute`, `align_window`, `align_forget` | wav2vec2-xlsr-53-russian int8 (boundaries) + GigaAM-v3 CTC (verifier) |
| `enhance` | `bench/envs/enh-cv` | `enhance` | DeepFilterNet3 (`deep-filter` 0.5.6 binary), MossFormer2_SE_48K (ClearVoice) |

`--preload` loads the role's default models before `ready` (otherwise the first request
pays the load: turbo ~1.3 s, align ~3 s, MF2 ~5 s warm-cache).

stdout is protocol-only: at start the worker re-points fd 1 to stderr, so library prints
(ClearVoice, tqdm, …) go to the log. stderr is free-form, timestamped.

## Smoke test

```
bench/envs/align-main/bin/python workers/smoke.py              # all roles, video-34442
bench/envs/align-main/bin/python workers/smoke.py --roles asr,align --clip video-34585
```

Spawns each role with its protocol default command (or `TITLER_WORKER_<ROLE>`), runs one
real request, checks results, prints timings. Stdlib-only, but under a venv with
numpy+soundfile (align-main) it also checks `speech + background == input` and the DFN3
residual lag (GCC-PHAT). Output + per-role stderr logs: `$TITLER_SMOKE_OUT`
(default `/mnt/flash/scratch/titler/smoke/<clip>/`).

## Environment

| var | default | |
|---|---|---|
| `TITLER_THREADS` | 8 | torch / CT2 / onnxruntime / rayon threads |
| `HF_HOME`, `TORCH_HOME`, `UV_CACHE_DIR` | `/mnt/flash/scratch/{hf-cache,torch-hub,uv-cache}` | set with `setdefault` |
| `TITLER_FW_MODEL` | `large-v3-turbo` | faster-whisper model (request `model` overrides) |
| `TITLER_FW_COMPUTE` / `TITLER_FW_BEAM` | `int8` / 5 | |
| `TITLER_FW_HALLU_SILENCE` | 2.0 | `hallucination_silence_threshold` (s) |
| `TITLER_FW_CONDITION_PREV` | 1 | `condition_on_previous_text` (see deviations); request key `condition_on_previous_text` overrides |
| `TITLER_FW_VAD_GUARD` | 1 | drop whisper segments with <10 % Silero speech overlap (VAD never cuts the audio) |
| `TITLER_ONNX_ASR_DIR` | `/mnt/flash/scratch/hf-cache/onnx-asr` | onnx-asr model dirs (real files, not HF symlinks) |
| `TITLER_ALIGN_BACKEND` / `TITLER_ALIGN_VERIFIER` | `w2v_ru_q8` / `gigaam` | |
| `TITLER_ALIGN_CHUNK_S` | 30 | precompute chunk length (bounded RSS; ±1 s context) |
| `TITLER_DFN_BIN` | `bench/envs/enh-dfn-bin/deep-filter-0.5.6-x86_64-unknown-linux-musl` | |
| `TITLER_CLEARVOICE_DIR` | `/mnt/flash/scratch/clearvoice` | ClearVoice resolves `checkpoints/` relative to cwd |
| `TITLER_DEHUM_HP` | 60 | de-hum highpass Hz (+ 50/100/150 Hz notches, ffmpeg) |
| `TITLER_FFMPEG` | `~/.local/bin/ffmpeg` | |

## Behaviour notes

- **asr / faster-whisper**: language auto, `vad_filter=False`, `word_timestamps=True`,
  `hallucination_silence_threshold=2`, beam 5. Word text = whisper word with the leading
  space stripped (punctuation attached); hyphen continuations ("как" + "-то") are merged.
  Hallucination guards: segments at >15 syllables/s or with <10 % VAD-speech overlap are
  removed and listed in `result.dropped`. Degenerate check (compression ratio > 2.4 or a
  token repeated > 8×) → one retry with `condition_on_previous_text=False`,
  `retried: true`; if still degenerate, `degenerate: "<reason>"` is set.
- **asr / gigaam, parakeet**: onnx-asr with Silero VAD segments (≤20 s); word ends are
  approximate (next start, capped +0.4 s). GigaAM words carry `lang: "ru"`. onnx-asr
  0.12 was installed into `asr-fw` so one process serves all providers; in a venv without
  it the request fails with a clear non-retryable error.
- **align**: engine vendored from `bench/align/local_align.py` (`align_engine.py`, seconds
  internally). Emission cache keyed by (path, mtime, model); a window on an uncached file
  computes window emissions (~0.3 s) instead. Result words also carry `text`.
- **enhance**: outputs are 48 kHz **32-bit float** WAV, same sample *and channel* count as
  the input. dfn3 runs `deep-filter -D [-a 12|20]` and pads the 1440 samples `-D` cuts
  from the tail (`latencyMs: 30` = the compensated model delay). mf2: `speech.wav` +
  `background.wav = input − speech` (bit-exact to float precision). `dehum` filters the
  input first, so for mf2 `speech + background` = de-hummed input. Temporary files live in
  `out_dir/.enh-*` and are removed. Missing `strength` → `voice`.
