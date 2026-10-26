# Speech enhancement / voice cleanup benchmark (Titler, «Выбор голоса» / Voice choice)

Date: 2026-10-24 · host n5 (CPU only, 8 threads, other benchmarks running concurrently, so
absolute RTFs are pessimistic by maybe 1.2–2×; relative order holds) · clips: `samples/audio/video-{34238,34442,34585}`
(33/30/64 s, Ray-Ban Meta, Russian with an English dialogue in 34238; 34442 is the windiest).

Scripts: `bench/enhance/` · outputs: `bench/runs/enhance/` (`raw/` model output as produced,
`aligned/` latency-compensated & length-exact 48k + 16k, `stems/` speech/background pairs,
`results.json`, `results.csv`, `table.md`, `wer_per_clip.md`, `stem_leak.json`) ·
**listening page: `bench/runs/enhance/listen/index.html`** (serve the folder, e.g.
`cd bench/runs/enhance/listen && python3 -m http.server 8790 --bind <n5 tailnet IP>`, or open from SMB).

## What was measured

* **RTF** = wall / audio over the 3 clips (8 threads). **load s** = model construction/load
  (2nd load, weights cached). **peak RSS** = process max RSS (for in-process runners it covers the
  whole process; the ClearVoice 16k models peaked at ~5 GB, MossFormer2 48k at ~1 GB). DFN3 binary start-up ≈0.6 s (timed on a 1 s file).
* **raw lag** = GCC-PHAT cross-correlation of the raw output vs the original (positive = output
  delayed), sample-exact; **raw Δlen** = output samples − input samples. Every variant is then
  shifted by −lag and padded/trimmed to the exact input sample count; **len/sync OK** re-checks
  residual lag = 0 samples and identical length at 48k and 16k.
* **phase** = magnitude-weighted mean cos(phase difference) vs original, 200–4000 Hz. ≈1.0 means
  the output is a (real, positive) mask of the original → mixing it with the original/residual
  cannot comb-filter or "double" the voice.
* **DNSMOS P.835** (speechmos ONNX, input normalised to −23 LUFS, 16 kHz) on the full clip and on the
  **noisiest 10 s** (window with the lowest original BAK: 34238@5 s, 34442@3 s, 34585@35 s).
  Reference-free proxy only; it rewards suppression and is blind to bandwidth (16 kHz models
  are not penalised although they lose everything above 8 kHz).
* **ASR change**: faster-whisper `small` int8, language auto, no VAD → CER of each transcript vs the
  original's transcript (how much the text *changes*, not whether it improves). Second pass with
  **large-v3-turbo** on the main variants, and WER vs `bench/refs/*.draft.txt` (SILVER machine
  majority draft from the ASR agent, `[a|b]` → majority; NOT ground truth, and it was built from
  models run on the *original* audio, so it is biased towards the original).

## Results (means over the 3 clips; per-clip in `results.json`)

| variant | sr | RTF@8t | load s | peak RSS MB | raw lag ms (3 clips) | raw Δlen (samples) | len/sync OK | SIG | BAK | OVRL | OVRL noisy10s | BAK noisy10s | phase | ASR CER vs orig | WER vs silver ref (small) | turbo: CER vs orig | turbo: WER vs silver ref |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| original | 48k | – | – | – | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.23 | 2.64 | 2.40 | 1.80 | 2.00 | 1.00 | – | 0.299 | 0.000 | 0.218 |
| bsroformer-1297-bg-12 | 48k | 13.178 | 1.0 | 2414 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.51 | 3.15 | 2.79 | 2.65 | 3.05 | 0.99 | 0.059 | 0.302 | 0.298 | 0.288 |
| bsroformer-1297-speech | 48k | 13.178 | 1.0 | 2414 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.47 | 3.42 | 2.89 | 2.80 | 3.45 | 0.98 | 0.082 | 0.284 | 0.136 | 0.062 |
| cv-FRCRN_SE_16K | 16k | 1.031 | 0.9 | 5121 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.53 | 4.08 | 3.27 | 3.16 | 4.09 | 0.99 | 0.114 | 0.370 | 0.153 | 0.155 |
| cv-MossFormer2_SE_48K | 48k | 0.712 | 0.8 | 957 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.49 | 4.11 | 3.23 | 3.16 | 4.11 | 0.99 | 0.109 | 0.365 | 0.133 | 0.099 |
| cv-MossFormerGAN_SE_16K | 16k | 7.226 | 0.5 | 5349 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.53 | 4.12 | 3.29 | 3.17 | 4.11 | 0.98 | 0.085 | 0.318 | 0.090 | 0.278 |
| demucs-htdemucs-bg-12 | 48k | 0.494 | 0.9 | 1658 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.44 | 3.07 | 2.70 | 2.57 | 3.04 | 1.00 | 0.029 | 0.294 | 0.124 | 0.099 |
| demucs-htdemucs-bg-20 | 48k | 0.494 | 0.9 | 1658 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.42 | 3.23 | 2.77 | 2.66 | 3.20 | 1.00 | 0.045 | 0.300 | – | – |
| demucs-htdemucs-bg-6 | 48k | 0.494 | 0.9 | 1658 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.44 | 2.93 | 2.62 | 2.44 | 2.80 | 1.00 | 0.025 | 0.287 | – | – |
| demucs-htdemucs-vocals | 48k | 0.494 | 0.9 | 1658 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.40 | 3.44 | 2.84 | 2.69 | 3.48 | 1.00 | 0.058 | 0.292 | 0.129 | 0.090 |
| demucs-htdemucs_ft-bg-12 | 48k | 0.380 | 1.5 | 1638 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.45 | 3.09 | 2.72 | 2.61 | 3.07 | 1.00 | 0.258 | 0.302 | – | – |
| demucs-htdemucs_ft-bg-20 | 48k | 0.380 | 1.5 | 1638 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.45 | 3.24 | 2.79 | 2.68 | 3.22 | 1.00 | 0.037 | 0.294 | – | – |
| demucs-htdemucs_ft-bg-6 | 48k | 0.380 | 1.5 | 1638 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.46 | 2.96 | 2.64 | 2.50 | 2.85 | 1.00 | 0.032 | 0.321 | – | – |
| demucs-htdemucs_ft-vocals | 48k | 0.380 | 1.5 | 1638 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.38 | 3.46 | 2.84 | 2.67 | 3.46 | 1.00 | 0.094 | 0.303 | 0.147 | 0.091 |
| dfn3-a12 | 48k | 0.105 | – | 109 | +0.0/+0.0/+0.0 | -1440/-1440/-1440 | yes | 3.48 | 3.41 | 2.90 | 2.82 | 3.40 | 1.00 | 0.042 | 0.301 | 0.299 | 0.296 |
| dfn3-a20 | 48k | 0.094 | – | 111 | +0.0/+0.0/+0.0 | -1440/-1440/-1440 | yes | 3.43 | 3.71 | 3.01 | 2.95 | 3.73 | 0.99 | 0.051 | 0.292 | 0.291 | 0.273 |
| dfn3-a6 | 48k | 0.097 | – | 109 | +0.0/+0.0/+0.0 | -1440/-1440/-1440 | yes | 3.49 | 3.06 | 2.72 | 2.56 | 2.95 | 1.00 | 0.056 | 0.316 | 0.033 | 0.236 |
| dfn3-full | 48k | 0.095 | – | 108 | +0.0/+0.0/+0.0 | -1440/-1440/-1440 | yes | 3.40 | 4.09 | 3.15 | 3.09 | 4.12 | 0.99 | 0.110 | 0.368 | 0.160 | 0.211 |
| dfn3-full-pf | 48k | 0.098 | – | 109 | +0.0/+0.0/+0.0 | -1440/-1440/-1440 | yes | 3.38 | 4.13 | 3.15 | 3.03 | 4.12 | 0.99 | 0.147 | 0.407 | 0.138 | 0.079 |
| dfn3-nocomp | 48k | 0.103 | – | 109 | +30.0/+30.0/+30.0 | 0/0/0 | yes | 3.40 | 4.09 | 3.15 | 3.09 | 4.12 | 0.99 | 0.110 | 0.368 | – | – |
| dsp-afftdn20 | 48k | 0.007 | – | 23 | +25.0/+25.0/+25.0 | 0/0/0 | yes | 3.26 | 2.70 | 2.44 | 2.08 | 2.28 | 0.95 | 0.065 | 0.321 | – | – |
| dsp-arnndn-sh | 48k | 0.012 | – | 24 | +10.0/+10.0/+10.0 | 68/3/160 | yes | 3.22 | 3.39 | 2.70 | 2.60 | 3.40 | 0.88 | 0.119 | 0.281 | 0.356 | 0.282 |
| dsp-hp-dehum | 48k | 0.002 | – | 20 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.27 | 2.70 | 2.44 | 2.09 | 2.29 | 0.95 | 0.065 | 0.327 | 0.293 | 0.256 |
| melroformer-kim-bg-12 | 48k | 2.804 | 2.0 | 2975 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.51 | 3.34 | 2.89 | 2.72 | 3.19 | 0.99 | 0.305 | 0.347 | 0.338 | 0.319 |
| melroformer-kim-speech | 48k | 2.804 | 2.0 | 2975 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.49 | 3.97 | 3.18 | 3.05 | 3.93 | 0.98 | 0.107 | 0.242 | 0.143 | 0.092 |
| mf2-bg-12 | 48k | 0.712 | 0.8 | 957 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.48 | 3.43 | 2.92 | 2.77 | 3.30 | 1.00 | 0.024 | 0.291 | 0.307 | 0.321 |
| mf2-bg-20 | 48k | 0.712 | 0.8 | 957 | +0.0/+0.0/+0.0 | 0/0/0 | yes | 3.43 | 3.74 | 3.02 | 2.91 | 3.65 | 0.99 | 0.031 | 0.275 | 0.064 | 0.233 |

Per-clip WER vs silver draft (turbo; 34442's reference is only ~25 words → 1 word ≈ 0.04):

| variant | turbo WER 34238 (lang) | turbo WER 34442 | turbo WER 34585 | small WER 34238/34442/34585 |
|---|---|---|---|---|
| original | 0.54 (ru) | 0.08 | 0.04 | 0.46/0.24/0.19 |
| cv-FRCRN_SE_16K | 0.12 (ru) | 0.28 | 0.06 | 0.54/0.36/0.21 |
| cv-MossFormer2_SE_48K | 0.07 (ru) | 0.16 | 0.07 | 0.46/0.40/0.23 |
| cv-MossFormerGAN_SE_16K | 0.57 (ru) | 0.16 | 0.10 | 0.48/0.28/0.19 |
| demucs-htdemucs-bg-12 | 0.12 (ru) | 0.12 | 0.05 | 0.48/0.20/0.20 |
| demucs-htdemucs-vocals | 0.05 (ru) | 0.12 | 0.10 | 0.48/0.20/0.19 |
| demucs-htdemucs_ft-vocals | 0.04 (ru) | 0.12 | 0.12 | 0.52/0.20/0.19 |
| dfn3-a12 | 0.66 (en) | 0.16 | 0.07 | 0.50/0.24/0.16 |
| dfn3-a20 | 0.62 (en) | 0.12 | 0.07 | 0.48/0.20/0.19 |
| dfn3-a6 | 0.48 (ru) | 0.16 | 0.07 | 0.48/0.28/0.19 |
| dfn3-full | 0.45 (ru) | 0.12 | 0.07 | 0.52/0.40/0.19 |
| dfn3-full-pf | 0.04 (ru) | 0.12 | 0.08 | 0.52/0.40/0.30 |
| dsp-hp-dehum | 0.57 (en) | 0.16 | 0.04 | 0.48/0.32/0.18 |
| bsroformer-1297-bg-12 | 0.68 (en) | 0.12 | 0.07 | 0.48/0.24/0.19 |
| bsroformer-1297-speech | 0.02 (ru) | 0.08 | 0.09 | 0.48/0.20/0.17 |
| dsp-arnndn-sh | 0.59 (en) | 0.16 | 0.10 | 0.48/0.16/0.20 |
| melroformer-kim-bg-12 | 0.64 (en) | 0.16 | 0.16 | 0.54/0.32/0.19 |
| melroformer-kim-speech | 0.04 (ru) | 0.16 | 0.08 | 0.50/0.04/0.19 |
| mf2-bg-12 | 0.75 (en) | 0.16 | 0.05 | 0.46/0.20/0.21 |
| mf2-bg-20 | 0.55 (ru) | 0.08 | 0.07 | 0.46/0.16/0.20 |

Per-clip DNSMOS OVRL, full clip / noisiest 10 s:

| variant | 34238 | 34442 (wind) | 34585 |
|---|---|---|---|
| original | 2.61 / 2.44 | 1.84 / 1.14 | 2.76 / 1.80 |
| dsp-hp-dehum | 2.65 / 2.51 | 1.89 / 1.20 | 2.79 / 2.56 |
| dsp-arnndn-sh | 2.71 / 2.62 | 2.59 / 2.56 | 2.79 / 2.61 |
| dfn3-a6 | 2.77 / 2.58 | 2.47 / 2.44 | 2.92 / 2.67 |
| dfn3-a12 | 2.89 / 2.73 | 2.83 / 2.91 | 2.97 / 2.83 |
| dfn3-a20 | 2.89 / 2.82 | 3.07 / 3.14 | 3.06 / 2.89 |
| dfn3-full | 3.13 / 3.02 | 3.13 / 3.18 | 3.17 / 3.07 |
| mf2-bg-12 (MossFormer2 speech + bg −12 dB) | 2.97 / 2.75 | 2.82 / 2.83 | 2.96 / 2.72 |
| mf2-bg-20 | 2.95 / 2.86 | 3.03 / 3.02 | 3.09 / 2.85 |
| cv-MossFormer2_SE_48K | 3.35 / 3.28 | 3.18 / 3.16 | 3.17 / 3.03 |
| cv-FRCRN_SE_16K | 3.31 / 3.13 | 3.34 / 3.36 | 3.15 / 3.00 |
| cv-MossFormerGAN_SE_16K | 3.31 / 3.14 | 3.31 / 3.27 | 3.23 / 3.09 |
| demucs-htdemucs-vocals | 2.99 / 2.98 | 2.62 / 2.54 | 2.90 / 2.55 |
| melroformer-kim-speech | 3.35 / 3.15 | 2.96 / 2.92 | 3.22 / 3.09 |
| bsroformer-1297-speech | 2.92 / 2.90 | 2.71 / 2.60 | 3.05 / 2.90 |

### Latency / length findings (what the compensation must do)

| processor | raw delay | raw length | compensation |
|---|---|---|---|
| DeepFilterNet3 (`deep-filter`, no `-D`) | **+30.0 ms = 1440 samples @48k** (STFT 20 ms + 2-frame lookahead), all clips | identical | drop first 1440 samples, pad 1440 at end |
| DeepFilterNet3 with `-D` (`--compensate-delay`) | 0 | **1440 samples short** (tail cut) | pad 1440 samples of zeros (or feed 30 ms extra input tail) |
| ffmpeg `afftdn` | **+25.0 ms = 1200 samples** | identical (tail lost) | shift −1200, pad end; better: append 25 ms silence before filtering |
| ffmpeg `arnndn` | **+10.0 ms = 480 samples** | +68 / +3 / +160 samples (frame padding) | shift −480, trim to input length |
| ffmpeg highpass + 50/100/150 Hz notches | 0 | identical | none (IIR phase shift only, phase 0.95) |
| ClearVoice FRCRN / MossFormerGAN (16k) / MossFormer2 (48k) | 0 | identical (lib trims) | none at sample level; 16k ones need resampling back to 48k (linear-phase `resample_poly`, 0 lag) |
| Demucs htdemucs / htdemucs_ft, Mel-/BS-Roformer (audio-separator) | 0 | identical after our 48k→44.1k→48k round trip | none (resampler must be zero-phase) |

Rule for the product: **always measure the lag once per processor/version with GCC-PHAT on a
calibration clip and store it as metadata**, then shift+pad to the exact source sample count; never
trust "compensate" flags blindly (DFN `-D` silently shortens the file).

### Stem viability (speech + k·background)

`background = original − speech` (exact complement) makes `speech + 1·background` bit-identical to the
original, and `speech + k·background = k·original + (1−k)·speech`. That is phase-safe only if the
speech estimate is sample-aligned and a positive mask of the original — measured `phase` is
0.98–1.00 for every NN model after compensation, so **no doubling/comb artefacts** (contrast
`arnndn`: phase 0.88, it re-synthesises its own frame grid).

Native stems: Demucs model stems do **not** sum to the mix (htdemucs −23…−32 dB error, the
htdemucs_ft vocals-only sub-model even −6…−11 dB) → always use the residual, never the model's
"other" stems. audio-separator Roformers output complementary stems (−58…−67 dB error).

Voice leakage into the background stem (`stem_leak.py`: 300–3400 Hz energy of the background in the
loudest-speech frames minus the quietest, dB; ~0 = clean background, ≫0 = voice remains in it):

| speech estimator | 34238 / 34442 / 34585 |
|---|---|
| cv-MossFormer2_SE_48K | −0.6 / +0.8 / −1.4 |
| melroformer-kim / bsroformer-1297 | −1.7/−4.5/−4.2 · −1.1/−4.0/−4.8 |
| demucs htdemucs / _ft | −3.5/+0.5/−5.7 · −2.7/−6.8/−4.4 |
| cv-FRCRN_SE_16K | −0.2 / **+8.6** / −0.1 |
| cv-MossFormerGAN_SE_16K | +1.7 / +3.3 / +5.2 |
| dfn3-full (no limit) | +2.6 / **+8.1** / +2.1 |
| dsp-arnndn-sh | **+17 / +11 / +19** (unusable as a stem) |

Negative values for the music separators mean they also put some background into the speech
stem during speech (the "speech" sounds less clean, DNSMOS BAK 3.4–3.5 vs 4.1 for MossFormer2).

**Conclusion: stem-based background control is viable**, with MossFormer2_SE_48K as the speech
estimator: zero lag, full-band, phase 0.99, background stem nearly free of voice, RTF 0.7.

## Listening notes (inferred from metrics/transcripts — nobody has listened yet)

* Plain highpass + de-hum: no audible noise change (BAK +0.06); safe, cheap toggle.
* `afftdn` (any `nf` from −40 to −20 dB): ~0 dB change on this material — the wind/traffic is far
  above its noise-floor model. Not a usable baseline.
* `arnndn` (RNNoise `sh` model): suppresses (BAK 3.4) but is unstable in ffmpeg: NaN bursts with packed
  float input (needs `aformat=sample_fmts=fltp`), `mix=0.5` produced NaNs/garbage, and a ~+26 dB spike on
  34585 even in the fixed chain. Expect artefacts; drop it.
* DeepFilterNet3 with attenuation limit behaves exactly like a "gentle → strong" knob: BAK 3.06 (6 dB) →
  3.41 (12) → 3.71 (20) → 4.09 (∞), SIG stays ~3.4–3.5. Post-filter (`--pf`) adds nothing on DNSMOS and
  changes the ASR text most (CER 0.15) → skip it.
* MossFormer2_SE_48K / FRCRN / MossFormerGAN reach the same DNSMOS plateau (OVRL ≈3.2–3.3, BAK ≈4.1);
  the two 16k models are band-limited to 8 kHz (will sound dull next to 48k video), MossFormerGAN is a
  GAN (some generated texture) and 7× slower than real time. MossFormer2 48k is the one to listen to.
* Music separators (Demucs, Roformers) keep more ambience inside the "vocals" stem (BAK 3.4–4.0); Kim
  Mel-Roformer is the cleanest of them (OVRL 3.18) but 2.8× RT on CPU; BS-Roformer-1297 is 13× RT.
* On 34442 (wind, OVRL 1.14 on the worst 10 s) every NN lifts the worst window to ≈2.9–3.4.

## ASR effect

* No preset reliably improves recognition. On the two monolingual clips turbo WER vs the silver draft
  is 0.08/0.04 on the original and 0.08–0.28 / 0.04–0.16 on the enhanced variants (several are within
  1 word on the 25-word 34442 reference). Strong suppression (FRCRN on 34442: 0.28) can hurt.
* On the code-switched 34238 the dominant effect is Whisper's auto language ID/skipping the English
  dialogue (original turbo: 0.54; some variants flip the whole clip to English, others transcribe both
  languages and drop to 0.02–0.07). That is chaotic, not a property of the enhancer.
* Small "CER vs original" (<0.05) for gentle presets (dfn3-a6/a12, demucs/mf2 bg mixes) = text stays
  stable. Matches the spec: run ASR on the original or the gentle track, not on the "nicest" one.

## Licences

| component | code | weights |
|---|---|---|
| DeepFilterNet3 (`deep-filter` 0.5.6 Rust binary, model embedded) | MIT / Apache-2.0 | same (shipped in repo) |
| ClearerVoice-Studio (FRCRN_SE_16K, MossFormer2_SE_48K, MossFormerGAN_SE_16K) | Apache-2.0 | Apache-2.0 (HF `alibabasglab/*` cards) |
| Demucs v4 htdemucs / htdemucs_ft | MIT | MIT |
| python-audio-separator | MIT | Roformer checkpoints are community releases (Kim Mel-Band vocals, viperx BS-Roformer-1297) without a clear licence/training-data statement → **verify before shipping**; fine for research |
| RNNoise / ffmpeg arnndn | BSD-3 (rnnoise), LGPL (ffmpeg) | GregorR models: declared non-copyrightable |
| DNSMOS (speechmos), faster-whisper | MIT | DNSMOS ONNX (Microsoft DNS Challenge), Whisper MIT — evaluation only |

Not tested on purpose: generative restorers (resemble-enhance, VoiceFixer, Miipher etc.) — they
synthesise voice, which the spec excludes. UVR-DeNoise (VR arch) could not run: it needs the system
`libsamplerate`, absent on TrueNAS (`samplerate==0.1.0` pin).

**Target-speaker extraction:** ClearVoice's only TSE model `AV_MossFormer2_TSE_16K` is
**audio-visual** — it needs a video of the target speaker's lips (face track). With Ray-Ban footage the
owner is behind the camera, so it is unusable for "keep only my voice". An audio-enrolment TSE (a clean
reference fragment of the owner, as the spec describes) needs a different family (e.g. WeSep /
SpeakerBeam-style / USEF-TSE) — separate evaluation. ClearVoice also has `MossFormer2_SS_16K`
(blind 2-speaker separation, 16 kHz) which could feed a "which stream is the owner" step via
speaker embeddings.

## Recommendation

One speech estimator S per clip, aligned and length-exact, plus `B = X − S`; presets are just gains
(all measured variants above):

| preset | recipe | measured stand-in | why |
|---|---|---|---|
| **Gentle** (cleanup, ambience kept) | S + B·(−12 dB) (slider −6…−20) | `mf2-bg-12`: OVRL 2.92, BAK 3.43, ASR CER vs orig 0.02 | voice-free B, phase-exact → no doubling; text unchanged |
| **Voice-forward** | S + B·(−20 dB) | `mf2-bg-20`: OVRL 3.02, BAK 3.74 | ambience audible but clearly behind voice |
| **Strong** | S only (MossFormer2_SE_48K) | `cv-MossFormer2_SE_48K`: OVRL 3.23, BAK 4.11, RTF 0.7, 1 GB | full-band, best DNSMOS among 48k models |
| **Fast/cheap fallback** (preview, long videos, mobile) | DeepFilterNet3 `-D -a {6,12,20,∞}` + pad 1440 samples | dfn3-a12 / a20 / full | RTF 0.1, 110 MB, 0.6 s start; voice leaks into its residual on wind (+8 dB) so use the atten-limit knob, not stems |
| **De-hum toggle** | highpass 70 Hz + 50/100/150 Hz notches | dsp-hp-dehum | zero latency, harmless |
| **ASR input** | original (or gentle) | — | enhancement never improved WER consistently |

Implementation notes: compute S once (≈0.7× real time on 8 CPU threads; GPU would be far faster) and
cache S and B as 48k float stems; A/B switching and the background slider are then instant mixes in
the player. Do loudness matching (EBU R128) per preset at playback; on the windiest clip the original's
crest factor forces −26 LUFS if nothing may clip — use a limiter or accept −18…−20 LUFS with peaks
limited. Cross-fade (≥20 ms equal-power) at preset boundaries inside a clip is trivial because all
variants share the same sample grid.

Caveats: 3 clips (~2 min), DNSMOS is a proxy, WER uses a silver machine draft on very short references,
CPU timings were taken under contention, and nobody has listened yet — the blind A/B page is there to
confirm or overturn these numbers.

## Reproduce

```
bench/enhance/setup_envs.sh            # venvs enh-metrics / enh-demucs / enh-cv (torch 2.5.1 CPU)
bench/enhance/run_cli.sh               # ffmpeg baselines + DeepFilterNet3 (binary in envs/enh-dfn-bin)
bench/enhance/run_cv_all.sh            # ClearVoice (checkpoints in /mnt/flash/scratch/clearvoice)
bench/enhance/run_demucs_all.sh        # Demucs
bench/enhance/run_uvr_all.sh           # Roformers via audio-separator (installed --no-deps in enh-demucs)
envs/enh-metrics/bin/python enhance/postproc.py        # align, DNSMOS, ASR small, listening files
envs/enh-metrics/bin/python enhance/mix_stems.py cv-MossFormer2_SE_48K mf2 -12 -20  # then ONLY=mf2-bg-12,mf2-bg-20 postproc.py
ASR_MODEL=large-v3-turbo envs/enh-metrics/bin/python enhance/asr2.py <variants>
envs/enh-metrics/bin/python enhance/stem_leak.py; envs/enh-metrics/bin/python enhance/make_table.py
```
Venvs take 4.2 GB each (enh-cv, enh-demucs) under `bench/envs/` (gitignored, in the snapshotted home
dataset — move or delete when done); caches/models are in `/mnt/flash/scratch/{hf-cache,torch-hub,clearvoice,audio-separator-models}`.
