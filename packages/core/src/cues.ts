import { allWords, effectiveTimes } from "./transcript.js";
import type { Ms, SubtitleStyle, TranscriptDoc } from "./types.js";

// One cue compiler for preview and export, so they cannot drift apart.

export interface CueWord {
  wordId: string;
  text: string;
  start: Ms;
  end: Ms;
}

export interface Cue {
  start: Ms;
  end: Ms;
  lines: CueWord[][];
}

const SENTENCE_END = /[.!?…]["»)]*$/;
const MIN_CUE_MS = 400;

type CueStyle = Pick<SubtitleStyle, "maxChars" | "maxLines" | "maxGapMs">;

/** Visible words with display times, in order. */
const cueWords = (doc: TranscriptDoc, durationMs: Ms): CueWord[] => {
  const all = allWords(doc);
  const times = effectiveTimes(all, durationMs);
  const words: CueWord[] = [];
  all.forEach((w, i) => {
    if (w.hidden) return;
    words.push({ wordId: w.id, text: w.text, start: times[i]!.start, end: times[i]!.end });
  });
  return words;
};

export const compileCues = (doc: TranscriptDoc, style: CueStyle, durationMs: Ms): Cue[] =>
  layoutCues(cueWords(doc, durationMs), style, durationMs);

/**
 * Cues of one series part, re-based to the part's own time (0 = part start).
 * Words are assigned by their midpoint, so a cut between words never splits a
 * word and each part lays out its own lines; words inside an overlap appear in
 * both parts.
 */
export const compilePartCues = (doc: TranscriptDoc, style: CueStyle, durationMs: Ms, part: { startMs: Ms; endMs: Ms }): Cue[] => {
  const { startMs: t0, endMs: t1 } = part;
  const words = cueWords(doc, durationMs).filter((w) => {
    const mid = (w.start + w.end) / 2;
    return mid >= t0 && mid < t1;
  });
  const clamp = (t: Ms) => Math.min(t1 - t0, Math.max(0, t - t0));
  return layoutCues(words, style, t1).map((c) => ({
    start: clamp(c.start),
    end: clamp(c.end),
    lines: c.lines.map((l) => l.map((w) => ({ ...w, start: clamp(w.start), end: clamp(w.end) }))),
  })).filter((c) => c.end > c.start);
};

/** Shift part-relative cues back to source time (preview of a part on the full video). */
export const shiftCues = (cues: Cue[], byMs: Ms): Cue[] =>
  cues.map((c) => ({
    start: c.start + byMs,
    end: c.end + byMs,
    lines: c.lines.map((l) => l.map((w) => ({ ...w, start: w.start + byMs, end: w.end + byMs }))),
  }));

const layoutCues = (words: CueWord[], style: CueStyle, durationMs: Ms): Cue[] => {
  const cues: Cue[] = [];
  let lines: CueWord[][] = [[]];
  const lineLen = (l: CueWord[]) => l.reduce((n, w, k) => n + w.text.length + (k ? 1 : 0), 0);
  const flush = () => {
    const ws = lines.flat();
    if (ws.length) cues.push({ start: ws[0]!.start, end: ws[ws.length - 1]!.end, lines });
    lines = [[]];
  };

  words.forEach((w, i) => {
    const prev = words[i - 1];
    const line = lines[lines.length - 1]!;
    if (prev && line.length + lines.length > 1) {
      const gap = w.start - prev.end;
      const cueChars = lines.reduce((n, l) => n + lineLen(l), 0);
      if (gap > style.maxGapMs || (SENTENCE_END.test(prev.text) && cueChars >= style.maxChars / 2)) {
        flush();
      }
    }
    let cur = lines[lines.length - 1]!;
    const fits = lineLen(cur) + (cur.length ? 1 : 0) + w.text.length <= style.maxChars;
    if (cur.length && !fits) {
      if (lines.length < style.maxLines) lines.push([]);
      else flush();
      cur = lines[lines.length - 1]!;
    }
    cur.push(w);
  });
  flush();

  // Minimum on-screen time without overlapping the next cue.
  for (let k = 0; k < cues.length; k++) {
    const c = cues[k]!;
    const next = cues[k + 1];
    const want = Math.max(c.end, c.start + MIN_CUE_MS);
    c.end = next ? Math.min(want, next.start) : Math.min(want, Math.max(durationMs, c.end));
  }
  return cues;
};

// ---- SRT / VTT ----------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

const clock = (ms: Ms, sep: string) => {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(t % 1000, 3)}`;
};

const cueText = (c: Cue) => c.lines.map((l) => l.map((w) => w.text).join(" ")).join("\n");

export const toSrt = (cues: Cue[]): string =>
  cues.map((c, i) => `${i + 1}\n${clock(c.start, ",")} --> ${clock(c.end, ",")}\n${cueText(c)}\n`).join("\n");

export const toVtt = (cues: Cue[]): string =>
  "WEBVTT\n\n" +
  cues.map((c) => `${clock(c.start, ".")} --> ${clock(c.end, ".")}\n${cueText(c)}\n`).join("\n");
