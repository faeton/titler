import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  badgeText,
  COVER,
  COVER_MAX_BYTES,
  coverAss,
  coverTitleLines,
  suggestFrames,
  type CoverFormat,
  type FrameScore,
  type StartCoverReq,
} from "@titler/core";
import { abs, artifactKey, artifactUrl, ensureArtifact, type Ctx } from "../context.js";
import type { JobContext } from "../jobs.js";
import { coverArgs, frameScanArgs, frameThumbArgs, parseFrameScan } from "../media/commands.js";
import { run } from "../media/run.js";
import type { ProjectRow } from "../store.js";
import { requireArtifact } from "./ingest.js";
import { stamp } from "./render.js";

const V = { scan: "frame_scan@1", cover: "cover@1" };
const SCAN_FPS = 4;

/** Per-frame sharpness of the proxy (cached per proxy). */
export const frameScan = async (ctx: Ctx, p: ProjectRow): Promise<{ frames: FrameScore[]; dir: string }> => {
  const proxy = requireArtifact(ctx, p, "proxy");
  const key = artifactKey("frame_scan", [proxy.key], { fps: SCAN_FPS }, V.scan);
  const a = await ensureArtifact(ctx, { key, projectId: p.id, kind: "frame_scan" }, async (dir) => {
    await run(ctx.cfg.ffmpeg, frameScanArgs(abs(ctx.cfg, proxy.path), `${dir}/scan.txt`, SCAN_FPS));
    const frames = parseFrameScan(await readFile(`${dir}/scan.txt`, "utf8"));
    await writeFile(`${dir}/scan.json`, JSON.stringify({ fps: SCAN_FPS, frames }));
    await rm(`${dir}/scan.txt`, { force: true });
    return { file: "scan.json", meta: { fps: SCAN_FPS, frames: frames.length } };
  });
  const path = abs(ctx.cfg, a.path);
  return { frames: (JSON.parse(await readFile(path, "utf8")) as { frames: FrameScore[] }).frames, dir: dirname(path) };
};

export const coverSuggestions = async (ctx: Ctx, p: ProjectRow, startMs: number, endMs: number) => {
  const { frames } = await frameScan(ctx, p);
  return { suggestions: suggestFrames(frames, startMs, endMs), fps: SCAN_FPS };
};

const thumbing = new Map<string, Promise<void>>();

/** Path of a small proxy JPEG at `atMs` (rounded to 10 ms), made on first request, kept next to the scan. */
export const frameThumb = async (ctx: Ctx, p: ProjectRow, atMs: number): Promise<string> => {
  const { dir } = await frameScan(ctx, p);
  const t = Math.max(0, Math.round(atMs / 10) * 10);
  const file = join(dir, "thumbs", `${t}.jpg`);
  if (existsSync(file)) return file;
  let job = thumbing.get(file);
  if (!job) {
    job = (async () => {
      await mkdir(dirname(file), { recursive: true });
      const proxy = requireArtifact(ctx, p, "proxy");
      await run(ctx.cfg.ffmpeg, frameThumbArgs(abs(ctx.cfg, proxy.path), t, `${file}.tmp.jpg`));
      await rename(`${file}.tmp.jpg`, file);
    })().finally(() => thumbing.delete(file));
    thumbing.set(file, job);
  }
  await job;
  return file;
};

export const cover = async (ctx: Ctx, j: JobContext): Promise<Record<string, unknown>> => {
  const p = ctx.store.getProject(j.job.projectId);
  if (!p?.probe) throw new Error("project not ingested");
  const req = j.job.params as unknown as StartCoverReq;
  const format: CoverFormat = req.format === "youtube" ? "youtube" : "vertical";
  const spec = COVER[format];
  const atMs = Math.min(Math.max(0, Math.round(req.atMs)), Math.max(0, p.probe.durationMs - 1));
  const part = req.part && req.part.total > 1 ? req.part : null;
  const { cover: cs, series } = p.settings;
  const title = (req.title !== undefined ? req.title : cs.title)?.trim() || null;
  const badge = part && (req.badge ?? cs.badge) ? badgeText(part.index, part.total, series.numbering.format) : null;
  const framing = { ...p.settings.framing, ratio: format === "youtube" ? ("16:9" as const) : ("9:16" as const) };
  const out = { w: spec.width, h: spec.height };
  const params = { atMs, format, framing, title: coverTitleLines(title, format), badge };
  const key = artifactKey("cover", [p.sourceSha256], params, V.cover);
  const tag = part ? `_p${part.index + 1}of${part.total}` : "";

  j.progress(0.1, "cover");
  const a = await ensureArtifact(ctx, { key, projectId: p.id, kind: "cover" }, async (dir) => {
    const ass = title || badge ? `${dir}/cover.ass` : null;
    if (ass) await writeFile(ass, coverAss(format, { title, badge }));
    const file = `${stamp(p)}_cover${tag}_${format}_${key.slice(0, 8)}.jpg`;
    // IG takes covers ≤ 8 MB: step the JPEG quality down until it fits.
    let bytes = 0;
    for (const q of [2, 4, 7, 12]) {
      j.throwIfCancelled();
      await run(ctx.cfg.ffmpeg, coverArgs({ src: abs(ctx.cfg, p.sourcePath), atMs, probe: p.probe!, framing, out, ass, fontsDir: ctx.cfg.fontsDir, dest: `${dir}/${file}` }, q), { signal: j.signal });
      bytes = (await stat(`${dir}/${file}`)).size;
      if (bytes <= COVER_MAX_BYTES) break;
    }
    if (bytes > COVER_MAX_BYTES) throw new Error(`cover is ${bytes} bytes, over the 8 MB limit`);
    if (ass) await rm(ass, { force: true });
    return { file, meta: { output: "cover", format, atMs, title, badge, part, width: spec.width, height: spec.height, bytes } };
  });
  return { url: artifactUrl(a), key: a.key, format, atMs, part, bytes: a.meta.bytes ?? null };
};
