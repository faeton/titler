import type { EditedParagraph, Run, TranscriptDoc, TranscriptRevision } from "@titler/core";
import type { Node as PMNode } from "prosemirror-model";
import type { Mapping } from "prosemirror-transform";
import type { EditorState, Transaction } from "prosemirror-state";
import { schema, wordMark } from "./schema";

// TranscriptDoc ⇄ ProseMirror doc ⇄ EditedParagraph[] (core.reconcile input).

export const pmFromTranscript = (doc: TranscriptDoc | null): PMNode => {
  const paras = (doc?.paragraphs ?? []).map((p) => {
    const content: PMNode[] = [];
    p.words.forEach((w, i) => {
      if (i) content.push(schema.text(" "));
      content.push(schema.text(w.text, [wordMark.create({ id: w.id })]));
    });
    return schema.node("paragraph", { id: p.id }, content);
  });
  return schema.node("doc", null, paras.length ? paras : [schema.node("paragraph")]);
};

const markId = (n: PMNode): string | null => {
  const m = n.marks.find((x) => x.type === wordMark);
  return m ? (m.attrs.id as string) : null;
};

export const editedFromPm = (doc: PMNode): EditedParagraph[] => {
  const out: EditedParagraph[] = [];
  doc.forEach((para) => {
    const runs: Run[] = [];
    para.forEach((child) => {
      const wordId = markId(child);
      const last = runs[runs.length - 1];
      if (last && last.wordId === wordId) last.text += child.text ?? "";
      else runs.push({ text: child.text ?? "", wordId });
    });
    out.push({ id: (para.attrs.id as string | null) ?? null, runs });
  });
  return out;
};

export interface Token {
  /** Absolute doc positions. */
  from: number;
  to: number;
  text: string;
  /** The one word id that owns every char of the token, or null (typed / merged). */
  id: string | null;
  /** All ids touching the token. */
  ids: string[];
}

export interface ParaTokens {
  pos: number;
  id: string | null;
  tokens: Token[];
}

/** Whitespace tokenisation — the same rule core.reconcile uses. */
export const tokenize = (doc: PMNode): ParaTokens[] => {
  const out: ParaTokens[] = [];
  doc.forEach((para, offset) => {
    const start = offset + 1;
    const owners: (string | null)[] = [];
    let text = "";
    para.forEach((child) => {
      const id = markId(child);
      const t = child.text ?? "";
      text += t;
      for (let k = 0; k < t.length; k++) owners.push(id);
    });
    const tokens: Token[] = [];
    for (const m of text.matchAll(/\S+/gu)) {
      const a = m.index!;
      const b = a + m[0].length;
      const own = owners.slice(a, b);
      const ids = [...new Set(own.filter((x): x is string => x !== null))];
      const pure = ids.length === 1 && own.every((x) => x !== null);
      tokens.push({ from: start + a, to: start + b, text: m[0], id: pure ? ids[0]! : null, ids });
    }
    out.push({ pos: offset, id: (para.attrs.id as string | null) ?? null, tokens });
  });
  return out;
};

/** Structure signature: equal ⇔ saving would not change the server's text/ids. */
export const pmSig = (doc: PMNode): string =>
  tokenize(doc)
    .filter((p) => p.tokens.length)
    .map((p) => p.tokens.map((t) => `${t.id ?? "*"}:${t.text}`).join(" "))
    .join("\n");

export const revSig = (doc: TranscriptDoc | null): string =>
  (doc?.paragraphs ?? [])
    .filter((p) => p.words.length)
    .map((p) => p.words.map((w) => `${w.id}:${w.text}`).join(" "))
    .join("\n");

/**
 * After a save, stamp the server's word/paragraph ids onto the editor doc.
 * `savedDoc` is what was sent; `mapping` covers everything typed since, so
 * edits made while the request was in flight are kept. Returns null if the
 * revision does not line up token-for-token with savedDoc.
 */
export const stampServerIds = (
  state: EditorState,
  savedDoc: PMNode,
  mapping: Mapping,
  rev: TranscriptRevision,
): Transaction | null => {
  const paras = tokenize(savedDoc).filter((p) => p.tokens.length);
  const revParas = rev.doc.paragraphs.filter((p) => p.words.length);
  if (paras.length !== revParas.length) return null;
  for (let i = 0; i < paras.length; i++) {
    const a = paras[i]!.tokens;
    const b = revParas[i]!.words;
    if (a.length !== b.length || a.some((t, k) => t.text !== b[k]!.text)) return null;
  }
  const tr = state.tr;
  paras.forEach((p, i) => {
    const rp = revParas[i]!;
    if (p.id !== rp.id) {
      const res = mapping.mapResult(p.pos, 1);
      const node = !res.deleted ? tr.doc.nodeAt(res.pos) : null;
      if (node?.type.name === "paragraph") tr.setNodeMarkup(res.pos, undefined, { ...node.attrs, id: rp.id });
    }
    p.tokens.forEach((t, k) => {
      const w = rp.words[k]!;
      if (t.id === w.id) return;
      const from = mapping.map(t.from, 1);
      const to = mapping.map(t.to, -1);
      if (to <= from) return;
      tr.removeMark(from, to, wordMark).addMark(from, to, wordMark.create({ id: w.id }));
    });
  });
  return tr.docChanged ? tr : null;
};
