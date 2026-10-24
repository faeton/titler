import type { SaveTranscriptRes, TranscriptOp, TranscriptRevision, Word } from "@titler/core";
import { allWords } from "@titler/core";
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo, undoDepth, redoDepth } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Fragment, type Node as PMNode, Slice } from "prosemirror-model";
import { EditorState, Plugin, TextSelection, type Transaction } from "prosemirror-state";
import { Mapping } from "prosemirror-transform";
import { EditorView } from "prosemirror-view";
import { isStale, type Api } from "../api/types";
import { editedFromPm, pmFromTranscript, pmSig, revSig, stampServerIds } from "./convert";
import { wordMark } from "./schema";
import { uiKey, uiPlugin, type IndexEntry, type Range, type UiMeta } from "./uiPlugin";

// Owns the ProseMirror view and keeps it in sync with the server:
//  - debounced autosave (PUT transcript with baseRev), never mid-composition;
//  - after a save, server ids are stamped onto the words typed meanwhile;
//  - polled revisions are adopted silently when only timings/flags changed;
//  - stale saves are retried (timing-only change, or user idle) or surface a conflict.

export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

export interface SessionDeps {
  api: Pick<Api, "saveTranscript" | "transcriptOps">;
  projectId: string;
  delayMs?: number;
  /** "Is the user typing" window used for the 409 policy. */
  idleMs?: number;
  onStatus?: (s: SaveStatus, err?: string) => void;
  onConflict?: (remote: TranscriptRevision | null) => void;
  onRevision?: (rev: TranscriptRevision) => void;
  /** A save/ops request succeeded (e.g. refresh jobs: an align job may be queued). */
  onSaved?: (res: SaveTranscriptRes) => void;
  /** Any state change (doc, selection, ui) — for React re-render. */
  onChange?: () => void;
}

const stripWordMarks = (frag: Fragment): Fragment => {
  const out: PMNode[] = [];
  frag.forEach((n) => {
    if (n.isText) out.push(n.mark(n.marks.filter((m) => m.type !== wordMark)));
    else out.push(n.type.create(n.type.name === "paragraph" ? { id: null } : n.attrs, stripWordMarks(n.content)));
  });
  return Fragment.fromArray(out);
};

export class TranscriptSession {
  readonly view: EditorView;
  baseRev = 0;
  private syncedSig = "";
  private inflight: { doc: PMNode; mapping: Mapping } | null = null;
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastInputAt = 0;
  private status: SaveStatus = "saved";
  private conflict: TranscriptRevision | null = null;
  private destroyed = false;
  private readonly deps: Required<Pick<SessionDeps, "delayMs" | "idleMs">> & SessionDeps;

  constructor(mount: HTMLElement, rev: TranscriptRevision | null, deps: SessionDeps) {
    this.deps = { delayMs: 900, idleMs: 2500, ...deps };
    this.view = new EditorView(mount, {
      state: this.makeState(rev),
      editable: (s) => !!uiKey.getState(s)?.editing,
      dispatchTransaction: (tr) => this.dispatch(tr),
      attributes: { class: "pm", spellcheck: "true", autocapitalize: "sentences", lang: "ru" },
      transformPasted: (slice) => new Slice(stripWordMarks(slice.content), slice.openStart, slice.openEnd),
    });
    // compositionend fires before PM flushes the composed text; give it a tick.
    this.view.dom.addEventListener("compositionend", () => setTimeout(() => this.status === "dirty" && this.schedule(), 0));
    this.adopt(rev);
  }

  private makeState(rev: TranscriptRevision | null): EditorState {
    return EditorState.create({
      doc: pmFromTranscript(rev?.doc ?? null),
      plugins: [
        history(),
        keymap({
          "Mod-z": undo,
          "Mod-Shift-z": redo,
          "Mod-y": redo,
          Escape: () => {
            this.exitEdit();
            return true;
          },
        }),
        keymap(baseKeymap),
        uiPlugin(),
        new Plugin({ props: { handleDOMEvents: { input: () => ((this.lastInputAt = Date.now()), false) } } }),
      ],
    });
  }

  // ---- state ---------------------------------------------------------------

  get state(): EditorState {
    return this.view.state;
  }

  get ui() {
    return uiKey.getState(this.view.state)!;
  }

  get saveStatus(): SaveStatus {
    return this.status;
  }

  get pendingConflict(): TranscriptRevision | null {
    return this.conflict;
  }

  get canUndo() {
    return undoDepth(this.view.state) > 0;
  }

  get canRedo() {
    return redoDepth(this.view.state) > 0;
  }

  /** Doc differs (in text or ids) from the last revision we are based on. */
  isDirty(): boolean {
    return pmSig(this.view.state.doc) !== this.syncedSig;
  }

  isTyping(): boolean {
    return this.view.composing || Date.now() - this.lastInputAt < this.deps.idleMs;
  }

  private setStatus(s: SaveStatus, err?: string) {
    if (this.status === s && !err) return;
    this.status = s;
    this.deps.onStatus?.(s, err);
  }

  dispatch(tr: Transaction) {
    if (this.destroyed) return;
    this.view.updateState(this.view.state.apply(tr));
    if (tr.docChanged && !tr.getMeta("sync")) {
      this.lastInputAt = Date.now();
      this.inflight?.mapping.appendMapping(tr.mapping);
      if (this.status !== "conflict") {
        this.setStatus(this.isDirty() ? "dirty" : "saved");
        this.schedule();
      }
    }
    this.deps.onChange?.();
  }

  setUi(meta: UiMeta) {
    this.dispatch(this.view.state.tr.setMeta(uiKey, meta).setMeta("addToHistory", false));
  }

  private setWordsFrom(rev: TranscriptRevision | null) {
    const words = new Map<string, Word>();
    if (rev) for (const w of allWords(rev.doc)) words.set(w.id, w);
    this.setUi({ words });
  }

  /** Make `rev` the base without touching the editor text. */
  private adopt(rev: TranscriptRevision | null) {
    this.baseRev = rev?.rev ?? 0;
    this.syncedSig = revSig(rev?.doc ?? null);
    this.setWordsFrom(rev);
    if (rev) this.deps.onRevision?.(rev);
  }

  /** Replace the editor content with `rev` (resets undo history). */
  private replaceDoc(rev: TranscriptRevision | null) {
    const ui = this.ui;
    this.view.updateState(this.makeState(rev));
    this.setUi({ current: ui.current, editing: ui.editing, range: null });
    this.adopt(rev);
    this.setStatus("saved");
  }

  // ---- saving --------------------------------------------------------------

  private schedule(delay = this.deps.delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, delay);
  }

  /** Save now if dirty. Never mid-composition (re-armed by compositionend). */
  async save(): Promise<void> {
    if (this.destroyed || this.status === "conflict") return;
    if (this.view.composing) return;
    if (this.inflight) {
      this.pending = true;
      return;
    }
    if (!this.isDirty()) {
      this.setStatus("saved");
      return;
    }
    const doc = this.view.state.doc;
    this.inflight = { doc, mapping: new Mapping() };
    this.setStatus("saving");
    try {
      const res = await this.deps.api.saveTranscript(this.deps.projectId, {
        baseRev: this.baseRev,
        paragraphs: editedFromPm(doc),
      });
      this.afterSave(res);
      this.deps.onSaved?.(res);
    } catch (e) {
      const inflight = this.inflight;
      this.inflight = null;
      if (isStale(e)) return this.onStale(e.body.current, inflight);
      this.setStatus("error", e instanceof Error ? e.message : String(e));
      this.schedule(4000);
      return;
    }
    this.inflight = null;
    if (this.pending || this.isDirty()) {
      this.pending = false;
      this.setStatus("dirty");
      this.schedule();
    } else this.setStatus("saved");
  }

  private afterSave(res: SaveTranscriptRes) {
    const inf = this.inflight!;
    const rev = res.revision;
    const tr = stampServerIds(this.view.state, inf.doc, inf.mapping, rev);
    if (tr) this.dispatch(tr.setMeta("addToHistory", false).setMeta("sync", true));
    else if (this.view.state.doc.eq(inf.doc)) {
      // Did not line up token-for-token (should not happen) and nothing typed since: take the server's.
      this.replaceDoc(rev);
      return;
    }
    this.adopt(rev);
  }

  private onStale(current: TranscriptRevision, inflight: { doc: PMNode } | null) {
    void inflight;
    if (revSig(current.doc) === this.syncedSig || !this.isTyping()) {
      // Only timings/flags moved, or the user is idle: rebase our text onto it.
      this.baseRev = current.rev;
      this.setWordsFrom(current);
      if (revSig(current.doc) === this.syncedSig) this.deps.onRevision?.(current);
      this.setStatus("dirty");
      this.schedule(0);
      return;
    }
    this.raiseConflict(current);
  }

  private raiseConflict(remote: TranscriptRevision) {
    this.conflict = remote;
    this.setStatus("conflict");
    this.deps.onConflict?.(remote);
  }

  /** "theirs" = load the server text; "mine" = keep my text and save over it. */
  resolveConflict(choice: "theirs" | "mine") {
    const remote = this.conflict;
    this.conflict = null;
    this.deps.onConflict?.(null);
    if (!remote) return;
    if (choice === "theirs") this.replaceDoc(remote);
    else {
      this.baseRev = remote.rev;
      this.setWordsFrom(remote);
      this.setStatus("dirty");
      void this.save();
    }
  }

  /** A newer revision seen by polling. */
  remoteRevision(rev: TranscriptRevision | null) {
    if (!rev || rev.rev <= this.baseRev || this.inflight || this.conflict) return;
    if (revSig(rev.doc) === this.syncedSig) this.adopt(rev);
    else if (!this.isDirty()) this.replaceDoc(rev);
    else this.raiseConflict(rev);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.save();
    // Wait out an in-flight save too.
    for (let i = 0; this.inflight && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
  }

  /** Word-level ops (hide, timing, review). Flushes text first so ids exist. */
  async applyOps(ops: TranscriptOp[]): Promise<void> {
    await this.flush();
    if (this.status === "conflict") throw new Error("Сначала разрешите конфликт версий");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.deps.api.transcriptOps(this.deps.projectId, { baseRev: this.baseRev, ops });
        this.deps.onSaved?.(res);
        if (revSig(res.revision.doc) === pmSig(this.view.state.doc) || !this.isDirty()) {
          if (revSig(res.revision.doc) !== pmSig(this.view.state.doc)) this.replaceDoc(res.revision);
          else this.adopt(res.revision);
        } else {
          // Typed during the request: keep the text, take the facts.
          this.baseRev = res.revision.rev;
          this.setWordsFrom(res.revision);
          this.deps.onRevision?.(res.revision);
        }
        return;
      } catch (e) {
        if (isStale(e) && attempt === 0 && revSig(e.body.current.doc) === this.syncedSig) {
          this.adopt(e.body.current);
          continue;
        }
        throw e;
      }
    }
  }

  // ---- modes & selection --------------------------------------------------------

  entry(id: string): IndexEntry | undefined {
    return this.ui.index.find((e) => e.id === id);
  }

  select(range: Range | null) {
    this.setUi({ range });
  }

  /** Enter edit mode with the caret at `pos` (call from a user gesture so the keyboard opens). */
  enterEdit(pos?: number, head?: number) {
    const { state } = this.view;
    const clamp = (p: number) => Math.max(0, Math.min(p, state.doc.content.size));
    let tr = state.tr.setMeta(uiKey, { editing: true, range: null } satisfies UiMeta).setMeta("addToHistory", false);
    if (pos !== undefined) tr = tr.setSelection(TextSelection.create(state.doc, clamp(pos), clamp(head ?? pos)));
    this.dispatch(tr);
    this.view.focus();
  }

  exitEdit() {
    if (!this.ui.editing) return;
    this.setUi({ editing: false });
    (this.view.dom as HTMLElement).blur();
    window.getSelection()?.removeAllRanges();
    void this.save();
  }

  /** "Вставить до/после": open a gap next to the word and put the caret in it. */
  insertAround(id: string, where: "before" | "after") {
    const e = this.entry(id);
    if (!e) return;
    const at = where === "before" ? e.from : e.to;
    const { state } = this.view;
    let tr = state.tr.insertText(" ", at);
    tr = tr.setSelection(TextSelection.create(tr.doc, where === "before" ? at : at + 1));
    tr.setStoredMarks([]);
    tr.setMeta(uiKey, { editing: true, range: null } satisfies UiMeta);
    this.dispatch(tr);
    this.view.focus();
  }

  undo() {
    undo(this.view.state, (tr) => this.dispatch(tr));
  }

  redo() {
    redo(this.view.state, (tr) => this.dispatch(tr));
  }

  destroy() {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.view.destroy();
  }
}
