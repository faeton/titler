import type { Word } from "@titler/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { tokenize } from "./convert";
import { wordMark } from "./schema";

// View state that is not document content: server word facts (timing, review,
// hidden), the word under the playhead, the browse-mode selection range.
// Everything is drawn with decorations so the doc stays plain text + ids.

export interface IndexEntry {
  id: string;
  from: number;
  to: number;
}

export interface Range {
  anchor: string;
  head: string;
}

export interface UiState {
  words: Map<string, Word>;
  current: string | null;
  range: Range | null;
  editing: boolean;
  index: IndexEntry[];
  deco: DecorationSet;
}

export type UiMeta = Partial<Pick<UiState, "words" | "current" | "range" | "editing">>;

export const uiKey = new PluginKey<UiState>("titler-ui");

export const buildIndex = (doc: PMNode): IndexEntry[] => {
  const out: IndexEntry[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const m = node.marks.find((x) => x.type === wordMark);
    if (!m) return;
    const id = m.attrs.id as string;
    const last = out[out.length - 1];
    if (last && last.id === id && last.to === pos) last.to = pos + node.nodeSize;
    else out.push({ id, from: pos, to: pos + node.nodeSize });
  });
  return out;
};

export const rangeIds = (index: IndexEntry[], range: Range | null): string[] => {
  if (!range) return [];
  const a = index.findIndex((e) => e.id === range.anchor);
  const b = index.findIndex((e) => e.id === range.head);
  if (a < 0 || b < 0) return [];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return index.slice(lo, hi + 1).map((e) => e.id);
};

const classesFor = (w: Word | undefined): string => {
  if (!w) return "w-unconf";
  const c: string[] = [];
  if (w.hidden) c.push("w-hidden");
  if (w.review === "needs_review") c.push("w-review");
  if (w.timing === "unconfirmed" || w.start === null) c.push("w-unconf");
  else if (w.timing === "manual") c.push("w-manual");
  return c.join(" ");
};

const decorate = (state: EditorState, s: Omit<UiState, "deco">): DecorationSet => {
  const decos: Decoration[] = [];
  const sel = new Set(rangeIds(s.index, s.range));
  for (const e of s.index) {
    let cls = classesFor(s.words.get(e.id));
    if (e.id === s.current) cls += " w-cur";
    if (sel.has(e.id)) cls += " w-sel";
    if (cls.trim()) decos.push(Decoration.inline(e.from, e.to, { class: cls.trim() }));
  }
  // Typed text that the server has not given an id yet.
  for (const p of tokenize(state.doc))
    for (const t of p.tokens) if (!t.ids.length) decos.push(Decoration.inline(t.from, t.to, { class: "w-new" }));
  if (s.editing) {
    const $from = state.selection.$from;
    if ($from.depth >= 1) {
      const pos = $from.before(1);
      decos.push(Decoration.node(pos, pos + $from.node(1).nodeSize, { class: "p-active" }));
    }
  }
  return DecorationSet.create(state.doc, decos);
};

export const uiPlugin = () =>
  new Plugin<UiState>({
    key: uiKey,
    state: {
      init: (_, state) => {
        const base = { words: new Map(), current: null, range: null, editing: false, index: buildIndex(state.doc) };
        return { ...base, deco: decorate(state, base) };
      },
      apply: (tr, prev, _old, state) => {
        const meta = tr.getMeta(uiKey) as UiMeta | undefined;
        if (!meta && !tr.docChanged && !(prev.editing && tr.selectionSet)) return prev;
        const next = { ...prev, ...meta, index: tr.docChanged ? buildIndex(state.doc) : prev.index };
        return { ...next, deco: decorate(state, next) };
      },
    },
    props: {
      decorations: (state) => uiKey.getState(state)?.deco,
    },
  });
