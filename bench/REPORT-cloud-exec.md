# External execution options for Titler (checked 2026-10-25)

Web research only; nothing was called. "3P" = third-party source only. Cloud ASR is in
[REPORT-cloud-asr.md](REPORT-cloud-asr.md) and is not repeated here.

## 1. Speech enhancement / stems

| Service | Speech + background? | Limits | Price | API | Retention |
|---|---|---|---|---|---|
| **ElevenLabs Voice Isolator** | speech only; background = residual (needs sample-exact output — test) | 500 MB, 1 h ([docs](https://elevenlabs.io/docs/capabilities/voice-isolator)) | **$0.12/min** ([pricing](https://elevenlabs.io/pricing/api)) | sync `POST /v1/audio-isolation`, multipart, audio or video ([ref](https://elevenlabs.io/docs/api-reference/audio-isolation/convert)) | zero-retention enterprise-only ([zrm](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode)) |
| **AudioShake** | **yes**: `dialogue` + `residual` ([models](https://developer.audioshake.ai/models)) | 45 min (alignment model); others not stated | credits, USD/credit not public (3P ≈ $1/min) | async `POST /tasks` with media **URL**, webhooks ([intro](https://developer.audioshake.ai/)) | not stated |
| LALAL.AI | voice cleaner / stems ([api](https://www.lalal.ai/api/)); residual track unconfirmed | 2 GB | API price not published | upload + async | — |
| Auphonic | in-place cleanup, no stems | — | 2 h/mo free; $12/5 h … $150/100 h ([pricing](https://auphonic.com/pricing)) | async REST | — |
| Adobe Podcast Enhance | no public API (enterprise beta in Firefly Services, 3P) | | | | |
| Dolby.io Media Enhance | apparently discontinued (docs redirect to OptiView) | | | | |
| Cleanvoice / Krisp | no stems / SDK only | | | | |

None documents 48 kHz output. Only AudioShake gives true speech + background stems.

## 2. Forced alignment (text + audio → word times)

| Service | Russian | Limits | Price | API |
|---|---|---|---|---|
| **ElevenLabs Forced Alignment** | **yes** ([capability](https://elevenlabs.io/docs/capabilities/forced-alignment)) | 3 GB, 10 h, 675k chars | "same as STT" (pricing page shows $0.22/h — confirm) | sync `POST /v1/forced-alignment` (`file` + `text`) → words/chars with times + per-word `loss` ([ref](https://elevenlabs.io/docs/api-reference/forced-alignment/create)) |
| Speechmatics alignment | unconfirmed | enabled by support | — | [docs](https://docs.speechmatics.com/en/alignment-service) |
| Rev.ai alignment | not stated | — | — | async, URLs ([docs](https://docs.rev.ai/api/alignment/get-started.md)) |

## 3. Serverless GPU for our own models

| Platform | L4 / A10-class | Billing / cold start |
|---|---|---|
| **Modal** | L4 $0.000222/s, T4 $0.000164/s, A10 $0.000306/s; $30/mo credit ([pricing](https://modal.com/pricing)) | per second; model load billed; idle window 2 s–20 min (default 60 s); memory snapshots ([cold start](https://modal.com/docs/guide/cold-start)) |
| RunPod Serverless | 24 GB $0.69/h, 16 GB $0.58/h ([pricing](https://www.runpod.io/pricing)) | per second; own Docker image; pass media by presigned URL |
| Beam | RTX 4090 $0.000192/s ([pricing](https://www.beam.cloud/pricing)) | code-load billed |
| Replicate | T4 $0.000225/s ([pricing](https://replicate.com/pricing)) | private models bill setup + idle |
| Baseten | L4 $0.0141/min ([pricing](https://www.baseten.co/pricing/)) | per minute |
| HF Endpoints | L4 $0.70–0.80/h ([pricing](https://huggingface.co/docs/inference-endpoints/pricing)) | billed while initialising |

Estimate per minute of video (ASR + align + MF2 ≈ 15 L4-seconds): compute ≈ $0.003; a cold
Modal call with a short idle window ≈ $0.01 (≈ $0.02 with the default 60 s idle). Bake weights
into the image; pass media by short-lived presigned URL.

## 4. Cloud render APIs

Shotstack burns styled SRT/VTT captions ("Rich Captions") but **no ASS** ([docs](https://shotstack.io/docs/guide/architecting-an-application/rich-captions/), [request](https://community.shotstack.io/t/feature-request-support-for-ass-subtitle-format-with-advanced-styling-and-animation/757)).
Mux / Cloudflare Stream: sidecar captions only. Verdict: keep libass render local (or ffmpeg on CPU serverless).

## 5. Exposing our API

- **Cloudflare proxy body limit: 100 MB (Free/Pro)**, 200 MB Business — Tunnel included ([limits](https://developers.cloudflare.com/workers/platform/limits/)). Our 4 MB chunked upload fits; a single big PUT does not. R2 presigned PUT ≤ 5 GiB ([R2](https://developers.cloudflare.com/r2/objects/upload-objects/)).
- Cloudflare Access: free ≤ 50 users; service tokens ([docs](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)) — free-plan availability not stated.
- Tailscale Funnel: ports 443/8443/10000, beta, undisclosed bandwidth limits ([kb](https://tailscale.com/kb/1223/tailscale-funnel)) — demo only.
- Suggested: phone/web → **de1 Caddy (auto-TLS) + Fastify gateway** (owner session + hashed per-device API keys) → tailnet → n5 / m3max. Nothing at home listens on the internet. Do not route uploads through Cloudflare.

## 6. All-in-one "captioned shorts" APIs (benchmarks only)

Captions/Mirage API $0.15/min ([pricing](https://www.captions.ai/help/docs/api/pricing)); Submagic API (`POST /v1/projects`, [docs](https://docs.submagic.co/), 3P ≈ $69/mo plan); Opus Clip / Vizard APIs on paid plans (3P). Russian quality unverified.

## Verify before relying on it

ElevenLabs alignment price and Isolator output rate (48 kHz?); residual-subtraction quality;
AudioShake USD/credit; Cloudflare service tokens on Free.
