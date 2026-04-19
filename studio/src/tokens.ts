// Editorial/magazine design tokens — warm paper + deep ink + burnt-amber accent.
// Light + dark palettes mirror one another.

export type ThemeName = "light" | "dark";

export type Tok = {
  paper: string;
  card: string;
  sunk: string;
  rule: string;
  ruleSoft: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  accent: string;
  accentFg: string;
  accentSoft: string;
  accentInk: string;
  ok: string;
  okSoft: string;
  warn: string;
  err: string;
  sel: string;
  focus: string;
};

export const TOKENS: Record<ThemeName, Tok> = {
  light: {
    paper: "oklch(0.985 0.006 85)",
    card: "oklch(0.995 0.004 85)",
    sunk: "oklch(0.955 0.009 85)",
    rule: "oklch(0.88 0.012 80)",
    ruleSoft: "oklch(0.92 0.010 80)",
    ink: "oklch(0.22 0.012 270)",
    ink2: "oklch(0.42 0.010 270)",
    ink3: "oklch(0.60 0.008 270)",
    ink4: "oklch(0.75 0.006 270)",
    accent: "oklch(0.62 0.17 40)",
    accentFg: "oklch(0.985 0.006 85)",
    accentSoft: "oklch(0.94 0.04 50)",
    accentInk: "oklch(0.45 0.15 40)",
    ok: "oklch(0.62 0.14 155)",
    okSoft: "oklch(0.94 0.04 155)",
    warn: "oklch(0.72 0.14 75)",
    err: "oklch(0.58 0.18 25)",
    sel: "oklch(0.93 0.03 50)",
    focus: "oklch(0.62 0.17 40 / 0.3)",
  },
  dark: {
    paper: "oklch(0.16 0.006 85)",
    card: "oklch(0.20 0.008 85)",
    sunk: "oklch(0.13 0.006 85)",
    rule: "oklch(0.28 0.010 80)",
    ruleSoft: "oklch(0.24 0.008 80)",
    ink: "oklch(0.96 0.008 85)",
    ink2: "oklch(0.78 0.010 85)",
    ink3: "oklch(0.60 0.010 85)",
    ink4: "oklch(0.42 0.008 85)",
    accent: "oklch(0.70 0.17 45)",
    accentFg: "oklch(0.16 0.006 85)",
    accentSoft: "oklch(0.30 0.07 45)",
    accentInk: "oklch(0.85 0.12 45)",
    ok: "oklch(0.72 0.14 155)",
    okSoft: "oklch(0.28 0.06 155)",
    warn: "oklch(0.78 0.14 75)",
    err: "oklch(0.68 0.18 25)",
    sel: "oklch(0.30 0.06 50)",
    focus: "oklch(0.70 0.17 45 / 0.35)",
  },
};

export const FONTS = {
  display: `'Fraunces', 'Times New Roman', Georgia, serif`,
  body: `'Geist', ui-sans-serif, system-ui, sans-serif`,
  mono: `'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace`,
};

export const fmtTime = (s: number): string => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};
