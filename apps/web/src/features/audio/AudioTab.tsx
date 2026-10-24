import type { AudioPreset, CompareClip } from "@titler/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, compareClips, isActive, latestJob } from "../../api";
import { fmtTime } from "../../lib/format";
import { Dock } from "../project/Dock";
import { useProjectCtx } from "../project/useProject";
import { AbPlayer } from "./abPlayer";

const PRESETS: { key: AudioPreset; letter: string; label: string }[] = [
  { key: "original", letter: "A", label: "Исходник" },
  { key: "gentle", letter: "B", label: "Мягко" },
  { key: "voice", letter: "C", label: "Голос" },
  { key: "strong", letter: "D", label: "Сильно" },
];

const EXCERPT_LABEL: Record<string, string> = {
  calm: "Спокойная речь",
  noisy: "Шум, ветер",
  voices: "Чужие голоса",
  custom: "Свой отрезок",
};

export const AudioTab = () => {
  const { view, player, patchSettings, run, id } = useProjectCtx();
  const clips = useMemo(() => compareClips(view), [view]);
  const compareJob = latestJob(view, "compare");
  const busy = !!compareJob && isActive(compareJob);
  const audio = view!.project.settings.audio;

  const [clipIdx, setClipIdx] = useState(0);
  const clip: CompareClip | undefined = clips[Math.min(clipIdx, clips.length - 1)];
  const ab = useMemo(() => new AbPlayer(), []);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [active, setActive] = useState<string>("original");
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [pos, setPos] = useState(0);
  const key = clip ? `${clip.excerpt}:${clip.startMs}:${Object.values(clip.variants).join("|")}` : null;

  useEffect(() => () => ab.dispose(), [ab]);

  // Load (decode) every variant of the selected excerpt.
  useEffect(() => {
    if (!clip || !key) return;
    const ac = new AbortController();
    setLoaded(null);
    setLoadErr(null);
    setPlaying(false);
    ab.load(clip.variants, ac.signal)
      .then(() => {
        ab.setActive(active in clip.variants ? active : "original");
        setLoaded(key);
        setPos(0);
      })
      .catch((e) => !ac.signal.aborted && setLoadErr(String(e?.message ?? e)));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Picture follows the comparison: the project video plays muted in sync.
  const video = () => player.video;
  const syncVideo = (sec: number, play: boolean) => {
    const v = video();
    if (!v || !clip) return;
    v.muted = true;
    v.currentTime = (clip.startMs + sec * 1000) / 1000;
    if (play) void v.play().catch(() => {});
    else v.pause();
  };
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let lastPos = ab.position();
    const step = () => {
      const p = ab.position();
      if (p + 0.05 < lastPos) syncVideo(p, true); // looped
      lastPos = p;
      setPos(p);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);
  useEffect(() => {
    ab.onEnded = () => {
      setPlaying(false);
      setPos(0);
      video()?.pause();
    };
  });
  useEffect(
    () => () => {
      player.slaved = false;
      const v = player.video;
      if (v) {
        v.pause();
        v.muted = false;
      }
    },
    [player],
  );

  const toggle = async () => {
    if (ab.playing) {
      ab.pause();
      setPlaying(false);
      video()?.pause();
      player.slaved = false;
      return;
    }
    player.pause();
    player.slaved = true;
    await ab.play();
    syncVideo(ab.position(), true);
    setPlaying(true);
  };
  const choose = (k: string) => {
    ab.setActive(k);
    setActive(k);
  };
  const seekTo = (sec: number) => {
    ab.seek(sec);
    setPos(sec);
    syncVideo(sec, ab.playing);
  };

  const chooseForAll = () => patchSettings({ audio: { preset: active as AudioPreset } });
  const recompute = (patch: Partial<typeof audio>) => {
    patchSettings({ audio: patch });
    // Settings PATCH is debounced; start the comparison after it lands.
    setTimeout(() => void run(() => api.startCompare(id, {})), 500);
  };
  const dur = view!.project.probe?.durationMs ?? player.duration;
  const [ownStart, setOwnStart] = useState(() => player.time);
  const ownExcerpt = () => {
    const start = Math.max(0, Math.min(ownStart, dur - 10_000));
    void run(() => api.startCompare(id, { excerpts: [{ startMs: start, endMs: Math.min(dur, start + 10_000) }] }));
  };

  const chosenLabel = PRESETS.find((p) => p.key === audio.preset)?.label ?? audio.preset;

  return (
    <>
      <div className="scroll">
        <div className="section">
          <h2>Фрагмент для сравнения</h2>
          {clips.length ? (
            <div className="excerpts" role="tablist">
              {clips.map((c, i) => (
                <button
                  key={`${c.excerpt}-${c.startMs}`}
                  className={i === clipIdx ? "btn on" : "btn"}
                  role="tab"
                  aria-selected={i === clipIdx}
                  onClick={() => {
                    ab.stop();
                    setPlaying(false);
                    setClipIdx(i);
                  }}
                >
                  {EXCERPT_LABEL[c.excerpt] ?? c.excerpt} · {fmtTime(c.startMs)}
                </button>
              ))}
            </div>
          ) : busy ? (
            <>
              <p className="hint">Готовлю варианты звука…</p>
              <div className="bar">
                <i style={{ width: `${Math.round((compareJob?.progress ?? 0) * 100)}%` }} />
              </div>
            </>
          ) : (
            <button className="btn primary" disabled={!view!.urls.proxy} onClick={() => void run(() => api.startCompare(id, {}))}>
              Подготовить сравнение
            </button>
          )}
          {busy && clips.length ? <p className="hint">Пересчитываю варианты…</p> : null}
          {compareJob?.status === "error" ? <div className="banner err">Сравнение не получилось: {compareJob.error}</div> : null}
          {loadErr ? <div className="banner err">Не загрузился звук: {loadErr}</div> : null}
          <label className="field">
            <span>Свой отрезок: 10 с начиная с {fmtTime(ownStart)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, dur - 10_000)}
              step={500}
              value={Math.min(ownStart, Math.max(0, dur - 10_000))}
              onChange={(e) => {
                const t = Number(e.target.value);
                setOwnStart(t);
                if (!ab.playing) player.seek(t);
              }}
            />
          </label>
          <button className="btn" onClick={ownExcerpt} disabled={busy || !dur}>
            Сравнить этот отрезок
          </button>
          <p className="hint">Все варианты выровнены по громкости: более громкий не выигрывает только за счёт громкости.</p>
        </div>
        <div className="section">
          <h2>Обработка</h2>
          <div className="seg" role="group" aria-label="Движок">
            <button aria-pressed={audio.engine === "dfn3"} onClick={() => audio.engine !== "dfn3" && recompute({ engine: "dfn3" })}>
              Быстро · DFN
            </button>
            <button aria-pressed={audio.engine === "mf2"} onClick={() => audio.engine !== "mf2" && recompute({ engine: "mf2" })}>
              Качественно · MF2
            </button>
          </div>
          <label className="switch">
            <input type="checkbox" checked={audio.dehum} onChange={(e) => recompute({ dehum: e.target.checked })} />
            Убрать гул (50/100/150 Гц)
          </label>
          <p className="hint">
            Для всего ролика сейчас: <b style={{ color: "var(--text)" }}>{chosenLabel}</b>
          </p>
        </div>
      </div>
      <Dock>
        {clip ? (
          <>
            <div className="variants" role="group" aria-label="Варианты звука">
              {PRESETS.filter((p) => p.key in clip.variants).map((p) => (
                <button
                  key={p.key}
                  aria-pressed={active === p.key}
                  className={audio.preset === p.key ? "chosen" : undefined}
                  onClick={() => choose(p.key)}
                >
                  <b>{p.letter}</b>
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
            <div className="pbar">
              <button className="btn icon primary" disabled={loaded !== key} aria-label={playing ? "Пауза" : "Слушать"} onClick={() => void toggle()}>
                {playing ? "❚❚" : "▶"}
              </button>
              <span className="time">
                {loaded === key ? `${fmtTime(pos * 1000, true)} / ${fmtTime(ab.duration * 1000)}` : "загрузка…"}
              </span>
              <input
                className="scrub"
                type="range"
                min={0}
                max={Math.max(0.1, ab.duration)}
                step={0.05}
                value={pos}
                aria-label="Позиция во фрагменте"
                onChange={(e) => seekTo(Number(e.target.value))}
              />
              <button
                className={loop ? "btn icon on" : "btn icon"}
                aria-label="Зациклить"
                aria-pressed={loop}
                onClick={() => {
                  ab.setLoop(!loop);
                  setLoop(!loop);
                }}
              >
                ⟲
              </button>
            </div>
            <div className="actions">
              <button className="btn" disabled={active === "original"} onClick={() => choose("original")}>
                ↩ К исходнику
              </button>
              <button className="btn primary grow" disabled={audio.preset === active} onClick={chooseForAll}>
                {audio.preset === active ? "✓ Выбран для ролика" : "Выбрать для всего ролика"}
              </button>
            </div>
          </>
        ) : null}
      </Dock>
    </>
  );
};
