import { Schema } from "prosemirror-model";

// Paragraphs of plain text. Every word that exists on the server carries a
// `word` mark with its id; freshly typed text has no mark (→ wordId null).
// The mark is non-inclusive so typing at a word's edge does not inherit it.

export const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "text*",
      attrs: { id: { default: null } },
      parseDOM: [{ tag: "p", getAttrs: (d) => ({ id: (d as HTMLElement).dataset.pid ?? null }) }],
      toDOM: (n) => ["p", n.attrs.id ? { "data-pid": n.attrs.id } : {}, 0],
    },
    text: {},
  },
  marks: {
    word: {
      attrs: { id: {} },
      inclusive: false,
      parseDOM: [{ tag: "span[data-w]", getAttrs: (d) => ({ id: (d as HTMLElement).dataset.w }) }],
      toDOM: (m) => ["span", { class: "w", "data-w": m.attrs.id }, 0],
    },
  },
});

export const wordMark = schema.marks.word!;
