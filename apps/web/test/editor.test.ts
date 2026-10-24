import {
  allWords,
  docFromHypothesis,
  reconcile,
  type SaveTranscriptReq,
  type SaveTranscriptRes,
  type TranscriptDoc,
  type TranscriptRevision,
} from "@titler/core";
import { TextSelection } from "prosemirror-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/types";
import { editedFromPm, pmFromTranscript, pmSig, revSig } from "../src/editor/convert";
import { wordMark } from "../src/editor/schema";
import { TranscriptSession } from "../src/editor/session";

const hyp = (text: string) => ({
  id: "h1",
  words: text.split(" ").map((w, i) => ({ text: w, start: i * 500, end: i * 500 + 400 })),
});

const docOf = (text: string): TranscriptDoc => docFromHypothesis(hyp(text));
const rev = (doc: TranscriptDoc, n = 1): TranscriptRevision => ({ rev: n, doc, actor: "asr", createdAt: "" });

/** Position just after the k-th word (0-based) of the first paragraph. */
const afterWord = (doc: TranscriptDoc, k: number) =>
  1 + doc.paragraphs[0]!.words.slice(0, k + 1).reduce((n, w, i) => n + w.text.length + (i ? 1 : 0), 0);

describe("PM doc ⇄ EditedParagraph", () => {
  it("round-trips: unchanged text reconciles to the same words", () => {
    const doc = docOf("я приехал Самоа, всё хорошо.");
    const edited = editedFromPm(pmFromTranscript(doc));
    const r = reconcile(doc, edited);
    expect(r.doc).toEqual(doc);
    expect(r.changed).toEqual([]);
    expect(pmSig(pmFromTranscript(doc))).toBe(revSig(doc));
  });

  it("every word run carries its id; spaces are unowned", () => {
    const doc = docOf("раз два");
    const [p] = editedFromPm(pmFromTranscript(doc));
    const ids = allWords(doc).map((w) => w.id);
    expect(p!.runs).toEqual([
      { text: "раз", wordId: ids[0] },
      { text: " ", wordId: null },
      { text: "два", wordId: ids[1] },
    ]);
    expect(p!.id).toBe(doc.paragraphs[0]!.id);
  });
});

describe("TranscriptSession", () => {
  let mount: HTMLElement;
  let session: TranscriptSession | null = null;
  let server: TranscriptRevision;
  const saves: SaveTranscriptReq[] = [];

  const api = {
    saveTranscript: vi.fn(async (_id: string, req: SaveTranscriptReq): Promise<SaveTranscriptRes> => {
      saves.push(structuredClone(req));
      if (req.baseRev !== server.rev) throw new ApiError(409, { error: "stale", current: server });
      const r = reconcile(server.doc, req.paragraphs);
      server = { rev: server.rev + 1, doc: r.doc, actor: "user", createdAt: "" };
      return { revision: server, changed: r.changed, alignJobId: null };
    }),
    transcriptOps: vi.fn(),
  };

  const open = (doc: TranscriptDoc) => {
    server = rev(doc);
    session = new TranscriptSession(mount, server, { api, projectId: "p", delayMs: 500, idleMs: 1000 });
    return session;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    saves.length = 0;
    api.saveTranscript.mockClear();
    mount = document.createElement("div");
    document.body.appendChild(mount);
  });
  afterEach(() => {
    session?.destroy();
    session = null;
    mount.remove();
    vi.useRealTimers();
  });

  it("editing inside a word keeps its id and mark", async () => {
    const doc = docOf("я приехал Самоа");
    const s = open(doc);
    const [, , samoa] = allWords(doc);
    // Replace "Самоа" → "Самоа," by typing at its end... inside the word: insert "x" after "Сам".
    const from = afterWord(doc, 1) + 1 + 3;
    s.dispatch(s.state.tr.insertText("о", from));
    const runs = editedFromPm(s.state.doc)[0]!.runs;
    expect(runs.find((r) => r.text.startsWith("Сам"))).toEqual({ text: "Самооа", wordId: samoa!.id });
    await vi.advanceTimersByTimeAsync(600);
    expect(api.saveTranscript).toHaveBeenCalledTimes(1);
    const w = allWords(server.doc)[2]!;
    expect(w.id).toBe(samoa!.id);
    expect(w.text).toBe("Самооа");
    expect(w.source).toEqual({ kind: "user" });
  });

  it("typed words have null id, then get the server id stamped", async () => {
    const doc = docOf("я приехал Самоа");
    const s = open(doc);
    const [, prie] = allWords(doc);
    s.insertAround(prie!.id, "after");
    s.dispatch(s.state.tr.insertText("на"));
    const runs = editedFromPm(s.state.doc)[0]!.runs;
    expect(runs.some((r) => r.text.includes("на") && r.wordId === null)).toBe(true);
    expect(runs.find((r) => r.wordId === prie!.id)!.text).toBe("приехал");
    expect(s.isDirty()).toBe(true);

    await vi.advanceTimersByTimeAsync(600);
    expect(saves).toHaveLength(1);
    const words = allWords(server.doc);
    expect(words.map((w) => w.text)).toEqual(["я", "приехал", "на", "Самоа"]);
    expect(words[2]!.timing).toBe("unconfirmed");
    // The editor now carries the server id for "на" and is clean.
    expect(s.isDirty()).toBe(false);
    expect(s.saveStatus).toBe("saved");
    let stamped: string | null = null;
    s.state.doc.descendants((n) => {
      if (n.isText && n.text === "на") stamped = n.marks.find((m) => m.type === wordMark)?.attrs.id ?? null;
    });
    expect(stamped).toBe(words[2]!.id);
    // A second save is not triggered by the stamp itself.
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toHaveLength(1);
  });

  it("text typed while a save is in flight is kept and saved next", async () => {
    const doc = docOf("раз два три");
    const s = open(doc);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = api.saveTranscript.getMockImplementation()!;
    api.saveTranscript.mockImplementationOnce(async (id, req) => {
      await gate;
      return orig(id, req);
    });
    s.dispatch(s.state.tr.insertText(" четыре", s.state.doc.content.size - 1));
    await vi.advanceTimersByTimeAsync(600); // save #1 in flight
    s.dispatch(s.state.tr.insertText("пять ", 1)); // typed at the start meanwhile
    release();
    await vi.advanceTimersByTimeAsync(10);
    // "четыре" got its server id at its *mapped* position; "пять" is still unsaved.
    const ids = editedFromPm(s.state.doc)[0]!.runs.filter((r) => r.wordId).map((r) => r.text);
    expect(ids).toEqual(["раз", "два", "три", "четыре"]);
    await vi.advanceTimersByTimeAsync(600);
    expect(allWords(server.doc).map((w) => w.text)).toEqual(["пять", "раз", "два", "три", "четыре"]);
    expect(s.isDirty()).toBe(false);
  });

  it("does not save mid-composition; saves after compositionend", async () => {
    const doc = docOf("привет мир");
    const s = open(doc);
    s.enterEdit(1);
    s.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(s.view.composing).toBe(true);
    s.dispatch(s.state.tr.insertText("ой "));
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.saveTranscript).not.toHaveBeenCalled();
    s.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.view.composing).toBe(false);
    expect(api.saveTranscript).toHaveBeenCalledTimes(1);
  });

  it("409 with a timing-only change rebases and retries silently", async () => {
    const doc = docOf("раз два");
    const s = open(doc);
    // Aligner moved timings on the server (same ids/text).
    const moved = structuredClone(server.doc);
    allWords(moved)[0]!.timing = "aligned";
    server = { rev: 2, doc: moved, actor: "align", createdAt: "" };
    s.dispatch(s.state.tr.insertText(" три", s.state.doc.content.size - 1));
    await vi.advanceTimersByTimeAsync(600);
    expect(saves.map((x) => x.baseRev)).toEqual([1, 2]);
    expect(allWords(server.doc)[0]!.timing).toBe("aligned");
    expect(s.saveStatus).toBe("saved");
  });

  it("409 with a text change while typing raises a conflict", async () => {
    const doc = docOf("раз два");
    const s = open(doc);
    const conflicts: unknown[] = [];
    // @ts-expect-error test hook
    s.deps.onConflict = (r: unknown) => conflicts.push(r);
    const other = reconcile(server.doc, [{ id: null, runs: [{ text: "совсем другое", wordId: null }] }]).doc;
    server = { rev: 2, doc: other, actor: "user", createdAt: "" };
    s.dispatch(s.state.tr.insertText(" три", s.state.doc.content.size - 1));
    await vi.advanceTimersByTimeAsync(520); // save fires; user still "typing" (idleMs 1000)
    expect(s.saveStatus).toBe("conflict");
    expect(conflicts).toHaveLength(1);
    s.resolveConflict("theirs");
    expect(s.state.doc.textContent).toBe("совсем другое");
  });

  it("polled revision with only timing changes is adopted without touching text", () => {
    const doc = docOf("раз два");
    const s = open(doc);
    s.enterEdit(1);
    s.dispatch(s.state.tr.insertText("ну "));
    const moved = structuredClone(doc);
    allWords(moved)[1]!.timing = "aligned";
    s.remoteRevision(rev(moved, 5));
    expect(s.baseRev).toBe(5);
    expect(s.state.doc.textContent).toBe("ну раз два");
    expect(s.ui.words.get(allWords(doc)[1]!.id)!.timing).toBe("aligned");
  });

  it("paste strips word marks so ids are never duplicated", () => {
    const doc = docOf("раз два");
    const s = open(doc);
    const slice = s.state.doc.slice(1, 4); // "раз" with its mark
    // @ts-expect-error ProseMirror exposes transformPasted via someProp
    const cleaned = s.view.someProp("transformPasted", (f) => f(slice, s.view));
    s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, s.state.doc.content.size - 1)).replaceSelection(cleaned!));
    const runs = editedFromPm(s.state.doc)[0]!.runs;
    expect(runs.filter((r) => r.wordId === allWords(doc)[0]!.id)).toHaveLength(1);
  });

  it("undo restores the previous text", async () => {
    const doc = docOf("раз два");
    const s = open(doc);
    s.dispatch(s.state.tr.insertText("!", 4));
    expect(s.state.doc.textContent).toBe("раз! два");
    s.undo();
    expect(s.state.doc.textContent).toBe("раз два");
    expect(s.isDirty()).toBe(false);
  });
});
