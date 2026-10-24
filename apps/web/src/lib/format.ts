export const fmtTime = (ms: number, withTenths = false): string => {
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  return withTenths ? `${base}.${Math.floor((t % 1000) / 100)}` : base;
};

export const fmtBytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} ГБ` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} МБ` : `${Math.max(1, Math.round(n / 1e3))} КБ`;

export const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
