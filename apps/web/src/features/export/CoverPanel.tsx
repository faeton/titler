import { badgeText, COVER, coverTitleLines, IG_GRID, type CoverFormat, type Framing } from "@titler/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, coverOutputs, isActive, type CoverOutput } from "../../api";
import { fmtBytes, fmtTime } from "../../lib/format";
import { centre, cropRect, fitBox } from "../../lib/framing";
import { usePlayerState, type Player } from "../../player/player";
import { useProjectCtx } from "../project/useProject";
import type { SeriesPlanView } from "./series";

// Cover = one frame of the source with the video's framing, an optional title
// and the «1/3» badge. The preview draws the proxy frame under the same layout
// numbers (core COVER) the server burns into the JPEG.

const FORMATS: [CoverFormat, string][] = [
  ["vertical", "9:16 · Reels, Shorts"],
  ["youtube", "16:9 · YouTube"],
];

export const CoverPanel = ({ plan }: { plan: SeriesPlanView | null }) => {
  const { view, id, run, player, patchSettings } = useProjectCtx();
  const { time } = usePlayerState(player);
  const [format, setFormat] = useState<CoverFormat>("vertical");
  const [partIdx, setPartIdx] = useState(0);
  const [suggestions, setSuggestions] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const probe = view!.project.probe;
  const { cover, framing, series } = view!.project.settings;
  const parts = plan && plan.parts.length > 1 ? plan.parts : null;
  const k = parts ? Math.min(partIdx, parts.length - 1) : 0;
  const range = parts ? parts[k]! : { startMs: 0, endMs: probe?.durationMs ?? 0 };
  const badge = parts && cover.badge ? badgeText(k, parts.length, series.numbering.format) : null;
  const frameMs = 1000 / (probe?.fps || 30);
  const at = Math.min(Math.max(time, range.startMs), Math.max(range.startMs, range.endMs - 1));
  const job = view!.jobs.find((j) => j.kind === "cover" && isActive(j));
  const covers = useMemo(() => coverOutputs(view), [view]);

  useEffect(() => {
    if (!view?.urls.proxy || !(range.endMs > range.startMs)) return;
    let live = true;
    api.coverSuggestions(id, range.startMs, range.endMs).then(
      (s) => live && setSuggestions(s.suggestions),
      () => live && setSuggestions([]),
    );
    return () => {
      live = false;
    };
  }, [id, view?.urls.proxy, range.startMs, range.endMs]);

  const pickPart = (i: number) => {
    setPartIdx(i);
    if (parts) player.seek(parts[i]!.startMs);
  };

  const make = async () => {
    setErr(null);
    player.pause();
    try {
      await run(() =>
        api.startCover(id, { atMs: Math.round(at), format, title: cover.title, badge: cover.badge, ...(parts ? { part: { index: k, total: parts.length } } : {}) }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="section">
      <h2>Обложка</h2>
      <div className="seg" role="group" aria-label="Формат обложки">
        {FORMATS.map(([f, l]) => (
          <button key={f} aria-pressed={format === f} onClick={() => setFormat(f)}>
            {l}
          </button>
        ))}
      </div>
      {parts ? (
        <div className="row" role="group" aria-label="Часть">
          {parts.map((_, i) => (
            <button key={i} className={i === k ? "btn on" : "btn"} aria-pressed={i === k} onClick={() => pickPart(i)}>
              Часть {i + 1}
            </button>
          ))}
        </div>
      ) : null}
      <div className="cover-edit">
        <CoverPreview player={player} framing={framing} format={format} title={cover.title} badge={badge} />
        <div className="cover-side">
          <div className="row">
            <button className="btn" aria-label="Кадр назад" onClick={() => player.seek(Math.max(range.startMs, at - frameMs))}>
              ‹ кадр
            </button>
            <button className="btn" aria-label="Кадр вперёд" onClick={() => player.seek(Math.min(range.endMs - 1, at + frameMs))}>
              кадр ›
            </button>
          </div>
          <span className="hint">Кадр {fmtTime(at, true)}</span>
          <label className="field">
            <span>Заголовок (необязательно)</span>
            <input className="text" type="text" maxLength={120} value={cover.title ?? ""} placeholder="Без заголовка" onChange={(e) => patchSettings({ cover: { title: e.target.value || null } })} />
          </label>
          {parts ? (
            <label className="switch">
              <input type="checkbox" checked={cover.badge} onChange={(e) => patchSettings({ cover: { badge: e.target.checked } })} />
              Номер части на обложке
            </label>
          ) : null}
        </div>
      </div>
      {suggestions.length ? (
        <div className="frames" role="group" aria-label="Предложенные кадры">
          {suggestions.map((t) => (
            <button key={t} aria-pressed={Math.abs(t - at) < frameMs} onClick={() => (player.pause(), player.seek(t))} aria-label={`Кадр ${fmtTime(t, true)}`}>
              <img src={api.frameUrl(id, t)} alt="" loading="lazy" />
              <span>{fmtTime(t, true)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {job ? (
        <div className="row">
          <span className="grow hint">Готовлю обложку…</span>
          <span className="spin" aria-hidden />
        </div>
      ) : (
        <button className="btn primary" disabled={!view?.urls.proxy} onClick={() => void make()}>
          Сделать обложку{parts ? ` части ${k + 1}` : ""}
        </button>
      )}
      {err ? <div className="banner err">{err}</div> : null}
      <p className="hint">
        {format === "vertical"
          ? "Пунктир — что видно в сетке профиля Instagram (~3:4), точки — полоса 16:9. Кадр берётся из исходника в полном качестве."
          : "1280×720 для обычных видео YouTube. Кадр берётся из исходника в полном качестве."}
      </p>
      {covers.length ? (
        <div className="covers">
          {covers.slice(0, 12).map((c) => (
            <CoverRow key={c.url} c={c} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const CoverRow = ({ c }: { c: CoverOutput }) => (
  <a className={c.format === "youtube" ? "cover-out wide" : "cover-out"} href={c.url} download={c.fileName}>
    <img src={c.url} alt="" loading="lazy" />
    <span>
      {c.part ? `${c.part.index + 1}/${c.part.total} · ` : ""}
      {fmtTime(c.atMs, true)}
      {c.bytes ? ` · ${fmtBytes(c.bytes)}` : ""}
    </span>
  </a>
);

/** The current proxy frame, framed like the cover, with title / badge / guides on top. */
const CoverPreview = ({ player, framing, format, title, badge }: { player: Player; framing: Framing; format: CoverFormat; title: string | null; badge: string | null }) => {
  const spec = COVER[format];
  const W = format === "vertical" ? 150 : 300;
  const H = Math.round((W * spec.height) / spec.width);
  const ref = useRef<HTMLCanvasElement>(null);
  const { time } = usePlayerState(player);

  useLayoutEffect(() => {
    const canvas = ref.current;
    const v = player.video;
    if (!canvas || !v) return;
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx || !v.videoWidth) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const cw = canvas.width;
      const ch = canvas.height;
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cw, ch);
      if (framing.fit === "fill") {
        const { cx, cy } = centre(framing);
        const r = cropRect(vw / vh, cw / ch, cx, cy);
        ctx.drawImage(v, r.x * vw, r.y * vh, r.w * vw, r.h * vh, 0, 0, cw, ch);
        return;
      }
      if (framing.fit === "fit_blur") {
        const r = cropRect(vw / vh, cw / ch);
        ctx.filter = "blur(8px)";
        ctx.drawImage(v, r.x * vw, r.y * vh, r.w * vw, r.h * vh, 0, 0, cw, ch);
        ctx.filter = "none";
      }
      const b = fitBox(vw / vh, cw, ch);
      ctx.drawImage(v, 0, 0, vw, vh, (cw - b.w) / 2, (ch - b.h) / 2, b.w, b.h);
    };
    draw();
    v.addEventListener("seeked", draw);
    v.addEventListener("loadeddata", draw);
    return () => {
      v.removeEventListener("seeked", draw);
      v.removeEventListener("loadeddata", draw);
    };
  }, [player, player.video, framing, W, H, time]);

  const k = H / spec.height;
  const lines = coverTitleLines(title, format);
  const ts = spec.height * spec.title.fontSizeRel * k;
  const bs = spec.height * spec.badge.fontSizeRel * k;
  const bp = bs * spec.badge.padRel;
  return (
    <div className="cover-prev" style={{ width: W, height: H }}>
      <canvas ref={ref} style={{ width: W, height: H }} />
      {lines.length ? (
        <div className="cover-title" style={{ top: spec.title.y * H, fontSize: ts, WebkitTextStrokeWidth: Math.max(1, ts * spec.title.outlineRel) * 2 }}>
          {lines.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      ) : null}
      {badge ? (
        <div className="badge" style={{ top: spec.badge.top * H - bp, fontSize: bs, padding: bp, background: "rgb(0 0 0 / 65%)", color: "#fff" }}>
          {badge}
        </div>
      ) : null}
      {format === "vertical" ? (
        <>
          <i className="guide grid" style={{ top: IG_GRID.top * H, bottom: (1 - IG_GRID.bottom) * H }} />
          <i className="guide wide" style={{ top: (H - (W * 9) / 16) / 2, height: (W * 9) / 16 }} />
        </>
      ) : null}
    </div>
  );
};
