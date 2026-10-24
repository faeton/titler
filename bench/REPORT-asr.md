# ASR benchmark: Ray-Ban Meta clips (RU / mixed / EN)

Date: 2026-10-24 · Host: n5, CPU only (Ryzen AI 9 HX PRO 370), **8 threads per model**
Clips: `video-34238` (33 s), `video-34442` (30 s), `video-34585` (64 s), 16 kHz mono.

> **Provisional:** no human reference yet. WER/CER is measured against a **silver draft** made
> by majority vote of 4 tested models (`refs/*.draft.txt`), biased toward those voters and
> especially each clip's pivot (wins ties). Once `refs/<clip>.txt` exists, re-run
> `python3 bench/asr/score.py`.
>
> **Timing caveat:** two other benchmark agents ran concurrently (load 15–27 on 24 threads);
> the same config varied up to 2× (large-v3 on 34585: 26–64 s). Pass-1 shown; pass 2 for
> headline configs in `runs/asr/_timing2/`.

## What the clips contain
- **34238**: Russian (0–17 s) **plus a second, quieter speaker in English, 18–32 s** (short conversational phrases) — the code-switching test.
- **34442**: Russian, colloquial.
- **34585**: fast colloquial Russian, a foreign place name in a Russian case form, slang, loanwords and onomatopoeia.
- **No Ukrainian and none of the brand terms** (Awerti, Esports Charts, Streams Charts). Ukrainian handling and keyterm biasing are **untested**.

## Results
RTF = inference / audio length. Load = model construction + 2 s warm-up. Peak RSS = whole process. P/C = punctuation/capitalisation.

| model | load s | infer s (238/442/585) | RTF | peak RSS GB | word times | P/C | prov. WER | prov. CER |
|---|---|---|---|---|---|---|---|---|
| **fw-turbo-auto-novad** (large-v3-turbo, auto, no VAD) | 8.2 | 11.3/15.0/22.9 | 0.38 (p2: 0.42) | 1.6 | yes | PC | 5.6%* | 1.6%* |
| fw-turbo-auto (VAD, = current params) | 66.5† | 23.1/9.3/37.5 | 0.55 | 2.0 | yes | PC | 14.9% | 11.0% |
| fw-turbo-ru (VAD) | 7.9 | 10.5/8.6/18.8 | 0.30 | 1.6 | yes | PC | 14.9% | 11.0% |
| fw-large-v3-auto (VAD, **= current default**) | 7.2 | 9.7/8.5/26.4 | 0.35 | 3.0 | yes | PC‡ | 27.9% | 16.1% |
| fw-large-v3-ru (VAD) | 9.3 | 5.9/7.3/35.9 | 0.38 | 3.0 | yes | PC‡ | 27.9% | 16.1% |
| fw-large-v3-multi (VAD, per-segment lang) | 13.9 | 19.0/18.6/42.9 | 0.63 | 3.0 | yes | PC‡ | 27.9% | 16.1% |
| fw-large-v3-ru-prompt (keyterms prompt) | 8.4 | 15.0/7.8/38.4 | 0.48 | 3.1 | yes | PC | 20.9% | 11.8% |
| fw-large-v3-auto-novad | 9.7 | 11.3/9.4/52.4 | 0.57 (p2: 0.87) | 3.1 | yes | PC | 19.5% | 13.7% |
| fw-antony66-ru (RU fine-tune, ct2 int8) | 6.1 | 16.2/9.6/61.6 | 0.68 | 3.0 | yes | PC | 17.7% | 11.6% |
| **gigaam-v3-e2e-rnnt** (onnx-asr, Silero VAD) | 5.2 | 2.5/1.4/6.8 | **0.08** (p2: 0.07) | 1.8 | tokens | PC | 19.1%* | 10.4%* |
| gigaam-v3-e2e-ctc | 4.0 | 2.8/1.3/6.1 | 0.08 | 1.7 | tokens | PC | 18.1% | 8.1% |
| gigaam-v3-rnnt (no punct.) | 4.2 | 3.8/1.7/7.0 | 0.10 | 1.7 | tokens | -- | 17.2% | 11.2% |
| gigaam-v3-ctc (no punct.) | 3.6 | 3.9/1.5/6.5 | 0.09 | 1.7 | tokens | -- | 17.2% | 11.1% |
| gigaam-multilingual-large-ctc | 4.0 | 14.8/5.0/21.6 | 0.32 | 2.6 | tokens | -- | 18.1% | 11.8% |
| **parakeet-tdt-0.6b-v3** (onnx-asr) | 12.3 | 6.9/2.1/11.7 | 0.16 (p2: 0.07) | 3.3 | tokens | PC | 12.6%* | 6.6%* |
| canary-1b-v2 (src=ru) | 5.1 | 19.6/8.4/51.5 | 0.62 | 5.9 | no | PC | 29.3% | 13.9% |
| t-one (T-Tech) | 4.9 | 2.4/1.1/5.4 | 0.07 | 0.5 | yes (≈+0.4 s lag) | -- | 29.3% | 15.6% |
| vosk-ru (ONNX) | 3.1 | 1.9/0.9/3.8 | 0.05 | 1.4 | tokens | -- | 21.4% | 13.4% |
| **qwen3-asr-auto-aligned** (fp32 + ForcedAligner) | 32.9 | 192/45/358 | 4.66 | 13.5 | forced | PC | 16.7%* | 6.3%* |
| qwen3-asr-auto-bf16 (no aligner) | 7.4 | 26.1/14.1/85.0 | 0.98 | 5.4 | no | PC | 17.7% | 6.4% |
| qwen3-asr bf16 + aligner (p2) | 6.0 | 35.4/33.1/113.9 | 1.43 | 7.2 | forced | PC | - | - |
| qwen3-asr-ru (fp32, forced ru) | 14.4 | 57/35/149 | 1.89 | 12.5 | no | PC | 16.7% | 6.3% |
| qwen3-asr-auto-context (fp32, keyterms context) | 2.8 | 29/19/92 | 1.09 | 12.5 | no | PC | 15.8% | 6.0% |

`*` = silver voter (gigaam-v3-e2e-rnnt, fw-turbo-auto-novad, parakeet-tdt-0.6b-v3, qwen3-asr-auto-aligned), biased low; fw-turbo-auto-novad was pivot on 34442/34585 — most inflated. † first-run download. ‡ large-v3 punctuation inconsistent (34238, 34585 all lowercase, no punctuation).

Provisional WER on pure-Russian 34585, non-voters: antony66 7.4% · gigaam-v3-rnnt 5.9% · gigaam-v3-ctc 5.2% · **large-v3 VAD 23.7%** · turbo VAD 3.0% · t-one 17.8% · vosk 11.1%.

Pairwise disagreement (`score.py --pairwise`): fw-turbo-auto lowest mean (26%), then antony66, gigaam-e2e-rnnt (27%); t-one (39%), canary (37%) outliers. Excluding the code-switched clip, Russian-capable models disagree on 5–17% of words.

## Notable differences
**1. The current pipeline loses the English tail of 34238.** With `vad_filter=True` every Whisper variant (large-v3/turbo, auto/ru/multilingual) dropped 18–32 s. Whisper detects language once per file (ru 0.71 / en 0.26). Silero VAD *does* mark it as speech, so the loss is in Whisper decoding the VAD-concatenated audio. Without VAD: turbo writes correct English; large-v3 and antony66 produce Cyrillic gibberish.

| model | English tail |
|---|---|
| Qwen3-ASR | Perfect English (still labels clip "Russian") |
| parakeet-v3 | Correct, plus extra "Okay", "yeah" |
| GigaAM-v3 | Phonetic Cyrillic / garbled Latin (Russian-only) |
| canary-1b-v2, large-v3 + prompt | Translated to Russian |
| T-one, Vosk | Fragments |

**2. Foreign place name (34585):** GigaAM-e2e, antony66, parakeet closest; turbo one vowel off; Qwen substitutes a common Russian verb; large-v3 VAD and T-one split it into two wrong words. Dictionary case.

**3. Colloquial Russian:** large-v3 VAD drops function words (23.7% vs turbo 3.0%). Qwen paraphrases slang and filler phrases and mangles diminutives. A loanword: turbo ✓, others vary. A diminutive in 34238: four different spellings across models — listening needed. A rare instrumental-case noun in 34442: all agree, possibly wrong — agreement ≠ correct. parakeet appends "I don't know" at 14.9–15.2 s of 34442 — unverified.

**4. Numbers:** GigaAM-e2e writes digits ("3"), others words ("три"); score.py doesn't normalise digits.

**5. Keyterm prompts:** Whisper `initial_prompt` changed style and caused EN→RU translation; Qwen `context` ~no effect. Untestable until clips contain the terms.

**6. Language reporting:** Whisper one language per file; Qwen one merged label; GigaAM/parakeet/T-one/Vosk none. Qwen3-ASR has **no Ukrainian**; GigaAM-v3 and T-one **Russian-only**; parakeet-v3, canary, Whisper cover ru/uk/en.

## Word timings (agreement, no ground truth)
| model | vs turbo (median / p90) | vs Qwen ForcedAligner (median / p90) |
|---|---|---|
| fw large-v3 / turbo (DTW) | reference | 50–130 / 410–680 ms |
| GigaAM-v3 e2e-rnnt | 96 / 364 ms | **56 / 136 ms** |
| parakeet-v3 | 100 / 524 ms | 56 / 200 ms |
| T-one | **408** / 772 ms | 360 / 490 ms (≈0.4 s lag) |
| Vosk | 76 / 440 ms | 64 / 200 ms |

Qwen3-ForcedAligner-0.6B aligns arbitrary text (what local re-align needs) but is slow on CPU and has no Ukrainian. GigaAM/parakeet word ends are approximated (next start, capped +0.4 s). Whisper times OK as preliminary.

## Licences (HF model cards, 2026-10-24)
| weights | licence | commercial |
|---|---|---|
| Whisper large-v3 | Apache-2.0 (code MIT) | yes |
| large-v3-turbo, ct2 conversions | MIT | yes |
| antony66/whisper-large-v3-russian | **none declared** | **unclear — avoid** |
| GigaAM-v3 (+ONNX, multilingual) | MIT | yes (Sber provenance; local only) |
| T-one | Apache-2.0 | yes |
| parakeet-tdt-0.6b-v3, canary-1b-v2 | CC-BY-4.0 | yes, attribution |
| Qwen3-ASR-1.7B, Qwen3-ForcedAligner-0.6B | Apache-2.0 | yes |
| Vosk ru | Apache-2.0 | yes |
| Silero VAD | MIT | yes |
| ElevenLabs Scribe v2 | commercial API | paid; audio leaves box |

## Recommendation
**(a) Primary: large-v3-turbo via faster-whisper int8, language auto, no VAD concatenation.** Most consistent Russian with reliable punctuation, keeps English, covers Ukrainian on paper; RTF 0.3–0.4 at 8 contended threads, 1.6 GB. Current default (large-v3 + VAD) is the worst Whisper setup here. Guard silence hallucinations with `hallucination_silence_threshold`, or use VAD only for `clip_timestamps`.

**(b) Second hypothesis: GigaAM-v3 e2e-rnnt (onnx-asr), parakeet-tdt-0.6b-v3 as multilingual fallback.** Different architecture/data, best on the Russian proper noun, ~5× faster than turbo, MIT, punctuated. Russian-only → run parakeet-v3 on spans where Whisper has Latin or GigaAM looks transliterated. Qwen3-ASR optional (best code-switching, 5–25× slower, weaker colloquial RU, no uk). Scribe v2 remains the external candidate.

**(c) Timings:** turbo for first pass; GigaAM/parakeet token times as second opinion; Qwen3-ForcedAligner-0.6B as candidate for re-aligning edited text (RU/EN). Correct T-one's lag or avoid.

**Not recommended:** antony66 (licence, garbles English, slow), canary-ru (translates), T-one/Vosk (accuracy, no punctuation), large-v3 + `initial_prompt` (translated English).

## Skipped
whisper.cpp (same weights; no compiler on host — see GPU report), Kaldi Vosk 0.42 (used ONNX vosk-model-ru), native `gigaam` package (onnx-asr covers v3), GPU (out of scope here).

## Files
- Runners: `asr/run_fw.py`, `asr/run_onnx.py`, `asr/run_qwen.py`, `asr/run_scribe.py` (needs `ELEVENLABS_API_KEY`).
- Drivers: `asr/run_fw_all.sh`, `asr/run_rest.sh`, `asr/run_extra.sh`, `asr/timing_pass.sh`; setup `asr/setup_envs.sh`, `asr/convert_antony66.sh`, `asr/env.sh`.
- Analysis: `asr/score.py` (`--draft`, `--pairwise`), `asr/build_draft.py`, `asr/timing_agreement.py`, `asr/summarize.py`.
- Outputs: `runs/asr/<model>/<clip>.{json,txt}`, `runs/asr/_silver/*.disputes.json`, `runs/asr/_scores_provisional.json`.
- Drafts to correct: `refs/<clip>.draft.txt` → save as `refs/<clip>.txt`.
- Versions: faster-whisper 1.2.1, ctranslate2 4.8.3, onnx-asr 0.12.0, onnxruntime 1.31.0, qwen-asr 0.0.6, torch 2.14.1+cpu, transformers 4.57.6. Caches in `/mnt/flash/scratch/hf-cache`.
