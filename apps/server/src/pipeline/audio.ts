import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Artifact, AudioChoice, AudioPreset, CompareClip, StartCompareReq } from "@titler/core";
import { abs, artifactKey, artifactUrl, ensureArtifact, type Ctx } from "../context.js";
import type { JobContext } from "../jobs.js";
import { loudnormApplyArgs, loudnormMeasureArgs, mixArgs, parseLoudnorm } from "../media/commands.js";
import { run } from "../media/run.js";
import type { ProjectRow } from "../store.js";
import { projectArtifact, requireArtifact } from "./ingest.js";

const V = { dfn3: "dfn3@1", mf2: "mf2@1", mix: "mix@1", compare: "compare@1" };

/** Default background level for stem-mixed presets (null = speech only). */
export const MF2_BG_DB: Record<Exclude<AudioPreset, "original">, number | null> = { gentle: -12, voice: -20, strong: null };

/**
 * The 48 kHz wav for an audio choice, producing it if needed. `null` for the
 * original (callers use wav48 / source audio). Cached by content key.
 */
export const ensureVariant = async (ctx: Ctx, p: ProjectRow, choice: AudioChoice, j: JobContext): Promise<Artifact | null> => {
  if (choice.preset === "original") return null;
  const wav48 = requireArtifact(ctx, p, "wav48");
  const wav48Abs = abs(ctx.cfg, wav48.path);
  const progress = (pr: number | null, m: string | null) => j.progress(null, m ?? (pr !== null ? `enhance ${Math.round(pr * 100)}%` : null));

  if (choice.engine === "dfn3") {
    const key = artifactKey("audio_variant", [wav48.key], { engine: "dfn3", strength: choice.preset, dehum: choice.dehum }, V.dfn3);
    return ensureArtifact(ctx, { key, projectId: p.id, kind: "audio_variant" }, async (dir) => {
      const res = await ctx.workers.request(
        "enhance",
        "enhance",
        { wav48: wav48Abs, out_dir: dir, engine: "dfn3", strength: choice.preset, dehum: choice.dehum },
        { signal: j.signal, onProgress: progress },
      );
      if (!existsSync(`${dir}/out.wav`)) throw new Error("enhance worker produced no out.wav");
      return { file: "out.wav", meta: { engine: "dfn3", preset: choice.preset, dehum: choice.dehum, latencyMs: res.latencyMs ?? null, model: res.model ?? null } };
    });
  }

  // mf2: speech/background stems once per (wav48, dehum), presets mixed by ffmpeg.
  const stemsKey = artifactKey("audio_variant", [wav48.key], { engine: "mf2", stems: true, dehum: choice.dehum }, V.mf2);
  const stems = await ensureArtifact(ctx, { key: stemsKey, projectId: p.id, kind: "audio_variant" }, async (dir) => {
    const res = await ctx.workers.request(
      "enhance",
      "enhance",
      { wav48: wav48Abs, out_dir: dir, engine: "mf2", dehum: choice.dehum },
      { signal: j.signal, onProgress: progress },
    );
    for (const f of ["speech.wav", "background.wav"]) if (!existsSync(`${dir}/${f}`)) throw new Error(`enhance worker produced no ${f}`);
    return { file: "speech.wav", meta: { engine: "mf2", stems: ["speech.wav", "background.wav"], dehum: choice.dehum, latencyMs: res.latencyMs ?? null, model: res.model ?? null } };
  });
  const stemDir = abs(ctx.cfg, stems.path).replace(/\/speech\.wav$/, "");
  const bgDb = choice.preset === "strong" ? null : (choice.backgroundDb ?? MF2_BG_DB[choice.preset]);
  const key = artifactKey("audio_variant", [stems.key], { preset: choice.preset, bgDb }, V.mix);
  return ensureArtifact(ctx, { key, projectId: p.id, kind: "audio_variant" }, async (dir) => {
    await run(ctx.cfg.ffmpeg, mixArgs(`${stemDir}/speech.wav`, `${stemDir}/background.wav`, bgDb, `${dir}/mix.wav`), { signal: j.signal });
    return { file: "mix.wav", meta: { engine: "mf2", preset: choice.preset, bgDb, dehum: choice.dehum, stems: stems.key } };
  });
};

export const enhance = async (ctx: Ctx, j: JobContext): Promise<Record<string, unknown>> => {
  const p = ctx.store.getProject(j.job.projectId);
  if (!p) throw new Error("project not found");
  const choice = { ...p.settings.audio, ...(j.job.params as Partial<AudioChoice>) };
  const a = await ensureVariant(ctx, p, choice, j);
  return a ? { key: a.key, url: artifactUrl(a) } : { key: null, url: null };
};

// ---- comparison excerpts -------------------------------------------------------------

const FRAME_MS = 100;

/** Per-100 ms RMS in dBFS of a 16-bit mono PCM wav. */
export const frameDb = (wav: Buffer): number[] => {
  let off = 12;
  let data: Buffer | null = null;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") {
      data = wav.subarray(off + 8, Math.min(wav.length, off + 8 + size));
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error("wav: no data chunk");
  const n = Math.floor((16000 * FRAME_MS) / 1000);
  const out: number[] = [];
  for (let s = 0; s + n * 2 <= data.length; s += n * 2) {
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const v = data.readInt16LE(s + k * 2) / 32768;
      acc += v * v;
    }
    out.push(10 * Math.log10(acc / n + 1e-10));
  }
  return out;
};

export interface Excerpt {
  excerpt: string;
  startMs: number;
  endMs: number;
}

const pct = (xs: number[], q: number): number => {
  if (!xs.length) return -100;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
};

/**
 * Pick ~9 s windows: calm = mostly speech with the quietest background,
 * noisy = mostly speech with the loudest background. Background energy is the
 * median of non-speech frames (or the 15th percentile when the window has
 * almost no pauses). "voices" needs diarisation and is not detected yet.
 */
export const pickExcerpts = (db: number[], speech: { startMs: number; endMs: number }[], durationMs: number, lenMs = 9000): Excerpt[] => {
  if (durationMs <= lenMs * 1.5) return [{ excerpt: "calm", startMs: 0, endMs: durationMs }];
  const isSpeech = db.map((_, i) => {
    const t = i * FRAME_MS + FRAME_MS / 2;
    return speech.some((r) => t >= r.startMs && t < r.endMs);
  });
  const win = lenMs / FRAME_MS;
  const cands: { start: number; speechFrac: number; bg: number }[] = [];
  for (let i = 0; i + win <= db.length; i += 10) {
    const fr = db.slice(i, i + win);
    const sp = isSpeech.slice(i, i + win);
    const nonSpeech = fr.filter((_, k) => !sp[k]);
    const speechFrac = sp.filter(Boolean).length / win;
    const bg = nonSpeech.length >= win * 0.1 ? pct(nonSpeech, 0.5) : pct(fr, 0.15);
    cands.push({ start: i * FRAME_MS, speechFrac, bg });
  }
  if (!cands.length) return [{ excerpt: "calm", startMs: 0, endMs: durationMs }];
  const maxSpeech = Math.max(...cands.map((c) => c.speechFrac));
  const good = cands.filter((c) => c.speechFrac >= Math.min(0.4, maxSpeech * 0.8));
  const calm = good.reduce((a, b) => (b.bg < a.bg ? b : a));
  const others = good.filter((c) => Math.abs(c.start - calm.start) >= lenMs);
  const out: Excerpt[] = [{ excerpt: "calm", startMs: calm.start, endMs: Math.min(durationMs, calm.start + lenMs) }];
  if (others.length) {
    const noisy = others.reduce((a, b) => (b.bg > a.bg ? b : a));
    // Only call it "noisy" when it is meaningfully louder than calm.
    if (noisy.bg - calm.bg >= 3) out.push({ excerpt: "noisy", startMs: noisy.start, endMs: Math.min(durationMs, noisy.start + lenMs) });
  }
  return out;
};

export const COMPARE_PRESETS: AudioPreset[] = ["original", "gentle", "voice", "strong"];

export const compare = async (ctx: Ctx, j: JobContext): Promise<Record<string, unknown>> => {
  const p = ctx.store.getProject(j.job.projectId);
  if (!p?.probe) throw new Error("project not ingested");
  const wav48 = requireArtifact(ctx, p, "wav48");
  const wav16 = requireArtifact(ctx, p, "wav16");
  const durationMs = p.probe.durationMs;

  // Speech regions from VAD when available, else a crude energy gate.
  const db = frameDb(await readFile(abs(ctx.cfg, wav16.path)));
  const vadArt = projectArtifact(ctx, p, "vad");
  let regions: { startMs: number; endMs: number }[];
  if (vadArt) {
    regions = (JSON.parse(await readFile(abs(ctx.cfg, vadArt.path), "utf8")) as { regions: { startMs: number; endMs: number }[] }).regions ?? [];
  } else {
    const gate = pct(db, 0.5) + 6;
    regions = db.flatMap((v, i) => (v > gate ? [{ startMs: i * FRAME_MS, endMs: (i + 1) * FRAME_MS }] : []));
  }

  const req = (j.job.params as StartCompareReq).excerpts;
  const auto = pickExcerpts(db, regions, durationMs);
  const excerpts: Excerpt[] = [];
  for (const e of req ?? ["calm", "noisy", "voices"]) {
    if (typeof e === "string") {
      const found = auto.find((a) => a.excerpt === e);
      if (found) excerpts.push(found);
    } else {
      const s = Math.max(0, Math.round(e.startMs));
      const en = Math.min(durationMs, Math.round(e.endMs));
      if (en - s >= 500) excerpts.push({ excerpt: `custom ${s}-${en}`, startMs: s, endMs: en });
    }
  }
  if (!excerpts.length) excerpts.push(auto[0]!);

  const base = p.settings.audio;
  const sources: { preset: AudioPreset; art: Artifact }[] = [];
  for (const [i, preset] of COMPARE_PRESETS.entries()) {
    j.progress((0.7 * i) / COMPARE_PRESETS.length, `preparing ${preset}`);
    const art = preset === "original" ? wav48 : await ensureVariant(ctx, p, { ...base, preset, backgroundDb: null }, j);
    sources.push({ preset, art: art! });
  }

  const clips: CompareClip[] = [];
  let n = 0;
  const total = excerpts.length * sources.length;
  for (const e of excerpts) {
    const variants: Record<string, string> = {};
    for (const { preset, art } of sources) {
      j.throwIfCancelled();
      const key = artifactKey("compare_clip", [art.key], { startMs: e.startMs, endMs: e.endMs, lufs: -16 }, V.compare);
      const clip = await ensureArtifact(ctx, { key, projectId: p.id, kind: "compare_clip" }, async (dir) => {
        const src = abs(ctx.cfg, art.path);
        const { stderr } = await run(ctx.cfg.ffmpeg, loudnormMeasureArgs(src, e.startMs, e.endMs), { signal: j.signal });
        const m = parseLoudnorm(stderr);
        const file = `${preset}_${e.startMs}.m4a`;
        await run(ctx.cfg.ffmpeg, loudnormApplyArgs(src, e.startMs, e.endMs, m, `${dir}/${file}`), { signal: j.signal });
        return { file, meta: { preset, excerpt: e.excerpt, startMs: e.startMs, endMs: e.endMs, inputLufs: Number(m.input_i), targetLufs: -16 } };
      });
      variants[preset] = artifactUrl(clip);
      j.progress(0.7 + (0.3 * ++n) / total);
    }
    clips.push({ excerpt: e.excerpt, startMs: e.startMs, endMs: e.endMs, variants });
  }
  return { clips, engine: base.engine, available: auto.map((a) => a.excerpt) };
};

