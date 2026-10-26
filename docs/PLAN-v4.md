# Titler — next stage: go public, anonymise faces, publish

2026-10-27. Follows [PLAN-v3.md](PLAN-v3.md): S1 (series), S2 (covers) and the server side of S3
(auth, device keys, signed links) are done and verified on n5 (HANDOFF-v3 §4). Face anonymisation
design: [PLAN-faces.md](PLAN-faces.md).

Same way of working as v3: develop on **n5**, push, `git pull` on the **Mac (m3max)** and re-run the
checks; both runtimes stay green after every stage. The prompt for the n5 session is at the end.

## Goal of the stage

A clip goes from upload to a **published** post with no other tool in between: faces of bystanders
blurred, cut into parts, covered, and sent to Telegram, YouTube and Instagram from the Export screen.
The metric stays the same: manual work between upload and publication.

## Stages

| # | what | depends on | who | result |
|---|---|---|---|---|
| V0 | housekeeping: carry-overs from v3 | — | n5 session | known bugs closed before new work |
| V1 | S3 rollout: Caddy on de1, gateway secret, owner token | — | **owner** (outward-facing) | Titler reachable from the internet |
| V2 | F1 faces: detect + track, blur/pixelate/box everyone, preview, covers | — | n5 session | a clip with bystanders exports anonymised |
| V3 | S4a publishing core + Telegram | V2 (fail-closed check) | n5 session + owner (bot) | publish to a channel from Titler |
| V4 | S4b YouTube | V3 | n5 session + owner (Google project) | Shorts / series as playlist |
| V5 | S4c Instagram Reels, then Stories | V1, V3 | n5 session + owner (Creator, Meta app) | Reels with cover from Titler |
| V6 | F2 faces: people, only/except, manual boxes, review, eye bar/sticker | V2 | n5 session | "everyone except me" |
| V7 | S5 cloud providers in the UI (Scribe v2, Claude review, EL align/isolator) | keys | n5 session | provider per step |

V1 and V2 are independent; V2 and V3 can run in parallel once V3's fail-closed hook for privacy is
agreed (it's a single check in the publish job). V6 and V7 are the stretch part of this stage.

### V0. Housekeeping (carry-overs from v3)

1. **Worker hang loading parakeet** (asr role hung 3 of 4 full smoke runs on n5). Add
   `faulthandler.register(SIGUSR1)` to every worker at startup (not only through a wrapper) and a
   server-side watchdog: a role that sends no line for N s during `load` gets SIGUSR1, its stack
   is logged, then it's restarted once. Reproduce under load (smoke while e2e runs) and fix the cause
   if the stack shows it (suspects: ORT thread pool vs. torch threads in one process, HF hub lock).
2. **Series overlap + badge**: with the 0.5 s overlap the badge timing still starts at 0 of the
   part; start it after the overlap.
3. **Signed link revocation**: an "invalidate all links" button that rotates `signing_secret`
   (the row exists), plus showing active links' count in «Доступ» (Access).
4. **Passkey login** (WebAuthn) as an option beside the long owner token. Keep the token as the
   fallback. Small, but it decides how comfortable the phone login is once V1 is live.

### V1. S3 rollout on de1 (owner)

Not done by the session: it's an outward-facing change on another box.
- DNS name → de1; Caddy from `deploy/de1/Caddyfile.example`; TLS auto.
- Gateway secret on both sides: `~/.config/titler/server.env` on n5 with `TITLER_GATEWAY_SECRET=…`,
  then `sudo ./deploy/n5/start.sh`.
- `pnpm --filter @titler/server auth owner`, log in from the phone over the public name, create a
  device key for scripts.
- Check: a request without the secret straight to n5's tailnet address still works (tailnet open);
  through de1 without login → 401; a signed link opens in a private window; an expired one → 410.
- The session prepares a `deploy/de1/README.md` checklist with exactly these steps.

### V2. F1 faces (see PLAN-faces.md §6)

1. `faces` worker role + `faces` venv + capability probe on both runtimes (Vision on the Mac, YuNet
   and SCRFD on n5); tracker with unit tests on synthetic boxes (gaps, crossings, hold, interpolation).
2. `bench/faces/`: labelling helper, `score.py`, `REPORT-faces.md`; choose the default detector per
   runtime from measured recall. Labels and frames stay in gitignored `bench/refs/faces/`.
3. Core: `Privacy` type and defaults, `activeBoxes()`, migration for old projects.
4. Server: `faces` and `face_mask` jobs and artifacts; `framingGraph` takes an input label;
   `renderArgs` and `coverArgs` add the mask input and the `maskedmerge` chain; fail-closed when
   privacy is on and the mask is missing; per-part seek for series. `commands.test.ts` for vaapi,
   videotoolbox and libx264.
5. Web: stage overlay (blur via `backdrop-filter`, pixelate via canvas, box), «Лица» (Faces) panel
   with mode/style/strength/padding, track strip with thumbnails, tap a box → "not a face".
6. e2e `--faces <blur|pixelate|box>`: sharpness inside sampled boxes drops below threshold in the
   output and the cover; series + faces together.

Done when: e2e passes on n5 and the Mac; recall ≥ 95 % on the labelled set; a 64 s 9:16 render is at
most 30 % slower with faces on.

### V3. S4a publishing core + Telegram

Core (shared by every platform, per spec-workflow "Publishing and audience"):
- **Destinations**: a connected account per platform (`destinations` table: platform, name, target
  such as channel id, audience, encrypted credentials in the data dir, never in the repo or logs).
- **Publication jobs**: one per (artifact or series part, destination) with state
  `prepared → uploading → processing → published | failed | finish_in_app`, the remote id, attempts
  and an idempotency key. A retry first reconciles with the platform (does the remote object exist?)
  and never posts twice. One platform failing doesn't roll back another.
- **Caption composer**: text per destination, «(1/3)» appended for series parts, hashtags, length
  limits per platform.
- **Pre-send screen**: per destination the account, format, exact audience, caption, cover, final
  video and the privacy state («Faces: blurred, reviewed» / «off»). Publishing is blocked if the
  audience isn't available, and **blocked if privacy is on but the artifact predates the current
  privacy settings**. No silent fallback to a public audience.
- **Series**: parts publish in order; part N waits for part N−1 to reach `published`.

Telegram:
- Bot token + channel set up by the owner; the bot needs post rights. `sendVideo` with
  `supports_streaming`, `cover` from the S2 JPEG, `thumbnail` (≤ 320 px, < 200 kB, generated),
  caption. ≤ 50 MB through the cloud Bot API; above that, a clear "too large" with the size, and an
  optional local Bot API server later (up to 2 GB).
- Test with a private test channel; e2e `--publish telegram` gated on an env token, skipped otherwise.

### V4. S4b YouTube

- Google Cloud project, OAuth consent screen moved to "In production" (in "Testing" refresh tokens
  die after 7 days), channel phone-verified (needed for `thumbnails.set`).
- Resumable `videos.insert`; privacy chosen per publication (default unlisted for the first run);
  `thumbnails.set` for regular videos (Shorts custom thumbnails likely unsupported: report what the
  API returns); series → playlist (`playlists.insert`, `playlistItems.insert`).
- First upload doubles as the check for the unverified-project private lock (REPORT-publishing).

### V5. S4c Instagram

- Owner: account to **Creator**, a Meta app in dev mode with the account as tester, Instagram Login
  (`instagram_business_basic`, `instagram_business_content_publish`).
- Container create with `video_url` = a signed de1 link (needs V1), `cover_url` likewise, poll
  `status_code`, then `media_publish`. Reels first; Stories after checking they work on Creator.
- "Link a Reel" for a series is app-only: after publishing, the UI shows a reminder with the
  parts in order.

### V6. F2 faces, V7. cloud providers

As in PLAN-faces.md §6 (F2) and PLAN-v3 §1 / S5. Start only when V2–V5 are green or blocked on the
owner.

## Things the owner has to do

| when | what |
|---|---|
| V1 | DNS + Caddy on de1, gateway secret on n5, create owner token |
| V2 | label faces on ~10 clips with the helper (≈ 30 min), or approve a smaller set |
| V3 | create a Telegram bot, add it to a test channel and the real channel with post rights |
| V4 | Google Cloud project, consent screen to production, phone-verify the channel |
| V5 | switch IG to Creator, create the Meta app, add the account as tester |
| V7 | ElevenLabs / Anthropic keys in `~/.config/titler/server.env` |

## My decisions (review)

- Faces before publishing: once publishing is one tap, an unblurred bystander is one tap from going
  out. The fail-closed check in the publish job is part of V3, not V2.
- Telegram first, Instagram last, as in PLAN-v3 (friction order); TikTok and Facebook Reels stay out
  of this stage.
- Platform credentials live encrypted in the data dir (key from `server.env`), not in `settings_kv`
  plaintext.
- Publishing defaults to the least public audience each platform offers (unlisted / test channel)
  until the owner switches a destination to its real audience.
- The n5 iGPU (Radeon 890M) stays an experiment: try `onnxruntime` with MIGraphX/ROCm for the face
  detector during V2 and record the numbers in `REPORT-faces.md`; adopt only if it's clearly faster
  and stable.

---

## Prompt for Claude Code on n5

Before starting: `cd ~/work/titler && git pull && pnpm install && sudo ./deploy/n5/start.sh`.
Paste into Claude Code in `~/work/titler` on n5:

---

Implement PLAN-v4 stages **V0 (housekeeping)** and **V2 (F1 faces)**, then **V3 (publishing core +
Telegram)** if time allows. V1 is the owner's; only write `deploy/de1/README.md` for it.

Read first: `docs/PLAN-v4.md`, `docs/PLAN-faces.md`, `docs/spec-workflow.md` ("Framing and captions",
"Publishing and audience"), `docs/PLAN-v3.md` §5, `docs/HANDOFF-v3.md` §4 (what v3 left),
`apps/server/src/media/commands.ts` (`framingGraph`, `renderArgs`, `coverArgs`),
`apps/server/src/pipeline/render.ts` and `cover.ts`, `apps/web/src/player/Stage.tsx`,
`workers/titler_worker/__main__.py` and `docs/worker-protocol.md`.

Constraints:
- Don't break either runtime: no Linux- or Mac-only code paths without a capability probe (the Vision
  detector is Mac-only, so it must be probed; YuNet/SCRFD must work on both). `pnpm test`,
  `pnpm typecheck`, `workers/smoke.py` and `e2e.ts` must pass on n5. The owner re-runs them on the Mac.
- **The repo is public.** Never commit clip transcripts, quotes, frames, face thumbnails, face
  labels, tailnet names/IPs, tokens or keys. Unit tests use synthetic boxes; real data stays in
  gitignored `bench/refs`, `bench/runs`, `bench/samples`.
- Fail closed: privacy on + missing/stale mask → render, cover and publish refuse with a clear error.
- No cloud calls (keys aren't set). Telegram tests only with `TITLER_TG_TEST_TOKEN` +
  `TITLER_TG_TEST_CHAT` in the env; skip otherwise.
- Small focused commits; push when a stage is green.
- At the end, write `docs/HANDOFF-v4.md` (same shape as HANDOFF-v3 §4): what was done, the measured
  numbers (detector recall and ms/frame per runtime, render overhead), what's left, and the exact
  commands to verify on the Mac.

---

## Back on the Mac (after the n5 session)

```bash
cd ~/Sites/titler && git pull && ./deploy/mac/setup.sh      # picks up the faces venv
pnpm test && pnpm typecheck
bench/envs/align-main/bin/python workers/smoke.py            # includes the faces role
pnpm --filter @titler/web build
pnpm --filter @titler/server start &
pnpm --filter @titler/server e2e --compare
pnpm --filter @titler/server e2e <clip with bystanders> --faces blur
pnpm --filter @titler/server e2e <clip with bystanders> --faces pixelate --series 25000 --expect-parts 3
```

Then on the phone: Frame → «Лица» (Faces) → all, blur → scrub through the clip → mark one false
positive → Export → cover for part 1 → check faces are blurred in the video and on the cover.
