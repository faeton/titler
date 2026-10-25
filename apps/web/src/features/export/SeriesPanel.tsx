import { SERIES_DESTINATIONS, SERIES_PRESETS, snapCut, type SeriesDestination, type SeriesSettings } from "@titler/core";
import { useRef, useState, type PointerEvent } from "react";
import { cx } from "../../lib/format";
import { usePlayerState } from "../../player/player";
import { useProjectCtx } from "../project/useProject";
import type { SeriesPlanView } from "./series";

const sec = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} с`;
const limit = (d: SeriesDestination, s: SeriesSettings) => {
  const max = d === "custom" ? s.customMaxMs : SERIES_PRESETS[d].maxPartMs;
  return max === null ? "без нарезки" : max >= 120_000 ? `до ${Math.round(max / 60_000)} мин` : `до ${Math.round(max / 1000)} с`;
};

export const SeriesPanel = ({ plan }: { plan: SeriesPlanView }) => {
  const { view, patchSettings } = useProjectCtx();
  const series = view!.project.settings.series;
  const setCuts = (cuts: number[] | null) => {
    const next = { ...series.cuts };
    if (cuts === null) delete next[series.destination];
    else next[series.destination] = cuts;
    patchSettings({ series: { cuts: next } });
  };
  const multi = plan.parts.length > 1;
  const n = series.numbering;

  return (
    <div className="section">
      <h2>Площадка</h2>
      <div className="dests" role="group" aria-label="Площадка">
        {SERIES_DESTINATIONS.map((d) => (
          <button key={d} aria-pressed={series.destination === d} onClick={() => patchSettings({ series: { destination: d } })}>
            <b>{SERIES_PRESETS[d].label}</b>
            <span>{limit(d, series)}</span>
          </button>
        ))}
      </div>
      {series.destination === "custom" ? (
        <label className="field">
          <span>Длина части: до {Math.round(series.customMaxMs / 1000)} с</span>
          <input
            type="range"
            min={10}
            max={600}
            step={1}
            value={Math.round(series.customMaxMs / 1000)}
            onChange={(e) => patchSettings({ series: { customMaxMs: Number(e.target.value) * 1000 } })}
          />
        </label>
      ) : null}

      {plan.maxPartMs === null ? (
        <p className="hint">Видео уходит целиком — эта площадка ограничивает размер файла, а не длину.</p>
      ) : !multi ? (
        <p className="hint">Видео ({sec(plan.durationMs)}) помещается в одну часть.</p>
      ) : (
        <>
          <Timeline plan={plan} onCuts={setCuts} />
          <div className="row">
            <span className="grow hint">
              {plan.parts.length} {plan.parts.length < 5 ? "части" : "частей"} · {plan.manual ? "разрезы двигали вручную" : "разрезы на паузах"}
            </span>
            {plan.manual ? (
              <button className="btn" onClick={() => setCuts(null)}>
                Авто
              </button>
            ) : null}
          </div>
          <label className="switch">
            <input type="checkbox" checked={n.enabled} onChange={(e) => patchSettings({ series: { numbering: { ...n, enabled: e.target.checked } } })} />
            Нумерация частей «1/{plan.parts.length}»
          </label>
          {n.enabled ? (
            <>
              <div className="seg" role="group" aria-label="Формат номера">
                {(["short", "long"] as const).map((f) => (
                  <button key={f} aria-pressed={n.format === f} onClick={() => patchSettings({ series: { numbering: { ...n, format: f } } })}>
                    {f === "short" ? `1/${plan.parts.length}` : `Часть 1 из ${plan.parts.length}`}
                  </button>
                ))}
              </div>
              <div className="seg" role="group" aria-label="Когда показывать номер">
                {([2500, null] as const).map((d) => (
                  <button key={String(d)} aria-pressed={n.durationMs === d} onClick={() => patchSettings({ series: { numbering: { ...n, durationMs: d } } })}>
                    {d === null ? "Всю часть" : "Первые 2,5 с"}
                  </button>
                ))}
              </div>
              <div className="seg" role="group" aria-label="С какого числа частей">
                {[2, 3].map((k) => (
                  <button key={k} aria-pressed={n.minParts === k} onClick={() => patchSettings({ series: { numbering: { ...n, minParts: k } } })}>
                    {k === 2 ? "Всегда" : "Если частей 3+"}
                  </button>
                ))}
              </div>
              {plan.parts.length < n.minParts ? <p className="hint">Частей меньше {n.minParts} — номер не рисуется.</p> : null}
            </>
          ) : null}
          <label className="switch">
            <input type="checkbox" checked={series.overlapMs > 0} onChange={(e) => patchSettings({ series: { overlapMs: e.target.checked ? 500 : 0 } })} />
            Повторять полсекунды в начале следующей части
          </label>
        </>
      )}
    </div>
  );
};

/** Parts as segments over the clip; cuts drag and snap to pauses; tap a part to play it. */
const Timeline = ({ plan, onCuts }: { plan: SeriesPlanView; onCuts: (cuts: number[]) => void }) => {
  const { player } = useProjectCtx();
  const { time } = usePlayerState(player);
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ i: number; t: number } | null>(null);
  const D = plan.durationMs;
  const cuts = drag ? plan.cuts.map((c, i) => (i === drag.i ? drag.t : c)) : plan.cuts;
  const pct = (t: number) => `${(100 * t) / D}%`;
  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(D, Math.max(0, ((e.clientX - r.left) / r.width) * D));
  };
  const bounds = [0, ...cuts, D];

  const down = (i: number) => (e: PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ i, t: plan.cuts[i]! });
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const lo = (plan.cuts[drag.i - 1] ?? 0) + 500;
    const hi = (plan.cuts[drag.i + 1] ?? D) - 500;
    setDrag({ i: drag.i, t: Math.min(hi, Math.max(lo, at(e))) });
  };
  const up = () => {
    if (!drag) return;
    const t = snapCut(drag.t, plan.candidates, plan.words);
    const next = plan.cuts.map((c, i) => (i === drag.i ? t : c));
    setDrag(null);
    if (next.some((c, i) => c !== plan.cuts[i])) onCuts(next);
    player.seek(t);
  };

  return (
    <div className="series">
      <div className="series-tl" ref={ref} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {bounds.slice(0, -1).map((b, k) => {
          const len = bounds[k + 1]! - b;
          const over = plan.maxPartMs !== null && len > plan.maxPartMs;
          return (
            <button
              key={k}
              className={cx("part", k % 2 ? "odd" : "", over && "over")}
              style={{ left: pct(b), width: pct(len) }}
              aria-label={`Часть ${k + 1}: ${sec(len)} — воспроизвести`}
              onClick={() => player.playRange(plan.parts[k]?.startMs ?? b, bounds[k + 1]!)}
            >
              <span>{k + 1}</span>
            </button>
          );
        })}
        {plan.candidates.map((c) => (
          <i key={c.at} className={c.score >= 1 ? "tick strong" : "tick"} style={{ left: pct(c.at) }} />
        ))}
        <i className="playhead" style={{ left: pct(Math.min(time, D)) }} />
        {cuts.map((c, i) => (
          <span
            key={i}
            className={cx("cut", drag?.i === i && "on")}
            style={{ left: pct(c) }}
            role="slider"
            aria-label={`Разрез ${i + 1}`}
            aria-valuemin={0}
            aria-valuemax={D}
            aria-valuenow={c}
            tabIndex={0}
            onPointerDown={down(i)}
          />
        ))}
      </div>
      <div className="series-lens">
        {bounds.slice(0, -1).map((b, k) => {
          const len = bounds[k + 1]! - b + (k && plan.parts[k] ? b - plan.parts[k]!.startMs : 0);
          const over = plan.maxPartMs !== null && len > plan.maxPartMs;
          return (
            <span key={k} className={cx("chip", over ? "err" : "")}>
              {k + 1} · {sec(len)}
              {over ? ` > ${sec(plan.maxPartMs!)}` : ""}
            </span>
          );
        })}
      </div>
      <p className="hint">Перетащите разрез — он прилипнет к ближайшей паузе. Коснитесь части, чтобы её прослушать.</p>
    </div>
  );
};
