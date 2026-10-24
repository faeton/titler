import { cp, mkdtemp, rm } from "node:fs/promises";
import type { Artifact } from "@titler/core";
import { abs, artifactKey, ensureArtifact, errMsg, findArtifact, type Ctx } from "../context.js";
import type { JobContext } from "../jobs.js";
import { PROXY_LONG, proxyArgs, thumbArgs, wav16Args, wav48Args, type Encoder } from "../media/commands.js";
import { probeFile, type ProbeX } from "../media/probe.js";
import { run } from "../media/run.js";
import type { ProjectRow } from "../store.js";

export const V = {
  wav48: "wav48@1",
  wav16: "wav16@1",
  proxy: "proxy@2",
  analyze: "analyze@1",
};

export const keys = {
  wav48: (sha: string) => artifactKey("wav48", [sha], {}, V.wav48),
  wav16: (sha: string) => artifactKey("wav16", [keys.wav48(sha)], {}, V.wav16),
  proxy: (sha: string) => artifactKey("proxy", [sha], { maxLong: PROXY_LONG }, V.proxy),
  peaks: (sha: string) => artifactKey("peaks", [keys.wav16(sha)], { rate: 100 }, V.analyze),
  vad: (sha: string) => artifactKey("vad", [keys.wav16(sha)], { model: "silero-vad" }, V.analyze),
};

export const projectArtifact = (ctx: Ctx, p: ProjectRow, kind: keyof typeof keys): Artifact | null =>
  findArtifact(ctx, keys[kind](p.sourceSha256));

export const requireArtifact = (ctx: Ctx, p: ProjectRow, kind: keyof typeof keys): Artifact => {
  const a = projectArtifact(ctx, p, kind);
  if (!a) throw new Error(`${kind} not ready (ingest not finished?)`);
  return a;
};

export const encoder = (ctx: Ctx, hw = true): Encoder => ({ hw: hw && ctx.cfg.ffmpegHw !== null, vaapiDevice: ctx.cfg.vaapiDevice });

/** Run an ffmpeg encode on VAAPI if available, falling back to libx264 on failure. */
export const withEncoderFallback = async <T>(ctx: Ctx, j: JobContext, fn: (enc: Encoder, ff: string) => Promise<T>): Promise<T & { encoder: string }> => {
  const enc = encoder(ctx);
  if (enc.hw) {
    try {
      return { ...(await fn(enc, ctx.cfg.ffmpegHw!)), encoder: "h264_vaapi" };
    } catch (e) {
      j.throwIfCancelled();
      ctx.log.warn({ job: j.job.id, err: errMsg(e).slice(0, 600) }, "VAAPI encode failed, falling back to libx264");
      j.progress(null, "VAAPI failed, retrying with libx264");
    }
  }
  return { ...(await fn({ ...enc, hw: false }, ctx.cfg.ffmpeg)), encoder: "libx264" };
};

export const ingest = async (ctx: Ctx, j: JobContext): Promise<Record<string, unknown>> => {
  const p = ctx.store.getProject(j.job.projectId);
  if (!p) throw new Error("project not found");
  const src = abs(ctx.cfg, p.sourcePath);
  const { ffmpeg } = ctx.cfg;

  j.progress(0.01, "probe");
  const probe: ProbeX = await probeFile(ctx.cfg.ffprobe, src);
  ctx.store.updateProject(p.id, { probe });
  const sig = j.signal;

  // Audio first: ASR and analysis can start while the proxy encodes.
  j.progress(0.03, "audio");
  const wav48 = await ensureArtifact(ctx, { key: keys.wav48(p.sourceSha256), projectId: p.id, kind: "wav48" }, async (dir) => {
    await run(ffmpeg, wav48Args(src, `${dir}/audio48.wav`, probe.audioCodec !== null, probe.durationMs), { signal: sig });
    return { file: "audio48.wav", meta: { sampleRate: 48000, channels: 2, silent: probe.audioCodec === null } };
  });
  await ensureArtifact(ctx, { key: keys.wav16(p.sourceSha256), projectId: p.id, kind: "wav16" }, async (dir) => {
    await run(ffmpeg, wav16Args(abs(ctx.cfg, wav48.path), `${dir}/audio16.wav`), { signal: sig });
    return { file: "audio16.wav", meta: { sampleRate: 16000, channels: 1 } };
  });
  j.throwIfCancelled();

  const followUps: string[] = [];
  const active = ctx.store.listJobs({ projectId: p.id }).filter((x) => x.status !== "cancelled" && x.status !== "error");
  if (!active.some((x) => x.kind === "analyze")) followUps.push(ctx.sched.enqueue(p.id, "analyze", {}).id);
  if (!active.some((x) => x.kind === "asr"))
    followUps.push(ctx.sched.enqueue(p.id, "asr", { provider: ctx.cfg.asrProvider, seed: true }).id);

  j.progress(0.1, "proxy");
  let encoderUsed = "cached";
  await ensureArtifact(ctx, { key: keys.proxy(p.sourceSha256), projectId: p.id, kind: "proxy" }, async (dir) => {
    await run(ffmpeg, thumbArgs(src, `${dir}/thumb.jpg`, probe.durationMs), { signal: sig });
    const r = await withEncoderFallback(ctx, j, (enc, ff) =>
      run(ff, proxyArgs(src, `${dir}/proxy.mp4`, probe, enc), {
        signal: sig,
        durationMs: probe.durationMs,
        onProgress: (f) => j.progress(0.1 + 0.89 * f),
      }),
    );
    encoderUsed = r.encoder;
    return { file: "proxy.mp4", meta: { encoder: r.encoder, thumb: "thumb.jpg" } };
  });

  return { probe, encoder: encoderUsed, followUps };
};

export const analyze = async (ctx: Ctx, j: JobContext): Promise<Record<string, unknown>> => {
  const p = ctx.store.getProject(j.job.projectId);
  if (!p) throw new Error("project not found");
  const wav16 = abs(ctx.cfg, requireArtifact(ctx, p, "wav16").path);
  // One worker call writes both files into a scratch dir; each is then committed as its own artifact.
  const scratch = await mkdtemp(`${abs(ctx.cfg, "artifacts")}/.analyze-`);
  let workerResult: Record<string, unknown> = {};
  let ran = false;
  const call = async () => {
    if (ran) return;
    workerResult = await ctx.workers.request(
      "analyze",
      "analyze",
      { wav16, peaks_out: `${scratch}/peaks.json`, vad_out: `${scratch}/vad.json` },
      { signal: j.signal, onProgress: (pr, m) => j.progress(pr, m) },
    );
    ran = true;
  };
  try {
    const peaks = await ensureArtifact(ctx, { key: keys.peaks(p.sourceSha256), projectId: p.id, kind: "peaks" }, async (dir) => {
      await call();
      await cp(`${scratch}/peaks.json`, `${dir}/peaks.json`);
      return { file: "peaks.json", meta: { rate: 100 } };
    });
    const vad = await ensureArtifact(ctx, { key: keys.vad(p.sourceSha256), projectId: p.id, kind: "vad" }, async (dir) => {
      await call();
      await cp(`${scratch}/vad.json`, `${dir}/vad.json`);
      return { file: "vad.json", meta: { model: "silero-vad" } };
    });
    // The spec's first step is the voice comparison: prepare it without being asked.
    const hasCompare = ctx.store
      .listJobs({ projectId: p.id })
      .some((x) => x.kind === "compare" && x.status !== "cancelled" && x.status !== "error");
    const compareJob = hasCompare ? null : ctx.sched.enqueue(p.id, "compare", {}).id;
    return { peaks: peaks.key, vad: vad.key, cached: !ran, compareJob, ...workerResult };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
