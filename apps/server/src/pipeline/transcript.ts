import {
  alignmentWindows,
  allWords,
  applyAlignment,
  docFromHypothesis,
  reconcile,
  type AlignedWord,
  type AlignWindow,
  type EditedParagraph,
  type SaveTranscriptRes,
  type TranscriptDoc,
  type TranscriptOp,
  type TranscriptRevision,
  type Word,
} from "@titler/core";
import { abs, type Ctx } from "../context.js";
import type { JobContext } from "../jobs.js";
import type { ProjectRow } from "../store.js";
import { projectArtifact, requireArtifact } from "./ingest.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const EMPTY: TranscriptDoc = { paragraphs: [] };

// ---- ASR ---------------------------------------------------------------------------

export const LOCAL_ASR = ["faster-whisper", "mlx-whisper", "gigaam", "parakeet"];

const int = (v: unknown): number => Math.max(0, Math.round(Number(v) || 0));

export const asr = async (ctx: Ctx, j: JobContext): Promise<Record<string, unknown>> => {
  const p = ctx.store.getProject(j.job.projectId);
  if (!p) throw new Error("project not found");
  const wav16 = requireArtifact(ctx, p, "wav16");
  const provider = String(j.job.params.provider ?? ctx.cfg.asrProvider);
  const model = j.job.params.model ? String(j.job.params.model) : undefined;
  const language = j.job.params.language ? String(j.job.params.language) : undefined;
  const params = { model: model ?? null, language: language ?? null };

  let hyp = ctx.store.findHypothesis(p.id, wav16.key, provider, params);
  const cached = !!hyp;
  if (!hyp) {
    const res = await ctx.workers.request(
      "asr",
      "asr",
      { wav16: abs(ctx.cfg, wav16.path), provider, ...(model ? { model } : {}), ...(language ? { language } : {}) },
      { signal: j.signal, onProgress: (pr, m) => j.progress(pr, m) },
    );
    const raw = Array.isArray(res.words) ? (res.words as Record<string, unknown>[]) : [];
    const words = raw
      .filter((w) => typeof w.text === "string" && w.text.trim())
      .map((w) => {
        const start = int(w.start);
        return {
          text: String(w.text).trim(),
          start,
          end: Math.max(start, int(w.end)),
          ...(typeof w.conf === "number" ? { conf: w.conf } : {}),
          ...(typeof w.lang === "string" ? { lang: w.lang } : {}),
        };
      });
    hyp = ctx.store.addHypothesis({
      projectId: p.id,
      provider,
      model: String(res.model ?? model ?? "default"),
      audioKey: wav16.key,
      lang: typeof res.lang === "string" ? res.lang : null,
      words,
      params,
      meta: { timing: res.timing ?? null, retried: res.retried ?? false, degenerate: res.degenerate ?? null, langProb: res.langProb ?? null, dropped: res.dropped ?? null },
    });
  }

  let seeded = false;
  if (j.job.params.seed) {
    const h = hyp;
    // Atomic check-and-create: never overwrite an existing transcript.
    seeded = ctx.store.tx(() => {
      if (ctx.store.latestRevision(p.id)) return false;
      ctx.store.addRevision(p.id, docFromHypothesis(h), "asr");
      return true;
    });
  }
  return { hypothesisId: hyp.id, words: hyp.words.length, lang: hyp.lang, seeded, cached };
};

// ---- saving --------------------------------------------------------------------------

const assertParagraphs = (v: unknown): EditedParagraph[] => {
  if (!Array.isArray(v)) throw new HttpError(400, "paragraphs must be an array");
  for (const p of v) {
    if (!p || typeof p !== "object") throw new HttpError(400, "bad paragraph");
    const { id, runs } = p as { id: unknown; runs: unknown };
    if (id !== null && typeof id !== "string") throw new HttpError(400, "paragraph id must be string|null");
    if (!Array.isArray(runs)) throw new HttpError(400, "paragraph runs must be an array");
    for (const r of runs) {
      if (!r || typeof (r as { text: unknown }).text !== "string") throw new HttpError(400, "run text must be a string");
      const wid = (r as { wordId: unknown }).wordId;
      if (wid !== null && wid !== undefined && typeof wid !== "string") throw new HttpError(400, "run wordId must be string|null");
    }
  }
  return v as EditedParagraph[];
};

/**
 * Revisions after `baseRev` that were written by the aligner only change
 * timings of words the client already has, so a save based on them is not
 * stale: we reconcile against the latest doc, which keeps those timings.
 */
const checkBase = (ctx: Ctx, projectId: string, baseRev: number): TranscriptRevision | null => {
  const latest = ctx.store.latestRevision(projectId);
  const cur = latest?.rev ?? 0;
  if (!Number.isInteger(baseRev) || baseRev < 0) throw new HttpError(400, "baseRev must be a non-negative integer");
  const stale = baseRev > cur || (baseRev < cur && ctx.store.actorsAfter(projectId, baseRev).some((a) => a !== "align"));
  if (stale) throw new HttpError(409, "stale", { current: latest });
  return latest;
};

const durationOf = (p: ProjectRow, doc: TranscriptDoc): number => {
  if (p.probe?.durationMs) return p.probe.durationMs;
  const ends = allWords(doc).map((w) => w.end ?? 0);
  return Math.max(0, ...ends);
};

/** Enqueue local alignment for changed words; null when nothing to align or no audio yet. */
export const scheduleAlign = (ctx: Ctx, p: ProjectRow, rev: TranscriptRevision, changed: string[]): string | null => {
  if (!changed.length || !projectArtifact(ctx, p, "wav16")) return null;
  const windows = alignmentWindows(rev.doc, changed, { durationMs: durationOf(p, rev.doc) });
  if (!windows.length) return null;
  const byId = new Map(allWords(rev.doc).map((w) => [w.id, w]));
  const texts = windows.map((w) => w.wordIds.map((id) => byId.get(id)!.text));
  // Interactive: jumps ahead of other queued align work.
  return ctx.sched.enqueue(p.id, "align", { rev: rev.rev, windows, texts }, { priority: 10 }).id;
};

export const saveTranscript = (ctx: Ctx, p: ProjectRow, body: { baseRev?: unknown; paragraphs?: unknown }): SaveTranscriptRes => {
  const paragraphs = assertParagraphs(body.paragraphs);
  const baseRev = Number(body.baseRev);
  const { revision, changed } = ctx.store.tx(() => {
    const latest = checkBase(ctx, p.id, baseRev);
    const prev = latest?.doc ?? EMPTY;
    const r = reconcile(prev, paragraphs);
    if (latest && JSON.stringify(r.doc) === JSON.stringify(prev)) return { revision: latest, changed: [] as string[] };
    return { revision: ctx.store.addRevision(p.id, r.doc, "user"), changed: r.changed };
  });
  const alignJobId = scheduleAlign(ctx, p, revision, changed);
  return { revision, changed, alignJobId };
};

export const applyOps = (ctx: Ctx, p: ProjectRow, body: { baseRev?: unknown; ops?: unknown }): SaveTranscriptRes => {
  if (!Array.isArray(body.ops) || !body.ops.length) throw new HttpError(400, "ops must be a non-empty array");
  const ops = body.ops as TranscriptOp[];
  const { revision, realign } = ctx.store.tx(() => {
    const latest = checkBase(ctx, p.id, Number(body.baseRev));
    if (!latest) throw new HttpError(409, "no transcript yet", { current: null });
    const doc = structuredClone(latest.doc);
    const byId = new Map<string, Word>(allWords(doc).map((w) => [w.id, w]));
    const get = (id: unknown): Word => {
      const w = typeof id === "string" ? byId.get(id) : undefined;
      if (!w) throw new HttpError(400, `unknown word id ${String(id)}`);
      return w;
    };
    const ids = (v: unknown): string[] => {
      if (!Array.isArray(v) || !v.length) throw new HttpError(400, "wordIds must be a non-empty array");
      return v as string[];
    };
    const realign: string[] = [];
    const dur = durationOf(p, doc);
    for (const op of ops) {
      switch (op?.kind) {
        case "set_timing": {
          const w = get(op.wordId);
          const { start, end } = op;
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || (dur && end > dur + 1000)) {
            throw new HttpError(400, `invalid interval ${start}..${end}`);
          }
          Object.assign(w, { start, end, timing: "manual" });
          break;
        }
        case "clear_manual": {
          const w = get(op.wordId);
          if (w.timing === "manual") {
            w.timing = w.start === null ? "unconfirmed" : "preliminary";
            realign.push(w.id);
          }
          break;
        }
        case "set_hidden":
          for (const id of ids(op.wordIds)) {
            const w = get(id);
            if (op.hidden) w.hidden = true;
            else delete w.hidden;
          }
          break;
        case "set_review":
          if (!["unreviewed", "needs_review", "confirmed"].includes(op.review)) throw new HttpError(400, "bad review status");
          for (const id of ids(op.wordIds)) get(id).review = op.review;
          break;
        default:
          throw new HttpError(400, `unknown op ${String((op as { kind?: unknown })?.kind)}`);
      }
    }
    if (JSON.stringify(doc) === JSON.stringify(latest.doc)) return { revision: latest, realign: [] as string[] };
    return { revision: ctx.store.addRevision(p.id, doc, "user"), realign };
  });
  const alignJobId = scheduleAlign(ctx, p, revision, realign);
  return { revision, changed: realign, alignJobId };
};

// ---- alignment job ---------------------------------------------------------------

export const align = async (ctx: Ctx, j: JobContext): Promise<Record<string, unknown>> => {
  const p = ctx.store.getProject(j.job.projectId);
  if (!p) throw new Error("project not found");
  const wav16 = abs(ctx.cfg, requireArtifact(ctx, p, "wav16").path);
  const windows = j.job.params.windows as AlignWindow[];
  const texts = j.job.params.texts as string[][];

  // Skip work whose words were already edited again (a newer align job will cover them).
  const live = (doc: TranscriptDoc, win: AlignWindow) => applyAlignment(doc, win, win.wordIds.map(() => ({ start: null, end: null, status: "anchor" }))) !== null;
  const latest0 = ctx.store.latestRevision(p.id);
  const todo = windows.map((w, i) => ({ w, i })).filter(({ w }) => latest0 && live(latest0.doc, w));
  if (!todo.length) return { windows: windows.length, aligned: 0, applied: 0, rev: latest0?.rev ?? null, skipped: "stale" };

  j.progress(0.05, "precompute");
  await ctx.workers.request("align", "align_precompute", { wav16 }, { signal: j.signal });
  const results: { win: AlignWindow; words: AlignedWord[] }[] = [];
  for (const [n, { w, i }] of todo.entries()) {
    j.throwIfCancelled();
    const anchors: Record<string, [number, number]> = {};
    for (const [k, v] of Object.entries(w.anchors)) anchors[String(k)] = v;
    const res = await ctx.workers.request(
      "align",
      "align_window",
      { wav16, t0: w.t0, t1: w.t1, words: texts[i], anchors },
      { signal: j.signal },
    );
    const words = (Array.isArray(res.words) ? res.words : []) as Record<string, unknown>[];
    results.push({
      win: w,
      words: words.map((r) => ({
        start: typeof r.start === "number" ? Math.round(r.start) : null,
        end: typeof r.end === "number" ? Math.round(r.end) : null,
        status: r.status === "aligned" || r.status === "anchor" ? r.status : "unconfirmed",
      })),
    });
    j.progress(0.1 + (0.9 * (n + 1)) / todo.length);
  }

  // Apply against the *latest* revision; stale windows return null and are dropped.
  return ctx.store.tx(() => {
    const latest = ctx.store.latestRevision(p.id);
    if (!latest) return { windows: windows.length, aligned: results.length, applied: 0, rev: null };
    let doc = latest.doc;
    let applied = 0;
    for (const r of results) {
      const next = applyAlignment(doc, r.win, r.words);
      if (next) {
        doc = next;
        applied++;
      }
    }
    if (!applied || JSON.stringify(doc) === JSON.stringify(latest.doc)) {
      return { windows: windows.length, aligned: results.length, applied, rev: latest.rev, wrote: false };
    }
    const rev = ctx.store.addRevision(p.id, doc, "align");
    return { windows: windows.length, aligned: results.length, applied, rev: rev.rev, wrote: true };
  });
};
