import { useCallback, useEffect, useRef, useState } from "react";
import type { Transcript } from "../api";

/**
 * Interactive transcript editor.
 *
 * - Click a word → seek video there (no auto-play)
 * - Double-click a word → pause video + enter edit mode
 * - During playback, current word highlights yellow
 * - Low-confidence words (prob < 0.7) shown in red
 * - Edit inline, Enter to save, Escape to cancel
 */

type Props = {
  transcript: Transcript;
  currentTime: number;
  onSeek: (time: number) => void;
  onPause: () => void;
  onEdit: (index: number, newText: string) => void;
};

export const TranscriptEditor: React.FC<Props> = ({
  transcript,
  currentTime,
  onSeek,
  onPause,
  onEdit,
}) => {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isEditing = editingIdx !== null;

  // Find current word based on playback time
  const currentWordIdx = transcript.words.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end,
  );

  // Auto-scroll to current word ONLY when not editing
  useEffect(() => {
    if (isEditing) return;
    if (currentWordIdx >= 0 && containerRef.current) {
      const el = containerRef.current.querySelector(
        `[data-word-idx="${currentWordIdx}"]`,
      );
      if (el) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }, [currentWordIdx, isEditing]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (editingIdx !== null) {
      // Small delay to ensure the input is rendered
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editingIdx]);

  const startEdit = useCallback(
    (idx: number) => {
      onPause(); // stop the video so it doesn't steal focus
      setEditingIdx(idx);
      setEditText(transcript.words[idx].text);
    },
    [transcript.words, onPause],
  );

  const commitEdit = useCallback(() => {
    if (editingIdx === null) return;
    const trimmed = editText.trim();
    if (trimmed && trimmed !== transcript.words[editingIdx].text) {
      onEdit(editingIdx, trimmed);
    }
    setEditingIdx(null);
  }, [editingIdx, editText, transcript.words, onEdit]);

  const cancelEdit = useCallback(() => {
    setEditingIdx(null);
  }, []);

  const handleClick = useCallback(
    (idx: number) => {
      if (isEditing) return; // don't seek while editing another word
      onSeek(transcript.words[idx].start);
    },
    [isEditing, onSeek, transcript.words],
  );

  const handleDoubleClick = useCallback(
    (idx: number) => {
      startEdit(idx);
    },
    [startEdit],
  );

  return (
    <div ref={containerRef} style={{ lineHeight: 2.2 }}>
      {transcript.words.map((word, i) => {
        const isCurrent = i === currentWordIdx && !isEditing;
        const isEditingThis = i === editingIdx;
        const lowProb = (word.prob ?? 1) < 0.7;

        if (isEditingThis) {
          return (
            <input
              key={`${i}-edit`}
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
                width: Math.max(40, editText.length * 9),
                outline: "none",
              }}
            />
          );
        }

        return (
          <span
            key={`${i}-${word.start}`}
            data-word-idx={i}
            onClick={() => handleClick(i)}
            onDoubleClick={() => handleDoubleClick(i)}
            title={`${word.start.toFixed(2)}s – ${word.end.toFixed(2)}s${lowProb ? ` (prob ${word.prob})` : ""}`}
            style={{
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
          </span>
        );
      })}
    </div>
  );
};
