# Word-level forced alignment — benchmark for local re-alignment

Date: 2026-10-24 · host n5 (CPU only, 8 threads per process, **shared with two other benchmark agents: load 20–35 on 24 threads during all timings** — absolute latencies pessimistic, relative ones hold).

Goal (spec «Пропущенные слова и точные тайминги»): after a text edit, re-align a small phrase (±2–3 neighbours, ~1 s padding) quickly, keep manual anchors untouched, never give a confident "aligned" status to a word that is not in the audio.

## TL;DR / recommendation
1. **Boundaries: jonatasgrosman/wav2vec2-large-xlsr-53-russian (Apache-2.0)**, CTC Viterbi (torchaudio.functional.forced_align), int8 dynamic quantization (boundaries identical over 616 words; ~2.4× faster). Agrees with MMS_FA to 0 / 20 ms (median / p90 |Δstart|); best VAD/energy plausibility.
2. **Failure detection: likelihood-ratio test** LLR = Viterbi(window | text) − Viterbi(window | text without the word), computed with **GigaAM-v3 CTC (MIT) as verifier** (status only; its timing drifts ±0.1–0.25 s). Hybrid w2v_ru + gigaam: real words accepted 99–100 %, inserted non-existent words rejected 95–100 % (worst: fake «и» 95 %), real neighbours unaffected (0 ms drift), anchors never moved.
3. **Emissions are text-independent → compute once per clip** (after ASR; ~0.3× RT on the loaded host), keep in the worker; each edit then costs 3–5 ms. Uncached: ~0.6 s per 5 s window (q8 w2v + GigaAM), ~0.35 s q8 w2v only.
4. **Verbalise digits** (num2words ru) before alignment.
5. English: only MMS-based aligners (uroman) handle it, but **MMS weights are CC-BY-NC 4.0** (torchaudio MMS_FA = ctc-forced-aligner checkpoint). ru models + GigaAM mark English mostly unconfirmed (safe failure). Add MMS for Latin-script words only if Titler stays non-commercial.
6. WhisperX: same ru model, segment-level → stretches last word (end p90 ≈350 ms), heavy deps — no gain. Whisper DTW: starts ~140 ms early (median), p90 ~550 ms — provisional only.

## Setup
- Transcript: faster-whisper large-v3 int8 CPU, language auto, word_timestamps (`align/asr_fw.py` → `runs/align/asr/`); all clips detected ru; 253 words.
- video-34238 20–31 s is **English** («same same, you've been in Thailand recently … they do same same there all the time»); with clip language ru, whisper wrote «сэм сэм юбилейный талант … таллинн». Excluded from agreement, used as mixed-language test. video-34442 30.0 s: whisper hallucinated «Продолжение следует...».
- Env `bench/envs/align-main`: torch 2.5.1+cpu, transformers 4.46.3, whisperx 3.8.6 (--no-deps), gigaam 0.2.0, ctc-forced-aligner 0.3.0 (built with zig; `align/setup_env.sh`).

| id | what | model / frame |
|-|-|-|
| whisper | faster-whisper cross-attention DTW | large-v3 |
| mms_fa | torchaudio MMS_FA + uroman, our engine (Viterbi + edge filler) | MMS-300M, 20 ms |
| cfa | ctc-forced-aligner official pipeline | same weights as MMS_FA, 20 ms |
| w2v_ru | jonatasgrosman xlsr-53 ru, our engine | 20 ms |
| whisperx | whisperx.alignment.align() per segment | same ru model |
| gigaam | GigaAM-v3 CTC emissions, our engine | 40 ms |

## 1. Agreement and plausibility (whole clips, 192 words outside the English part)
| pair | med \|Δstart\| ms | p90 | med \|Δend\| ms | p90 |
|-|-|-|-|-|
| mms_fa ~ cfa | 4 | 23 | 5 | 24 |
| mms_fa ~ w2v_ru | 0 | 20 | 20 | 40 |
| mms_fa ~ whisperx | 14 | 44 | 34 | 351 |
| w2v_ru ~ whisperx | 10 | 47 | 47 | 350 |
| mms_fa ~ gigaam | 80 | 240 | 63 | 255 |
| whisper ~ mms_fa | 141 | 577 | 81 | 181 |
| whisper ~ gigaam | 220 | 559 | 126 | 323 |

Whisper starts 130–260 ms early. GigaAM: no constant offset but ±150–300 ms context-dependent jitter.

| aligner | mean VAD fraction | words <50 % in VAD | dB before start − dB word | dB after end − dB word | dur>1.2 s |
|-|-|-|-|-|-|
| whisper | 0.919 | 13 | −1.4 | −1.2 | 5 |
| mms_fa | 0.979 | 3 | −2.8 | −1.5 | 2 |
| cfa | 0.978 | 4 | −2.6 | −1.4 | 2 |
| w2v_ru | 0.981 | 3 | −3.2 | −1.3 | 1 |
| whisperx | 0.966 | 4 | −1.7 | −2.1 | 6 |
| gigaam | 0.945 | 10 | −1.7 | −1.8 | 2 |

## 2. Local re-alignment tests (`align/bench_local.py`, `runs/align/local_summary.md`)
88 windows of 7 words (centre ±3, 1 s padding, median 5.1 s audio). Variants: original; centre word deleted; 6 inserted non-existent words («синий», «компьютер», «на», «и», «не», «вот»); same with words c−2 and c+1 anchored. Real words labelled by text consensus of 17 other ASR systems (≥50 % support = confirmed).

| config | confirmed real aligned (≥3 / 1–2 letters) | fake rejected синий/компьютер/на/и/не/вот | fake between anchors rejected (синий/на) | centre vs whole-clip MMS med/p90 ms |
|-|-|-|-|-|
| mms_fa | 94 / 85 % | 98/100/94/75/83/98 | 99/94 % | 11/30 |
| mms_fa_q8 | 92 / 88 % | 99/100/89/68/78/98 | 99/90 % | 11/28 |
| w2v_ru | 97 / 98 % | 99/100/89/85/88/94 | 100/89 % | 11/32 |
| w2v_ru_q8 | 97 / 99 % | 99/100/91/84/88/93 | 100/90 % | 11/32 |
| gigaam alone | 100 / 99 % | 100/100/100/95/99/97 | 94/76 % | 100/344 |
| **w2v_ru(_q8)+gigaam** | **100 / 99 %** | **100/100/100/95/99/97** | **100/100 %** | **10/31** |
| mms_fa+gigaam | 100 / 99 % | 100/100/100/95/99/97 | 100/100 % | 11/15 |

- Anchors 100 % untouched; inserted word lands inside the anchor gap 99–100 %.
- Inserting a fake never moves real neighbours (drop-worst re-alignment, ≤ len/2 iterations); 98–100 % of real neighbours stay aligned.
- Fakes into a ≥250 ms pause: hybrid 98 % rejected vs 99 % in running speech.
- Deletion → re-insertion («я приехал Самоа»): with the word deleted, neighbours absorb its audio (drift p90 150–450 ms), flagged only 1–14 % → **a missing word is not reliably detectable** by alignment. Re-inserting restores alignment exactly; inserted word aligned 93–99 % (hybrid 99 %), 10/30 ms from whole-clip boundaries.
- Disputed ASR words: hybrid accepts 85 % long / 25 % short; «Продолжение следует» LLR −111/−51 rejected by all; «человека» (others: «человечка») rejected by MMS.
- Cached whole-clip emissions vs per-window: boundaries ±1 frame, acceptance equivalent.

### Signals (p5 / p50 / p95)
| signal | real (all) | fake синий | fake на | fake и |
|-|-|-|-|-|
| LLR GigaAM (nats) | 4.9 / 28.8 / 105 | −215 / −117 / −45 | −104 / −42 / −16 | −62 / −18 / −7.4 |
| LLR w2v_ru | −2.0 / 59 / 147 | −142 / −94 / −17 | −65 / −40 / −6.9 | −36 / −17 / +0.9 |
| LLR MMS | −3.8 / 16 / 53 | −49 / −34 / −21 | −19 / −14 / −8.3 | −9.1 / −6.9 / −2.1 |
| mean log-posterior MMS | −2.95 / −0.22 / −0.01 | −9.7 / −6.5 / −3.8 | −9.0 / −6.9 / −2.9 | −9.0 / −6.9 / −0.6 |
| duration | 20–40 / 220 / 620 ms | 1 frame/letter in ≥75 % | 40/80 ms | 20/40 ms |

Weak spot: 1–2-letter function words (reduced / merged with next word).

### Proposed thresholds (`THRESHOLDS` in local_align.py)
| model | LLR min ≥3 letters | LLR min 1–2 letters | min mean log-posterior |
|-|-|-|-|
| gigaam (verifier) | 1.0 | 0.0 | — |
| w2v_ru / w2v_ru_q8 | 1.0 | −3.0 | — |
| mms_fa / mms1130 | 1.0 | −3.0 | −4.0 |

status=aligned iff all pass; else unconfirmed + reason (low-llr, low-posterior, verifier, no-alignable-chars, no-fit) + provisional interval = gap between aligned neighbours. Optional UI tier: aligned but mean log-posterior < −2 → low confidence (catches wrong-but-present words, e.g. «юбилейный» for "you've been", which LLR accepts).

## 3. Latency (7-word window, median 5.1 s audio, warm, 8 threads, loaded host)
| config | per edit, window emissions (median; med-of-3 / p90) | cached clip emissions |
|-|-|-|
| gigaam | 179 ms (182 / 215) | 1.4 ms |
| mms_fa | 769 ms (855 / 1534) | 4 ms |
| mms_fa_q8 | 241 ms (257 / 305) | 2 ms |
| w2v_ru | 800 ms (907 / 1699) | 2 ms |
| w2v_ru_q8 | 340 ms (389 / 494) | 3 ms |
| w2v_ru + gigaam | 1030 ms (1422 / 1766) | 3 ms |
| **w2v_ru_q8 + gigaam** | **592 ms (630 / 815)** | **3–5 ms (p90 5.4)** |
| mms_fa + gigaam | 1485 ms (1602 / 2192) | 3 ms |

Whole-clip precompute (w2v fp32 + GigaAM): 7.9 s (30 s clip), 16–19 s (33 / 64 s). Cache ≈ 250 KB/min (w2v fp16) + 110 KB/min (GigaAM). Worker: load 8 s; peak RSS 4.7 GB on a 64 s precompute → chunk into 20–30 s windows.

## 4. Mixed language / Ukrainian / numbers (`align/bench_mixed.py`, `runs/align/mixed.md`)
| case | mms_fa | w2v_ru | gigaam / hybrid |
|-|-|-|-|
| EN "same same you've been in thailand recently" | 5/7 | 6/7 | 3/7 |
| EN "thailand they do same same there all the time" | 9/9 | 5/9 | 6/9 |
| same audio, Cyrillic gibberish «сэм сэм юбилейный талант и» | 5/5 accepted | 5/5 accepted | 1/5 |
| «эко воркинги» Cyrillic | ok (я ✗) | эко ✗ | 7/7 |
| «eco workings» / «coworking» Latin | eco ✗ / ✓ | eco ✗ / ✓ | eco ✗ / ✓ |
| «за 3 дня» verbalised / raw | ✓ / «3» unconfirmed | same | same |
| uk spelling of same sounds («ні», «трильйон») | ✓ | ✓ | ✓ |
| uk translation over ru audio | 0/3 (rejected) | 1/3 | 0/3 |

- Only MMS aligns English; ru models get crude Latin→Cyrillic transliteration: loanwords pass, English sentences mostly unconfirmed.
- No real Ukrainian speech in clips — only text handling tested.
- num2words is nominative only («в 2015 году» → «две тысячи пятнадцать»); case-aware verbalisation is a product task.

## 5. Licences
| component | licence |
|-|-|
| torchaudio MMS_FA weights | CC-BY-NC 4.0 (non-commercial) |
| ctc-forced-aligner | code BSD-2; model mms-300m-1130-forced-aligner CC-BY-NC 4.0 |
| jonatasgrosman/wav2vec2-large-xlsr-53-russian | Apache-2.0 |
| GigaAM-v3 code + weights | MIT (Sber/Salute provenance; runs locally) |
| WhisperX | BSD-2-Clause |
| faster-whisper / Whisper weights | MIT |
| uroman | Apache-style |
| silero-vad | MIT |
| num2words | LGPL-2.1 |
| torchaudio | BSD-2; forced_align deprecated 2.8, removed 2.9 → pin ≤2.7 or use ctc-forced-aligner's BSD C++ forced_align |

## 6. Prototype `bench/align/local_align.py`
`align_window(audio, t0, t1, words, anchors={i: (s, e)}, backend="w2v_ru_q8", verifier="gigaam")` → `[{w, start, end, status: aligned|unconfirmed|anchor, reason?, llr, lp, score, dur, v_llr, v_lp}]`; `precompute(audio)` caches whole-clip emissions.

Worker: `python local_align.py --worker --backend w2v_ru_q8 --verifier gigaam`; JSON lines `{"op":"precompute","audio"}`, `{"id","audio","t0","t1","words","anchors"}`, `{"op":"forget","audio"}` → `{"id","words","ms"}` | `{"id","error"}`.

Engine: edge filler token absorbs neighbour speech in the padding; uroman letter doubling collapsed; free words between anchors aligned only inside the gap; too-short gap → proportional provisional split (no-fit); verifier ignores anchor walls.

Limitations: proclitics «в/с/к» have LLR≈0 on ru/MMS (GigaAM ok); a window starting inside a word lets short words grab neighbour sound (start windows at a neighbour's start − padding); thresholds from 88 windows, one speaker, three clips — re-check on wind / overlap / music.

## Files
`bench/align/`: asr_fw.py, local_align.py, bench_full.py, analyze_full.py, bench_local.py, analyze_local.py, rule_sweep.py, consensus.py, bench_cached.py, bench_mixed.py, setup_env.sh.
`bench/runs/align/`: asr/, full/ + full_summary.{md,json}, local/*.jsonl + local/latency.json, local_summary.{md,json}, cached_*.json, mixed.{md,json}, consensus*.json, logs.
