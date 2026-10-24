# titler

Mobile-first studio for captioning smart-glasses (Ray-Ban Meta) and phone videos:
upload → choose a clean, natural voice → fix the transcript fast → frame and caption →
export (later: publish per platform). ~90% Russian, plus mixed Russian/Ukrainian and English.

**v2 rebuild in progress.** The v1 app lives at git tag `legacy-v1`.

- Target workflow (owner spec): [docs/spec-workflow.md](docs/spec-workflow.md)
- Plan and architecture: [docs/PLAN-v2.md](docs/PLAN-v2.md), review of v1: [docs/review-codex.md](docs/review-codex.md)
- Worker protocol: [docs/worker-protocol.md](docs/worker-protocol.md)
- Benchmarks (ASR, enhancement, alignment, AMD iGPU, cloud ASR): `bench/REPORT-*.md`
- Running on n5: [docs/n5.md](docs/n5.md)

## Layout

```
apps/web/        React + ProseMirror studio (phone first)
apps/server/     Fastify API, SQLite (node:sqlite), job scheduler, ffmpeg
packages/core/   shared domain model, transcript reconcile/alignment, cue compiler, ASS/SRT
workers/         Python model workers (ASR, alignment, enhancement, VAD) — JSON lines
bench/           benchmark harness and reports (samples/runs/envs are gitignored)
```

## Dev

```bash
pnpm install
pnpm test          # core + server + web tests
pnpm dev           # server :8772, web :5180
```
