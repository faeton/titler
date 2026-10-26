import { allWords, effectiveTimes } from "./transcript.js";
import type { Ms, SeriesDestination, SeriesNumbering, SeriesSettings, TranscriptDoc } from "./types.js";

// Splitting a finished clip into parts that fit a platform's length limit.
// Pure: the server renders the cuts, the export screen edits them, both call
// these functions so the plan cannot drift between them.

export interface SeriesPreset {
  label: string;
  /** null = never split (size-limited destinations). */
  maxPartMs: Ms | null;
}

/** Part limits with ~1 s of headroom below each platform's cap (bench/REPORT-publishing.md). */
export const SERIES_PRESETS: Record<SeriesDestination, SeriesPreset> = {
  ig_stories: { label: "IG Stories", maxPartMs: 59_000 },
  ig_reels: { label: "IG Reels", maxPartMs: 179_000 },
  yt_shorts: { label: "YT Shorts", maxPartMs: 179_000 },
  tiktok: { label: "TikTok", maxPartMs: 179_000 },
  fb_reels: { label: "FB Reels", maxPartMs: 89_000 },
  telegram: { label: "Telegram", maxPartMs: null },
  custom: { label: "Своя", maxPartMs: null },
};

export const SERIES_DESTINATIONS = Object.keys(SERIES_PRESETS) as SeriesDestination[];

export const maxPartMs = (s: Pick<SeriesSettings, "destination" | "customMaxMs">): Ms | null =>
  s.destination === "custom" ? s.customMaxMs : SERIES_PRESETS[s.destination].maxPartMs;

/** A spoken word as the planner sees it (times always known; see seriesWords). */
export interface SeriesWord {
  start: Ms;
  end: Ms;
  /** The word ends a sentence. */
  sentenceEnd?: boolean;
  /** The word is the last of a transcript paragraph. */
  paragraphEnd?: boolean;
}

export interface SpeechRegion {
  startMs: Ms;
  endMs: Ms;
}

export interface PlanOpts {
  maxPartMs: Ms;
  minPartMs?: Ms;
  overlapMs?: Ms;
  /** A pause at least this long is a cut candidate. */
  minPauseMs?: Ms;
  /** Search window around each equal-split target, as a fraction of the target part length. */
  window?: number;
}

const SENTENCE_END = /[.!?…]["»)]*$/;

/** Every word with display times (hidden words are still spoken, so they count). */
export const seriesWords = (doc: TranscriptDoc | null, durationMs: Ms): SeriesWord[] => {
  if (!doc) return [];
  const words = allWords(doc);
  const times = effectiveTimes(words, durationMs);
  const lastOfPara = new Set(doc.paragraphs.map((p) => p.words[p.words.length - 1]?.id));
  return words.map((w, i) => ({
    start: times[i]!.start,
    end: times[i]!.end,
    sentenceEnd: SENTENCE_END.test(w.text),
    paragraphEnd: lastOfPara.has(w.id),
  }));
};

export interface CutCandidate {
  /** Where the cut goes (middle of the pause). */
  at: Ms;
  /** The pause it sits in. */
  gapMs: Ms;
  /** Higher = nicer place to cut. */
  score: number;
}

const inSpeech = (t: Ms, vad: SpeechRegion[]) => vad.some((r) => t >= r.startMs && t < r.endMs);

/** All pauses between words where a cut is allowed, scored (sentence end, paragraph end, VAD silence, length). */
export const cutCandidates = (
  words: SeriesWord[],
  vad: SpeechRegion[],
  durationMs: Ms,
  minPauseMs = 300,
): CutCandidate[] => {
  const ws = [...words].sort((a, b) => a.start - b.start);
  const out: CutCandidate[] = [];
  if (!ws.length) {
    // No transcript: cut in VAD silences.
    let prev = 0;
    for (const r of [...vad, { startMs: durationMs, endMs: durationMs }].sort((a, b) => a.startMs - b.startMs)) {
      const gap = r.startMs - prev;
      if (gap >= minPauseMs && prev > 0 && r.startMs < durationMs) out.push({ at: Math.round(prev + gap / 2), gapMs: gap, score: 0.5 + Math.min(gap, 1500) / 3000 });
      prev = Math.max(prev, r.endMs);
    }
    return out;
  }
  for (let i = 0; i + 1 < ws.length; i++) {
    const a = ws[i]!;
    const b = ws[i + 1]!;
    const gap = b.start - a.end;
    if (gap < minPauseMs) continue;
    const at = Math.round(a.end + gap / 2);
    let score = Math.min(gap, 1500) / 3000;
    if (a.sentenceEnd) score += 1;
    if (a.paragraphEnd) score += 0.5;
    if (vad.length && !inSpeech(at, vad)) score += 0.5;
    out.push({ at, gapMs: gap, score });
  }
  return out;
};

/** Move `t` out of any word it falls inside, to the nearer word edge. */
export const safeCut = (t: Ms, words: SeriesWord[]): Ms => {
  const w = words.find((x) => t > x.start && t < x.end);
  if (!w) return Math.round(t);
  return Math.round(t - w.start <= w.end - t ? w.start : w.end);
};

/** Where a hand-dragged cut lands: the nearest pause within `radiusMs`, else just outside the word under it. */
export const snapCut = (t: Ms, candidates: CutCandidate[], words: SeriesWord[], radiusMs = 1500): Ms => {
  let best: CutCandidate | null = null;
  for (const c of candidates) if (Math.abs(c.at - t) <= radiusMs && (!best || Math.abs(c.at - t) < Math.abs(best.at - t))) best = c;
  return best ? best.at : safeCut(t, words);
};

/**
 * [t0, t1) per part in source ms. Part k > 0 starts `overlapMs` before its cut;
 * `leadMs` is that repeated lead-in (cut − start, 0 for the first part).
 */
export const seriesParts = (cuts: Ms[], durationMs: Ms, overlapMs = 0): { startMs: Ms; endMs: Ms; leadMs: Ms }[] => {
  const bounds = [0, ...cuts, durationMs];
  return bounds.slice(0, -1).map((b, k) => {
    const startMs = k ? Math.max(0, b - overlapMs) : 0;
    return { startMs, endMs: bounds[k + 1]!, leadMs: b - startMs };
  });
};

/** Longest inter-word gap whose midpoint is inside [lo, hi]; null if no word boundary there. */
const longestGap = (words: SeriesWord[], lo: Ms, hi: Ms): CutCandidate | null => {
  let best: CutCandidate | null = null;
  for (let i = 0; i + 1 < words.length; i++) {
    const gap = Math.max(0, words[i + 1]!.start - words[i]!.end);
    const at = Math.round(words[i]!.end + gap / 2);
    if (at <= lo || at >= hi) continue;
    if (!best || gap > best.gapMs) best = { at, gapMs: gap, score: 0 };
  }
  return best;
};

/**
 * Cut points (source ms, ascending) that split a clip into near-equal parts,
 * each ≤ maxPartMs. Cuts only fall between words, preferring pauses at
 * sentence / paragraph ends and VAD silence near the equal-split targets.
 * Empty when the clip already fits.
 */
export const planSeries = (words: SeriesWord[], vad: SpeechRegion[], durationMs: Ms, opts: PlanOpts): Ms[] => {
  const { maxPartMs: max, minPartMs = 12_000, overlapMs = 0, minPauseMs = 300, window = 0.15 } = opts;
  if (!(max > 0) || durationMs <= max) return [];
  const ws = [...words].sort((a, b) => a.start - b.start);
  const all = cutCandidates(ws, vad, durationMs, minPauseMs);
  const partLen = (cuts: Ms[]) => seriesParts(cuts, durationMs, overlapMs).map((p) => p.endMs - p.startMs);

  // Each extra part adds overlap, so leave room for it when choosing n.
  const n0 = Math.ceil(durationMs / Math.max(1, max - overlapMs));
  for (let n = n0; n <= n0 + 4; n++) {
    const L = durationMs / n;
    // ±window around each equal-split target; once more at twice the width before adding a part.
    for (const w of [window, window * 2]) {
      const win = L * w;
      const norm = L * window;
      // Candidates per cut k (target k·L), with a fallback when the window has no real pause.
      const cands: Scored[][] = [];
      for (let k = 1; k < n; k++) {
        const t = k * L;
        let c = all.filter((x) => Math.abs(x.at - t) <= win);
        if (!c.length) c = [longestGap(ws, t - win, t + win) ?? { at: safeCut(t, ws), gapMs: 0, score: 0 }];
        cands.push(c.map((x) => ({ ...x, cost: 2 * ((x.at - t) / norm) ** 2 - x.score })));
      }
      const plan = choose(cands, durationMs, max, overlapMs, Math.min(minPartMs, L * 0.5));
      if (plan && partLen(plan).every((d) => d <= max)) return plan;
    }
  }
  // Pathological input (e.g. one endless word): equal cuts, nudged out of words.
  const n = n0 + 5;
  return Array.from({ length: n - 1 }, (_, k) => safeCut(((k + 1) * durationMs) / n, ws));
};

/** DP over candidate lists: min total cost with every part ≤ max and ≥ minPart. */
type Scored = CutCandidate & { cost: number };

const choose = (
  cands: Scored[][],
  durationMs: Ms,
  max: Ms,
  overlap: Ms,
  minPart: Ms,
): Ms[] | null => {
  if (!cands.length) return [];
  const ok = (from: Ms, to: Ms, first: boolean) => {
    const d = to - from + (first ? 0 : overlap);
    return d <= max && to - from >= minPart;
  };
  // best[k][i] = min cost ending with candidate i at cut k; prev[k][i] = index at k-1.
  const best: number[][] = [];
  const prev: number[][] = [];
  cands.forEach((list, k) => {
    best.push(list.map(() => Infinity));
    prev.push(list.map(() => -1));
    list.forEach((c, i) => {
      if (k === 0) {
        if (ok(0, c.at, true)) best[0]![i] = c.cost;
        return;
      }
      cands[k - 1]!.forEach((p, j) => {
        const b = best[k - 1]![j]!;
        if (b === Infinity || !ok(p.at, c.at, false)) return;
        if (b + c.cost < best[k]![i]!) {
          best[k]![i] = b + c.cost;
          prev[k]![i] = j;
        }
      });
    });
  });
  const last = cands.length - 1;
  let bi = -1;
  cands[last]!.forEach((c, i) => {
    if (best[last]![i] === Infinity || !ok(c.at, durationMs, false)) return;
    if (bi < 0 || best[last]![i]! < best[last]![bi]!) bi = i;
  });
  if (bi < 0) return null;
  const cuts: Ms[] = [];
  for (let k = last, i = bi; k >= 0; i = prev[k]![i]!, k--) cuts.unshift(cands[k]![i]!.at);
  return cuts;
};

/** Stored hand-edited cuts if they are still usable, else the automatic plan. */
export const resolveCuts = (
  series: SeriesSettings,
  words: SeriesWord[],
  vad: SpeechRegion[],
  durationMs: Ms,
): { cuts: Ms[]; manual: boolean; maxPartMs: Ms | null } => {
  const max = maxPartMs(series);
  if (max === null) return { cuts: [], manual: false, maxPartMs: null };
  const stored = series.cuts[series.destination];
  if (stored && stored.length) {
    const cuts = normaliseCuts(stored, durationMs);
    if (cuts.length) return { cuts, manual: true, maxPartMs: max };
  }
  return { cuts: planSeries(words, vad, durationMs, { maxPartMs: max, overlapMs: series.overlapMs }), manual: false, maxPartMs: max };
};

/** Sorted, de-duplicated integer cuts inside (0, duration), parts ≥ 0.5 s. */
export const normaliseCuts = (cuts: Ms[], durationMs: Ms): Ms[] => {
  const out: Ms[] = [];
  for (const c of [...cuts].map(Math.round).filter((c) => Number.isFinite(c) && c >= 500 && c <= durationMs - 500).sort((a, b) => a - b)) {
    if (!out.length || c - out[out.length - 1]! >= 500) out.push(c);
  }
  return out;
};

// ---- numbering badge -----------------------------------------------------------

export interface Badge {
  text: string;
  /** Part-relative ms. */
  start: Ms;
  end: Ms;
}

/** Badge geometry shared by the ASS writer and the browser preview. */
export const BADGE = {
  fontSizeRel: 0.03, // of output height
  /** Top edge of the badge, fraction of output height (below the platform top bar, ~12 %). */
  top: 0.14,
  padRel: 0.4, // horizontal padding, fraction of font size
  text: "#FFFFFF",
  box: "#000000A6",
};

export const badgeText = (index: number, total: number, format: SeriesNumbering["format"]): string =>
  format === "long" ? `Часть ${index + 1} из ${total}` : `${index + 1}/${total}`;

/**
 * The «1/3» badge for part `index` (0-based), or null when numbering is off / too few parts.
 * `leadMs` is the part's overlap with the previous one (`seriesParts().leadMs`): the badge
 * starts after it, where the new material begins, and keeps its full duration from there.
 */
export const seriesBadge = (numbering: SeriesNumbering, index: number, total: number, partMs: Ms, leadMs: Ms = 0): Badge | null => {
  if (!numbering.enabled || total < Math.max(2, numbering.minParts)) return null;
  const start = Math.max(0, Math.min(leadMs, partMs));
  const end = numbering.durationMs === null ? partMs : Math.min(partMs, start + numbering.durationMs);
  return end > start ? { text: badgeText(index, total, numbering.format), start, end } : null;
};
