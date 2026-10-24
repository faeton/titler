# Worker protocol (apps/server ↔ workers/titler_worker)

Python model workers are long-lived processes started by the server. One process per
**role**; each role can live in a different Python environment (CPU venv now, the ROCm
GPU container later — same protocol). A worker handles **one request at a time**; the
server serialises requests per worker.

## Launch

The server reads the command per role from env (JSON array), with defaults for n5:

| Role | Env var | Default (n5, CPU) |
|---|---|---|
| `analyze` | `TITLER_WORKER_ANALYZE` | align venv: `bench/envs/align-main/bin/python -m titler_worker --role analyze` |
| `asr` | `TITLER_WORKER_ASR` | `bench/envs/asr-fw/bin/python -m titler_worker --role asr` |
| `align` | `TITLER_WORKER_ALIGN` | `bench/envs/align-main/bin/python -m titler_worker --role align` |
| `enhance` | `TITLER_WORKER_ENHANCE` | `bench/envs/enh-cv/bin/python -m titler_worker --role enhance` |

`PYTHONPATH=<repo>/workers`, cwd = repo root. Workers must not write outside the paths
given in a request (plus model caches under `/mnt/flash/scratch`).

## Wire format

Newline-delimited JSON on stdin/stdout. stderr is free-form logging.

```
→ {"id": 7, "op": "asr", ...params}
← {"id": 7, "progress": 0.4, "message": "decoding"}        (0..n times, optional)
← {"id": 7, "ok": true, "result": {...}}                     (exactly once)
← {"id": 7, "ok": false, "error": "text", "retryable": false} (instead of ok)
```

On start the worker prints `{"ready": true, "role": "...", "pid": n}`. Every role answers
`{"op": "ping"}` → `{"ok": true, "result": {"role", "models": [...loaded]}}`.

All times are **integer milliseconds**. All audio paths are absolute.

## Ops

### role `analyze`
- `analyze {wav16, peaks_out, vad_out}` → writes
  - `peaks_out`: `{"rate": 100, "peaks": [[min,max], ...]}` (int8-scaled −127..127, 100 per second)
  - `vad_out`: `{"regions": [{"startMs","endMs"}], "model": "silero-vad"}`
  - result: `{"speechMs": n, "regions": n}`

### role `asr`
- `asr {wav16, provider, model?, language?}` → `{"lang": "ru"|null, "words": [{"text","start","end","conf"?, "lang"?}], "model": "...", "provider": "...", "timing": {"load_ms","infer_ms"}}`
  - `provider: "faster-whisper"` default model `large-v3-turbo`, language auto, **no VAD
    concatenation** (`vad_filter=False`, `hallucination_silence_threshold≈2`,
    `condition_on_previous_text=True` — False translated the English speaker in 34238 and
    added «Продолжение следует...»; the degenerate-output retry flips it to False),
    `word_timestamps=True`. Text keeps punctuation attached to words. Extra result keys:
    `langProb`, `dropped` (segments removed by speech-rate / VAD-overlap guards), `degenerate`.
  - `provider: "gigaam"` / `"parakeet"` (onnx-asr) optional; `asr-onnx` venv.
  - Sanity check: if the output looks degenerate (compression ratio > 2.4, or the same token
    repeated > 8×) retry once and set `"retried": true`.

### role `align`
- `align_precompute {wav16}` → caches emissions for the file (keyed by path+mtime) → `{"ms": n}`
- `align_window {wav16, t0, t1, words: [string], anchors: {"<i>": [start, end]}}` →
  `{"words": [{"start","end","status": "aligned"|"unconfirmed"|"anchor","reason"?,"llr"?}], "ms": n}`
  - Backend `w2v_ru_q8` boundaries + `gigaam` verifier (see `bench/REPORT-align.md`); digits
    are verbalised internally only.
- `align_forget {wav16}`

### role `enhance`
- `enhance {wav48, out_dir, engine: "dfn3"|"mf2", strength?: "gentle"|"voice"|"strong", dehum?: bool}`
  - Output files in `out_dir` (48 kHz, **same sample count as input**, latency compensated):
    - `dfn3`: `out.wav` — strength maps to attenuation limit (gentle 12 dB, voice 20 dB, strong ∞).
    - `mf2`: `speech.wav` + `background.wav` (= input − speech, exact residual). Presets are
      mixed by the server with ffmpeg (`gentle` = speech + bg −12 dB, `voice` −20 dB, `strong`
      = speech only).
  - result: `{"files": {...}, "latencyMs": n, "samples": n, "engine", "model"}`
