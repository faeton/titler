# Titler — next stage: faces, Stories out of the box

2026-10-27. Follows [PLAN-v3.md](PLAN-v3.md): S1 (series), S2 (covers) and the server side of S3
(auth, device keys, signed links) are done and verified on n5 (HANDOFF-v3 §4).
Design notes: [PLAN-faces.md](PLAN-faces.md) (face anonymisation),
[REPORT-stories.md](../bench/REPORT-stories.md) (how Stories can be posted automatically).

Same way of working as v3: develop on **n5**, push, `git pull` on the **Mac (m3max)** and re-run the
checks; both runtimes stay green after every stage. The prompt for the n5 session is at the end.

## What changed since PLAN-v3

The owner mostly posts **Stories** (Instagram and Telegram), often to **Close Friends**, as a series
of ~59 s parts. The Stories research settles what that means:

- No official API can post to Close Friends. Instagram's Graph API posts public Stories only, and
  only for professional accounts; Telegram's Bot API `postStory` only works for Business accounts
  and has no audience.
- **Telegram**: the user API (MTProto, `stories.sendStory`) supports every audience (close friends,
  contacts, selected users, exclusions) and is permitted with the owner's own `api_id`. Free accounts
  get 1 live story / 3 per week, which kills a series; **the owner has Premium**, so this is the
  first automation target.
- **Instagram**: Close Friends is only reachable through a private-API client (instagrapi). Its
  login is fragile right now (open challenge-loop issues, Oct 2026) and it's against Instagram's
  terms. **The owner doesn't want to log in yet**, so Instagram stays manual: Titler hands the
  part to the phone and the owner finishes in the app.

So the de1 gateway (PLAN-v3 S3 step A) and the official Instagram API (S4 Instagram) are **parked**:
they only matter for public posts from a professional account. The server-side auth from S3 stays;
it's what protects the Telegram session later.

## Goal of the stage

From upload to a posted Story series with as little manual work as possible:
bystanders' faces blurred, cut into 59 s parts, Telegram Stories posted automatically to the chosen
audience, Instagram parts one tap away on the phone.

## Stages

| # | what | depends on | result |
|---|---|---|---|
| V0 | housekeeping: carry-overs from v3 | — | known bugs closed before new work (in progress) |
| V1 | F1 faces: detect + track, blur/pixelate/box everyone, preview, covers | — | a clip with bystanders exports anonymised |
| V2 | Stories export + phone handoff | — | every part one tap from the Instagram / Telegram composer |
| V3 | Telegram Stories via the owner's account (Kurigram) | V1 (fail-closed), V2 (encode) | a series posted in order to close friends / contacts / chosen people |
| V4 | F2 faces: people, only/except, manual boxes, review, eye bar/sticker | V1 | "everyone except me" |
| V5 | cloud providers in the UI (Scribe v2, Claude review, EL align/isolator) | keys | provider per step |
| — | parked: de1 gateway, official IG/YT/FB API publishing, instagrapi | owner decision | — |

V1 and V2 are independent and can run in parallel. V4 and V5 are the stretch part of this stage.

### V0. Housekeeping (in progress)

1. **Worker hang loading parakeet**: faulthandler stack dumps in every worker, plus a server
   watchdog that dumps, restarts once, then fails the job.
2. **Series overlap + badge**: the badge starts after the overlap.
3. **Signed link revocation**: rotate `signing_secret` from «Доступ» (Access).
4. **Passkey login** beside the owner token (disabled with a reason until a public origin is set).

### V1. F1 faces (see PLAN-faces.md §6)

1. `faces` worker role + `faces` venv + capability probe on both runtimes (Vision on the Mac, YuNet
   and SCRFD on n5); tracker with unit tests on synthetic boxes (gaps, crossings, hold, interpolation).
2. `bench/faces/`: labelling helper, `score.py`, `REPORT-faces.md`; choose the default detector per
   runtime from measured recall. Labels and frames stay in gitignored `bench/refs/faces/`.
3. Core: `Privacy` type and defaults, `activeBoxes()`, defaults for old projects.
4. Server: `faces` and `face_mask` jobs and artifacts; `framingGraph` takes an input label;
   `renderArgs` and `coverArgs` add the mask input and the `maskedmerge` chain; fail-closed when
   privacy is on and the mask is missing; per-part seek for series. `commands.test.ts` for vaapi,
   videotoolbox and libx264.
5. Web: stage overlay (blur via `backdrop-filter`, pixelate via canvas, box), «Лица» (Faces) panel
   with mode/style/strength/padding, track strip with thumbnails, tap a box → "not a face".
6. e2e `--faces <blur|pixelate|box>`: sharpness inside sampled boxes drops below threshold in the
   output and the cover; series + faces together.
7. The n5 iGPU (Radeon 890M): try `onnxruntime` with MIGraphX/ROCm for the detector, record the
   numbers in `REPORT-faces.md`; adopt only if clearly faster and stable.

Done when: e2e passes on n5 and the Mac; recall ≥ 95 % on the labelled set; a 64 s 9:16 render is at
most 30 % slower with faces on.

### V2. Stories export + phone handoff

1. **Story outputs per destination.** The Stories series preset (59 s) already exists. Add output
   profiles:
   - **Instagram Story**: 1080×1920 H.264 faststart MP4 (the current final encode).
   - **Telegram Story**: 720×1280 H.265 (`hvc1`), keyframe every 1 s, streamable (faststart),
     ≤ 30 MB, so ~3 Mbit/s video + 128 kbit/s AAC for 59 s; validated per part (size, duration,
     codec), with a two-pass or capped-CRF fallback if a part comes out too big. Fits both encoder
     kinds (`hevc_vaapi` on n5, `hevc_videotoolbox` on the Mac, `libx265` fallback).
   - Captions and the «1/3» badge follow the existing series settings; nothing new per profile.
2. **«Отправить» (Send) per part**: fetches the part as a `File` and calls
   `navigator.share({ files: [file] })` from the tap (user gesture), so the iPhone share sheet opens
   with the video; the owner picks Instagram or Telegram and finishes in the app (Close Friends
   chosen there). Fallback when `navigator.canShare` says no: a plain download link.
3. **«Сохранить все части» (Save all parts)**: shares/saves the parts in order, one gesture each
   (iOS needs a gesture per share), with a "next: part 2/3" button so it's a quick tap sequence.
4. **Device check, recorded in `bench/REPORT-stories.md`**: what the Instagram and Telegram share
   extensions open for a shared video on the owner's iPhone (Story composer or not), and whether
   Close Friends is selectable from there. This decides how good the manual path is.
5. Part captions: a short text per part (default «(1/3)») copied to the clipboard with the share,
   since Stories have no caption field on Instagram (Telegram does: used by V3).

### V3. Telegram Stories via the owner's account

Per REPORT-stories.md: Kurigram (maintained Pyrogram fork, `send_story` with privacy settings).

1. **Worker role `telegram`** (new venv `tg`: `kurigram`, `tgcrypto`), owner's own `api_id`/`api_hash`
   from my.telegram.org in `~/.config/titler/server.env` (never in the repo or logs).
2. **One-time login** from the web («Доступ» → «Telegram»): phone → code → 2FA password, relayed
   through the worker; the session file lives in the data dir with mode 600, and the UI shows
   "connected as …" and a «Выйти» (Log out) that terminates the session on Telegram's side too.
3. **Audience per series**: everyone / contacts / close friends / selected people, plus "except" list;
   pickers fed from the account's contacts and current close friends list (read-only in this stage).
   Story period (6/12/24/48 h), `pinned` (post to profile), `noforwards` (protect content), caption.
4. **Publication jobs** (the core from PLAN-v3 §5 / spec-workflow, Telegram only for now):
   one job per part with state `prepared → uploading → published | failed`, remote story id,
   attempts, idempotency key; a retry first checks whether the story exists (`stories.getStoriesByID`)
   and never posts twice. Parts go strictly in order, each waiting for the previous to be confirmed.
   `stories.canSendStory` is checked before each part; quota or FloodWait → the series pauses and
   the UI says why and when it can resume. No retry storms.
5. **Pre-send screen**: per part the account, exact audience, period, caption, final video and the
   privacy state («Faces: blurred, reviewed» / «off»). **Blocked if privacy is on but the part
   predates the current privacy settings.** No silent fallback to "everyone": if the chosen audience
   can't be built (e.g. a picked user isn't a contact), it stops.
6. Tests: unit tests with a fake client; a live test only with `TITLER_TG_TEST=1` and a story posted
   to a "selected users: only myself" audience (or the smallest audience Telegram allows), deleted
   right after.

### V4. F2 faces, V5. cloud providers

As in PLAN-faces.md §6 (F2) and PLAN-v3 §1 / S5. Start only when V1–V3 are green or blocked.

### Parked

- de1 gateway (PLAN-v3 S3 step A): needed only for platforms that fetch media by public URL.
  The checklist is in PLAN-v3 §2; nothing to do until a public API path is chosen.
- Official publishing APIs (Instagram Graph, YouTube, Facebook Reels, TikTok): public posts only.
- instagrapi (Instagram private API): the only way to automate Instagram Close Friends. Revisit when
  the owner wants it; first step then is one throwaway test story from n5, with the login approved in
  the app, a pinned library version and `with_challenge_flow=False`.

## Things the owner has to do

| when | what |
|---|---|
| V1 | label faces on ~10 clips with the helper (≈ 30 min), or approve a smaller set |
| V2 | on the iPhone: share one part to Instagram and to Telegram, note which composer opens |
| V3 | create an app at my.telegram.org (api_id/api_hash) and put them in `server.env` on n5; log in once from the web UI |
| V5 | ElevenLabs / Anthropic keys in `server.env` |

## My decisions (review)

- Faces before Telegram automation: once posting is one tap, an unblurred bystander is one tap from
  going out. The fail-closed check is part of V3's pre-send, not optional.
- Telegram through the owner's own account (MTProto), not a bot: only that path has audiences.
- Kurigram over Telethon: it has a ready `send_story` with privacy settings; Telethon only exposes the
  raw request and moved to Codeberg. If Kurigram stalls, the raw `stories.sendStory` call is small
  enough to port.
- Telegram Story encode at 720×1280 HEVC to match the only documented spec; 1080×1920 uploads may
  also work, but untested sizes aren't worth a failed series.
- Instagram stays manual (share sheet) until the owner decides on instagrapi.
- The Telegram session file is as powerful as the account: data dir, mode 600, never logged, never
  served by any route, and covered by the server's auth (S3) if the gateway is ever enabled.

---

## Prompt for Claude Code on n5

Before starting: `cd ~/work/titler && git pull && pnpm install && sudo ./deploy/n5/start.sh`.
Paste into Claude Code in `~/work/titler` on n5:

---

Implement PLAN-v4 stages **V1 (F1 faces)** and **V2 (Stories export + phone handoff)**, then **V3
(Telegram Stories)** if time allows. V0 is being done separately; pull it first if it has landed.

Read first: `docs/PLAN-v4.md`, `docs/PLAN-faces.md`, `bench/REPORT-stories.md`,
`docs/spec-workflow.md` ("Framing and captions", "Publishing and audience"), `docs/HANDOFF-v3.md` §4,
`apps/server/src/media/commands.ts` (`framingGraph`, `renderArgs`, `coverArgs`, encoders),
`apps/server/src/pipeline/render.ts` and `cover.ts`, `apps/web/src/player/Stage.tsx`,
`apps/web/src/features/export/`, `workers/titler_worker/__main__.py` and `docs/worker-protocol.md`.

Constraints:
- Don't break either runtime: no Linux- or Mac-only code paths without a capability probe (the Vision
  detector is Mac-only, so it must be probed; YuNet/SCRFD must work on both; HEVC encode must work
  with vaapi, videotoolbox and libx265). `pnpm test`, `pnpm typecheck`, `workers/smoke.py` and
  `e2e.ts` must pass on n5. The owner re-runs them on the Mac.
- **The repo is public.** Never commit clip transcripts, quotes, frames, face thumbnails, face
  labels, tailnet names/IPs, tokens, keys, api_id/api_hash or session files. Unit tests use synthetic
  data; real data stays in gitignored `bench/refs`, `bench/runs`, `bench/samples`.
- Fail closed: privacy on + missing/stale mask → render, cover, share and publish refuse with a clear
  error.
- No cloud calls. No Instagram login of any kind. Telegram: no live calls unless `TITLER_TG_TEST=1`
  is set and the owner has logged in; tests use a fake client otherwise.
- Small focused commits; push when a stage is green.
- At the end, write `docs/HANDOFF-v4.md` (same shape as HANDOFF-v3 §4): what was done, the measured
  numbers (detector recall and ms/frame per runtime, render overhead, Telegram encode sizes), what's
  left, and the exact commands to verify on the Mac.

---

## Back on the Mac (after the n5 session)

```bash
cd ~/Sites/titler && git pull && ./deploy/mac/setup.sh      # picks up the faces (and tg) venvs
pnpm test && pnpm typecheck
bench/envs/align-main/bin/python workers/smoke.py
pnpm --filter @titler/web build
pnpm --filter @titler/server start &
pnpm --filter @titler/server e2e --compare
pnpm --filter @titler/server e2e <clip with bystanders> --faces blur
pnpm --filter @titler/server e2e <clip with bystanders> --faces pixelate --series stories --expect-parts 2
```

Then on the phone: Frame → «Лица» (Faces) → all, blur → scrub → mark one false positive → Export →
Stories → «Отправить» (Send) part 1 → share to Instagram and to Telegram → check the composer and
that faces are blurred.
