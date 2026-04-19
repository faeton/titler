import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Transcript, Word } from "../api";
import { FONTS, fmtTime, type Tok } from "../tokens";

/**
 * Editorial prose transcript:
 *  - Words grouped into sentences; each sentence gets a clickable timestamp gutter
 *  - Click word → seek + briefly play ~1s (via onSeek)
 *  - Double-click word → edit inline with amber focus ring
 *  - Low-confidence words show a dotted warn underline
 *  - Hovering reveals an × to remove the word
 *  - Double-click the thin gap between two words → insert at playhead time
 */

type EditTarget =
  | { kind: "word"; index: number }
  | { kind: "gap"; afterIndex: number };

export const TranscriptEditor: React.FC<{
  tok: Tok;
  transcript: Transcript;
  currentTime: number;
  onSeek: (time: number) => void;
  onPause: () => void;
  onEdit: (index: number, newText: string) => void;
  onDelete: (index: number) => void;
  onDeleteLine?: (indices: number[]) => void;
  onInsert: (afterIndex: number, text: string) => void;
}> = ({ tok, transcript, currentTime, onSeek, onPause, onEdit, onDelete, onDeleteLine, onInsert }) => {
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [draft, setDraft] = useState("");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isEditing = editing !== null;
  const words = transcript.words;

  const activeIdx = useMemo(() => {
    for (let i = 0; i < words.length; i++) {
      if (currentTime >= words[i].start && currentTime < words[i].end) return i;
    }
    for (let i = words.length - 1; i >= 0; i--) {
      if (currentTime >= words[i].start) return i;
    }
    return -1;
  }, [currentTime, words]);

  // Group words into sentences by punctuation.
  const sentences = useMemo(() => {
    const out: { words: Word[]; idx: number[] }[] = [];
    let cur: { words: Word[]; idx: number[] } = { words: [], idx: [] };
    words.forEach((w, i) => {
      cur.words.push(w);
      cur.idx.push(i);
      if (/[.!?]$/.test(w.text) || (w.end - w.start > 0 && w.text.length > 0 && i === words.length - 1)) {
        out.push(cur);
        cur = { words: [], idx: [] };
      }
    });
    if (cur.words.length > 0) out.push(cur);
    return out;
  }, [words]);

  useEffect(() => {
    if (isEditing) return;
    if (activeIdx < 0 || !containerRef.current) return;
    const el = containerRef.current.querySelector(
      `[data-word-idx="${activeIdx}"]`,
    );
    if (el) (el as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx, isEditing]);

  useEffect(() => {
    if (editing !== null) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing]);

  const startEditWord = useCallback(
    (idx: number) => {
      onPause();
      setEditing({ kind: "word", index: idx });
      setDraft(words[idx].text);
    },
    [words, onPause],
  );

  const startInsert = useCallback(
    (afterIndex: number) => {
      onPause();
      setEditing({ kind: "gap", afterIndex });
      setDraft("");
    },
    [onPause],
  );

  const commit = useCallback(() => {
    if (!editing) return;
    const trimmed = draft.trim();
    if (editing.kind === "word") {
      if (trimmed && trimmed !== words[editing.index].text) {
        onEdit(editing.index, trimmed);
      }
    } else {
      if (trimmed) onInsert(editing.afterIndex, trimmed);
    }
    setEditing(null);
  }, [editing, draft, words, onEdit, onInsert]);

  const cancel = useCallback(() => setEditing(null), []);

  const renderInput = (w: number) => (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") cancel();
      }}
      style={{
        font: "inherit",
        color: tok.ink,
        border: 0,
        outline: `2px solid ${tok.accent}`,
        background: tok.accentSoft,
        padding: "1px 4px",
        borderRadius: 3,
        width: `${Math.max(w, 2)}ch`,
        margin: "0 2px",
      }}
    />
  );

  return (
    <div
      ref={containerRef}
      style={{
        fontFamily: FONTS.display,
        fontWeight: 400,
        fontSize: "clamp(18px, 1.35vw, 22px)",
        lineHeight: 1.55,
        letterSpacing: -0.1,
        color: tok.ink,
        maxWidth: 720,
      }}
    >
      {sentences.map((sent, si) => {
        const firstT = sent.words[0].start;
        const lineHovered = hoverLine === si && !isEditing;
        return (
          <p
            key={si}
            style={{ margin: "0 0 16px", position: "relative" }}
            onMouseEnter={() => setHoverLine(si)}
            onMouseLeave={() =>
              setHoverLine((h) => (h === si ? null : h))
            }
          >
            <span
              onClick={() => onSeek(firstT)}
              style={{
                fontFamily: FONTS.mono,
                fontSize: 10,
                color: tok.ink3,
                marginRight: 12,
                fontWeight: 500,
                cursor: "pointer",
                verticalAlign: "0.2em",
              }}
            >
              {fmtTime(firstT)}
            </span>
            {onDeleteLine && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteLine(sent.idx);
                  setHoverLine(null);
                  setHoverIdx(null);
                }}
                title="remove this line"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 14,
                  height: 14,
                  fontSize: 10,
                  fontWeight: 700,
                  color: tok.paper,
                  background: tok.err,
                  borderRadius: "50%",
                  cursor: "pointer",
                  fontFamily: FONTS.body,
                  verticalAlign: "0.2em",
                  marginRight: 10,
                  lineHeight: 1,
                  visibility: lineHovered ? "visible" : "hidden",
                }}
              >
                ×
              </span>
            )}
            {sent.idx.map((gi, wi) => {
              const w = words[gi];
              const isActive = gi === activeIdx && !isEditing;
              const low = (w.prob ?? 1) < 0.75;
              const isEditingWord = editing?.kind === "word" && editing.index === gi;
              const isEditingGap = editing?.kind === "gap" && editing.afterIndex === gi;
              const isHovered = hoverIdx === gi && !isEditing;
              const isLast = wi === sent.idx.length - 1;

              return (
                <span key={`${gi}-${w.start}`} style={{ whiteSpace: "normal" }}>
                  {isEditingWord ? (
                    renderInput(Math.max(draft.length, 2))
                  ) : (
                    <span
                      data-word-idx={gi}
                      onClick={() => !isEditing && onSeek(w.start)}
                      onDoubleClick={() => startEditWord(gi)}
                      onMouseEnter={() => setHoverIdx(gi)}
                      onMouseLeave={() =>
                        setHoverIdx((h) => (h === gi ? null : h))
                      }
                      title={`${fmtTime(w.start)} · conf ${Math.round((w.prob ?? 1) * 100)}%`}
                      style={{
                        position: "relative",
                        zIndex: isHovered ? 3 : "auto",
                        color: isActive ? tok.accentInk : tok.ink,
                        background: isActive ? tok.accentSoft : "transparent",
                        padding: isActive ? "1px 4px" : 0,
                        borderRadius: isActive ? 3 : 0,
                        borderBottom: low
                          ? `1.5px dotted ${tok.warn}`
                          : "none",
                        cursor: "pointer",
                        transition:
                          "background 0.12s ease, color 0.12s ease",
                        display: "inline-block",
                      }}
                      onMouseOver={(e) => {
                        if (!isActive)
                          (e.currentTarget as HTMLElement).style.background =
                            tok.sel;
                      }}
                      onMouseOut={(e) => {
                        if (!isActive)
                          (e.currentTarget as HTMLElement).style.background =
                            "transparent";
                      }}
                    >
                      {w.text}
                      {isHovered && (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(gi);
                            setHoverIdx(null);
                          }}
                          onDoubleClick={(e) => e.stopPropagation()}
                          title="remove this word"
                          style={{
                            position: "absolute",
                            top: -4,
                            right: -4,
                            width: 14,
                            height: 14,
                            lineHeight: "12px",
                            textAlign: "center",
                            fontSize: 10,
                            fontWeight: 700,
                            color: tok.paper,
                            background: tok.err,
                            borderRadius: "50%",
                            cursor: "pointer",
                            boxShadow: `0 0 0 1.5px ${tok.paper}`,
                            fontFamily: FONTS.body,
                            zIndex: 4,
                          }}
                        >
                          ×
                        </span>
                      )}
                    </span>
                  )}
                  {isEditingGap ? (
                    renderInput(Math.max(draft.length, 2))
                  ) : (
                    !isLast && (
                      <span
                        onDoubleClick={() => startInsert(gi)}
                        title="double-click to insert a word"
                        style={{
                          display: "inline-block",
                          width: "0.35em",
                          cursor: "text",
                        }}
                      >
                        {" "}
                      </span>
                    )
                  )}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
};
