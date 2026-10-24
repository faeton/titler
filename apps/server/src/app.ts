import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  DEFAULT_AUDIO,
  type AudioChoice,
  type CompareClip,
  type PatchProjectReq,
  type ProjectSettings,
  type ProjectSummary,
  type ProjectView,
  type ProviderInfo,
  type StartAsrReq,
  type StartCompareReq,
  type StartRenderReq,
} from "@titler/core";
import { loadConfig, type Config } from "./config.js";
import { abs, artifactUrl, type Ctx } from "./context.js";
import { encoderName } from "./media/commands.js";
import { openDb } from "./db.js";
import { Scheduler } from "./jobs.js";
import { compare, enhance } from "./pipeline/audio.js";
import { analyze, ingest, projectArtifact } from "./pipeline/ingest.js";
import { render } from "./pipeline/render.js";
import { applyOps, asr, align, HttpError, LOCAL_ASR, saveTranscript } from "./pipeline/transcript.js";
import { sendFile } from "./serve.js";
import { Store, type ProjectRow } from "./store.js";
import { completeUpload, createUpload, uploadState, writeChunk } from "./uploads.js";
import { WorkerManager } from "./workers.js";

export interface App {
  fastify: FastifyInstance;
  ctx: Ctx;
  close: () => Promise<void>;
}

export interface BuildOpts {
  config?: Partial<Config>;
  /** Don't start the job scheduler (tests drive it). */
  noScheduler?: boolean;
  logger?: boolean;
}

// ---- views --------------------------------------------------------------------

const projectView = (ctx: Ctx, p: ProjectRow): ProjectView => {
  const { sourcePath: _s, ...project } = p;
  const url = (kind: "proxy" | "peaks" | "vad") => {
    const a = projectArtifact(ctx, p, kind);
    return a ? artifactUrl(a) : null;
  };
  const jobs = ctx.store.projectJobs(p.id);
  const proxy = projectArtifact(ctx, p, "proxy");
  const lastCompare = jobs.find((j) => j.kind === "compare" && j.status === "done");
  return {
    project,
    artifacts: ctx.store.listArtifacts(p.id),
    jobs,
    transcript: ctx.store.latestRevision(p.id),
    hypotheses: ctx.store.listHypotheses(p.id).map(({ id, provider, model, lang, createdAt }) => ({ id, provider, model, lang, createdAt })),
    urls: {
      proxy: url("proxy"),
      peaks: url("peaks"),
      vad: url("vad"),
      thumbnail: proxy?.meta.thumb ? artifactUrl(proxy, String(proxy.meta.thumb)) : null,
    },
    compare: (lastCompare?.result?.clips as CompareClip[] | undefined) ?? null,
  };
};

const projectSummary = (ctx: Ctx, p: ProjectRow): ProjectSummary => {
  const { sourcePath: _s, ...project } = p;
  const proxy = projectArtifact(ctx, p, "proxy");
  const renders = ctx.store.listArtifacts(p.id, "render");
  const last = renders[renders.length - 1];
  return {
    project,
    thumbnailUrl: proxy?.meta.thumb ? artifactUrl(proxy, String(proxy.meta.thumb)) : null,
    busy: ctx.store.listJobs({ projectId: p.id, active: true }).length > 0,
    hasTranscript: p.transcriptRev > 0,
    lastRenderUrl: last ? artifactUrl(last) : null,
  };
};

const appleSilicon = process.platform === "darwin" && process.arch === "arm64";

export const providers = (env: NodeJS.ProcessEnv = process.env): ProviderInfo[] => {
  const cloud = (id: string, envKey: string, kind: ProviderInfo["kind"], models: string[], wordTimestamps: boolean): ProviderInfo => ({
    id,
    kind,
    local: false,
    enabled: false,
    reason: env[envKey] ? "cloud execution not implemented yet" : `${envKey} not set`,
    models,
    wordTimestamps,
  });
  return [
    { id: "faster-whisper", kind: "asr", local: true, enabled: true, models: ["large-v3-turbo", "large-v3"], wordTimestamps: true },
    // Apple GPU, greedy-only: faster but loses code-switched English (bench: video-34238), so opt-in.
    appleSilicon
      ? { id: "mlx-whisper", kind: "asr", local: true, enabled: true, models: ["large-v3-turbo", "large-v3"], wordTimestamps: true }
      : { id: "mlx-whisper", kind: "asr", local: true, enabled: false, reason: "needs Apple Silicon", models: ["large-v3-turbo"], wordTimestamps: true },
    { id: "gigaam", kind: "asr", local: true, enabled: true, models: ["gigaam-v3-e2e-rnnt"], wordTimestamps: true },
    { id: "parakeet", kind: "asr", local: true, enabled: true, models: ["nemo-parakeet-tdt-0.6b-v3"], wordTimestamps: true },
    cloud("elevenlabs", "ELEVENLABS_API_KEY", "asr", ["scribe_v2"], true),
    cloud("openai", "OPENAI_API_KEY", "asr", ["gpt-transcribe"], false),
    cloud("gemini", "GEMINI_API_KEY", "asr", ["gemini-3.5-transcribe"], true),
    cloud("soniox", "SONIOX_API_KEY", "asr", ["stt-async"], true),
    cloud("anthropic", "ANTHROPIC_API_KEY", "review", ["claude"], false),
  ];
};

// ---- settings patch -----------------------------------------------------------

const RATIOS = ["9:16", "16:9", "source"];
const FITS = ["fill", "fit_blur", "fit_solid"];
const LOOKS = ["bold", "clean", "focus"];
const PRESETS = ["original", "gentle", "voice", "strong"];

const mergeSettings = (cur: ProjectSettings, patch: PatchProjectReq["settings"]): ProjectSettings => {
  const next: ProjectSettings = {
    audio: { ...cur.audio, ...(patch?.audio ?? {}) },
    framing: { ...cur.framing, ...(patch?.framing ?? {}) },
    style: { ...cur.style, ...(patch?.style ?? {}) },
  };
  const bad = (m: string) => {
    throw new HttpError(400, m);
  };
  const { audio, framing, style } = next;
  if (!PRESETS.includes(audio.preset)) bad("audio.preset");
  if (!["dfn3", "mf2"].includes(audio.engine)) bad("audio.engine");
  if (audio.backgroundDb !== null && !(typeof audio.backgroundDb === "number" && audio.backgroundDb <= 0 && audio.backgroundDb >= -60)) bad("audio.backgroundDb");
  if (typeof audio.dehum !== "boolean") bad("audio.dehum");
  if (!RATIOS.includes(framing.ratio)) bad("framing.ratio");
  if (!FITS.includes(framing.fit)) bad("framing.fit");
  if (!Array.isArray(framing.keyframes)) bad("framing.keyframes");
  framing.keyframes = framing.keyframes
    .map((k) => ({ t: Math.max(0, Math.round(Number(k.t) || 0)), cx: Math.min(1, Math.max(0, Number(k.cx))), cy: Math.min(1, Math.max(0, Number(k.cy))) }))
    .filter((k) => Number.isFinite(k.cx) && Number.isFinite(k.cy))
    .sort((a, b) => a.t - b.t);
  if (!LOOKS.includes(style.look)) bad("style.look");
  if (!(Number.isInteger(style.maxChars) && style.maxChars >= 4 && style.maxChars <= 80)) bad("style.maxChars");
  if (style.maxLines !== 1 && style.maxLines !== 2) bad("style.maxLines");
  if (!(Number.isFinite(style.maxGapMs) && style.maxGapMs >= 0)) bad("style.maxGapMs");
  if (!(typeof style.y === "number" && style.y >= 0 && style.y <= 1)) bad("style.y");
  if (typeof style.wordHighlight !== "boolean") bad("style.wordHighlight");
  if (style.watermark !== null && typeof style.watermark !== "string") bad("style.watermark");
  return next;
};

const sameAudio = (a: AudioChoice, b: AudioChoice) => JSON.stringify({ ...DEFAULT_AUDIO, ...a }) === JSON.stringify({ ...DEFAULT_AUDIO, ...b });

// ---- app ----------------------------------------------------------------------------

export const buildApp = async (opts: BuildOpts = {}): Promise<App> => {
  const cfg = loadConfig(process.env, opts.config);
  for (const d of ["sources", "uploads", "artifacts"]) await mkdir(resolve(cfg.dataDir, d), { recursive: true });
  // Scratch left by a killed process (temp artifact dirs, render/analyze scratch).
  for (const f of await readdir(resolve(cfg.dataDir, "artifacts"))) {
    if (f.startsWith(".") || f.includes(".tmp-")) await rm(resolve(cfg.dataDir, "artifacts", f), { recursive: true, force: true });
  }
  const db = openDb(resolve(cfg.dataDir, "titler.db"));
  const store = new Store(db);
  const fastify = Fastify({
    logger: opts.logger === false ? false : { level: cfg.logLevel },
    bodyLimit: 4 * 1024 * 1024,
  });
  const log = fastify.log;
  const workers = new WorkerManager(
    Object.fromEntries(
      Object.entries(cfg.workers).map(([role, command]) => [role, { command, cwd: cfg.repoRoot, env: cfg.workerEnv, log }]),
    ),
    cfg.workerTimeoutMs,
  );
  const sched = new Scheduler(store, cfg.concurrency);
  const ctx: Ctx = { cfg, store, sched, workers, log };
  sched.onError = (job, err) => log.error({ job: job.id, kind: job.kind, err: err instanceof Error ? err.message : err }, "job failed");
  sched.register("ingest", (j) => ingest(ctx, j));
  sched.register("analyze", (j) => analyze(ctx, j));
  sched.register("asr", (j) => asr(ctx, j));
  sched.register("align", (j) => align(ctx, j));
  sched.register("enhance", (j) => enhance(ctx, j));
  sched.register("compare", (j) => compare(ctx, j));
  sched.register("render", (j) => render(ctx, j));

  fastify.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...err.extra });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) log.error(err);
    return reply.code(status).send({ error: err.message });
  });

  // Raw upload chunks are streamed straight to disk, never buffered.
  fastify.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  const project = (id: string): ProjectRow => {
    const p = store.getProject(id);
    if (!p) throw new HttpError(404, "project not found");
    return p;
  };
  type IdReq = FastifyRequest<{ Params: { id: string } }>;

  // ---- uploads ----
  fastify.post("/api/uploads", async (req) => uploadState(await createUpload(ctx, (req.body ?? {}) as Record<string, unknown>)));
  fastify.get("/api/uploads/:id", async (req: IdReq) => {
    const u = store.getUpload(req.params.id);
    if (!u) throw new HttpError(404, "upload not found");
    return uploadState(u);
  });
  fastify.put(
    "/api/uploads/:id",
    { bodyLimit: 1024 ** 4 },
    async (req: FastifyRequest<{ Params: { id: string }; Querystring: { offset?: string } }>) => {
      const body = req.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== "function") throw new HttpError(415, "send application/octet-stream");
      return uploadState(await writeChunk(ctx, req.params.id, Number(req.query.offset ?? NaN), body as import("node:stream").Readable, req.headers["content-length"] ? Number(req.headers["content-length"]) : undefined));
    },
  );
  fastify.post("/api/uploads/:id/complete", async (req: IdReq) => projectView(ctx, await completeUpload(ctx, req.params.id)));

  // ---- projects ----
  fastify.get("/api/projects", async (req: FastifyRequest<{ Querystring: { archived?: string } }>) =>
    store.listProjects(req.query.archived === "1").map((p) => projectSummary(ctx, p)),
  );
  fastify.get("/api/projects/:id", async (req: IdReq) => projectView(ctx, project(req.params.id)));
  fastify.patch("/api/projects/:id", async (req: IdReq) => {
    const p = project(req.params.id);
    const body = (req.body ?? {}) as PatchProjectReq;
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) throw new HttpError(400, "name");
    const settings = body.settings ? mergeSettings(p.settings, body.settings) : undefined;
    store.updateProject(p.id, {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.archived !== undefined ? { archived: Boolean(body.archived) } : {}),
      ...(settings ? { settings } : {}),
    });
    // Precompute a newly chosen audio variant so render doesn't wait for it.
    if (settings && settings.audio.preset !== "original" && !sameAudio(settings.audio, p.settings.audio)) {
      sched.enqueue(p.id, "enhance", { ...settings.audio });
    }
    return projectView(ctx, project(p.id));
  });
  fastify.delete("/api/projects/:id", async (req: IdReq) => {
    const p = project(req.params.id);
    await sched.cancelProject(p.id);
    const arts = store.listArtifacts(p.id);
    store.deleteProject(p.id);
    await rm(abs(cfg, p.sourcePath), { force: true });
    for (const a of arts) await rm(abs(cfg, dirname(a.path)), { recursive: true, force: true });
    return { ok: true };
  });
  fastify.route({
    method: ["GET", "HEAD"],
    url: "/api/projects/:id/source",
    handler: async (req: IdReq, reply) => {
      const p = project(req.params.id);
      return sendFile(req, reply, abs(cfg, p.sourcePath), { downloadName: p.sourceName });
    },
  });

  // ---- transcript ----
  fastify.get("/api/projects/:id/transcript", async (req: IdReq) => store.latestRevision(project(req.params.id).id));
  fastify.get("/api/projects/:id/transcript/revisions", async (req: IdReq) => store.listRevisions(project(req.params.id).id));
  fastify.get("/api/projects/:id/transcript/:rev", async (req: FastifyRequest<{ Params: { id: string; rev: string } }>) => {
    const r = store.getRevision(project(req.params.id).id, Number(req.params.rev));
    if (!r) throw new HttpError(404, "revision not found");
    return r;
  });
  fastify.put("/api/projects/:id/transcript", async (req: IdReq) =>
    saveTranscript(ctx, project(req.params.id), (req.body ?? {}) as Record<string, unknown>),
  );
  fastify.post("/api/projects/:id/transcript/ops", async (req: IdReq) =>
    applyOps(ctx, project(req.params.id), (req.body ?? {}) as Record<string, unknown>),
  );

  // ---- processing ----
  // Re-run ingest (cached artifacts are reused; only changed stages re-encode).
  fastify.post("/api/projects/:id/ingest", async (req: IdReq) => sched.enqueue(project(req.params.id).id, "ingest", {}, { priority: 5 }));
  fastify.post("/api/projects/:id/asr", async (req: IdReq) => {
    const p = project(req.params.id);
    const body = (req.body ?? {}) as StartAsrReq;
    const provider = body.provider ?? cfg.asrProvider;
    const info = providers().find((x) => x.id === provider && x.kind === "asr");
    if (!info) throw new HttpError(400, `unknown provider ${provider}`);
    if (!info.enabled || !LOCAL_ASR.includes(provider)) throw new HttpError(400, `provider ${provider} unavailable: ${info.reason ?? "disabled"}`);
    return sched.enqueue(p.id, "asr", { provider, ...(body.model ? { model: body.model } : {}), seed: Boolean(body.seed) });
  });
  fastify.get("/api/projects/:id/hypotheses", async (req: IdReq) =>
    store.listHypotheses(project(req.params.id).id).map(({ projectId: _p, params: _x, meta: _m, ...h }) => h),
  );
  fastify.post("/api/projects/:id/compare", async (req: IdReq) => {
    const p = project(req.params.id);
    const body = (req.body ?? {}) as StartCompareReq;
    if (body.excerpts !== undefined && !Array.isArray(body.excerpts)) throw new HttpError(400, "excerpts must be an array");
    return sched.enqueue(p.id, "compare", body.excerpts ? { excerpts: body.excerpts } : {}, { priority: 5 });
  });
  fastify.post("/api/projects/:id/render", async (req: IdReq) => {
    const p = project(req.params.id);
    const body = (req.body ?? {}) as Partial<StartRenderReq>;
    const outputs = Array.isArray(body.outputs) && body.outputs.length ? body.outputs : ["captioned", "srt"];
    if (outputs.some((o) => !["captioned", "clean", "srt", "vtt"].includes(o))) throw new HttpError(400, "bad outputs");
    return sched.enqueue(p.id, "render", { outputs });
  });
  fastify.get("/api/providers", async () => providers());
  fastify.get("/api/jobs", async (req: FastifyRequest<{ Querystring: { projectId?: string; active?: string } }>) =>
    store.listJobs({ projectId: req.query.projectId, active: req.query.active === "1", limit: 200 }),
  );
  fastify.get("/api/jobs/:id", async (req: IdReq) => {
    const j = store.getJob(req.params.id);
    if (!j) throw new HttpError(404, "job not found");
    return j;
  });
  fastify.post("/api/jobs/:id/cancel", async (req: IdReq) => {
    const j = sched.cancel(req.params.id);
    if (!j) throw new HttpError(404, "job not found");
    return j;
  });

  // ---- files ----
  const artifactFile = async (req: FastifyRequest<{ Params: { key: string; file?: string } }>, reply: FastifyReply) => {
    const a = store.getArtifact(req.params.key);
    if (!a) throw new HttpError(404, "artifact not found");
    const dir = abs(cfg, dirname(a.path));
    const file = req.params.file ? basename(req.params.file) : basename(a.path);
    return sendFile(req, reply, join(dir, file), { cache: "private, max-age=31536000, immutable", downloadName: file });
  };
  fastify.route({ method: ["GET", "HEAD"], url: "/api/artifacts/:key", handler: artifactFile });
  fastify.route({ method: ["GET", "HEAD"], url: "/api/artifacts/:key/:file", handler: artifactFile });
  fastify.route({
    method: ["GET", "HEAD"],
    url: "/api/fonts/:file",
    handler: async (req: FastifyRequest<{ Params: { file: string } }>, reply) =>
      sendFile(req, reply, join(cfg.fontsDir, basename(req.params.file)), { cache: "public, max-age=86400" }),
  });
  fastify.get("/api/health", async () => ({
    ok: true,
    vaapi: cfg.ffmpegHw !== null && cfg.hwEncoder === "vaapi",
    encoder: cfg.ffmpegHw !== null ? encoderName(cfg.hwEncoder) : "libx264",
  }));

  // ---- web app (SPA) ----
  fastify.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) {
      return reply.code(404).send({ error: "not found" });
    }
    if (!existsSync(join(cfg.webDist, "index.html"))) return reply.code(404).send({ error: "web app not built" });
    const path = decodeURIComponent(req.url.split("?")[0]!);
    const file = normalize(join(cfg.webDist, path));
    if (file.startsWith(cfg.webDist + sep) && existsSync(file) && !file.endsWith(sep) && !path.endsWith("/")) {
      const immutable = path.startsWith("/assets/");
      return sendFile(req, reply, file, { cache: immutable ? "public, max-age=31536000, immutable" : "no-cache" });
    }
    return sendFile(req, reply, join(cfg.webDist, "index.html"), { cache: "no-cache" });
  });

  if (!opts.noScheduler) {
    const n = sched.start();
    if (n) log.info({ requeued: n }, "re-queued jobs left running by the previous process");
  }

  return {
    fastify,
    ctx,
    close: async () => {
      await fastify.close();
      await sched.stop();
      workers.stopAll();
      db.close();
    },
  };
};
