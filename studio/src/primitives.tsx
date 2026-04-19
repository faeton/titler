import { useState, type CSSProperties, type ReactNode } from "react";
import { FONTS, type Tok } from "./tokens";

// -------- Icon system — thin stroked lines, magazine-y

const ICONS: Record<string, ReactNode> = {
  play: <path d="M8 5l11 7-11 7V5z" />,
  pause: (
    <>
      <path d="M7 5h3v14H7z" />
      <path d="M14 5h3v14h-3z" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  x: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="M5 11l7-7 7 7" />
      <path d="M4 20h16" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v12" />
      <path d="M19 13l-7 7-7-7" />
      <path d="M4 20h16" />
    </>
  ),
  render: <path d="M5 5l14 7-14 7V5z" />,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />,
  file: (
    <>
      <path d="M6 3h8l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" />
      <path d="M14 3v5h5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4 12H1M23 12h-3M5.6 5.6L3.5 3.5M20.5 20.5l-2.1-2.1M18.4 5.6l2.1-2.1M3.5 20.5l2.1-2.1" />
    </>
  ),
  check: <path d="M4 12l5 5L20 6" />,
  crop: (
    <>
      <path d="M7 3v14h14" />
      <path d="M3 7h14v14" />
    </>
  ),
  wand: (
    <>
      <path d="M4 20L14 10" />
      <path d="M16 4l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z" />
    </>
  ),
  iphone: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  glasses: (
    <>
      <circle cx="7" cy="13" r="3" />
      <circle cx="17" cy="13" r="3" />
      <path d="M10 13h4" />
      <path d="M3 13l2-4M21 13l-2-4" />
    </>
  ),
  telegram: <path d="M3 12l18-8-3 18-6-4-3 4v-5l10-8-12 7L3 12z" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="M13 5l7 7-7 7" />
    </>
  ),
  batch: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" />
    </>
  ),
  edit: <path d="M4 20h4L20 8l-4-4L4 16v4z" />,
  refresh: (
    <>
      <path d="M3 12a9 9 0 0115-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 01-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8" />
      <path d="M10 12h4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2" />
      <path d="M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13" />
    </>
  ),
};

export type IconName = keyof typeof ICONS;

export const Icon = ({
  name,
  size = 16,
  stroke = 1.6,
  color,
  style,
}: {
  name: IconName | string;
  size?: number;
  stroke?: number;
  color?: string;
  style?: CSSProperties;
}) => {
  const d = ICONS[name];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      {d}
    </svg>
  );
};

export const DeviceIcon = ({
  device,
  size = 14,
  color,
}: {
  device?: string | null;
  size?: number;
  color?: string;
}) => {
  if (!device) return <Icon name="iphone" size={size} color={color} />;
  if (/ray.?ban|glasses|meta/i.test(device))
    return <Icon name="glasses" size={size} color={color} />;
  if (/telegram/i.test(device))
    return <Icon name="telegram" size={size} color={color} />;
  return <Icon name="iphone" size={size} color={color} />;
};

// -------- Buttons

type BtnVariant = "primary" | "accent" | "quiet" | "outline" | "ghost" | "danger";
type BtnSize = "sm" | "md" | "lg";

export const Btn = ({
  children,
  variant = "ghost",
  size = "md",
  icon,
  iconRight,
  tok,
  onClick,
  disabled,
  style,
  title,
  type = "button",
}: {
  children?: ReactNode;
  variant?: BtnVariant;
  size?: BtnSize;
  icon?: string;
  iconRight?: string;
  tok: Tok;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
  title?: string;
  type?: "button" | "submit";
}) => {
  const sizes: Record<BtnSize, { p: string; f: number; h: number; g: number }> = {
    sm: { p: "6px 10px", f: 12, h: 28, g: 6 },
    md: { p: "8px 14px", f: 13, h: 34, g: 8 },
    lg: { p: "11px 18px", f: 14, h: 42, g: 10 },
  };
  const s = sizes[size];
  const variants: Record<
    BtnVariant,
    { bg: string; fg: string; bd: string; hoverBg?: string; hoverFilter?: string }
  > = {
    primary: { bg: tok.ink, fg: tok.paper, bd: tok.ink, hoverFilter: "brightness(1.15)" },
    accent: { bg: tok.accent, fg: tok.accentFg, bd: tok.accent, hoverFilter: "brightness(1.08)" },
    quiet: { bg: "transparent", fg: tok.ink2, bd: "transparent", hoverBg: tok.sunk },
    outline: { bg: tok.card, fg: tok.ink, bd: tok.rule, hoverBg: tok.sunk },
    ghost: { bg: "transparent", fg: tok.ink, bd: "transparent", hoverBg: tok.sunk },
    danger: { bg: "transparent", fg: tok.err, bd: "transparent", hoverBg: "oklch(0.94 0.04 25)" },
  };
  const v = variants[variant];
  const [h, setH] = useState(false);
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: s.g,
        padding: s.p,
        height: s.h,
        fontFamily: FONTS.body,
        fontSize: s.f,
        fontWeight: 500,
        letterSpacing: -0.05,
        color: v.fg,
        background: h && !disabled ? v.hoverBg ?? v.bg : v.bg,
        filter: h && !disabled && v.hoverFilter ? v.hoverFilter : "none",
        border: `1px solid ${v.bd}`,
        borderRadius: 999,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.12s ease, filter 0.12s ease, color 0.12s ease",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={s.f + 2} />}
      {children}
      {iconRight && <Icon name={iconRight} size={s.f + 2} />}
    </button>
  );
};

export const IconBtn = ({
  name,
  size = 32,
  iconSize,
  tok,
  onClick,
  title,
  active,
  style,
}: {
  name: string;
  size?: number;
  iconSize?: number;
  tok: Tok;
  onClick?: () => void;
  title?: string;
  active?: boolean;
  style?: CSSProperties;
}) => {
  const [h, setH] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        background: active ? tok.sunk : h ? tok.sunk : "transparent",
        color: active ? tok.ink : tok.ink2,
        border: 0,
        borderRadius: 999,
        cursor: "pointer",
        transition: "all 0.12s ease",
        ...style,
      }}
    >
      <Icon name={name} size={iconSize || Math.round(size * 0.5)} />
    </button>
  );
};

export const Pill = ({
  children,
  tone = "neutral",
  tok,
  style,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "ok" | "warn" | "err" | "ink";
  tok: Tok;
  style?: CSSProperties;
}) => {
  const tones: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: tok.sunk, fg: tok.ink2 },
    accent: { bg: tok.accentSoft, fg: tok.accentInk },
    ok: { bg: tok.okSoft, fg: tok.ok },
    warn: { bg: "oklch(0.95 0.04 75)", fg: "oklch(0.48 0.12 75)" },
    err: { bg: "oklch(0.94 0.04 25)", fg: tok.err },
    ink: { bg: tok.ink, fg: tok.paper },
  };
  const t = tones[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 999,
        background: t.bg,
        color: t.fg,
        fontFamily: FONTS.body,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: 0.01,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
};

export const Kbd = ({ children, tok }: { children: ReactNode; tok: Tok }) => (
  <span
    style={{
      display: "inline-block",
      padding: "1px 6px",
      fontFamily: FONTS.mono,
      fontSize: 10.5,
      fontWeight: 500,
      background: tok.card,
      color: tok.ink3,
      border: `1px solid ${tok.rule}`,
      borderBottomWidth: 2,
      borderRadius: 4,
      lineHeight: "14px",
    }}
  >
    {children}
  </span>
);

export const Hairline = ({
  tok,
  vertical,
  style,
}: {
  tok: Tok;
  vertical?: boolean;
  style?: CSSProperties;
}) => (
  <div
    style={{
      background: tok.rule,
      ...(vertical ? { width: 1, alignSelf: "stretch" } : { height: 1, width: "100%" }),
      ...style,
    }}
  />
);

export const SectionLabel = ({
  children,
  tok,
  style,
}: {
  children: ReactNode;
  tok: Tok;
  style?: CSSProperties;
}) => (
  <div
    style={{
      fontFamily: FONTS.mono,
      fontSize: 10.5,
      color: tok.ink3,
      textTransform: "uppercase",
      letterSpacing: 0.14,
      fontWeight: 500,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Toggle = ({
  tok,
  on,
  onChange,
}: {
  tok: Tok;
  on: boolean;
  onChange?: () => void;
}) => (
  <span
    onClick={onChange}
    style={{
      width: 28,
      height: 16,
      borderRadius: 999,
      position: "relative",
      background: on ? tok.ink : tok.rule,
      cursor: "pointer",
      transition: "all 0.15s ease",
      flexShrink: 0,
      display: "inline-block",
    }}
  >
    <span
      style={{
        position: "absolute",
        top: 2,
        left: on ? 14 : 2,
        width: 12,
        height: 12,
        borderRadius: 999,
        background: tok.paper,
        transition: "left 0.15s ease",
      }}
    />
  </span>
);

export const ToggleChip = ({
  tok,
  label,
  on,
  onChange,
}: {
  tok: Tok;
  label: string;
  on: boolean;
  onChange: () => void;
}) => (
  <span
    onClick={onChange}
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      cursor: "pointer",
      fontSize: 12,
      color: on ? tok.ink : tok.ink3,
      padding: "5px 10px",
      borderRadius: 999,
      transition: "color 0.12s ease",
    }}
  >
    <Toggle tok={tok} on={on} />
    {label}
  </span>
);
