import type { AspectRatio, Framing, Probe } from "@titler/core";

// Output framing geometry, normalised to the source frame (0..1).

export const outAspect = (ratio: AspectRatio, probe: Pick<Probe, "width" | "height"> | null): number =>
  ratio === "9:16" ? 9 / 16 : ratio === "16:9" ? 16 / 9 : probe ? probe.width / probe.height : 9 / 16;

export const srcAspect = (probe: Pick<Probe, "width" | "height"> | null, fallback = 3 / 4) =>
  probe && probe.height ? probe.width / probe.height : fallback;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The part of the source that survives a "fill" crop to outAR, centred at (cx, cy). */
export const cropRect = (src: number, out: number, cx = 0.5, cy = 0.5): Rect => {
  const w = src > out ? out / src : 1;
  const h = src > out ? 1 : src / out;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
};

export const centre = (f: Framing): { cx: number; cy: number } => {
  const k = f.keyframes[0];
  return { cx: k?.cx ?? 0.5, cy: k?.cy ?? 0.5 };
};

/** Largest box of aspect `ar` inside (W, H). */
export const fitBox = (ar: number, W: number, H: number) => (W / H > ar ? { w: H * ar, h: H } : { w: W, h: W / ar });
