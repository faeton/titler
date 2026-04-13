/**
 * Generate ASS (Advanced SubStation Alpha) subtitles for ffmpeg rendering.
 * Replicates the three Remotion caption styles using ASS styling and
 * karaoke tags. The Remotion Player stays for browser preview; this is
 * the fast ffmpeg export path.
 *
 * ASS color format: &HAABBGGRR (hex, alpha-blue-green-red)
 * ASS time format: H:MM:SS.CC (centiseconds)
 */

import type { Transcript, CircleLayout, TextOverlay } from "./types.js";

// Re-use the same chunking logic as Remotion compositions
type Word = { start: number; end: number; text: string; prob?: number };
type Chunk = {
  words: Word[];
  start: number;
  end: number;
  text: string;
};

// --- pre-processing: fix whisper artifacts ---

function preprocessWords(words: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = { ...words[i] };
    // Rejoin split numbers: "0 ,8" → "0,8", "0 ,2%" → "0,2%"
    if (
      i + 1 < words.length &&
      /^\d+$/.test(w.text) &&
      /^[,.]/.test(words[i + 1].text)
    ) {
      w.text = w.text + words[i + 1].text;
      w.end = words[i + 1].end;
      i++; // skip next
    }
    out.push(w);
  }
  return out;
}

// --- chunking ---

const SENTENCE_END = /[.!?…]+$/;
const CLAUSE_END = /[,;:—–\-]+$/;
// Conjunctions / particles that shouldn't end a chunk
const WEAK_TAIL = /^(но|и|а|что|как|не|на|в|к|с|у|о|за|из|от|по|до|для|при|без|ну)$/i;

function breakScore(words: Word[], i: number): number {
  if (i >= words.length - 1) return 100;
  const w = words[i];
  const next = words[i + 1];
  const gap = next.start - w.end;
  let score = 0;
  if (SENTENCE_END.test(w.text)) score += 50;
  else if (CLAUSE_END.test(w.text)) score += 20;
  if (gap > 0.6) score += 40;
  else if (gap > 0.3) score += 15;
  else if (gap > 0.15) score += 5;
  // Penalize breaking after a weak word (conjunction/preposition)
  const clean = w.text.replace(/[.,!?;:—\-"'«»()…]/g, "");
  if (WEAK_TAIL.test(clean)) score -= 25;
  return score;
}

function chunkWords(words: Word[]): Chunk[] {
  const maxWords = 5;
  const maxChars = 32;
  const maxGap = 0.7;
  const minDuration = 0.6;

  const processed = preprocessWords(words);
  if (processed.length === 0) return [];

  const chunks: Chunk[] = [];
  let buf: Word[] = [];
  let bufChars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    // Don't let a weak word be the last in a chunk — move it to next
    if (
      buf.length >= 2 &&
      WEAK_TAIL.test(buf[buf.length - 1].text.replace(/[.,!?;:—\-"'«»()…]/g, "")) &&
      !SENTENCE_END.test(buf[buf.length - 1].text)
    ) {
      const moved = buf.pop()!;
      chunks.push({
        words: [...buf],
        start: buf[0].start,
        end: buf[buf.length - 1].end,
        text: buf.map((w) => w.text).join(" "),
      });
      buf = [moved];
      bufChars = moved.text.length;
      return;
    }
    chunks.push({
      words: buf,
      start: buf[0].start,
      end: buf[buf.length - 1].end,
      text: buf.map((w) => w.text).join(" "),
    });
    buf = [];
    bufChars = 0;
  };

  for (let i = 0; i < processed.length; i++) {
    const w = processed[i];
    const gap = buf.length > 0 ? w.start - buf[buf.length - 1].end : 0;
    const proposedChars =
      bufChars + w.text.length + (buf.length > 0 ? 1 : 0);

    if (buf.length > 0 && gap > maxGap) flush();
    if (
      buf.length > 0 &&
      (buf.length >= maxWords || proposedChars > maxChars)
    ) {
      if (buf.length >= 3) {
        const s1 = breakScore(processed, i - 1);
        const s2 = buf.length >= 2 ? breakScore(processed, i - 2) : -1;
        if (s2 > s1 + 15 && buf.length >= 2) {
          const rewind = buf.pop()!;
          flush();
          buf.push(rewind);
          bufChars = rewind.text.length;
        } else {
          flush();
        }
      } else {
        flush();
      }
    }

    buf.push(w);
    bufChars = buf.map((x) => x.text).join(" ").length;
    if (buf.length >= 2 && SENTENCE_END.test(w.text)) flush();
  }
  flush();

  // Merge tiny chunks into neighbors (forward or backward)
  const merged: Chunk[] = [];
  for (const chunk of chunks) {
    const dur = chunk.end - chunk.start;
    if (dur < minDuration && merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.words.length + chunk.words.length <= 7) {
        prev.words = [...prev.words, ...chunk.words];
        prev.end = chunk.end;
        prev.text = prev.words.map((w) => w.text).join(" ");
        continue;
      }
    }
    merged.push(chunk);
  }
  // Second pass: merge any remaining tiny chunks forward
  const final: Chunk[] = [];
  for (let i = 0; i < merged.length; i++) {
    const chunk = merged[i];
    const dur = chunk.end - chunk.start;
    if (dur < minDuration && i + 1 < merged.length) {
      const next = merged[i + 1];
      if (next.words.length + chunk.words.length <= 7) {
        next.words = [...chunk.words, ...next.words];
        next.start = chunk.start;
        next.text = next.words.map((w) => w.text).join(" ");
        continue;
      }
    }
    final.push(chunk);
  }
  return final;
}

// --- ASS helpers ---

const fmtTime = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};

// Convert #RRGGBB to ASS &H00BBGGRR& format
const hexToAss = (hex: string, alpha = 0): string => {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  const a = alpha.toString(16).padStart(2, "0").toUpperCase();
  return `&H${a}${b}${g}${r}&`.toUpperCase();
};

const REELS_SAFE = { x: 30, y: 250, w: 1020, h: 1220 };

// Unified caption Y position. For IG Reels the lower third works best.
// Circle (telegram) videos need captions well below the circle.
const captionPos = (circle?: CircleLayout | null) => ({
  x: 540, // center of 1080
  y: circle ? 1420 : 1380, // lower third
});

// --- ASS generation per style ---

type StyleName = "bold" | "clean" | "focus";

export function generateAss(
  transcript: Transcript,
  style: StyleName,
  circle?: CircleLayout | null,
  opts?: { watermark?: boolean; overlays?: TextOverlay[] },
): string {
  const chunks = chunkWords(transcript.words);

  let ass: string;
  switch (style) {
    case "bold":
      ass = generateBoldAss(chunks, circle);
      break;
    case "clean":
      ass = generateCleanAss(chunks, circle);
      break;
    case "focus":
      ass = generateFocusAss(chunks, circle);
      break;
    default:
      ass = generateBoldAss(chunks, circle);
  }

  // Append manual text overlays
  const overlays = opts?.overlays ?? [];
  for (const ov of overlays) {
    const ovColor = hexToAss(ov.color || "#FFFFFF");
    const ovOutline = ov.outline ? `\\bord4\\3c${hexToAss("#000000")}` : "\\bord0";
    const ovWeight = (ov.fontWeight ?? 400) >= 700 ? "\\b1" : "\\b0";
    const ovText = `{\\pos(${Math.round(ov.x)},${Math.round(ov.y)})\\fs${ov.fontSize ?? 48}\\c${ovColor}${ovOutline}${ovWeight}\\fad(150,150)}${ov.text}`;
    ass += `Dialogue: 5,${fmtTime(ov.start)},${fmtTime(ov.end)},Default,,0,0,0,,${ovText}\n`;
  }

  // Append watermark — persistent, barely visible at the very bottom
  const showWatermark = opts?.watermark !== false;
  if (showWatermark) {
    const duration = transcript.duration || 9999;
    ass += `Dialogue: 10,${fmtTime(0)},${fmtTime(duration)},Watermark,,0,0,0,,titler.org\n`;
  }
  return ass;
}

// --- BOLD style ---
// Karaoke word tracking: full chunk visible, current word highlighted
// yellow + scaled up, past words white, upcoming dim.
// Uses per-word dialogue lines (same approach as Focus) for reliable
// word-by-word color switching.

function generateBoldAss(
  chunks: Chunk[],
  circle?: CircleLayout | null,
): string {
  const fontSize = 72;
  const font = "Arial Black";
  const outlineSize = 4;
  const shadowDepth = 2;

  const { x: captionX, y: captionY } = captionPos(circle);

  const header = assHeader({
    fontSize,
    font,
    primaryColor: hexToAss("#FFFFFF"),
    outlineColor: hexToAss("#000000", 12),
    shadowColor: hexToAss("#000000", 100),
    outline: outlineSize,
    shadow: shadowDepth,
    bold: 1,
    alignment: 5,
    marginV: 10,
  });

  const events: string[] = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const nextChunkStart = ci < chunks.length - 1 ? chunks[ci + 1].start : Infinity;
    // Don't extend past the next chunk's start to prevent overlap
    const start = Math.max(0, chunk.start - 0.05);
    const end = Math.min(chunk.end + 0.10, nextChunkStart - 0.01);

    // Emit one dialogue line per word-highlight period
    for (let wi = 0; wi < chunk.words.length; wi++) {
      const w = chunk.words[wi];
      const wStart = wi === 0 ? start : w.start;
      const wEnd =
        wi < chunk.words.length - 1 ? chunk.words[wi + 1].start : end;

      let text = `{\\pos(${captionX},${captionY})}`;
      for (let j = 0; j < chunk.words.length; j++) {
        if (j === wi) {
          text += `{\\c${hexToAss("#FACC15")}\\alpha&H00&\\fscx120\\fscy120}${chunk.words[j].text.toUpperCase()}{\\r}`;
        } else if (j < wi) {
          text += `{\\c${hexToAss("#FFFFFF")}\\alpha&H00&}${chunk.words[j].text.toUpperCase()}{\\r}`;
        } else {
          text += `{\\c${hexToAss("#FFFFFF")}\\alpha&H80&}${chunk.words[j].text.toUpperCase()}{\\r}`;
        }
        if (j < chunk.words.length - 1) text += " ";
      }

      events.push(
        `Dialogue: 0,${fmtTime(wStart)},${fmtTime(wEnd)},Default,,0,0,0,,${text}`,
      );
    }
  }

  return header + "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + events.join("\n") + "\n";
}

// --- CLEAN style ---
// Dark pill background, phrase-level fade in/out. No per-word tracking.
// Uses ASS \3c for border-box background simulation + \fad for fade.

function generateCleanAss(
  chunks: Chunk[],
  circle?: CircleLayout | null,
): string {
  const fontSize = 48;
  const font = "Arial";
  const { x: cx, y: cy } = captionPos(circle);

  const header = assHeader({
    fontSize,
    font,
    primaryColor: hexToAss("#FFFFFF"),
    outlineColor: hexToAss("#000000", 48),
    shadowColor: hexToAss("#000000", 220),
    outline: 24,
    shadow: 0,
    bold: 0,
    alignment: 5,
    marginV: 10,
    borderStyle: 3, // opaque box mode = dark pill
  });

  const events: string[] = [];
  const fadeDur = 200; // ms

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const nextStart = ci < chunks.length - 1 ? chunks[ci + 1].start : Infinity;
    const start = Math.max(0, chunk.start - 0.05);
    const end = Math.min(chunk.end + 0.1, nextStart - 0.01);
    const text = `{\\pos(${cx},${cy})\\fad(${fadeDur},${fadeDur})}${chunk.text}`;
    events.push(
      `Dialogue: 0,${fmtTime(start)},${fmtTime(end)},Default,,0,0,0,,${text}`,
    );
  }

  return header + "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + events.join("\n") + "\n";
}

// --- FOCUS style ---
// All words visible, active word pops yellow + scale. Uses ASS override
// tags per word with timing.

function generateFocusAss(
  chunks: Chunk[],
  circle?: CircleLayout | null,
): string {
  const fontSize = 64;
  const font = "Arial";
  const outlineSize = 4;
  const { x: cx, y: cy } = captionPos(circle);

  const header = assHeader({
    fontSize,
    font,
    primaryColor: hexToAss("#FFFFFF", 160),
    outlineColor: hexToAss("#000000", 40),
    shadowColor: hexToAss("#000000", 100),
    outline: outlineSize,
    shadow: 2,
    bold: 1,
    alignment: 5,
    marginV: 10,
  });

  const events: string[] = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const nextStart = ci < chunks.length - 1 ? chunks[ci + 1].start : Infinity;
    const start = Math.max(0, chunk.start - 0.05);
    const end = Math.min(chunk.end + 0.10, nextStart - 0.01);

    for (let wi = 0; wi < chunk.words.length; wi++) {
      const w = chunk.words[wi];
      const wStart = wi === 0 ? start : w.start;
      const wEnd =
        wi < chunk.words.length - 1 ? chunk.words[wi + 1].start : end;

      let text = `{\\pos(${cx},${cy})\\fad(80,80)}`;
      for (let j = 0; j < chunk.words.length; j++) {
        if (j === wi) {
          // Active word: yellow, full opacity, slightly bigger
          text += `{\\c${hexToAss("#FACC15")}\\alpha&H00&\\fscx115\\fscy115}${chunk.words[j].text.toUpperCase()}{\\r}`;
        } else if (j < wi) {
          // Spoken: white, mostly opaque
          text += `{\\c${hexToAss("#FFFFFF")}\\alpha&H28&}${chunk.words[j].text.toUpperCase()}{\\r}`;
        } else {
          // Upcoming: white, dim
          text += `{\\c${hexToAss("#FFFFFF")}\\alpha&HA0&}${chunk.words[j].text.toUpperCase()}{\\r}`;
        }
        if (j < chunk.words.length - 1) text += " ";
      }

      events.push(
        `Dialogue: 0,${fmtTime(wStart)},${fmtTime(wEnd)},Default,,0,0,0,,${text}`,
      );
    }
  }

  return header + "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + events.join("\n") + "\n";
}

// --- Header builder ---

function assHeader(opts: {
  fontSize: number;
  font: string;
  primaryColor: string;
  outlineColor: string;
  shadowColor: string;
  outline: number;
  shadow: number;
  bold: number;
  alignment: number;
  marginV: number;
  borderStyle?: number;
  styles?: string[];
}): string {
  return `[Script Info]
Title: Titler Export
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${opts.font},${opts.fontSize},${opts.primaryColor},${opts.primaryColor},${opts.outlineColor},${opts.shadowColor},${opts.bold},0,0,0,100,100,0,0,${opts.borderStyle ?? 1},${opts.outline},${opts.shadow},${opts.alignment},30,30,${Math.round(opts.marginV)},1
Style: Watermark,Arial,16,${hexToAss("#FFFFFF", 220)},${hexToAss("#FFFFFF", 220)},${hexToAss("#000000", 240)},${hexToAss("#000000", 250)},0,0,0,0,100,100,2,0,1,0,0,2,30,30,20,1
${(opts.styles ?? []).join("\n")}
`;
}
