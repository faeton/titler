import type { Framing, ProjectView, SubtitleStyle, TranscriptDoc } from "@titler/core";
import type { CSSProperties, PointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { centre, cropRect, fitBox, outAspect, srcAspect } from "../lib/framing";
import { BlurBackdrop } from "./BlurBackdrop";
import { CaptionOverlay, useCues } from "./CaptionOverlay";
import type { Player } from "./player";
import { usePlayerState } from "./player";

export type StageMode = "preview" | "crop";

interface Props {
  view: ProjectView;
  player: Player;
  doc: TranscriptDoc | null;
  framing: Framing;
  style: SubtitleStyle;
  mode?: StageMode;
  showCaptions?: boolean;
  showSafe?: boolean;
  onCrop?: (cx: number, cy: number) => void;
}

const useSize = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
};

export const Stage = ({ view, player, doc, framing, style, mode = "preview", showCaptions = true, showSafe = false, onCrop }: Props) => {
  const [wrap, size] = useSize();
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [meta, setMeta] = useState<{ w: number; h: number } | null>(null);
  const { time } = usePlayerState(player);
  const p = view.project.probe;
  const src = srcAspect(p ? p : meta ? { width: meta.w, height: meta.h } : null);
  const durationMs = view.project.probe?.durationMs ?? player.duration;
  const cues = useCues(doc, style, durationMs);

  const videoRef = useCallback(
    (v: HTMLVideoElement | null) => {
      setVideo(v);
      player.attach(v);
    },
    [player],
  );
  useEffect(() => () => player.attach(null), [player]);

  // Drag state for the crop window (normalised centre).
  const [overflow, setOverflow] = useState(false);
  const [drag, setDrag] = useState<{ cx: number; cy: number } | null>(null);
  const c = drag ?? centre(framing);

  const pad = 8;
  const W = Math.max(0, size.w - pad * 2);
  const H = Math.max(0, size.h - pad * 2);
  const out = outAspect(framing.ratio, view.project.probe);
  const crop = mode === "crop";
  const box = crop ? fitBox(src, W, H) : fitBox(out, W, H);
  const r = cropRect(src, out, c.cx, c.cy);

  let vs: CSSProperties;
  if (crop) vs = { left: 0, top: 0, width: box.w, height: box.h };
  else if (framing.fit === "fill") {
    const vw = box.w / r.w;
    const vh = box.h / r.h;
    vs = { width: vw, height: vh, left: -r.x * vw, top: -r.y * vh };
  } else {
    const inner = fitBox(src, box.w, box.h);
    vs = { width: inner.w, height: inner.h, left: (box.w - inner.w) / 2, top: (box.h - inner.h) / 2 };
  }

  const start = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const onDown = (e: PointerEvent) => {
    if (!crop || framing.fit !== "fill") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const onWin = (e.target as HTMLElement).classList.contains("cropwin");
    let { cx, cy } = c;
    if (!onWin) {
      // Tap outside the window: centre it there.
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      cx = (e.clientX - rect.left) / rect.width;
      cy = (e.clientY - rect.top) / rect.height;
      const rr = cropRect(src, out, cx, cy);
      cx = rr.x + rr.w / 2;
      cy = rr.y + rr.h / 2;
      setDrag({ cx, cy });
    }
    start.current = { x: e.clientX, y: e.clientY, cx, cy };
  };
  const onMove = (e: PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const rr = cropRect(src, out, s.cx + (e.clientX - s.x) / box.w, s.cy + (e.clientY - s.y) / box.h);
    setDrag({ cx: rr.x + rr.w / 2, cy: rr.y + rr.h / 2 });
  };
  const onUp = () => {
    if (!start.current) return;
    start.current = null;
    if (drag) onCrop?.(Number(drag.cx.toFixed(4)), Number(drag.cy.toFixed(4)));
    setDrag(null);
  };

  return (
    <div className="stage" ref={wrap}>
      <div
        className={crop ? "frame cropview" : framing.fit === "fit_solid" ? "frame solid" : "frame"}
        style={{ width: box.w, height: box.h }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {!crop && framing.fit === "fit_blur" ? <BlurBackdrop video={video} /> : null}
        {view.urls.proxy ? (
          <video
            key="v"
            ref={videoRef}
            src={view.urls.proxy}
            playsInline
            preload="auto"
            style={vs}
            onClick={() => {
              if (!crop) player.toggle();
            }}
            onLoadedMetadata={(e) => setMeta({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
          />
        ) : null}
        {crop && framing.fit === "fill" ? (
          <div className="cropwin" style={{ left: r.x * box.w, top: r.y * box.h, width: r.w * box.w, height: r.h * box.h }} />
        ) : null}
        {!crop && showSafe && framing.ratio === "9:16" ? (
          <>
            <div className="safe" style={{ left: 0, right: 0, top: 0, height: "12%" }} />
            <div className="safe" style={{ left: 0, right: 0, bottom: 0, height: "20%" }} />
            <div className="safe" style={{ right: 0, width: "15%", top: "45%", height: "35%" }} />
          </>
        ) : null}
        {!crop && showCaptions ? <CaptionOverlay cues={cues} style={style} time={time} height={box.h} onOverflow={(o) => o !== overflow && setOverflow(o)} /> : null}
      </div>
      {!crop && showCaptions && overflow ? (
        <span className="stage-tag warn">Строка субтитров шире кадра — уменьшите длину строки</span>
      ) : null}
      {!view.urls.proxy ? <span className="stage-tag">Видео готовится…</span> : null}
      {crop ? <span className="stage-tag">Весь кадр · рамка = что попадёт в {framing.ratio === "source" ? "исходный формат" : framing.ratio}</span> : null}
    </div>
  );
};
