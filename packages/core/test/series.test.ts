import { describe, expect, it } from "vitest";
import {
  compilePartCues,
  cutCandidates,
  DEFAULT_SERIES,
  DEFAULT_STYLE,
  docFromHypothesis,
  normaliseCuts,
  planSeries,
  resolveCuts,
  safeCut,
  seriesBadge,
  seriesParts,
  seriesWords,
  toAss,
  type SeriesWord,
} from "../src/index.js";

// Synthetic speech: words of `wordMs` separated by `gapMs`, with an optional
// longer pause (and sentence end) every `sentenceEvery` words.
const speech = (durationMs: number, o: { wordMs?: number; gapMs?: number; sentenceEvery?: number; pauseMs?: number; seed?: number } = {}): SeriesWord[] => {
  const { wordMs = 320, gapMs = 60, sentenceEvery = 0, pauseMs = 700 } = o;
  let rnd = o.seed ?? 1;
  const jitter = () => {
    rnd = (rnd * 16807) % 2147483647;
    return (rnd / 2147483647) * 0.6 + 0.7; // 0.7..1.3
  };
  const out: SeriesWord[] = [];
  let t = 200;
  for (let i = 0; t + wordMs < durationMs - 200; i++) {
    const len = Math.round(wordMs * (o.seed ? jitter() : 1));
    const sentenceEnd = sentenceEvery > 0 && (i + 1) % sentenceEvery === 0;
    out.push({ start: t, end: t + len, sentenceEnd });
    t += len + (sentenceEnd ? pauseMs : Math.round(gapMs * (o.seed ? jitter() : 1)));
  }
  return out;
};

const inWord = (t: number, ws: SeriesWord[]) => ws.some((w) => t > w.start && t < w.end);
const lengths = (cuts: number[], d: number, overlap = 0) => seriesParts(cuts, d, overlap).map((p) => p.endMs - p.startMs);

describe("planSeries", () => {
  it("returns no cuts when the clip fits", () => {
    expect(planSeries(speech(50_000), [], 50_000, { maxPartMs: 59_000 })).toEqual([]);
    expect(planSeries(speech(59_000), [], 59_000, { maxPartMs: 59_000 })).toEqual([]);
  });

  it("splits 64 s for Stories into two near-equal parts at a sentence pause", () => {
    const ws = speech(64_000, { sentenceEvery: 7 });
    const cuts = planSeries(ws, [], 64_000, { maxPartMs: 59_000 });
    expect(cuts).toHaveLength(1);
    expect(Math.abs(cuts[0]! - 32_000)).toBeLessThan(64_000 / 2 * 0.15 + 1);
    // The cut sits in a sentence-end pause (700 ms), not in a 60 ms gap.
    const before = ws.filter((w) => w.end <= cuts[0]!).at(-1)!;
    expect(before.sentenceEnd).toBe(true);
  });

  it("speech without pauses: cuts at the longest gap, never inside a word", () => {
    const ws = speech(100_000, { gapMs: 40, seed: 7 });
    expect(cutCandidates(ws, [], 100_000)).toEqual([]);
    const cuts = planSeries(ws, [], 100_000, { maxPartMs: 40_000 });
    expect(cuts).toHaveLength(2);
    for (const c of cuts) expect(inWord(c, ws)).toBe(false);
    expect(Math.max(...lengths(cuts, 100_000))).toBeLessThanOrEqual(40_000);
  });

  it("rebalances instead of leaving a short tail", () => {
    // Greedy 59+59 would leave a 7 s tail.
    const cuts = planSeries(speech(125_000, { sentenceEvery: 9 }), [], 125_000, { maxPartMs: 59_000 });
    const ls = lengths(cuts, 125_000);
    expect(ls).toHaveLength(3);
    expect(Math.min(...ls)).toBeGreaterThan(30_000);
    expect(Math.max(...ls)).toBeLessThanOrEqual(59_000);
  });

  it("every part ≤ max and no cut inside a word, across lengths and limits", () => {
    for (const d of [61_000, 90_000, 178_000, 240_000, 600_000]) {
      for (const max of [25_000, 59_000, 89_000, 179_000]) {
        for (const overlapMs of [0, 500]) {
          const ws = speech(d, { sentenceEvery: 11, seed: d + max });
          const cuts = planSeries(ws, [], d, { maxPartMs: max, overlapMs });
          const ls = lengths(cuts, d, overlapMs);
          expect(Math.max(...ls)).toBeLessThanOrEqual(max);
          if (d <= max) expect(ls).toHaveLength(1);
          else expect(ls.length).toBeGreaterThanOrEqual(Math.ceil(d / max));
          // Parts stay close to the cap: no more than one extra beyond 85 % of max.
          expect(ls.length).toBeLessThanOrEqual(Math.ceil(d / (0.85 * max - overlapMs)) + 1);
          for (const c of cuts) expect(inWord(c, ws)).toBe(false);
          expect([...cuts].sort((a, b) => a - b)).toEqual(cuts);
        }
      }
    }
  });

  it("prefers a VAD silence over an equally long pause inside speech", () => {
    // Two 400 ms pauses near the middle; only the second is VAD silence.
    const ws: SeriesWord[] = [];
    for (let t = 0; t < 70_000; t += 500) if (t !== 34_500 && t !== 35_500) ws.push({ start: t, end: t + 450 });
    const vad = [{ startMs: 0, endMs: 35_550 }, { startMs: 35_950, endMs: 70_000 }];
    const cuts = planSeries(ws, vad, 70_000, { maxPartMs: 59_000 });
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toBeGreaterThan(35_500);
    expect(cuts[0]).toBeLessThan(36_000);
  });

  it("no transcript: cuts in VAD silence", () => {
    const vad = [{ startMs: 0, endMs: 30_000 }, { startMs: 31_000, endMs: 64_000 }];
    expect(planSeries([], vad, 64_000, { maxPartMs: 59_000 })).toEqual([30_500]);
  });

  it("safeCut moves a point out of a word", () => {
    const ws = [{ start: 1000, end: 2000 }];
    expect(safeCut(1200, ws)).toBe(1000);
    expect(safeCut(1800, ws)).toBe(2000);
    expect(safeCut(500, ws)).toBe(500);
  });
});

describe("resolveCuts", () => {
  const ws = speech(64_000, { sentenceEvery: 7 });
  it("Telegram never splits; Stories plans automatically; manual cuts win", () => {
    expect(resolveCuts({ ...DEFAULT_SERIES, destination: "telegram" }, ws, [], 64_000).cuts).toEqual([]);
    const auto = resolveCuts({ ...DEFAULT_SERIES, destination: "ig_stories" }, ws, [], 64_000);
    expect(auto).toMatchObject({ manual: false, maxPartMs: 59_000 });
    expect(auto.cuts).toHaveLength(1);
    const man = resolveCuts({ ...DEFAULT_SERIES, destination: "ig_stories", cuts: { ig_stories: [20_000.4] } }, ws, [], 64_000);
    expect(man).toEqual({ cuts: [20_000], manual: true, maxPartMs: 59_000 });
    expect(resolveCuts({ ...DEFAULT_SERIES, destination: "custom", customMaxMs: 25_000 }, ws, [], 64_000).cuts).toHaveLength(2);
  });
  it("normaliseCuts drops out-of-range and near-duplicate cuts", () => {
    expect(normaliseCuts([5000, -1, 4800, 64_000, 30_000, 5200, 400], 64_000)).toEqual([4800, 30_000]);
  });
});

describe("part cues", () => {
  const doc = docFromHypothesis({
    id: "h",
    words: [
      { text: "один", start: 0, end: 400 },
      { text: "два", start: 450, end: 900 },
      { text: "три.", start: 950, end: 1400 },
      { text: "четыре", start: 1500, end: 1900 },
      { text: "пять", start: 1950, end: 2400 },
    ],
  });

  it("re-bases cues and never splits a word across parts", () => {
    const a = compilePartCues(doc, DEFAULT_STYLE, 2500, { startMs: 0, endMs: 1450 });
    const b = compilePartCues(doc, DEFAULT_STYLE, 2500, { startMs: 1450, endMs: 2500 });
    expect(a.flatMap((c) => c.lines.flat().map((w) => w.text))).toEqual(["один", "два", "три."]);
    expect(b.flatMap((c) => c.lines.flat().map((w) => w.text))).toEqual(["четыре", "пять"]);
    expect(b[0]!.start).toBe(50);
    expect(Math.max(...a.map((c) => c.end))).toBeLessThanOrEqual(1450);
    expect(Math.max(...b.map((c) => c.end))).toBeLessThanOrEqual(1050);
  });

  it("overlap repeats the words at the boundary", () => {
    const b = compilePartCues(doc, DEFAULT_STYLE, 2500, { startMs: 900, endMs: 2500 });
    expect(b[0]!.lines.flat()[0]!.text).toBe("три.");
  });

  it("seriesWords marks sentence and paragraph ends", () => {
    const ws = seriesWords(doc, 2500);
    expect(ws.map((w) => w.sentenceEnd)).toEqual([false, false, true, false, false]);
    expect(ws.at(-1)!.paragraphEnd).toBe(true);
  });
});

describe("numbering badge", () => {
  const n = DEFAULT_SERIES.numbering;
  it("shows from minParts on, for the configured time", () => {
    expect(seriesBadge(n, 0, 2, 30_000)).toBeNull();
    expect(seriesBadge(n, 0, 3, 30_000)).toEqual({ text: "1/3", start: 0, end: 2500 });
    expect(seriesBadge({ ...n, minParts: 2, format: "long", durationMs: null }, 1, 2, 30_000)).toEqual({ text: "Часть 2 из 2", start: 0, end: 30_000 });
    expect(seriesBadge({ ...n, enabled: false }, 0, 5, 30_000)).toBeNull();
  });
  it("is written as a top-centred boxed ASS event", () => {
    const ass = toAss([], { width: 1080, height: 1920, style: DEFAULT_STYLE, badge: { text: "1/3", start: 0, end: 2500 } });
    expect(ass).toMatch(/^Style: Badge,Montserrat,58,.*,3,23,0,8,/m);
    expect(ass).toContain("Dialogue: 2,0:00:00.00,0:00:02.50,Badge,,0,0,0,,{\\an8\\pos(540,269)}1/3");
    expect(toAss([], { width: 1080, height: 1920, style: DEFAULT_STYLE })).not.toContain("Badge");
  });
});
