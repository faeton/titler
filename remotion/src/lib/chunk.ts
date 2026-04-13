import type { Word } from "../types";

export type Chunk = {
  words: Word[];
  start: number;
  end: number;
  text: string;
};

export type ChunkOpts = {
  maxWords?: number;
  maxChars?: number;
  maxGap?: number;
  minDuration?: number;
};

// --- pre-processing: fix whisper artifacts ---

function preprocessWords(words: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = { ...words[i] };
    if (
      i + 1 < words.length &&
      /^\d+$/.test(w.text) &&
      /^[,.]/.test(words[i + 1].text)
    ) {
      w.text = w.text + words[i + 1].text;
      w.end = words[i + 1].end;
      i++;
    }
    out.push(w);
  }
  return out;
}

const SENTENCE_END = /[.!?…]+$/;
const CLAUSE_END = /[,;:—–\-]+$/;
const WEAK_TAIL =
  /^(но|и|а|что|как|не|на|в|к|с|у|о|за|из|от|по|до|для|при|без|ну)$/i;

function breakScore(words: Word[], i: number): number {
  if (i >= words.length - 1) return 100;
  const w = words[i];
  const next = words[i + 1];
  const gap = next.start - w.end;
  let score = 0;

  if (SENTENCE_END.test(w.text)) score += 50;
  else if (CLAUSE_END.test(w.text)) score += 20;

  if (gap > 0.6) score += 40;
  else if (gap > 0.3) score += 15;
  else if (gap > 0.15) score += 5;

  const clean = w.text.replace(/[.,!?;:—\-"'«»()…]/g, "");
  if (WEAK_TAIL.test(clean)) score -= 25;

  return score;
}

export function chunkWords(words: Word[], opts: ChunkOpts = {}): Chunk[] {
  const maxWords = opts.maxWords ?? 5;
  const maxChars = opts.maxChars ?? 32;
  const maxGap = opts.maxGap ?? 0.7;
  const minDuration = opts.minDuration ?? 0.6;

  const processed = preprocessWords(words);
  if (processed.length === 0) return [];

  const chunks: Chunk[] = [];
  let buf: Word[] = [];
  let bufChars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    if (
      buf.length >= 2 &&
      WEAK_TAIL.test(
        buf[buf.length - 1].text.replace(/[.,!?;:—\-"'«»()…]/g, ""),
      ) &&
      !SENTENCE_END.test(buf[buf.length - 1].text)
    ) {
      const moved = buf.pop()!;
      chunks.push({
        words: [...buf],
        start: buf[0].start,
        end: buf[buf.length - 1].end,
        text: buf.map((w) => w.text).join(" "),
      });
      buf = [moved];
      bufChars = moved.text.length;
      return;
    }
    chunks.push({
      words: buf,
      start: buf[0].start,
      end: buf[buf.length - 1].end,
      text: buf.map((w) => w.text).join(" "),
    });
    buf = [];
    bufChars = 0;
  };

  for (let i = 0; i < processed.length; i++) {
    const w = processed[i];
    const gap = buf.length > 0 ? w.start - buf[buf.length - 1].end : 0;
    const proposedChars =
      bufChars + w.text.length + (buf.length > 0 ? 1 : 0);

    if (buf.length > 0 && gap > maxGap) flush();

    if (
      buf.length > 0 &&
      (buf.length >= maxWords || proposedChars > maxChars)
    ) {
      if (buf.length >= 3) {
        const s1 = breakScore(processed, i - 1);
        const s2 = buf.length >= 2 ? breakScore(processed, i - 2) : -1;
        if (s2 > s1 + 15 && buf.length >= 2) {
          const rewind = buf.pop()!;
          flush();
          buf.push(rewind);
          bufChars = rewind.text.length;
        } else {
          flush();
        }
      } else {
        flush();
      }
    }

    buf.push(w);
    bufChars = buf.map((x) => x.text).join(" ").length;

    if (buf.length >= 2 && SENTENCE_END.test(w.text)) flush();
  }

  flush();

  // Merge tiny chunks backward
  const merged: Chunk[] = [];
  for (const chunk of chunks) {
    const dur = chunk.end - chunk.start;
    if (dur < minDuration && merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.words.length + chunk.words.length <= 7) {
        prev.words = [...prev.words, ...chunk.words];
        prev.end = chunk.end;
        prev.text = prev.words.map((w) => w.text).join(" ");
        continue;
      }
    }
    merged.push(chunk);
  }
  // Merge remaining tiny chunks forward
  const final: Chunk[] = [];
  for (let i = 0; i < merged.length; i++) {
    const chunk = merged[i];
    const dur = chunk.end - chunk.start;
    if (dur < minDuration && i + 1 < merged.length) {
      const next = merged[i + 1];
      if (next.words.length + chunk.words.length <= 7) {
        next.words = [...chunk.words, ...next.words];
        next.start = chunk.start;
        next.text = next.words.map((w) => w.text).join(" ");
        continue;
      }
    }
    final.push(chunk);
  }
  return final;
}

