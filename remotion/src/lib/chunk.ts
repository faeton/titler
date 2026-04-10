import type { Word } from "../types";

/**
 * A chunk is a group of consecutive words displayed together on screen.
 * The chunker decides where to break: it respects sentence boundaries,
 * punctuation, pauses, and a hard max on words/chars per chunk.
 */
export type Chunk = {
  words: Word[];
  start: number; // first word's start
  end: number; // last word's end
  text: string; // joined text
};

export type ChunkOpts = {
  maxWords?: number; // default 5
  maxChars?: number; // default 30
  maxGap?: number; // seconds; force-break on silence > this (default 0.7)
  minDuration?: number; // seconds; don't show chunks shorter than this (default 0.5)
};

const SENTENCE_END = /[.!?…]+$/;
const CLAUSE_END = /[,;:—–\-]+$/;

/**
 * Score how "good" it is to break after word at index i.
 * Higher = stronger break point.
 */
function breakScore(words: Word[], i: number): number {
  if (i >= words.length - 1) return 100; // end of transcript
  const w = words[i];
  const next = words[i + 1];
  const gap = next.start - w.end;
  let score = 0;

  // Sentence-ending punctuation is a very strong break
  if (SENTENCE_END.test(w.text)) score += 50;
  // Clause-ending punctuation is a moderate break
  else if (CLAUSE_END.test(w.text)) score += 20;

  // Silence gaps proportional to gap length
  if (gap > 0.6) score += 40;
  else if (gap > 0.3) score += 15;
  else if (gap > 0.15) score += 5;

  return score;
}

export function chunkWords(words: Word[], opts: ChunkOpts = {}): Chunk[] {
  const maxWords = opts.maxWords ?? 5;
  const maxChars = opts.maxChars ?? 30;
  const maxGap = opts.maxGap ?? 0.7;
  const minDuration = opts.minDuration ?? 0.5;

  if (words.length === 0) return [];

  const chunks: Chunk[] = [];
  let buf: Word[] = [];
  let bufChars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.map((w) => w.text).join(" ");
    chunks.push({
      words: buf,
      start: buf[0].start,
      end: buf[buf.length - 1].end,
      text,
    });
    buf = [];
    bufChars = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const gap = buf.length > 0 ? w.start - buf[buf.length - 1].end : 0;
    const proposedChars = bufChars + w.text.length + (buf.length > 0 ? 1 : 0);

    // Force break on big silence gap
    if (buf.length > 0 && gap > maxGap) {
      flush();
    }

    // Force break if adding this word exceeds hard limits
    if (buf.length > 0 && (buf.length >= maxWords || proposedChars > maxChars)) {
      // Before flushing, check if the previous word was a better break
      // point than a hard cutoff. Look back 1-2 words for a natural break.
      if (buf.length >= 3) {
        const s1 = breakScore(words, i - 1); // break before current word
        const s2 = buf.length >= 2 ? breakScore(words, i - 2) : -1;
        // If 2 words ago was a much better break, rewind
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

    // Natural break: if this word ends a sentence and we have >=2 words
    if (buf.length >= 2 && SENTENCE_END.test(w.text)) {
      flush();
    }
  }

  flush();

  // Merge tiny chunks into neighbors
  const merged: Chunk[] = [];
  for (const chunk of chunks) {
    const dur = chunk.end - chunk.start;
    if (
      dur < minDuration &&
      merged.length > 0 &&
      merged[merged.length - 1].words.length + chunk.words.length <= maxWords + 1
    ) {
      // Merge into previous
      const prev = merged[merged.length - 1];
      prev.words = [...prev.words, ...chunk.words];
      prev.end = chunk.end;
      prev.text = prev.words.map((w) => w.text).join(" ");
    } else {
      merged.push(chunk);
    }
  }

  return merged;
}

/**
 * Pick a "keyword" index within a chunk for accent highlighting.
 * Prefers known trigger words, otherwise picks the longest word (≥5 chars).
 * Returns -1 if no word qualifies.
 */
const TRIGGER_WORDS = new Set([
  // Russian
  "важно", "никогда", "всегда", "лучший", "деньги", "бесплатно", "секрет",
  "круто", "реально", "точно", "просто", "вообще", "кстати", "кайф",
  // English
  "never", "always", "best", "money", "free", "secret", "now", "stop",
  "amazing", "actually", "literally", "insane", "crazy",
]);

export function pickKeyword(chunk: Chunk): number {
  let best = -1;
  let bestLen = 0;

  for (let i = 0; i < chunk.words.length; i++) {
    const clean = chunk.words[i].text
      .replace(/[.,!?;:—\-"'«»()…]/g, "")
      .toLowerCase();
    if (TRIGGER_WORDS.has(clean)) return i;
    if (clean.length >= 5 && clean.length > bestLen) {
      bestLen = clean.length;
      best = i;
    }
  }

  return best;
}
