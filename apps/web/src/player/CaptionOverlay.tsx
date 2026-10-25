import { BADGE, compileCues, LOOKS, type Cue, type SubtitleStyle, type TranscriptDoc } from "@titler/core";
import { useLayoutEffect, useMemo, useRef } from "react";

// Browser rendering of the same cue plan the ASS writer burns in (core/cues.ts
// + core/ass.ts LOOKS), with the same Montserrat files from /api/fonts.

const findCue = (cues: Cue[], t: number): Cue | null => {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return c;
  }
  return null;
};

const cssColor = (hex: string) => {
  const h = hex.replace("#", "");
  if (h.length !== 8) return `#${h}`;
  return `rgb(${parseInt(h.slice(0, 2), 16)} ${parseInt(h.slice(2, 4), 16)} ${parseInt(h.slice(4, 6), 16)} / ${(parseInt(h.slice(6, 8), 16) / 255).toFixed(2)})`;
};

export const useCues = (doc: TranscriptDoc | null, style: SubtitleStyle, durationMs: number) =>
  useMemo(
    () => (doc ? compileCues(doc, style, durationMs) : []),
    [doc, style.maxChars, style.maxLines, style.maxGapMs, durationMs],
  );

export const CaptionOverlay = ({
  cues,
  style,
  time,
  height,
  onOverflow,
}: {
  cues: Cue[];
  style: SubtitleStyle;
  time: number;
  /** Output frame height in CSS px. */
  height: number;
  /** Reports whether the current cue is wider than the caption area (it would be cut in export too). */
  onOverflow?: (over: boolean) => void;
}) => {
  const cue = findCue(cues, time);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !onOverflow) return;
    const max = el.clientWidth;
    onOverflow([...el.querySelectorAll<HTMLElement>(".line > span")].some((l) => l.offsetWidth > max + 1));
  });
  if (!cue || height <= 0) return null;
  const look = LOOKS[style.look];
  const size = height * look.fontSizeRel;
  const outline = look.box ? 0 : Math.max(1, size * look.outline);
  const flat = cue.lines.flat();
  const highlight = style.wordHighlight && look.active !== look.primary;
  let k = 0;
  if (highlight) for (let i = 0; i < flat.length; i++) if (flat[i]!.start <= time) k = i;
  const tx = (s: string) => (look.uppercase ? s.toLocaleUpperCase("ru") : s);
  let n = 0;
  return (
    <div
      ref={ref}
      className={look.box ? "caps box" : "caps"}
      style={{ top: `${style.y * 100}%`, fontSize: size, fontWeight: look.bold ? 700 : 400 }}
      aria-hidden
    >
      {cue.lines.map((line, li) => (
        <span className="line" key={li}>
          <span className={look.box ? "pill" : undefined} style={look.box ? { padding: `0 ${size * 0.35}px` } : undefined}>
            {line.map((w, wi) => {
              const idx = n++;
              const colour = !highlight
                ? look.primary
                : idx === k
                  ? look.active
                  : idx > k && look.upcoming
                    ? look.upcoming
                    : look.primary;
              return (
                <span key={w.wordId}>
                  {wi ? " " : ""}
                  <span
                    className="cw"
                    style={{
                      color: cssColor(colour),
                      WebkitTextStrokeWidth: outline ? outline * 2 : 0,
                      transform: highlight && idx === k && style.look === "focus" ? "scale(1.1)" : undefined,
                    }}
                  >
                    {tx(w.text)}
                  </span>
                </span>
              );
            })}
          </span>
        </span>
      ))}
    </div>
  );
};

/** Series numbering («1/3») with the ASS writer's geometry (core BADGE / badgeMetrics). */
export const BadgeOverlay = ({ badges, time, height }: { badges: { startMs: number; endMs: number; text: string }[]; time: number; height: number }) => {
  const b = badges.find((x) => time >= x.startMs && time < x.endMs);
  if (!b || height <= 0) return null;
  const size = height * BADGE.fontSizeRel;
  const pad = size * BADGE.padRel;
  return (
    <div className="badge" style={{ top: height * BADGE.top - pad, fontSize: size, padding: pad, background: cssColor(BADGE.box), color: BADGE.text }} aria-hidden>
      {b.text}
    </div>
  );
};
