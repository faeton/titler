import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { compileCues, toAss, toSrt, toVtt, type Artifact, type StartRenderReq } from "@titler/core";
import { abs, artifactKey, artifactUrl, canonical, ensureArtifact, findArtifact, sha256, type Ctx } from "../context.js";
import type { JobContext } from "../jobs.js";
import { outputSize, renderArgs } from "../media/commands.js";
import { ffprobeJson } from "../media/probe.js";
import { run } from "../media/run.js";
import type { ProjectRow } from "../store.js";
import { ensureVariant } from "./audio.js";
import { withEncoderFallback } from "./ingest.js";

const V = { render: "render@1", subs: "subs@1" };
const OUTPUTS = ["captioned", "clean", "srt", "vtt"] as const;

/** YYYYMMDD_HHMMSS (UTC) of the recording time, else project creation. */
export const stamp = (p: Pick<ProjectRow, "probe" | "createdAt">): string => {
  const iso = p.probe?.createdAt ?? p.createdAt ?? new Date().toISOString();
  const d = new Date(iso);
  const s = (Number.isNaN(d.getTime()) ? new Date() : d).toISOString();
  return s.replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
};

export interface Validation {
  ok: boolean;
  problems: string[];
  durationMs: number;
}

/** ffprobe an output: has video (+audio when expected), exact dims, duration within 50 ms of the source. */
export const validateOutput = async (
  ffprobe: string,
  path: string,
  want: { w: number; h: number; durationMs: number; audio: boolean },
): Promise<Validation> => {
  const j = (await ffprobeJson(ffprobe, path)) as {
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
    format?: { duration?: string };
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const problems: string[] = [];
  if (!v) problems.push("no video stream");
  else if (v.width !== want.w || v.height !== want.h) problems.push(`dimensions ${v.width}x${v.height} != ${want.w}x${want.h}`);
  if (want.audio && !a) problems.push("no audio stream");
  const durationMs = Math.round(Number(v?.duration ?? j.format?.duration ?? 0) * 1000);
  if (Math.abs(durationMs - want.durationMs) > 50) problems.push(`duration ${durationMs} ms vs source ${want.durationMs} ms`);
  return { ok: !problems.length, problems, durationMs };
};

export const render = async (ctx: Ctx, j: JobContext): Promise<Record<string, unknown>> => {
  const p = ctx.store.getProject(j.job.projectId);
  if (!p?.probe) throw new Error("project not ingested");
  const probe = p.probe;
  const req = j.job.params as Partial<StartRenderReq>;
  const outputs = new Set((req.outputs?.length ? req.outputs : ["captioned", "srt"]).filter((o) => (OUTPUTS as readonly string[]).includes(o)));
  const needsText = outputs.has("captioned") || outputs.has("srt") || outputs.has("vtt");
  const transcript = ctx.store.latestRevision(p.id);
  if (needsText && !transcript) throw new Error("no transcript yet");

  const { framing, style } = p.settings;
  const out = outputSize(framing, probe);
  const cues = transcript ? compileCues(transcript.doc, style, probe.durationMs) : [];
  const cuesHash = sha256(canonical(cues));

  j.progress(0.02, "audio");
  const variant = await ensureVariant(ctx, p, p.settings.audio, j);
  const audioKey = variant?.key ?? "source-audio";
  const hasAudio = variant !== null || probe.audioCodec !== null;
  const st = stamp(p);
  const result: Record<string, string> = {};
  const arts: Artifact[] = [];

  // Subtitles (cheap, always both formats).
  if (outputs.has("srt") || outputs.has("vtt")) {
    const key = artifactKey("subs", [p.sourceSha256], { cuesHash }, V.subs);
    const subs = await ensureArtifact(ctx, { key, projectId: p.id, kind: "subs" }, async (dir) => {
      const base = `${st}_${key.slice(0, 8)}`;
      await writeFile(`${dir}/${base}.srt`, toSrt(cues));
      await writeFile(`${dir}/${base}.vtt`, toVtt(cues));
      return { file: `${base}.srt`, meta: { vtt: `${base}.vtt`, cues: cues.length, transcriptRev: transcript?.rev } };
    });
    if (outputs.has("srt")) result.srt = artifactUrl(subs);
    if (outputs.has("vtt")) result.vtt = artifactUrl(subs, String(subs.meta.vtt));
    arts.push(subs);
  }

  const videoKinds = (["captioned", "clean"] as const).filter((k) => outputs.has(k));
  const spec = (kind: "captioned" | "clean") => {
    const params =
      kind === "captioned" ? { kind, framing, style, cuesHash, out } : { kind, framing, out };
    const key = artifactKey("render", [p.sourceSha256, audioKey], params, V.render);
    const file = `${st}_${kind === "captioned" ? style.look : "clean"}_${key.slice(0, 8)}.mp4`;
    return { kind, key, file };
  };
  const specs = videoKinds.map(spec);
  const missing = specs.filter((s) => !findArtifact(ctx, s.key));
  let encoder = "cached";
  let validations: Record<string, Validation> = {};

  if (missing.length) {
    const scratch = await mkdtemp(`${abs(ctx.cfg, "artifacts")}/.render-`);
    try {
      const assPath = `${scratch}/subs.ass`;
      const cap = missing.find((s) => s.kind === "captioned");
      const clean = missing.find((s) => s.kind === "clean");
      if (cap) await writeFile(assPath, toAss(cues, { width: out.w, height: out.h, style }));
      const src = abs(ctx.cfg, p.sourcePath);
      j.progress(0.05, "encoding");
      const r = await withEncoderFallback(ctx, j, async (enc, ff) => {
        await run(
          ff,
          renderArgs(
            {
              src,
              audio: variant ? abs(ctx.cfg, variant.path) : null,
              hasSourceAudio: probe.audioCodec !== null,
              probe,
              framing,
              out,
              captioned: cap ? { path: `${scratch}/${cap.file}`, ass: assPath } : null,
              clean: clean ? { path: `${scratch}/${clean.file}` } : null,
              fontsDir: ctx.cfg.fontsDir,
            },
            enc,
          ),
          { signal: j.signal, durationMs: probe.durationMs, onProgress: (f) => j.progress(0.05 + 0.9 * f) },
        );
        const v: Record<string, Validation> = {};
        for (const s of missing) {
          v[s.kind] = await validateOutput(ctx.cfg.ffprobe, `${scratch}/${s.file}`, { ...out, durationMs: probe.durationMs, audio: hasAudio });
          if (!v[s.kind]!.ok) throw new Error(`${s.kind} output failed validation: ${v[s.kind]!.problems.join("; ")}`);
        }
        return { v };
      });
      encoder = r.encoder;
      validations = r.v;
      for (const s of missing) {
        await ensureArtifact(ctx, { key: s.key, projectId: p.id, kind: "render" }, async (dir) => {
          await rename(`${scratch}/${s.file}`, `${dir}/${s.file}`);
          return {
            file: s.file,
            meta: { output: s.kind, look: style.look, width: out.w, height: out.h, encoder: r.encoder, transcriptRev: transcript?.rev ?? null, audio: audioKey, validation: r.v[s.kind] },
          };
        });
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  for (const s of specs) {
    const a = requireRender(ctx, s.key);
    result[s.kind] = artifactUrl(a);
    arts.push(a);
  }
  return { outputs: result, artifacts: arts.map((a) => a.key), encoder, validations, transcriptRev: transcript?.rev ?? null, cues: cues.length };
};

const requireRender = (ctx: Ctx, key: string): Artifact => {
  const a = findArtifact(ctx, key);
  if (!a) throw new Error(`render artifact ${key} missing`);
  return a;
};

