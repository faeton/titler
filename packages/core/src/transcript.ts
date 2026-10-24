import type { AsrHypothesis, Ms, Paragraph, TranscriptDoc, Word } from "./types.js";

// randomUUID only exists in secure contexts (https/localhost); a phone on plain
// http over the tailnet has getRandomValues only.
export const newId = (): string => {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

// ---- Seeding from a hypothesis ----------------------------------------------

const SENTENCE_END = /[.!?…]["»)]*$/;

/**
 * Build the first transcript from an ASR hypothesis. Paragraph break on a
 * long pause, or on a sentence end followed by a shorter pause.
 */
export const docFromHypothesis = (
  hyp: Pick<AsrHypothesis, "id" | "words">,
  { pauseMs = 1500, sentencePauseMs = 700 } = {},
): TranscriptDoc => {
  const paragraphs: Paragraph[] = [];
  let cur: Word[] = [];
  let prev: AsrHypothesis["words"][number] | undefined;
  for (const w of hyp.words) {
    const text = w.text.trim();
    if (!text) continue;
    if (prev && cur.length) {
      const gap = w.start - prev.end;
      if (gap >= pauseMs || (gap >= sentencePauseMs && SENTENCE_END.test(prev.text.trim()))) {
        paragraphs.push({ id: newId(), words: cur });
        cur = [];
      }
    }
    cur.push({
      id: newId(),
      text,
      start: w.start,
      end: w.end,
      timing: "preliminary",
      review: "unreviewed",
      source: { kind: "asr", hypothesisId: hyp.id },
      ...(w.lang ? { lang: w.lang } : {}),
    });
    prev = w;
  }
  if (cur.length) paragraphs.push({ id: newId(), words: cur });
  return { paragraphs };
};

export const allWords = (doc: TranscriptDoc): Word[] => doc.paragraphs.flatMap((p) => p.words);

export const plainText = (doc: TranscriptDoc): string =>
  doc.paragraphs.map((p) => p.words.map((w) => w.text).join(" ")).join("\n\n");

// ---- Reconciling edited text back into words ------------------------------

/**
 * The editor represents a paragraph as text runs; each run carries the id of
 * the word it came from (or null for freshly typed text). After any edit the
 * paragraph is re-tokenised on whitespace and each token is matched to an
 * existing word by the ids covering its characters.
 */
export interface Run {
  text: string;
  wordId: string | null;
}

export interface EditedParagraph {
  id: string | null;
  runs: Run[];
}

export interface ReconcileResult {
  doc: TranscriptDoc;
  /** Words whose text is new or changed — candidates for local re-alignment. */
  changed: string[];
  /** Word ids that no longer exist. */
  removed: string[];
}

const isSpace = (ch: string) => /\s/u.test(ch);

export const reconcile = (prev: TranscriptDoc, edited: EditedParagraph[]): ReconcileResult => {
  const byId = new Map<string, Word>();
  for (const w of allWords(prev)) byId.set(w.id, w);

  const used = new Set<string>();
  const changed: string[] = [];
  const paragraphs: Paragraph[] = [];

  for (const ep of edited) {
    // Flatten runs into per-character ownership.
    const chars: string[] = [];
    const owners: (string | null)[] = [];
    for (const r of ep.runs) {
      for (const ch of r.text) {
        chars.push(ch);
        owners.push(r.wordId && byId.has(r.wordId) ? r.wordId : null);
      }
    }
    const words: Word[] = [];
    let i = 0;
    while (i < chars.length) {
      if (isSpace(chars[i]!)) {
        i++;
        continue;
      }
      let j = i;
      const ids: string[] = [];
      let unowned = false;
      while (j < chars.length && !isSpace(chars[j]!)) {
        const o = owners[j] ?? null;
        if (o === null) unowned = true;
        else if (!ids.includes(o)) ids.push(o);
        j++;
      }
      const text = chars.slice(i, j).join("");
      const candidate = ids.find((id) => !used.has(id));
      const old = candidate ? byId.get(candidate) : undefined;
      if (old && candidate) {
        used.add(candidate);
        const sameText = old.text === text;
        const pureCopy = sameText && ids.length === 1 && !unowned;
        if (pureCopy) {
          words.push(old);
        } else {
          // Edited in place, merged, or extended with typed characters.
          const timing = old.timing === "manual" ? "manual" : old.start === null ? "unconfirmed" : "preliminary";
          words.push({
            ...old,
            text,
            timing,
            review: "confirmed",
            source: sameText ? old.source : { kind: "user" },
          });
          if (!sameText || ids.length > 1) changed.push(candidate);
        }
      } else {
        const id = newId();
        words.push({
          id,
          text,
          start: null,
          end: null,
          timing: "unconfirmed",
          review: "confirmed",
          source: { kind: "user" },
        });
        changed.push(id);
      }
      i = j;
    }
    if (words.length) {
      const pid = ep.id && !paragraphs.some((p) => p.id === ep.id) ? ep.id : newId();
      paragraphs.push({ id: pid, words });
    }
  }

  const removed = [...byId.keys()].filter((id) => !used.has(id));
  return { doc: { paragraphs }, changed, removed };
};

/** Inverse of reconcile's input: one run per word, single spaces between. */
export const toEditedParagraphs = (doc: TranscriptDoc): EditedParagraph[] =>
  doc.paragraphs.map((p) => ({
    id: p.id,
    runs: p.words.flatMap((w, i) => [
      ...(i ? [{ text: " ", wordId: null }] : []),
      { text: w.text, wordId: w.id },
    ]),
  }));

// ---- Local alignment windows -------------------------------------------------

export interface AlignWindow {
  /** Word ids in order: context + changed words. */
  wordIds: string[];
  /** Index (into wordIds) → fixed interval; manual words are never moved. */
  anchors: Record<number, [Ms, Ms]>;
  t0: Ms;
  t1: Ms;
  /** Texts at request time; the result is applied only if they still match. */
  fingerprint: string;
}

export const fingerprint = (words: Pick<Word, "id" | "text">[]): string =>
  words.map((w) => `${w.id}:${w.text}`).join("|");

/**
 * Group changed words into small windows with `context` neighbours on each
 * side. Window bounds come from the nearest neighbours that have times.
 */
export const alignmentWindows = (
  doc: TranscriptDoc,
  changedIds: string[],
  { context = 3, padMs = 800, durationMs }: { context?: number; padMs?: Ms; durationMs: Ms },
): AlignWindow[] => {
  const words = allWords(doc);
  const idx = new Map(words.map((w, i) => [w.id, i]));
  const targets = [...new Set(changedIds)]
    .map((id) => idx.get(id))
    .filter((i): i is number => i !== undefined)
    .sort((a, b) => a - b);
  if (!targets.length) return [];

  // Merge overlapping [i-context, i+context] spans.
  const spans: [number, number][] = [];
  for (const t of targets) {
    const lo = Math.max(0, t - context);
    const hi = Math.min(words.length - 1, t + context);
    const last = spans[spans.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else spans.push([lo, hi]);
  }

  return spans.map(([lo, hi]) => {
    const slice = words.slice(lo, hi + 1);
    let t0: Ms | null = null;
    for (let k = lo; k >= 0 && t0 === null; k--) t0 = words[k]!.start;
    let t1: Ms | null = null;
    for (let k = hi; k < words.length && t1 === null; k++) t1 = words[k]!.end;
    const anchors: Record<number, [Ms, Ms]> = {};
    slice.forEach((w, k) => {
      if (w.timing === "manual" && w.start !== null && w.end !== null) anchors[k] = [w.start, w.end];
    });
    return {
      wordIds: slice.map((w) => w.id),
      anchors,
      t0: Math.max(0, (t0 ?? 0) - padMs),
      t1: Math.min(durationMs, (t1 ?? durationMs) + padMs),
      fingerprint: fingerprint(slice),
    };
  });
};

export interface AlignedWord {
  start: Ms | null;
  end: Ms | null;
  status: "aligned" | "unconfirmed" | "anchor";
}

/**
 * Apply an aligner result to the *current* doc. Returns null (nothing to do)
 * if the window's words changed since the request — a late result never
 * overwrites a fresher edit.
 */
export const applyAlignment = (
  doc: TranscriptDoc,
  win: AlignWindow,
  result: AlignedWord[],
): TranscriptDoc | null => {
  const words = allWords(doc);
  const byId = new Map(words.map((w) => [w.id, w]));
  const current = win.wordIds.map((id) => byId.get(id));
  if (current.some((w) => !w)) return null;
  if (fingerprint(current as Word[]) !== win.fingerprint) return null;
  if (result.length !== win.wordIds.length) return null;

  const patch = new Map<string, Partial<Word>>();
  win.wordIds.forEach((id, k) => {
    const w = byId.get(id)!;
    const r = result[k]!;
    if (w.timing === "manual" || r.status === "anchor") return;
    if (r.status === "aligned" && r.start !== null && r.end !== null) {
      patch.set(id, { start: r.start, end: r.end, timing: "aligned" });
    } else {
      // Keep a provisional interval for playback but never claim it is aligned.
      patch.set(id, { start: r.start ?? w.start, end: r.end ?? w.end, timing: "unconfirmed" });
    }
  });
  return {
    paragraphs: doc.paragraphs.map((p) => ({
      ...p,
      words: p.words.map((w) => (patch.has(w.id) ? { ...w, ...patch.get(w.id) } : w)),
    })),
  };
};

/**
 * Effective display times: words without an interval get a provisional slot
 * between their timed neighbours, split by character length. Used for
 * playback highlighting and captions only — never stored as alignment.
 */
export const effectiveTimes = (words: Word[], durationMs: Ms): { start: Ms; end: Ms }[] => {
  const out: { start: Ms; end: Ms }[] = new Array(words.length);
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (w.start !== null && w.end !== null) {
      out[i] = { start: w.start, end: Math.max(w.end, w.start + 1) };
      i++;
      continue;
    }
    let j = i;
    while (j < words.length && (words[j]!.start === null || words[j]!.end === null)) j++;
    const lo = i > 0 ? out[i - 1]!.end : 0;
    const hi = j < words.length ? words[j]!.start! : durationMs;
    const span = Math.max(hi - lo, 0);
    const lens = words.slice(i, j).map((x) => Math.max(x.text.length, 1));
    const total = lens.reduce((a, b) => a + b, 0);
    let t = lo;
    for (let k = i; k < j; k++) {
      const d = Math.round((span * lens[k - i]!) / total);
      out[k] = { start: t, end: k === j - 1 ? Math.max(hi, t) : t + d };
      t += d;
    }
    i = j;
  }
  return out;
};
