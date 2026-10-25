import { describe, expect, it } from "vitest";
import { coverAss, coverMetrics, coverTitleLines, suggestFrames, wrapTitle, type FrameScore } from "../src/index.js";

describe("cover title", () => {
  it("wraps greedily and folds overflow into the last line", () => {
    expect(wrapTitle("один два три четыре", 9, 3)).toEqual(["один два", "три", "четыре"]);
    expect(wrapTitle("один два три четыре пять", 9, 2)).toEqual(["один два", "три четыре пять"]);
    expect(wrapTitle("  ", 9, 2)).toEqual([]);
    expect(coverTitleLines("Дорога вдоль моря", "vertical")).toEqual(["ДОРОГА ВДОЛЬ", "МОРЯ"]);
  });

  it("ASS: centred title and top badge at the shared metrics", () => {
    const m = coverMetrics("vertical");
    expect(m).toMatchObject({ titleSize: 108, titleY: 691, badgeSize: 69, badgeTop: 307 });
    const ass = coverAss("vertical", { title: "Дорога вдоль моря", badge: "2/3" });
    expect(ass).toContain("PlayResX: 1080\nPlayResY: 1920");
    expect(ass).toContain("Title,,0,0,0,,{\\an5\\pos(540,691)}ДОРОГА ВДОЛЬ\\NМОРЯ");
    expect(ass).toContain("Badge,,0,0,0,,{\\an8\\pos(540,307)}2/3");
    const plain = coverAss("youtube", { title: null, badge: null });
    expect(plain).toContain("PlayResX: 1280");
    expect(plain).not.toContain("Dialogue:");
  });
});

describe("suggestFrames", () => {
  // 4 fps scan over 20 s; a sharp peak at 13.25 s, mild bumps elsewhere.
  const frames: FrameScore[] = Array.from({ length: 80 }, (_, i) => ({ t: i * 250, sharpness: i === 53 ? 40 : 10 + (i % 7) }));

  it("spreads over the range and includes the sharpest frame", () => {
    const s = suggestFrames(frames, 0, 20_000);
    expect(s).toContain(13_250);
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(s.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < s.length; i++) expect(s[i]! - s[i - 1]!).toBeGreaterThanOrEqual(1000);
    expect(s[0]!).toBeLessThan(5000);
    expect(s.at(-1)!).toBeGreaterThan(15_000);
  });

  it("stays inside a part's range", () => {
    const s = suggestFrames(frames, 5000, 10_000);
    expect(s.every((t) => t >= 5000 && t < 10_000)).toBe(true);
    expect(suggestFrames([], 5000, 10_000)).toEqual([7500]);
  });
});
