import type { TranscriptOp } from "@titler/core";
import { useEffect, useRef, useState } from "react";
import type { TranscriptSession } from "../../editor/session";
import { fmtTime } from "../../lib/format";
import { useProjectCtx } from "../project/useProject";
import type { TimedEntry } from "./TextTab";

interface Props {
  session: TranscriptSession;
  timeline: TimedEntry[];
  selectedIds: string[];
  first: TimedEntry | undefined;
  last: TimedEntry | undefined;
  editing: boolean;
  rangeMode: boolean;
  timingMode: boolean;
  setTimingMode: (v: boolean) => void;
  onClear: () => void;
  onContext: () => void;
  contextOn: boolean;
  ops: (fn: () => Promise<void>) => Promise<void>;
}

const UndoRedo = ({ session }: { session: TranscriptSession }) => (
  <>
    <button className="btn icon" aria-label="Отменить" title="Отменить (Ctrl/Cmd+Z)" disabled={!session.canUndo} onClick={() => session.undo()}>
      ↶
    </button>
    <button className="btn icon" aria-label="Повторить" title="Повторить (Ctrl/Cmd+Shift+Z)" disabled={!session.canRedo} onClick={() => session.redo()}>
      ↷
    </button>
  </>
);

const statusText = (e: TimedEntry | undefined): string => {
  const w = e?.word;
  if (!e) return "";
  if (!w) return "не сохранено";
  const s: string[] = [];
  if (w.review === "needs_review") s.push("проверить");
  if (w.review === "confirmed") s.push("проверено");
  if (w.timing === "unconfirmed" || w.start === null) s.push("тайминг не подтверждён");
  if (w.timing === "manual") s.push("тайминг вручную");
  if (w.timing === "aligned") s.push("выровнено");
  if (w.hidden) s.push("скрыто в субтитрах");
  return s.join(" · ");
};

export const WordActions = (p: Props) => {
  const { session, selectedIds, first, last, editing } = p;
  const { player } = useProjectCtx();

  if (editing)
    return (
      <div className="actions" role="toolbar" aria-label="Правка текста" onMouseDown={(e) => e.preventDefault()}>
        <button className="btn primary" onClick={() => session.exitEdit()}>
          Готово
        </button>
        <UndoRedo session={session} />
        <span className="hint" style={{ alignSelf: "center", fontSize: 13 }}>
          Enter — новый абзац · Esc — выйти
        </span>
      </div>
    );

  if (!first || !last)
    return (
      <div className="actions" role="toolbar">
        <span className="hint grow" style={{ alignSelf: "center", fontSize: 14 }}>
          Коснитесь слова — перейти к нему. Удержание — выделить несколько.
        </span>
        <UndoRedo session={session} />
      </div>
    );

  if (p.timingMode && first === last && first.word) return <TimingPanel {...p} entry={first} />;

  const words = selectedIds.map((id) => p.timeline.find((e) => e.id === id)?.word).filter(Boolean);
  const allHidden = words.length > 0 && words.every((w) => w!.hidden);
  const anyReview = words.some((w) => w!.review === "needs_review");
  const saved = words.length === selectedIds.length;
  const text =
    first === last
      ? session.state.doc.textBetween(first.from, first.to)
      : `${session.state.doc.textBetween(first.from, first.to)} … ${session.state.doc.textBetween(last.from, last.to)}`;

  const op = (o: TranscriptOp) => p.ops(() => session.applyOps([o]));

  return (
    <>
      <div className="selinfo">
        <b>«{text}»</b>
        <span>{fmtTime(first.start, true)}</span>
        {selectedIds.length > 1 ? <span>{selectedIds.length} сл.</span> : null}
        <span>{first === last ? statusText(first) : ""}</span>
        {p.rangeMode ? <span style={{ color: "var(--accent)" }}>коснитесь последнего слова</span> : null}
      </div>
      <div className="actions" role="toolbar" aria-label="Действия со словом">
        <button className={p.contextOn ? "btn on" : "btn"} onClick={p.onContext} title="C">
          {p.contextOn ? "■ Стоп" : "▶ Контекст"}
        </button>
        <button
          className="btn primary"
          onClick={() => {
            p.setTimingMode(false);
            if (first === last) session.enterEdit(first.to);
            else session.enterEdit(first.from, last.to);
          }}
        >
          Править
        </button>
        <button className="btn" onClick={() => session.insertAround(first.id, "before")}>
          Вставить до
        </button>
        <button className="btn" onClick={() => session.insertAround(last.id, "after")}>
          Вставить после
        </button>
        <button
          className="btn"
          disabled={!saved}
          onClick={() => void op({ kind: "set_hidden", wordIds: selectedIds, hidden: !allHidden })}
        >
          {allHidden ? "Вернуть в субтитры" : "Убрать из субтитров"}
        </button>
        {anyReview ? (
          <button className="btn" onClick={() => void op({ kind: "set_review", wordIds: selectedIds, review: "confirmed" })}>
            ✓ Проверено
          </button>
        ) : null}
        {first === last ? (
          <button className="btn" disabled={!first.word} onClick={() => p.setTimingMode(true)}>
            Тайминг
          </button>
        ) : null}
        <UndoRedo session={session} />
        <button
          className="btn icon ghost"
          aria-label="Снять выделение"
          onClick={() => {
            if (player.range) player.stopRange();
            p.onClear();
          }}
        >
          ×
        </button>
      </div>
    </>
  );
};

const STEP = 50;

const TimingPanel = (p: Props & { entry: TimedEntry }) => {
  const { session, entry } = p;
  const { player } = useProjectCtx();
  const w = entry.word!;
  const [t, setT] = useState({ start: entry.start, end: entry.end });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setT({ start: entry.start, end: entry.end }), [entry.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const nudge = (which: "start" | "end", d: number) => {
    const next = { ...t, [which]: Math.max(0, t[which] + d) };
    if (next.end - next.start < 20) return;
    setT(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => void p.ops(() => session.applyOps([{ kind: "set_timing", wordId: w.id, start: next.start, end: next.end }])),
      500,
    );
    player.playRange(which === "start" ? next.start : Math.max(next.start, next.end - 400), which === "start" ? Math.min(next.end, next.start + 400) : next.end);
  };
  const sec = (ms: number) => (ms / 1000).toFixed(2);

  return (
    <>
      <div className="selinfo">
        <b>«{session.state.doc.textBetween(entry.from, entry.to)}»</b>
        <span>
          {sec(t.start)}–{sec(t.end)} с
        </span>
        <span>{w.timing === "manual" ? "вручную" : statusText(entry)}</span>
      </div>
      <div className="actions" role="toolbar" aria-label="Тайминг слова">
        <button className="btn" aria-label="Начало раньше" onClick={() => nudge("start", -STEP)}>
          ⟨ −50
        </button>
        <button className="btn" aria-label="Начало позже" onClick={() => nudge("start", STEP)}>
          ⟨ +50
        </button>
        <button className="btn primary" onClick={() => player.playRange(t.start, t.end)}>
          ▶ Слово
        </button>
        <button className="btn" aria-label="Конец раньше" onClick={() => nudge("end", -STEP)}>
          −50 ⟩
        </button>
        <button className="btn" aria-label="Конец позже" onClick={() => nudge("end", STEP)}>
          +50 ⟩
        </button>
        {w.timing === "manual" ? (
          <button className="btn" onClick={() => void p.ops(() => session.applyOps([{ kind: "clear_manual", wordId: w.id }]))}>
            Сбросить
          </button>
        ) : null}
        <button className="btn" onClick={() => p.setTimingMode(false)}>
          Готово
        </button>
      </div>
    </>
  );
};
