import { describe, expect, it } from "vitest";
import {
  alignmentWindows,
  allWords,
  applyAlignment,
  assEscape,
  assTime,
  compileCues,
  docFromHypothesis,
  DEFAULT_STYLE,
  effectiveTimes,
  reconcile,
  toAss,
  toEditedParagraphs,
  toSrt,
  type EditedParagraph,
  type TranscriptDoc,
} from "../src/index.js";

const hyp = {
  id: "h1",
  words: [
    { text: "я", start: 0, end: 200 },
    { text: "приехал", start: 220, end: 700 },
    { text: "Самоа.", start: 900, end: 1500 },
    { text: "Тут", start: 3500, end: 3700 },
    { text: "хорошо", start: 3750, end: 4200 },
  ],
};

const seed = () => docFromHypothesis(hyp);

/** Simulate the editor: replace the text of the whole paragraph, keeping word marks where unchanged. */
const editPara = (doc: TranscriptDoc, pi: number, f: (p: EditedParagraph) => EditedParagraph) =>
  toEditedParagraphs(doc).map((p, i) => (i === pi ? f(p) : p));

describe("docFromHypothesis", () => {
  it("splits paragraphs on long pauses and keeps every word", () => {
    const d = seed();
    expect(d.paragraphs).toHaveLength(2);
    expect(allWords(d).map((w) => w.text)).toEqual(["я", "приехал", "Самоа.", "Тут", "хорошо"]);
    expect(allWords(d).every((w) => w.timing === "preliminary")).toBe(true);
  });
});

describe("reconcile", () => {
  it("is a no-op for unchanged text", () => {
    const d = seed();
    const r = reconcile(d, toEditedParagraphs(d));
    expect(r.changed).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(allWords(r.doc)).toEqual(allWords(d));
  });

  it("inserts a typed word between two words without touching neighbours", () => {
    const d = seed();
    const [ya, priehal, samoa] = allWords(d);
    const edited = editPara(d, 0, (p) => ({
      ...p,
      runs: [
        { text: "я", wordId: ya!.id },
        { text: " ", wordId: null },
        { text: "приехал", wordId: priehal!.id },
        { text: " на ", wordId: null },
        { text: "Самоа.", wordId: samoa!.id },
      ],
    }));
    const r = reconcile(d, edited);
    const ws = allWords(r.doc);
    expect(ws.map((w) => w.text)).toEqual(["я", "приехал", "на", "Самоа.", "Тут", "хорошо"]);
    const na = ws[2]!;
    expect(na.timing).toBe("unconfirmed");
    expect(na.start).toBeNull();
    expect(r.changed).toEqual([na.id]);
    expect(ws[1]).toEqual(priehal);
    expect(ws[3]).toEqual(samoa);
  });

  it("keeps the id when a word is corrected in place", () => {
    const d = seed();
    const samoa = allWords(d)[2]!;
    const edited = editPara(d, 0, (p) => ({
      ...p,
      runs: p.runs.map((r) => (r.wordId === samoa.id ? { ...r, text: "Самоа," } : r)),
    }));
    const r = reconcile(d, edited);
    const w = allWords(r.doc)[2]!;
    expect(w.id).toBe(samoa.id);
    expect(w.text).toBe("Самоа,");
    expect(w.review).toBe("confirmed");
    expect(r.changed).toEqual([samoa.id]);
  });

  it("splitting a word keeps the id on the first part", () => {
    const d = seed();
    const pr = allWords(d)[1]!;
    const edited = editPara(d, 0, (p) => ({
      ...p,
      runs: p.runs.map((r) => (r.wordId === pr.id ? { ...r, text: "при ехал" } : r)),
    }));
    const ws = allWords(reconcile(d, edited).doc);
    expect(ws[1]!.id).toBe(pr.id);
    expect(ws[1]!.text).toBe("при");
    expect(ws[2]!.id).not.toBe(pr.id);
    expect(ws[2]!.timing).toBe("unconfirmed");
  });

  it("reports deleted words", () => {
    const d = seed();
    const ya = allWords(d)[0]!;
    const edited = editPara(d, 0, (p) => ({ ...p, runs: p.runs.filter((r) => r.wordId !== ya.id) }));
    expect(reconcile(d, edited).removed).toEqual([ya.id]);
  });

  it("keeps manual timing on edited words", () => {
    const d = seed();
    d.paragraphs[0]!.words[1] = { ...d.paragraphs[0]!.words[1]!, timing: "manual" };
    const pr = allWords(d)[1]!;
    const edited = editPara(d, 0, (p) => ({
      ...p,
      runs: p.runs.map((r) => (r.wordId === pr.id ? { ...r, text: "приехала" } : r)),
    }));
    expect(allWords(reconcile(d, edited).doc)[1]!.timing).toBe("manual");
  });
});

describe("alignment windows", () => {
  it("builds a padded window and refuses stale results", () => {
    const d = seed();
    const w = allWords(d)[1]!;
    const [win] = alignmentWindows(d, [w.id], { context: 1, padMs: 100, durationMs: 5000 });
    expect(win!.wordIds).toHaveLength(3);
    expect(win!.t0).toBe(0);
    expect(win!.t1).toBe(1600);
    const res = win!.wordIds.map(() => ({ start: 10, end: 20, status: "aligned" as const }));
    expect(applyAlignment(d, win!, res)).not.toBeNull();

    const changed = reconcile(
      d,
      editPara(d, 0, (p) => ({ ...p, runs: p.runs.map((r) => (r.wordId === w.id ? { ...r, text: "уехал" } : r)) })),
    ).doc;
    expect(applyAlignment(changed, win!, res)).toBeNull();
  });

  it("never marks unconfirmed results as aligned and never moves manual words", () => {
    const d = seed();
    d.paragraphs[0]!.words[0] = { ...d.paragraphs[0]!.words[0]!, timing: "manual" };
    const [win] = alignmentWindows(d, [allWords(d)[1]!.id], { context: 1, durationMs: 5000 });
    expect(win!.anchors[0]).toEqual([0, 200]);
    const out = applyAlignment(d, win!, [
      { start: 5, end: 6, status: "aligned" },
      { start: 300, end: 600, status: "unconfirmed" },
      { start: 900, end: 1400, status: "aligned" },
    ])!;
    const ws = allWords(out);
    expect(ws[0]!.start).toBe(0);
    expect(ws[1]!.timing).toBe("unconfirmed");
    expect(ws[2]!.timing).toBe("aligned");
  });
});

describe("effectiveTimes", () => {
  it("fills gaps proportionally without overlap", () => {
    const d = seed();
    const ws = allWords(d);
    ws.splice(2, 0, { ...ws[0]!, id: "x", text: "на", start: null, end: null, timing: "unconfirmed" });
    const t = effectiveTimes(ws, 5000);
    expect(t[2]!.start).toBe(700);
    expect(t[2]!.end).toBe(900);
  });
});

describe("cues + writers", () => {
  it("includes the last word and respects line length", () => {
    const d = seed();
    const cues = compileCues(d, DEFAULT_STYLE, 5000);
    const words = cues.flatMap((c) => c.lines.flat().map((w) => w.text));
    expect(words).toEqual(["я", "приехал", "Самоа.", "Тут", "хорошо"]);
    for (const c of cues) for (const l of c.lines) expect(l.map((w) => w.text).join(" ").length).toBeLessThanOrEqual(22);
  });

  it("skips hidden words", () => {
    const d = seed();
    d.paragraphs[1]!.words[0]!.hidden = true;
    const words = compileCues(d, DEFAULT_STYLE, 5000).flatMap((c) => c.lines.flat().map((w) => w.text));
    expect(words).not.toContain("Тут");
  });

  it("formats ASS times with carry and escapes overrides", () => {
    expect(assTime(59_999)).toBe("0:01:00.00");
    expect(assTime(3_723_450)).toBe("1:02:03.45");
    expect(assEscape("a{\\b1}b")).not.toMatch(/[{}]/);
  });

  it("writes SRT and ASS", () => {
    const cues = compileCues(seed(), DEFAULT_STYLE, 5000);
    expect(toSrt(cues)).toMatch(/^1\n00:00:00,000 --> /);
    const ass = toAss(cues, { width: 1080, height: 1920, style: DEFAULT_STYLE });
    expect(ass).toContain("PlayResY: 1920");
    expect(ass.match(/^Dialogue:/gm)!.length).toBeGreaterThan(cues.length - 1);
  });
});
