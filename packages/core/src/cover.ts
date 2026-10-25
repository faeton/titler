import { assColor, assEscape, CAPTION_FONT } from "./ass.js";
import type { Ms } from "./types.js";

// Cover (thumbnail) layout shared by the server's JPEG (ffmpeg + libass) and
// the export screen's preview, like LOOKS for captions.

export type CoverFormat = "vertical" | "youtube";

export interface CoverSpec {
  width: number;
  height: number;
  /** Title: size as a fraction of height, centre line y (0 = top), wrap width in characters, max lines. */
  title: { fontSizeRel: number; y: number; maxChars: number; maxLines: number; outlineRel: number };
  /** «1/3» badge: size and top edge as fractions of height. */
  badge: { fontSizeRel: number; top: number; padRel: number };
}

/**
 * vertical: 1080×1920 for Reels / Shorts / Stories (IG cover ≤ 8 MB). The
 * profile grid shows only the middle ~3:4 (y 12.5 %–87.5 %), so title and
 * badge stay inside it. youtube: 1280×720 for regular YouTube videos.
 */
export const COVER: Record<CoverFormat, CoverSpec> = {
  vertical: {
    width: 1080,
    height: 1920,
    title: { fontSizeRel: 0.056, y: 0.36, maxChars: 14, maxLines: 3, outlineRel: 0.09 },
    badge: { fontSizeRel: 0.036, top: 0.16, padRel: 0.4 },
  },
  youtube: {
    width: 1280,
    height: 720,
    title: { fontSizeRel: 0.11, y: 0.62, maxChars: 20, maxLines: 2, outlineRel: 0.09 },
    badge: { fontSizeRel: 0.07, top: 0.07, padRel: 0.4 },
  },
};

/** IG profile grid crop of a 9:16 cover, as fractions of the cover height. */
export const IG_GRID = { top: 0.125, bottom: 0.875 };

export const COVER_MAX_BYTES = 8 * 1024 * 1024;

/** Greedy word wrap; a word longer than the line gets its own line; overflow joins the last line. */
export const wrapTitle = (text: string, maxChars: number, maxLines: number): string[] => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (cur !== undefined && (cur.length + 1 + w.length <= maxChars || lines.length >= maxLines)) lines[lines.length - 1] = `${cur} ${w}`;
    else lines.push(w);
  }
  return lines;
};

export const coverTitleLines = (title: string | null, format: CoverFormat): string[] => {
  const t = COVER[format].title;
  return title ? wrapTitle(title.toLocaleUpperCase("ru"), t.maxChars, t.maxLines) : [];
};

/** Pixel metrics of a cover layout (the preview scales these by its own height). */
export const coverMetrics = (format: CoverFormat) => {
  const s = COVER[format];
  const title = Math.round(s.height * s.title.fontSizeRel);
  const badge = Math.round(s.height * s.badge.fontSizeRel);
  return {
    titleSize: title,
    titleOutline: Math.max(1, Math.round(title * s.title.outlineRel)),
    titleY: Math.round(s.height * s.title.y),
    badgeSize: badge,
    badgePad: Math.round(badge * s.badge.padRel),
    badgeTop: Math.round(s.height * s.badge.top),
  };
};

/** ASS overlay for one cover frame (events span the first `ms`, the frame is at t = 0). */
export const coverAss = (format: CoverFormat, o: { title: string | null; badge: string | null }, ms: Ms = 10_000): string => {
  const s = COVER[format];
  const m = coverMetrics(format);
  const lines = coverTitleLines(o.title, format);
  const end = `0:00:${String(Math.floor(ms / 1000)).padStart(2, "0")}.00`;
  const events: string[] = [];
  if (lines.length) {
    events.push(`Dialogue: 0,0:00:00.00,${end},Title,,0,0,0,,{\\an5\\pos(${Math.round(s.width / 2)},${m.titleY})}${lines.map(assEscape).join("\\N")}`);
  }
  if (o.badge) {
    events.push(`Dialogue: 1,0:00:00.00,${end},Badge,,0,0,0,,{\\an8\\pos(${Math.round(s.width / 2)},${m.badgeTop})}${assEscape(o.badge)}`);
  }
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${s.width}`,
    `PlayResY: ${s.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Title,${CAPTION_FONT},${m.titleSize},${assColor("#FFFFFF")},${assColor("#FFFFFF")},${assColor("#000000")},${assColor("#00000080")},-1,0,0,0,100,100,0,0,1,${m.titleOutline},0,5,0,0,0,1`,
    `Style: Badge,${CAPTION_FONT},${m.badgeSize},${assColor("#FFFFFF")},${assColor("#FFFFFF")},${assColor("#000000A6")},${assColor("#000000A6")},-1,0,0,0,100,100,0,0,3,${m.badgePad},0,8,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
};

// ---- frame suggestions ------------------------------------------------------------

export interface FrameScore {
  t: Ms;
  /** Edge density of the frame (higher = sharper, less motion blur). */
  sharpness: number;
}

/**
 * Up to `n` cover candidates inside [startMs, endMs): n − 1 evenly spread
 * points, each moved to the sharpest scanned frame within ±slackMs, plus the
 * sharpest frame of the whole range. Sorted by time, ≥ 1 s apart.
 */
export const suggestFrames = (frames: FrameScore[], startMs: Ms, endMs: Ms, n = 5, slackMs = 600): Ms[] => {
  const inRange = frames.filter((f) => f.t >= startMs && f.t < endMs);
  if (!inRange.length) return [Math.round(startMs + (endMs - startMs) / 2)];
  const best = (fs: FrameScore[]) => fs.reduce((a, b) => (b.sharpness > a.sharpness ? b : a));
  const picks: Ms[] = [];
  const spread = Math.max(1, n - 1);
  for (let k = 0; k < spread; k++) {
    const at = startMs + ((k + 0.5) * (endMs - startMs)) / spread;
    const near = inRange.filter((f) => Math.abs(f.t - at) <= slackMs);
    picks.push(near.length ? best(near).t : Math.round(at));
  }
  if (n > 1) picks.push(best(inRange).t);
  // Two picks closer than 1 s: keep the sharper one.
  const sharp = new Map(inRange.map((f) => [f.t, f.sharpness]));
  const out: Ms[] = [];
  for (const t of picks.sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last === undefined || t - last >= 1000) out.push(t);
    else if ((sharp.get(t) ?? -1) > (sharp.get(last) ?? -1)) out[out.length - 1] = t;
  }
  return out;
};
