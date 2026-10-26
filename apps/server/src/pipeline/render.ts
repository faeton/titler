import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  compileCues,
  compilePartCues,
  resolveCuts,
  seriesBadge,
  seriesParts,
  seriesWords,
  toAss,
  toSrt,
  toVtt,
  type Artifact,
  type Badge,
  type Cue,
  type SpeechRegion,
  type StartRenderReq,
} from "@titler/core";
import { abs, artifactKey, artifactUrl, canonical, ensureArtifact, findArtifact, sha256, type Ctx } from "../context.js";
import type { JobContext } from "../jobs.js";
import { outputSize, renderArgs } from "../media/commands.js";
import { ffprobeJson, type ProbeX } from "../media/probe.js";
import { run } from "../media/run.js";
import type { ProjectRow } from "../store.js";
import { ensureVariant } from "./audio.js";
import { projectArtifact, withEncoderFallback } from "./ingest.js";

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
  /** |audio − video| stream duration / start difference, ms (A/V sync). */
  avDriftMs?: number;
}

/**
 * ffprobe an output: has video (+audio when expected), exact dims, duration
 * within 50 ms of the expected length, ≤ maxMs when given, audio and video
 * starting and ending together (within 100 ms plus whatever drift the source has).
 */
export const validateOutput = async (
  ffprobe: string,
  path: string,
  want: { w: number; h: number; durationMs: number; audio: boolean; maxMs?: number | null; avToleranceMs?: number },
): Promise<Validation> => {
  const j = (await ffprobeJson(ffprobe, path)) as {
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string; start_time?: string }[];
    format?: { duration?: string };
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const problems: string[] = [];
  if (!v) problems.push("no video stream");
  else if (v.width !== want.w || v.height !== want.h) problems.push(`dimensions ${v.width}x${v.height} != ${want.w}x${want.h}`);
  if (want.audio && !a) problems.push("no audio stream");
  const durationMs = Math.round(Number(v?.duration ?? j.format?.duration ?? 0) * 1000);
  if (Math.abs(durationMs - want.durationMs) > 50) problems.push(`duration ${durationMs} ms vs expected ${want.durationMs} ms`);
  // Presets already keep ~1 s below the platform cap; allow the last frame's spill.
  if (want.maxMs && durationMs > want.maxMs + 50) problems.push(`duration ${durationMs} ms over the ${want.maxMs} ms limit`);
  let avDriftMs: number | undefined;
  if (v && a) {
    const ms = (x: string | undefined) => Math.round(Number(x ?? 0) * 1000);
    avDriftMs = Math.max(Math.abs(ms(a.start_time) - ms(v.start_time)), Math.abs(ms(a.duration) + ms(a.start_time) - ms(v.duration) - ms(v.start_time)));
    if (avDriftMs > (want.avToleranceMs ?? 100)) problems.push(`audio/video out of sync by ${avDriftMs} ms`);
  }
  return { ok: !problems.length, problems, durationMs, ...(avDriftMs !== undefined ? { avDriftMs } : {}) };
};

export const loadVad = async (ctx: Ctx, p: ProjectRow): Promise<SpeechRegion[]> => {
  const a = projectArtifact(ctx, p, "vad");
  if (!a) return [];
  try {
    return (JSON.parse(await readFile(abs(ctx.cfg, a.path), "utf8")) as { regions?: SpeechRegion[] }).regions ?? [];
  } catch {
    return [];
  }
};

export interface PartPlan {
  index: number;
  total: number;
  startMs: number;
  endMs: number;
  /** Overlap repeated from the previous part (the badge starts after it). */
  leadMs: number;
}

export interface PartResult extends PartPlan {
  outputs: Record<string, string>;
  validations: Record<string, Validation>;
  badge: string | null;
}

export const render = async (ctx: Ctx, j: JobContext): Promise<Record<string, unknown>> => {
  const p = ctx.store.getProject(j.job.projectId);
  if (!p?.probe) throw new Error("project not ingested");
  const probe = p.probe;
  const req = j.job.params as Partial<StartRenderReq>;
  const outputs = new Set((req.outputs?.length ? req.outputs : ["captioned", "srt"]).filter((o) => (OUTPUTS as readonly string[]).includes(o)));
  const needsText = outputs.has("captioned") || outputs.has("srt") || outputs.has("vtt");
  const transcript = ctx.store.latestRevision(p.id);
  if (needsText && !transcript) throw new Error("no transcript yet");

  const { framing, style, series } = p.settings;
  const out = outputSize(framing, probe);
  const D = probe.durationMs;

  // Parts: the whole clip, or the series plan for the chosen destination.
  let parts: PartPlan[] = [{ index: 0, total: 1, startMs: 0, endMs: D, leadMs: 0 }];
  let maxMs: number | null = null;
  let manual = false;
  if (req.series) {
    const plan = resolveCuts(series, seriesWords(transcript?.doc ?? null, D), await loadVad(ctx, p), D);
    const ranges = seriesParts(plan.cuts, D, series.overlapMs);
    maxMs = plan.maxPartMs;
    manual = plan.manual;
    parts = ranges.map((r, index) => ({ index, total: ranges.length, ...r }));
    const over = maxMs === null ? [] : parts.filter((x) => x.endMs - x.startMs > maxMs!);
    if (over.length) throw new Error(`part ${over.map((x) => x.index + 1).join(", ")} longer than ${Math.round(maxMs! / 1000)} s — move the cuts`);
  }
  const isSeries = parts.length > 1;

  j.progress(0.02, "audio");
  const variant = await ensureVariant(ctx, p, p.settings.audio, j);
  const audioKey = variant?.key ?? "source-audio";
  const hasAudio = variant !== null || probe.audioCodec !== null;
  // A source whose audio track is shorter than its video can't render in sync at the end.
  const srcAudioMs = (probe as Partial<ProbeX>).audioDurationMs;
  const avToleranceMs = 100 + (typeof srcAudioMs === "number" ? Math.abs(srcAudioMs - D) : 0);
  const st = stamp(p);
  const arts: Artifact[] = [];
  const results: PartResult[] = [];
  let encoder = "cached";
  let totalCues = 0;

  for (const part of parts) {
    const len = part.endMs - part.startMs;
    const tag = isSeries ? `_p${part.index + 1}of${part.total}` : "";
    const label = isSeries ? `part ${part.index + 1}/${part.total}` : "";
    const progress = (f: number, m?: string) => j.progress(0.05 + (0.93 * (part.index + f)) / parts.length, m ? [label, m].filter(Boolean).join(" · ") : undefined);
    const cues: Cue[] = !transcript ? [] : isSeries ? compilePartCues(transcript.doc, style, D, part) : compileCues(transcript.doc, style, D);
    const badge: Badge | null = isSeries ? seriesBadge(series.numbering, part.index, part.total, len, part.leadMs) : null;
    const cuesHash = sha256(canonical(cues));
    // Undefined keys drop out of the canonical params, so whole-clip keys match pre-series renders.
    const partKey = isSeries ? { startMs: part.startMs, endMs: part.endMs, index: part.index, total: part.total } : undefined;
    const partMeta = isSeries ? { part: { ...part, destination: series.destination, manual } } : {};
    const result: PartResult = { ...part, outputs: {}, validations: {}, badge: badge?.text ?? null };
    totalCues += cues.length;

    // Subtitles (cheap, always both formats).
    if (outputs.has("srt") || outputs.has("vtt")) {
      const key = artifactKey("subs", [p.sourceSha256], { cuesHash, part: partKey }, V.subs);
      const subs = await ensureArtifact(ctx, { key, projectId: p.id, kind: "subs" }, async (dir) => {
        const base = `${st}${tag}_${key.slice(0, 8)}`;
        await writeFile(`${dir}/${base}.srt`, toSrt(cues));
        await writeFile(`${dir}/${base}.vtt`, toVtt(cues));
        return { file: `${base}.srt`, meta: { vtt: `${base}.vtt`, cues: cues.length, transcriptRev: transcript?.rev, ...partMeta } };
      });
      if (outputs.has("srt")) result.outputs.srt = artifactUrl(subs);
      if (outputs.has("vtt")) result.outputs.vtt = artifactUrl(subs, String(subs.meta.vtt));
      arts.push(subs);
    }

    const videoKinds = (["captioned", "clean"] as const).filter((k) => outputs.has(k));
    const specs = videoKinds.map((kind) => {
      const params =
        kind === "captioned" ? { kind, framing, style, cuesHash, out, part: partKey, badge: badge ?? undefined } : { kind, framing, out, part: partKey };
      const key = artifactKey("render", [p.sourceSha256, audioKey], params, V.render);
      const file = `${st}_${kind === "captioned" ? style.look : "clean"}${tag}_${key.slice(0, 8)}.mp4`;
      return { kind, key, file };
    });
    const missing = specs.filter((s) => !findArtifact(ctx, s.key));

    if (missing.length) {
      const scratch = await mkdtemp(`${abs(ctx.cfg, "artifacts")}/.render-`);
      try {
        const assPath = `${scratch}/subs.ass`;
        const cap = missing.find((s) => s.kind === "captioned");
        const clean = missing.find((s) => s.kind === "clean");
        if (cap) await writeFile(assPath, toAss(cues, { width: out.w, height: out.h, style, badge }));
        const src = abs(ctx.cfg, p.sourcePath);
        progress(0, "encoding");
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
                range: isSeries ? part : null,
              },
              enc,
            ),
            { signal: j.signal, durationMs: len, onProgress: (f) => progress(f) },
          );
          const v: Record<string, Validation> = {};
          for (const s of missing) {
            v[s.kind] = await validateOutput(ctx.cfg.ffprobe, `${scratch}/${s.file}`, { ...out, durationMs: len, audio: hasAudio, maxMs, avToleranceMs });
            if (!v[s.kind]!.ok) throw new Error(`${s.kind}${tag} output failed validation: ${v[s.kind]!.problems.join("; ")}`);
          }
          return { v };
        });
        encoder = r.encoder;
        Object.assign(result.validations, r.v);
        for (const s of missing) {
          await ensureArtifact(ctx, { key: s.key, projectId: p.id, kind: "render" }, async (dir) => {
            await rename(`${scratch}/${s.file}`, `${dir}/${s.file}`);
            return {
              file: s.file,
              meta: { output: s.kind, look: style.look, width: out.w, height: out.h, encoder: r.encoder, transcriptRev: transcript?.rev ?? null, audio: audioKey, validation: r.v[s.kind], ...partMeta },
            };
          });
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }

    for (const s of specs) {
      const a = requireRender(ctx, s.key);
      result.outputs[s.kind] = artifactUrl(a);
      if (!result.validations[s.kind] && a.meta.validation) result.validations[s.kind] = a.meta.validation as Validation;
      arts.push(a);
    }
    results.push(result);
  }

  const first = results[0]!;
  return {
    outputs: isSeries ? Object.fromEntries(results.flatMap((r) => Object.entries(r.outputs).map(([k, u]) => [`${k}_p${r.index + 1}`, u]))) : first.outputs,
    artifacts: arts.map((a) => a.key),
    encoder,
    validations: isSeries ? Object.fromEntries(results.flatMap((r) => Object.entries(r.validations).map(([k, v]) => [`${k}_p${r.index + 1}`, v]))) : first.validations,
    transcriptRev: transcript?.rev ?? null,
    cues: totalCues,
    ...(req.series ? { series: { destination: series.destination, maxPartMs: maxMs, manual, parts: results } } : {}),
  };
};

const requireRender = (ctx: Ctx, key: string): Artifact => {
  const a = findArtifact(ctx, key);
  if (!a) throw new Error(`render artifact ${key} missing`);
  return a;
};
