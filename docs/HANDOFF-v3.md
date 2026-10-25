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

_(the n5 session appends here)_
