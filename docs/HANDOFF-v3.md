# Handoff: build PLAN-v3 on n5, test on m3max

Workflow: develop on **n5**, push, then `git pull` on the **MacBook (m3max)** and run the same
checks there. Both runtimes must stay green after every step.

## 1. On n5 before starting

```bash
cd ~/work/titler && git pull          # includes the Mac port (VideoToolbox, mlx-whisper, paths, scrub)
pnpm install
sudo ./deploy/n5/start.sh             # restart the service on the new code (root: POSTINIT script)
```

Changed defaults since the Mac port that matter on n5:
- `apps/web` dev server binds `127.0.0.1` by default. For the phone: `export TITLER_WEB_HOST=<n5 tailnet IP>`
  before `pnpm --filter @titler/web dev`. Web smoke scripts take `TITLER_WEB_URL` (or the URL argument).
- `bench/align/bench_mixed.py` reads its cases from the gitignored `bench/refs/mixed_cases.json`
  (already copied to n5).
- `workers/smoke.py` takes align words from `bench/runs/asr/fw-turbo-auto-novad/` when the asr role is skipped.

## 2. Prompt for Claude Code on n5

Paste into Claude Code in `~/work/titler` on n5:

---

Implement PLAN-v3 stages **S1 (series)** and **S2 (covers)**, then S3 if time allows.
Read first: `docs/PLAN-v3.md` (the plan; §3 series, §4 covers, §2 public API, "Мои решения"),
`bench/REPORT-publishing.md` (platform limits), `docs/PLAN-v2.md`, `docs/spec-workflow.md`
("Публикация"), `docs/mac.md` (the second runtime), `packages/core/src/cues.ts` and
`apps/server/src/pipeline/render.ts` (where parts plug in).

S1 — series:
1. `packages/core`: pure `planSeries(words, vadRegions, durationMs, {maxPartMs, minPartMs≈12000, overlapMs})`
   → cut points in source ms. Equal-length targets, cuts only between words at pauses ≥ 300 ms
   (prefer sentence end / paragraph boundary / VAD silence), window ±15 %, hard cap per part,
   short tail rebalanced, fallback = longest inter-word gap. Unit tests incl. no-pause speech,
   tail rebalance, every part ≤ max, never inside a word.
2. Presets: IG Stories 59 s, IG Reels / YT Shorts / TikTok 179 s, FB Reels 89 s, Telegram none, custom.
   Series plan is per destination and stored in project settings (cuts editable).
3. Numbering overlay «1/3» / «Часть 1 из 3»: option, shown when parts ≥ threshold (default 3),
   top safe zone, first 2–3 s or whole part — drawn through the cue compiler so preview == ASS.
4. Render each part as its own artifact over `[t0, t1]` (accurate seek, trimmed audio variant,
   cues split and re-based), names `…_p1of3.mp4`, per-part validation (duration ≤ max, A/V sync),
   per-part progress, cached per part. Works for vaapi, videotoolbox and libx264
   (`apps/server/test/commands.test.ts` covers all three encoder kinds — extend it).
5. Export screen: destination → timeline with draggable cuts snapping to pauses, part durations
   (red over max), numbering toggle; SRT/VTT per part.
6. Extend `apps/server/scripts/e2e.ts` with `--series <preset|ms>`: video-34585 (64 s) with
   Stories → 2 parts; with `--series 25000` → 3 parts and «1/3» visible.

S2 — covers: frame picker on the proxy (frame stepping + ~5 suggested frames: even spread + the
sharpest), optional title text and «1/3» badge, IG grid (~3:4) and 16:9 guides, JPEG from the
**source** with the same framing (1080×1920 ≤ 8 MB; 1280×720 for YouTube long), one cover per part.

S3 (if time): owner login + hashed revocable device API keys + signed expiring artifact URLs
(`/s/<token>`) in the server; Caddy on de1 → tailnet → n5. No Cloudflare on the upload path.

Constraints:
- Don't break either runtime: no Linux- or Mac-only code paths without a capability probe;
  `pnpm test`, `workers/smoke.py` and `e2e.ts` must pass on n5. The owner re-runs them on the Mac.
- **The repo is public.** Never commit clip transcripts, quotes from clips, tailnet names/IPs or
  keys. Test text in fixtures must be synthetic; real-clip data stays in gitignored `bench/refs`,
  `bench/runs`, `bench/samples`.
- Small focused commits, push when a stage is green. No cloud calls (keys aren't set).
- At the end, append to `docs/HANDOFF-v3.md` §4 what was done, what's left, and the exact
  commands to verify on the Mac.

---

## 3. Back on the MacBook

```bash
cd ~/Sites/titler && git pull
./deploy/mac/setup.sh                 # idempotent; picks up new deps
pnpm test && pnpm typecheck
bench/envs/align-main/bin/python workers/smoke.py          # all worker roles
```

End to end (server on the Mac uses VideoToolbox; `/api/health` → `"encoder":"h264_videotoolbox"`):

```bash
pnpm --filter @titler/web build
pnpm --filter @titler/server start &                        # :8772
pnpm --filter @titler/server e2e --compare
pnpm --filter @titler/server e2e bench/samples/video-34585_singular_display.mov --series stories
pnpm --filter @titler/server e2e bench/samples/video-34585_singular_display.mov --series 25000
```

Browser smoke (headless mobile Chromium; the scripts connect to a Playwright server):

```bash
cd apps/web
node node_modules/playwright-core/cli.js install chromium-headless-shell   # once
node node_modules/playwright-core/cli.js run-server --port 30150 --host 127.0.0.1 &
npx vite --host 127.0.0.1 --port 5180 --strictPort &
# the clip must be < 50 MB (Playwright buffer limit) — cut one:
ffmpeg -v error -y -ss 10 -i ../../bench/samples/video-34238_singular_display.mov -t 23 -c copy -tag:v hvc1 /tmp/clip.mp4
node scripts/smoke-server.mjs /tmp/clip.mp4 http://127.0.0.1:5180
# mock UI: bash scripts/make-dev-media.sh; VITE_MOCK=1 npx vite --port 5181 &; node scripts/smoke.mjs http://127.0.0.1:5181
```

Phone → laptop: `tailscale serve --bg --https=8772 http://127.0.0.1:8772` on the Mac, open the
`https://m3max.<tailnet>.ts.net:8772` URL on the phone, run upload → edit → series → cover → export.
Visually check one part of each series: «1/3» badge, captions not cut at the part boundary,
part ≤ its limit.

## 4. Progress log

### 2026-10-25, n5 session: S1 + S2 + S3 (server side) done

**S1: series**
- `packages/core/src/series.ts`: `planSeries` (equal targets, cuts only between words at pauses ≥ 300 ms,
  sentence / paragraph end / VAD silence preferred, ±15 % window widened once to ±30 % before adding a
  part, DP with a hard cap of every part ≤ max and ≥ ~12 s, fallback to the longest gap, then a point outside
  a word), `resolveCuts` (hand cuts per destination, else automatic), `snapCut`, `seriesParts` (+ overlap),
  `seriesBadge`. Presets: Stories 59 s, Reels / Shorts / TikTok 179 s, FB 89 s, Telegram none, custom.
  `compilePartCues` assigns words to parts by midpoint and re-bases them. Badge geometry is in `BADGE`,
  and the ASS writer draws it as a boxed top-centre event.
- Settings gained `series` (destination, customMaxMs, overlapMs, numbering, cuts per destination) and
  `cover`. Old projects get defaults: Telegram, so nothing changes until a destination is picked.
- Render: `POST /render { outputs, series: true }` gives one artifact per part, `…_p1of3_<key>.mp4` and SRT/VTT
  per part. Input `-ss` on the source and the processed audio, output `-t`. An input `-t` lets one extra
  frame of the VFR glasses footage through (+57 ms). Each part is validated: length ±50 ms, ≤ limit,
  A/V drift ≤ 100 ms plus the source's own drift. Hand cuts that make a part over the limit are refused
  before encoding. Progress and caching are per part. Whole-clip artifact keys are unchanged.
  `commands.test.ts` covers vaapi, videotoolbox and libx264.
- Export screen: destination grid, timeline (parts, pause ticks, playhead; drag a cut and it snaps to the
  nearest pause; tap a part to play it; «Авто» resets), part lengths in red when over the limit, numbering
  options (format, 2.5 s or whole part, 2+ or 3+ parts), 0.5 s overlap toggle, one caption per part with
  «(1/3)», outputs grouped by part. On this tab the stage previews each part's own cue layout and the
  badge, using the same core functions as the render.
- e2e `--series <destination|alias|ms> [--expect-parts N]`. On n5 (VAAPI), video-34585 (64.3 s):
  `stories` → 2 parts (30.14 + 34.19 s, no badge since fewer than 3); `25000` → 3 parts (22.8 / 19.8 / 21.7 s),
  «1/3» `visible`. The script diffs the top band of the captioned vs the clean frame: 14.4 at 1 s, 0.0 at 4 s.
  Frames go to `bench/runs/e2e/` (gitignored).

**S2: covers**
- `core/cover.ts`: `COVER` layouts (1080×1920 with title and badge inside the IG ~3:4 grid crop,
  1280×720 YouTube), `wrapTitle`, `coverAss`, `suggestFrames` (even spread moved to the sharpest nearby
  frame, plus the sharpest overall).
- Server: `POST /api/projects/:id/cover { atMs, format, part?, title?, badge? }` is a `cover` job. It takes
  one frame from the **source** (accurate seek) with the project framing, burns in title and badge via
  libass, and writes a JPEG, stepping quality down to stay ≤ 8 MB (~320 KB in practice).
  `GET /cover/suggestions` scans proxy edge density at 4 fps, once per proxy (0.6 s for 64 s).
  `GET /frame/<ms>.jpg` serves cached thumbnails. Title and badge go in the request, so the JPEG matches
  the preview even if the debounced settings PATCH hasn't landed yet.
- Export screen «Обложка»: format, part, ‹ кадр / кадр ›, suggested frames, title, badge toggle. The
  canvas preview draws the proxy frame with the same framing and core layout, with IG grid (dashed) and
  16:9 (dotted) guides. Covers are listed with download links.

**S3: public API, server side (the de1 gateway is not deployed)**
- `apps/server/src/auth.ts`: requests that carry `X-Titler-Gateway: <TITLER_GATEWAY_SECRET>` (set by
  Caddy) must log in. A wrong secret gets 401. Tailnet and local requests stay open (`TITLER_AUTH=gateway`,
  the default). `all` = everyone logs in; `off` = no one.
- Owner token → `POST /api/auth/login` → session cookie (HttpOnly; Secure when the visitor is on HTTPS).
  Device keys use `Authorization: Bearer tk_…`; they are sha256-hashed, named, revocable, record last use,
  and can't manage keys. Signed links: `POST /api/artifacts/:key/sign` → `/s/<token>/<name>`, HMAC, one
  file, 60 s – 7 d, Range supported; tampered → 403, expired → 410. CORS only for `TITLER_CORS_ORIGINS`.
  Rate limits per client: 10 logins/min, 1200 requests/min. DB migration 2 adds `auth_keys`, `sessions`
  and `settings_kv`.
- CLI: `pnpm --filter @titler/server auth owner [name] | device <name> | list | revoke <id>`.
- Web: the login screen appears only when the server asks for it. «Доступ» (projects header) lists,
  creates (shown once) and revokes device keys, and has «Выйти».
- `deploy/de1/Caddyfile.example` (placeholders, no names). `deploy/n5/start.sh` now loads the optional
  `~/.config/titler/server.env`; the file doesn't exist yet.

**Verified on n5**: `pnpm test` (core 34, server 45, web 11), `pnpm typecheck`, e2e `--compare`, e2e
`--series stories --expect-parts 2`, e2e `--series 25000 --expect-parts 3`, `smoke-server.mjs` (incl.
series panel and a part cover), `smoke.mjs` (mock), `smoke-access.mjs` (throwaway server with a
gateway secret, scratch data dir). `workers/smoke.py`: **0 failed checks (40 s)**, but only on the
4th try. Three earlier full runs hung in the asr role while loading parakeet. The worker was busy with no
«loaded parakeet» line, and it also hung with `HF_HUB_OFFLINE=1`. The same sequence run in-process, an
asr-only smoke and the passing full run (worker started through a `faulthandler` wrapper) all load parakeet
in ~1.6 s. Not caused by this work (workers untouched); the first two hangs overlapped e2e and browser runs
on the live server. If it recurs, dump the worker's stack (`faulthandler.register(SIGUSR1)` via
`TITLER_WORKER_ASR`) to see where it blocks.

**Left / for the owner**
- S3 step A on de1: DNS name → de1, Caddy with `deploy/de1/Caddyfile.example`, a gateway secret on both
  sides (`~/.config/titler/server.env` on n5: `TITLER_GATEWAY_SECRET=…`, then `sudo ./deploy/n5/start.sh`),
  `pnpm --filter @titler/server auth owner`. Not done: it's an outward-facing change on another box.
- Passkey login (only the long token exists), revoking signed links (rotate the `signing_secret` row).
- Cover delivery per platform and «(1/3)» in captions sent by API belong to S4 (publishing).
- The overlap option reuses the last 0.5 s; the badge timing then still starts at 0 of the part.

**On the Mac** (after `git pull && ./deploy/mac/setup.sh`):

```bash
pnpm test && pnpm typecheck
bench/envs/align-main/bin/python workers/smoke.py
pnpm --filter @titler/web build
pnpm --filter @titler/server start &                        # /api/health → "encoder":"h264_videotoolbox"
pnpm --filter @titler/server e2e --compare
pnpm --filter @titler/server e2e bench/samples/video-34585_singular_display.mov --series stories --expect-parts 2
pnpm --filter @titler/server e2e bench/samples/video-34585_singular_display.mov --series 25000 --expect-parts 3
open bench/runs/e2e/*_p1of3.jpg                              # «1/3» top-centre, captions intact
# browser (Playwright server + vite as in §3):
node scripts/smoke-server.mjs "" http://127.0.0.1:5180       # from apps/web; series + cover checks
# access, against a throwaway server:
TITLER_DATA=/tmp/titler-auth TITLER_PORT=8773 TITLER_GATEWAY_SECRET=s pnpm --filter @titler/server start &
TITLER_DATA=/tmp/titler-auth pnpm --filter @titler/server auth owner smoke   # prints to_…
GATEWAY_SECRET=s OWNER_TOKEN=to_… node apps/web/scripts/smoke-access.mjs http://127.0.0.1:8773
```

On the phone: Export → pick Stories / custom → drag a cut → play a part (badge, captions) → «Экспортировать
N частей» → make a cover for part 2 → download.
