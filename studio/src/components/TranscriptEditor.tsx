import { useCallback, useEffect, useRef, useState } from "react";
import type { Transcript } from "../api";

/**
 * Interactive transcript editor.
 *
 * - Click a word → seek video there (no auto-play)
 * - Double-click a word → pause video + edit text
 * - Hover a word → × appears to remove it
 * - Double-click the gap between two words → insert a new word
 * - During playback, current word highlights yellow
 * - Low-confidence words (prob < 0.7) shown in red
 * - Enter to save edit, Escape to cancel
 */

type Props = {
  transcript: Transcript;
  currentTime: number;
  onSeek: (time: number) => void;
  onPause: () => void;
  onEdit: (index: number, newText: string) => void;
  onDelete: (index: number) => void;
  onInsert: (afterIndex: number, text: string) => void;
};

type EditTarget =
  | { kind: "word"; index: number }
  | { kind: "gap"; afterIndex: number };

export const TranscriptEditor: React.FC<Props> = ({
  transcript,
  currentTime,
  onSeek,
  onPause,
  onEdit,
  onDelete,
  onInsert,
}) => {
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [editText, setEditText] = useState("");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isEditing = editing !== null;

  const currentWordIdx = transcript.words.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end,
  );

  useEffect(() => {
    if (isEditing) return;
    if (currentWordIdx >= 0 && containerRef.current) {
      const el = containerRef.current.querySelector(
        `[data-word-idx="${currentWordIdx}"]`,
      );
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [currentWordIdx, isEditing]);

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
      setEditText(transcript.words[idx].text);
    },
    [transcript.words, onPause],
  );

  const startInsert = useCallback(
    (afterIndex: number) => {
      onPause();
      setEditing({ kind: "gap", afterIndex });
      setEditText("");
    },
    [onPause],
  );

  const commitEdit = useCallback(() => {
    if (!editing) return;
    const trimmed = editText.trim();
    if (editing.kind === "word") {
      if (trimmed && trimmed !== transcript.words[editing.index].text) {
        onEdit(editing.index, trimmed);
      }
    } else {
      if (trimmed) onInsert(editing.afterIndex, trimmed);
    }
    setEditing(null);
  }, [editing, editText, transcript.words, onEdit, onInsert]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
  }, []);

  const handleClick = useCallback(
    (idx: number) => {
      if (isEditing) return;
      onSeek(transcript.words[idx].start);
    },
    [isEditing, onSeek, transcript.words],
  );

  const renderEditInput = (keyPrefix: string, width: number) => (
    <input
      key={keyPrefix}
      ref={inputRef}
      type="text"
      value={editText}
      onChange={(e) => setEditText(e.target.value)}
      onBlur={commitEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitEdit();
        if (e.key === "Escape") cancelEdit();
      }}
      style={{
        font: "inherit",
        fontSize: 13,
        fontWeight: 600,
        color: "#facc15",
        background: "#2a2a33",
        border: "1px solid #facc15",
        borderRadius: 4,
        padding: "2px 6px",
        margin: "0 2px",
        width,
        outline: "none",
      }}
    />
  );

  const renderGap = (afterIndex: number) => {
    const isEditingHere =
      editing?.kind === "gap" && editing.afterIndex === afterIndex;
    if (isEditingHere) {
      return renderEditInput(
        `gap-${afterIndex}-edit`,
        Math.max(40, editText.length * 9),
      );
    }
    return (
      <span
        key={`gap-${afterIndex}`}
        onDoubleClick={() => startInsert(afterIndex)}
        title="double-click to insert a word"
        style={{
          display: "inline-block",
          width: 6,
          height: 18,
          verticalAlign: "middle",
          cursor: "text",
          borderRadius: 2,
        }}
      />
    );
  };

  return (
    <div ref={containerRef} style={{ lineHeight: 2.2 }}>
      {renderGap(-1)}
      {transcript.words.map((word, i) => {
        const isCurrent = i === currentWordIdx && !isEditing;
        const isEditingThis =
          editing?.kind === "word" && editing.index === i;
        const lowProb = (word.prob ?? 1) < 0.7;
        const isHovered = hoverIdx === i && !isEditing;

        const wordNode = isEditingThis
          ? renderEditInput(
              `${i}-edit`,
              Math.max(40, editText.length * 9),
            )
          : (
              <span
                key={`${i}-${word.start}`}
                data-word-idx={i}
                onClick={() => handleClick(i)}
                onDoubleClick={() => startEditWord(i)}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() =>
                  setHoverIdx((h) => (h === i ? null : h))
                }
                title={`${word.start.toFixed(2)}s – ${word.end.toFixed(2)}s${lowProb ? ` (prob ${word.prob})` : ""}`}
                style={{
                  position: "relative",
                  display: "inline-block",
                  padding: "1px 4px",
                  margin: "0 1px",
                  borderRadius: 3,
                  fontSize: 13,
                  cursor: "pointer",
                  transition: "background 0.15s, color 0.15s",
                  background: isCurrent
                    ? "#facc15"
                    : lowProb
                      ? "rgba(239, 68, 68, 0.15)"
                      : "transparent",
                  color: isCurrent
                    ? "#000"
                    : lowProb
                      ? "#ef4444"
                      : "#e6e6e6",
                  fontWeight: isCurrent ? 700 : 400,
                  textDecoration: lowProb ? "underline dotted" : "none",
                }}
              >
                {word.text}
                {isHovered && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(i);
                      setHoverIdx(null);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title="remove this word"
                    style={{
                      position: "absolute",
                      top: -6,
                      right: -4,
                      width: 14,
                      height: 14,
                      lineHeight: "13px",
                      textAlign: "center",
                      fontSize: 10,
                      fontWeight: 700,
                      color: "#fff",
                      background: "#ef4444",
                      borderRadius: "50%",
                      cursor: "pointer",
                      boxShadow: "0 0 0 1.5px #1a1a22",
                    }}
                  >
                    ×
                  </span>
                )}
              </span>
            );

        return (
          <span key={`w-${i}`}>
            {wordNode}
            {renderGap(i)}
          </span>
        );
      })}
    </div>
  );
};
