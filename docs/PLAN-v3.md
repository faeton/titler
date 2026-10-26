# Titler — next stage: execution providers, public API, series, covers, publishing

2026-10-25. Continues [PLAN-v2.md](PLAN-v2.md) after the Mac port ([mac.md](mac.md)).
How the work is run (n5 → m3max): [HANDOFF-v3.md](HANDOFF-v3.md).
Research: [cloud ASR](../bench/REPORT-cloud-asr.md), [cloud providers and gateway](../bench/REPORT-cloud-exec.md),
[publishing platforms](../bench/REPORT-publishing.md).

Status (2026-10-27): S1, S2 and the server side of S3 are done (HANDOFF-v3 §4). The next stage is
[PLAN-v4.md](PLAN-v4.md).

## Why

One web interface, with a choice of where each step runs: n5, the Mac, a cloud API, later the
phone. A finished clip is cut into parts to fit platform limits, gets a cover and goes out for
publishing without being rebuilt by hand. The main metric is unchanged: how much manual work is
left between upload and a published clip.

Not goals of this stage: cloud rendering (no service supports ASS/libass), moving the whole
pipeline to the phone, publishing to other people's accounts.

## 1. Step providers (one shell, many options)

**Steps:** ingest/proxy, analyze, asr, align, enhance, render, cover, publish.

A **provider** is whoever runs a step:

| kind | example | transport |
|---|---|---|
| local | this server's workers (as now) | JSON lines (`docs/worker-protocol.md`) |
| remote runner | another titler over the tailnet (n5 ↔ m3max) | the same protocol over HTTP, files by signed link |
| cloud API | ElevenLabs, Gemini, Soniox, OpenAI, Claude | adapters from `bench/cloud/` → a new worker role `cloud` |
| cloud GPU | our own models on Modal (later) | the same protocol, media by presigned URL |
| phone | offline draft in the app (future, §6) | — |

- `/api/providers` already exists; extend it to one entry per step: `step`, `kind`, `models`,
  `enabled/reason`, `costPerMin` (estimate), `dataLeavesBox` (data goes outside), `wordTimestamps`.
- Choice: global defaults in settings plus a per-project override. Job parameters store
  provider + model; the artifact key includes them (already the case for ASR).
- UI: each step has a provider selector with price per minute and a "goes to the cloud" mark.
  A cloud provider without a key is visible but disabled with a reason (as now).

**What to connect first (per the research):**

| step | local (default) | external option | note |
|---|---|---|---|
| asr | faster-whisper turbo | ElevenLabs Scribe v2 ($0.0045/min), Soniox, Gemini | adapters ready, keys needed |
| review | — | Claude (text pass over disputed spots) | ready in `bench/cloud` |
| align | w2v + GigaAM | ElevenLabs Forced Alignment (has Russian, per-word `loss`) | as a cross-check |
| enhance | MF2 / DFN3 | ElevenLabs Voice Isolator ($0.12/min, voice only → background = residual); AudioShake (real stems) | check 48 kHz and subtraction accuracy |
| own models in the cloud | — | Modal L4, ≈ $0.01 per video minute | when n5 and the Mac are unavailable |
| render | ffmpeg + libass | none | cloud renderers can't do ASS |

## 2. Public API (de1)

Today the server has no auth and is only reachable on the tailnet. For the app and the
platforms to use it (Instagram fetches video from a public URL), it needs an entry from the internet.

**Step A (minimum):** Caddy with auto-TLS on de1 → proxy over the tailnet to the n5 (or Mac) server.
Nothing at home listens on the internet. Add to the server itself:
- owner login: cookie session (passkey or long token);
- device keys for the app and scripts: hashed, revocable, named;
- signed expiring artifact links (`/s/<token>`, TTL minutes to hours) for Instagram
  `video_url`/`cover_url`, AudioShake, Modal;
- CORS, rate limits.
Uploads are already chunked at 4 MB, so they don't hit Cloudflare's 100 MB limit, but uploads never
go through Cloudflare at all (direct Caddy only).

**Step B (later):** a coordinator on de1 with a queue; n5 and the Mac pull jobs over the tailnet.
Needed once there are several providers that come and go.

## 3. Series (splitting into parts)

**Part length presets** (with a margin under the limits):

| platform | max part |
|---|---|
| IG Stories | 59 s |
| IG Reels, YT Shorts, TikTok | 179 s |
| FB Reels | 89 s |
| Telegram | no splitting (limit is file size) |
| custom | any value |

**Algorithm** (pure function in `packages/core`, with tests):
1. Number of parts `n = ceil(duration / max)`; targets are equal shares.
2. Cut candidates are inter-word pauses ≥ 300 ms; sentence ends, paragraph boundaries and VAD
   silence weigh more. Never cut inside a word.
3. Choose cuts by dynamic programming: minimise distance from targets plus penalties, with the hard
   constraint "every part ≤ max". Search window ±15 % around each target.
4. A tail shorter than ~12 s is rebalanced (or merged into the previous part if it fits).
5. If there are no pauses, cut at the longest inter-word gap in the window.
6. Option: repeat the last ~0.5 s at the start of the next part.

**Numbering «1/3»:**
- An option in the series settings; shown when there are **more than two** parts (threshold
  configurable, default 3, as the brief says).
- Format «1/3» or «Часть 1 из 3» ("Part 1 of 3"); top of the frame inside the safe zone, first 2–3 s
  or the whole part; drawn by the same caption compiler, so preview and ASS match.
- The publishing caption gets «(1/3)» automatically.

**Render:** each part is its own artifact over `[t0, t1]` in source time (accurate `-ss/-to`, the
audio variant trimmed the same way, captions split at the boundary and re-based to zero). Each part
is checked: duration ≤ max, A/V sync. Names `…_p1of3.mp4`, cached per part, progress per part.

**UI (Export screen):** pick a platform → timeline with cuts (draggable, snapping to pauses),
each part's duration (red if > max), «1/3» toggle. Each platform has its own series plan (Stories
and Reels are cut differently).

## 4. Covers (thumbnails)

- Frame picker on the Export screen: scrub the proxy, step by frame; 3–5 suggested frames
  (sharp, no motion blur); in the first version simply an even spread plus the sharpest.
- Cover overlays: title (optional), «1/3» badge for a series.
- Guides: full 9:16, the IG profile grid centre crop (~3:4), 16:9 for regular YouTube videos.
- The frame is taken from the source (not the proxy) with the same framing → JPEG 1080×1920
  (≤ 8 MB), 1280×720 for YouTube videos.
- Delivery per platform: IG Reels `cover_url` (Stories have no cover); YouTube `thumbnails.set`
  (probably not available for Shorts via the API); TikTok `video_cover_timestamp_ms`; Telegram `cover`.

## 5. Publishing (refined P7)

In order of how hard each is to connect:
1. **Telegram**: a bot in the channel; ≤ 50 MB (or a local Bot API server up to 2 GB).
2. **YouTube**: own channel, file upload, a playlist per series. Move the OAuth consent screen to
   "In production" (in "Testing" the token lives 7 days). Check with the first upload whether it
   gets locked to private.
3. **Instagram**: switch the account to **Creator** (personal accounts have no API); a Meta app in
   dev mode with the account as an app tester (no App Review); Instagram Login; video served by a
   signed link from de1 (§2). Reels first, then Stories. "Link a Reel" for a series is app-only;
   the UI reminds.
4. Facebook Reels only if there is a Page. 5. TikTok last (audit; without it, private only).

Each platform is a separate job with its own state and remote id; a retry doesn't duplicate a
successful publication (as in `spec-workflow.md`). A series is published in part order.

**Needed from the owner:** switch IG to Creator; create a Meta app; a Google Cloud project and
verify the channel by phone; a Telegram bot with rights in the channel; ElevenLabs / Anthropic keys
(and optionally Gemini/Soniox).

## 6. iOS app (future, not now)

A thin shell: the interface is the same web app (WKWebView); native only for what Safari can't do:
- share extension "Share → Titler" from Photos and Meta View;
- background upload of large clips (`URLSession` background);
- "done" push, save to Photos;
- **publishing through the native Instagram app** (share to Stories/Reels from the app), possibly
  without a Creator account and without the Meta API. Check what this gives for Reels.
- offline draft: quick transcription on the phone (WhisperKit) and a simple render; first test
  WhisperKit on three clips (does it keep the English tail of 34238).

Start after §2 (needs device keys and a public address).

## Order of work

| # | what | depends on | result |
|---|---|---|---|
| S1 | series: core algorithm + part render + «1/3» + UI | — | clips > 1 min ready for Stories/Reels |
| S2 | covers: frame pick, overlays, JPEG | S1 (badge) | a cover per part |
| S3 | auth + device keys + signed links + Caddy on de1 | — | access from the internet |
| S4 | publishing: Telegram → YouTube → Instagram | S2, S3 (IG) | publish from Titler |
| S5 | cloud providers in the UI: Scribe v2, Claude review, EL align, EL isolator | keys | provider choice per step |
| S6 | remote runner (Mac ↔ n5), Modal | S3 | a step on another machine / in the cloud |
| S7 | iOS shell | S3 | share extension, background, publish via the IG app |

S1 and S3 are independent and can run in parallel.

## My decisions (review)

- «1/3» threshold: by default at 3+ parts (my reading of "if more than two parts").
- Length presets with a 1 s margin under the limit (59 / 89 / 179).
- Minimum part length ~12 s; below that, rebalance.
- Gateway: own Caddy on de1, not Cloudflare Tunnel (100 MB limit, video uploads) and not Funnel.
- Step A first (proxy to n5); the coordinator with pull workers later.
- Cloud models: Modal (easiest Python deploy, $30/month free), RunPod as backup.
- Rendering stays local everywhere.

## Check when connecting

ElevenLabs: alignment price, Isolator output rate (48 kHz?), background quality by subtraction.
Instagram: 100 or 50 posts/day; Stories on Creator; rupload with Instagram Login.
YouTube: private lock for an unverified project; Shorts covers via the API.
