import { effectiveTimes, type TranscriptRevision, type Word } from "@titler/core";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { api, isActive, latestJob } from "../../api";
import { TranscriptSession, type SaveStatus } from "../../editor/session";
import { rangeIds, type IndexEntry } from "../../editor/uiPlugin";
import { isTypingTarget } from "../../lib/hooks";
import { Dock } from "../project/Dock";
import { useProjectCtx } from "../project/useProject";
import { Legend } from "./Legend";
import { WordActions } from "./WordActions";

export interface TimedEntry extends IndexEntry {
  start: number;
  end: number;
  word: Word | undefined;
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: "Сохранено",
  dirty: "Изменено…",
  saving: "Сохраняю…",
  error: "Не сохранилось, повторю",
  conflict: "Конфликт версий",
};

const LONG_PRESS_MS = 450;

export const TextTab = () => {
  const ctx = useProjectCtx();
  const { view, player, id } = ctx;
  const host = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<TranscriptSession | null>(null);
  const [, setVer] = useState(0);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [conflict, setConflict] = useState<TranscriptRevision | null>(null);
  const [follow, setFollow] = useState(true);
  const [rangeMode, setRangeMode] = useState(false);
  const [legend, setLegend] = useState(false);
  const [timingMode, setTimingMode] = useState(false);
  const transcript = view?.transcript ?? null;
  const durationMs = view?.project.probe?.durationMs ?? player.duration;

  // Create the editor once a transcript exists; on leave, save then destroy.
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const noteRevision = ctx.noteRevision;
  const refresh = ctx.refresh;
  const hasTranscript = transcript !== null;
  useEffect(() => {
    if (!host.current || !transcriptRef.current) return;
    const s = new TranscriptSession(host.current, transcriptRef.current, {
      api,
      projectId: id,
      onStatus: (st) => setStatus(st),
      onConflict: (r) => setConflict(r),
      onRevision: (r) => noteRevision(r),
      onChange: () => setVer((v) => v + 1),
      onSaved: () => void refresh(),
    });
    setSession(s);
    return () => {
      setSession(null);
      void s.flush().finally(() => s.destroy());
    };
  }, [hasTranscript, id, noteRevision, refresh]);

  // Polled revisions (aligner, other tabs).
  useEffect(() => {
    if (session && transcript) session.remoteRevision(transcript);
  }, [session, transcript]);

  // Save when the app goes to background; warn on unload with unsaved text.
  useEffect(() => {
    if (!session) return;
    const vis = () => document.hidden && void session.flush();
    const unload = (e: BeforeUnloadEvent) => {
      if (session.isDirty()) {
        void session.flush();
        e.preventDefault();
      }
    };
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("beforeunload", unload);
    };
  }, [session]);

  const ui = session?.ui;
  const editing = !!ui?.editing;

  // Word timeline in editor order (typed words get provisional slots).
  const timeline: TimedEntry[] = useMemo(() => {
    if (!ui) return [];
    const words = ui.index.map((e) => ui.words.get(e.id));
    const times = effectiveTimes(
      words.map((w, i) => w ?? ({ id: ui.index[i]!.id, text: "x", start: null, end: null } as unknown as Word)),
      durationMs || 1,
    );
    return ui.index.map((e, i) => ({ ...e, start: times[i]!.start, end: times[i]!.end, word: words[i] }));
  }, [ui?.index, ui?.words, durationMs]);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const byId = useMemo(() => new Map(timeline.map((e, i) => [e.id, i])), [timeline]);

  const scrollToEntry = useCallback(
    (e: TimedEntry, smooth = true) => {
      const sc = scroller.current;
      if (!session || !sc) return;
      try {
        const c = session.view.coordsAtPos(e.from);
        const box = sc.getBoundingClientRect();
        const rel = c.top - box.top;
        if (rel < box.height * 0.15 || rel > box.height * 0.6)
          sc.scrollTo({ top: sc.scrollTop + rel - box.height * 0.3, behavior: smooth ? "smooth" : "auto" });
      } catch {
        /* not laid out */
      }
    },
    [session],
  );

  // Current-word highlight + follow-scroll, outside React renders.
  const followRef = useRef(follow);
  followRef.current = follow;
  useEffect(() => {
    if (!session) return;
    let cur: string | null = null;
    const update = () => {
      const t = player.time;
      const tl = timelineRef.current;
      let lo = 0;
      let hi = tl.length - 1;
      let found: TimedEntry | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const e = tl[mid]!;
        if (t < e.start) hi = mid - 1;
        else if (t >= e.end) lo = mid + 1;
        else {
          found = e;
          break;
        }
      }
      const next = found?.id ?? null;
      if (next === cur) return;
      cur = next;
      session.setUi({ current: next });
      if (found && player.playing && followRef.current && !session.ui.editing) scrollToEntry(found);
    };
    return player.subscribe(update);
  }, [session, player, scrollToEntry]);

  // Stop following when the user scrolls by hand during playback.
  const userScrolled = () => {
    if (player.playing && follow) setFollow(false);
  };

  // ---- selection helpers ---------------------------------------------------

  const selectedIds = ui ? rangeIds(ui.index, ui.range) : [];
  const first = selectedIds.length ? timeline[byId.get(selectedIds[0]!)!] : undefined;
  const last = selectedIds.length ? timeline[byId.get(selectedIds[selectedIds.length - 1]!)!] : undefined;

  const selectWord = useCallback(
    (wid: string, extend = false) => {
      if (!session) return;
      const r = session.ui.range;
      session.select(extend && r ? { anchor: r.anchor, head: wid } : { anchor: wid, head: wid });
      const e = timelineRef.current.find((x) => x.id === wid);
      if (e && !extend) {
        if (player.range) player.stopRange();
        player.seek(e.start);
      }
    },
    [session, player],
  );

  const clearSelection = () => {
    session?.select(null);
    setRangeMode(false);
    setTimingMode(false);
  };

  // ---- pointer handling in browse mode -------------------------------------------

  const press = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout>; long: boolean } | null>(null);
  const wordAt = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.("[data-w]")?.getAttribute("data-w") ?? null;

  const onPointerDown = (e: PointerEvent) => {
    if (editing || !session) return;
    const wid = wordAt(e.target);
    if (!wid) return;
    const p = {
      id: wid,
      x: e.clientX,
      y: e.clientY,
      long: false,
      timer: setTimeout(() => {
        p.long = true;
        setRangeMode(true);
        setTimingMode(false);
        selectWord(wid);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS),
    };
    press.current = p;
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = press.current;
    if (p && !p.long && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) {
      clearTimeout(p.timer);
      press.current = null;
    }
  };
  const onPointerUp = () => {
    const p = press.current;
    if (p) clearTimeout(p.timer);
  };
  const onClick = (e: MouseEvent) => {
    if (!session || editing) return;
    const p = press.current;
    press.current = null;
    if (p?.long) return;
    const wid = wordAt(e.target);
    if (!wid) {
      if (!rangeMode) clearSelection();
      return;
    }
    const r = session.ui.range;
    if (e.shiftKey || rangeMode) {
      if (!r) selectWord(wid);
      else selectWord(wid, true);
      return;
    }
    if (r && r.anchor === wid && r.head === wid) {
      // Second tap on the same word: edit here (inside the gesture, so the keyboard opens).
      const pos = session.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
      setTimingMode(false);
      session.enterEdit(pos);
      return;
    }
    setTimingMode(false);
    selectWord(wid);
  };

  // ---- desktop keys in browse mode -------------------------------------------------

  useEffect(() => {
    if (!session) return;
    const on = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || session.ui.editing || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      const tl = timelineRef.current;
      const r = session.ui.range;
      const headIdx = r ? tl.findIndex((x) => x.id === r.head) : -1;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const ni = Math.max(0, Math.min(tl.length - 1, headIdx + (e.key === "ArrowRight" ? 1 : headIdx < 0 ? tl.length : -1)));
        const target = tl[ni];
        if (target) {
          selectWord(target.id, e.shiftKey);
          scrollToEntry(target, false);
        }
      } else if (e.key === "Enter" && r) {
        e.preventDefault();
        const ent = tl.find((x) => x.id === r.head);
        session.enterEdit(ent?.to);
      } else if (e.key === "Escape") clearSelection();
      else if ((e.key === "c" || e.key === "с") && r) playContext();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  // ---- actions -------------------------------------------------------------

  const playContext = () => {
    if (!first || !last) return;
    if (player.range?.loop) {
      player.stopRange();
      return;
    }
    const i0 = byId.get(first.id)!;
    const i1 = byId.get(last.id)!;
    const a = timeline[Math.max(0, i0 - 1)]!;
    const b = timeline[Math.min(timeline.length - 1, i1 + 1)]!;
    player.playRange(Math.max(0, a.start - 80), b.end + 80, true);
  };

  const [opError, setOpError] = useState<string | null>(null);
  const ops = async (fn: () => Promise<void>) => {
    try {
      setOpError(null);
      await fn();
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  };

  const nextReview = () => {
    const tl = timelineRef.current;
    const from = last ? byId.get(last.id)! + 1 : 0;
    const order = [...tl.slice(from), ...tl.slice(0, from)];
    const hit = order.find((e) => e.word?.review === "needs_review");
    if (hit) {
      selectWord(hit.id);
      scrollToEntry(hit);
    }
  };
  const reviewCount = timeline.filter((e) => e.word?.review === "needs_review").length;

  // Keep the caret visible when the keyboard opens / the viewport shrinks.
  useEffect(() => {
    if (!session) return;
    const vv = window.visualViewport;
    const keep = () => {
      if (session.ui.editing) setTimeout(() => session.dispatch(session.state.tr.scrollIntoView()), 60);
    };
    vv?.addEventListener("resize", keep);
    return () => vv?.removeEventListener("resize", keep);
  }, [session]);

  // ---- render ------------------------------------------------------------------------

  const asr = latestJob(view, "asr");
  if (!transcript) {
    return (
      <div className="section">
        {asr && isActive(asr) ? (
          <>
            <h2>Распознавание</h2>
            <div className="bar">
              <i style={{ width: `${Math.round((asr.progress ?? 0) * 100)}%` }} />
            </div>
            <p className="hint">Текст появится здесь автоматически. Пока можно выбрать звук на вкладке «Звук».</p>
          </>
        ) : (
          <>
            <p className="hint">
              {asr?.status === "error" ? `Распознавание не удалось: ${asr.error ?? ""}` : "Текста пока нет."}
            </p>
            <button className="btn primary big" onClick={() => void ctx.run(() => api.startAsr(id, { seed: true }))}>
              Распознать речь
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="row" style={{ padding: "6px 12px", borderBottom: "1px solid var(--line)", gap: 6 }}>
        <span className="save-state grow" aria-live="polite">
          {SAVE_LABEL[status]}
          {session ? ` · правка ${session.baseRev}` : ""}
        </span>
        {reviewCount ? (
          <button className="btn" onClick={nextReview} title="Перейти к следующему спорному месту">
            Спорное · {reviewCount} ›
          </button>
        ) : null}
        <button className={legend ? "btn icon on" : "btn icon"} aria-label="Обозначения" onClick={() => setLegend(!legend)}>
          ?
        </button>
      </div>
      {legend ? <Legend /> : null}
      {conflict ? (
        <div className="banner">
          <span>Текст изменился в другом месте, пока вы правили.</span>
          <div className="row">
            <button className="btn" onClick={() => session?.resolveConflict("theirs")}>
              Взять ту версию
            </button>
            <button className="btn primary" onClick={() => session?.resolveConflict("mine")}>
              Оставить мою
            </button>
          </div>
        </div>
      ) : null}
      {opError ? <div className="banner err">{opError}</div> : null}
      <div
        className="editor-wrap"
        ref={scroller}
        onWheel={userScrolled}
        onTouchMove={userScrolled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        onContextMenu={(e) => !editing && e.preventDefault()}
      >
        <div ref={host} />
        {!follow ? (
          <button
            className="btn primary follow"
            onClick={() => {
              setFollow(true);
              const cur = timeline.find((e) => e.id === session?.ui.current);
              if (cur) scrollToEntry(cur);
            }}
          >
            Следовать за воспроизведением
          </button>
        ) : null}
      </div>
      <Dock>
        {session ? (
          <WordActions
            session={session}
            timeline={timeline}
            selectedIds={selectedIds}
            first={first}
            last={last}
            editing={editing}
            rangeMode={rangeMode}
            timingMode={timingMode}
            setTimingMode={setTimingMode}
            onClear={clearSelection}
            onContext={playContext}
            contextOn={!!player.range?.loop}
            ops={ops}
          />
        ) : null}
      </Dock>
    </>
  );
};
