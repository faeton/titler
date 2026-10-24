import type { Cue } from "./cues.js";
import type { CaptionLook, Ms, SubtitleStyle } from "./types.js";

// ASS writer for libass burn-in. The browser preview draws the same cues with
// the same font files (see LOOKS), so what you see is what renders.

export const CAPTION_FONT = "Montserrat";

export interface LookSpec {
  fontSizeRel: number; // fraction of output height
  bold: boolean;
  primary: string; // spoken / normal text, CSS hex
  active: string; // current word when highlighting
  upcoming: string | null; // not-yet-spoken words (karaoke), null = same as primary
  outline: number; // fraction of font size
  box: boolean; // dark pill behind text
  uppercase: boolean;
}

export const LOOKS: Record<CaptionLook, LookSpec> = {
  bold: { fontSizeRel: 0.034, bold: true, primary: "#FFFFFF", active: "#FFE14D", upcoming: "#FFFFFFB3", outline: 0.09, box: false, uppercase: true },
  clean: { fontSizeRel: 0.028, bold: false, primary: "#FFFFFF", active: "#FFFFFF", upcoming: null, outline: 0, box: true, uppercase: false },
  focus: { fontSizeRel: 0.036, bold: true, primary: "#FFFFFF", active: "#FFE14D", upcoming: null, outline: 0.08, box: false, uppercase: false },
};

/** "#RRGGBB" or "#RRGGBBAA" (CSS alpha, FF = opaque) → ASS "&HAABBGGRR" (00 = opaque). */
export const assColor = (css: string): string => {
  const h = css.replace("#", "");
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  const a = h.length === 8 ? (255 - parseInt(h.slice(6, 8), 16)).toString(16).padStart(2, "0") : "00";
  return `&H${a}${b}${g}${r}`.toUpperCase();
};

/** ASS time is H:MM:SS.cc; round to centiseconds *before* splitting so 59.999 → 1:00.00. */
export const assTime = (ms: Ms): string => {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
};

/** Neutralise ASS override syntax in user text. */
export const assEscape = (text: string): string =>
  text.replace(/\\/g, "\\​").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, " ");

export interface AssOptions {
  width: number;
  height: number;
  style: SubtitleStyle;
}

export const toAss = (cues: Cue[], { width, height, style }: AssOptions): string => {
  const look = LOOKS[style.look];
  const size = Math.round(height * look.fontSizeRel);
  const outline = look.box ? Math.round(size * 0.35) : Math.max(1, Math.round(size * look.outline));
  const marginV = Math.round(height * (1 - style.y));
  const tx = (s: string) => assEscape(look.uppercase ? s.toLocaleUpperCase("ru") : s);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${CAPTION_FONT},${size},${assColor(look.primary)},${assColor(look.active)},${look.box ? assColor("#000000B3") : assColor("#000000")},${assColor("#00000080")},${look.bold ? -1 : 0},0,0,0,100,100,0,0,${look.box ? 3 : 1},${outline},0,2,${Math.round(width * 0.08)},${Math.round(width * 0.08)},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];
  const dialogue = (start: Ms, end: Ms, text: string) =>
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${text}`);

  for (const cue of cues) {
    const flat = cue.lines.flat();
    if (!style.wordHighlight || look.active === look.primary) {
      dialogue(cue.start, cue.end, cue.lines.map((l) => l.map((w) => tx(w.text)).join(" ")).join("\\N"));
      continue;
    }
    // One event per active-word slice; colour spoken / active / upcoming words.
    flat.forEach((active, k) => {
      const sliceStart = k === 0 ? cue.start : active.start;
      const sliceEnd = k === flat.length - 1 ? cue.end : flat[k + 1]!.start;
      if (sliceEnd <= sliceStart) return;
      let n = 0;
      const text = cue.lines
        .map((l) =>
          l
            .map((w) => {
              const idx = n++;
              const colour =
                idx === k ? look.active : idx > k && look.upcoming ? look.upcoming : look.primary;
              const c = assColor(colour);
              const a = c.slice(2, 4);
              const scale = idx === k && style.look === "focus" ? "\\fscx110\\fscy110" : "";
              return `{\\1c&H${c.slice(4)}&\\1a&H${a}&${scale}}${tx(w.text)}{\\fscx100\\fscy100}`;
            })
            .join(" "),
        )
        .join("\\N");
      dialogue(sliceStart, sliceEnd, text);
    });
  }

  if (style.watermark) {
    const end = cues.length ? cues[cues.length - 1]!.end : 0;
    events.push(
      `Dialogue: 1,${assTime(0)},${assTime(Math.max(end, 1000) + 60_000)},Cap,,0,0,0,,{\\an9\\fs${Math.round(size * 0.45)}\\bord1\\1a&H60&\\pos(${width - Math.round(width * 0.04)},${Math.round(height * 0.04)})}${assEscape(style.watermark)}`,
    );
  }

  return [...header, ...events, ""].join("\n");
};
