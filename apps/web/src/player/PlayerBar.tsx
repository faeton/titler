import { fmtTime } from "../lib/format";
import type { Player } from "./player";
import { usePlayerState } from "./player";

export const PlayerBar = ({ player }: { player: Player }) => {
  const s = usePlayerState(player);
  return (
    <div className="pbar">
      <button className="btn icon" aria-label="Назад на 2 секунды" onClick={() => player.skip(-2000)}>
        ↺
      </button>
      <button
        className={s.buffering ? "btn icon primary busy" : "btn icon primary"}
        aria-label={s.buffering ? "Загрузка" : s.playing ? "Пауза" : "Воспроизвести"}
        onClick={() => player.toggle()}
      >
        {s.buffering ? <span className="spinner" aria-hidden /> : s.playing ? "❚❚" : "▶"}
      </button>
      <span className="time">
        {fmtTime(s.time, true)} / {fmtTime(s.duration)}
      </span>
      <input
        className="scrub"
        type="range"
        min={0}
        max={Math.max(1, s.duration)}
        step={100}
        value={Math.min(s.time, s.duration)}
        aria-label="Позиция"
        onChange={(e) => player.seek(Number(e.target.value))}
      />
      {s.error ? (
        <span className="pbar-err" role="status">
          {s.error}
        </span>
      ) : null}
    </div>
  );
};
