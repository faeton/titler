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

export const compileCues = (
  doc: TranscriptDoc,
  style: Pick<SubtitleStyle, "maxChars" | "maxLines" | "maxGapMs">,
  durationMs: Ms,
): Cue[] => {
  const all = allWords(doc);
  const times = effectiveTimes(all, durationMs);
  const words: CueWord[] = [];
  all.forEach((w, i) => {
    if (w.hidden) return;
    words.push({ wordId: w.id, text: w.text, start: times[i]!.start, end: times[i]!.end });
  });

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
