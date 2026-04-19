import { useEffect, useMemo, useRef, useState } from "react";
import type { Job, Project } from "../api";
import { FONTS, type Tok } from "../tokens";
import { Pill, SectionLabel } from "../primitives";

const rank = (s: Job["status"]) =>
  s === "running" ? 0 : s === "queued" ? 1 : s === "error" ? 2 : 3;

const glyph = (s: Job["status"]) =>
  s === "running"
    ? "▶"
    : s === "queued"
      ? "⏳"
      : s === "done"
        ? "✓"
        : "✗";

export const JobsDropdown: React.FC<{
  tok: Tok;
  jobs: Job[];
  projects: Project[];
  onClear: () => void;
}> = ({ tok, jobs, projects, onClear }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const running = jobs.filter((j) => j.status === "running").length;
  const queued = jobs.filter((j) => j.status === "queued").length;
  const errored = jobs.filter((j) => j.status === "error").length;
  const active = running + queued;

  const sorted = useMemo(
    () =>
      [...jobs]
        .sort((a, b) => {
          const ra = rank(a.status);
          const rb = rank(b.status);
          if (ra !== rb) return ra - rb;
          return b.createdAt.localeCompare(a.createdAt);
        })
        .slice(0, 40),
    [jobs],
  );

  const tone: "accent" | "err" | "neutral" =
    active > 0 ? "accent" : errored > 0 ? "err" : "neutral";
  const label =
    active > 0
      ? `${active} active${errored ? ` · ${errored} err` : ""}`
      : errored > 0
        ? `${errored} err`
        : `jobs · ${jobs.length}`;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        title="Jobs"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          height: 28,
          fontFamily: FONTS.body,
          fontSize: 11.5,
          fontWeight: 500,
          color:
            tone === "accent"
              ? tok.accentInk
              : tone === "err"
                ? tok.err
                : tok.ink2,
          background:
            tone === "accent"
              ? tok.accentSoft
              : tone === "err"
                ? "oklch(0.94 0.04 25)"
                : tok.sunk,
          border: `1px solid ${
            tone === "accent"
              ? tok.accent
              : tone === "err"
                ? tok.err
                : tok.rule
          }`,
          borderRadius: 999,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background:
              tone === "accent"
                ? tok.accent
                : tone === "err"
                  ? tok.err
                  : tok.ink3,
            animation:
              active > 0 ? "titler-pulse 1.2s ease-in-out infinite" : undefined,
            color:
              tone === "accent"
                ? tok.accent
                : tone === "err"
                  ? tok.err
                  : tok.ink3,
          }}
        />
        {label}
        <span style={{ fontSize: 9, color: tok.ink3 }}>
          {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            marginBottom: 6,
            width: 340,
            maxHeight: 420,
            overflowY: "auto",
            background: tok.card,
            border: `1px solid ${tok.rule}`,
            borderRadius: 8,
            padding: 10,
            zIndex: 30,
            boxShadow: "0 12px 32px -12px rgba(0,0,0,0.25)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <SectionLabel tok={tok}>Jobs</SectionLabel>
            <div style={{ flex: 1 }} />
            <button
              onClick={onClear}
              style={{
                fontFamily: FONTS.body,
                fontSize: 10,
                color: tok.ink3,
                padding: "2px 6px",
              }}
            >
              clear done
            </button>
          </div>
          {sorted.length === 0 && (
            <div
              style={{
                fontFamily: FONTS.display,
                fontStyle: "italic",
                fontSize: 12,
                color: tok.ink3,
                padding: "10px 4px",
              }}
            >
              No jobs yet.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {sorted.map((j) => {
              const proj = projects.find((p) => p.id === j.projectId);
              const name = proj?.name ?? j.projectId;
              const color =
                j.status === "error"
                  ? tok.err
                  : j.status === "done"
                    ? tok.ok
                    : j.status === "running"
                      ? tok.accent
                      : tok.ink3;
              const detail = j.error ?? j.progress ?? j.status;
              return (
                <div
                  key={j.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: 4,
                    borderLeft: `2px solid ${color}`,
                    background:
                      j.status === "running" ? tok.sunk : "transparent",
                  }}
                  title={j.error ?? j.progress}
                >
                  <span
                    style={{
                      color,
                      fontFamily: FONTS.mono,
                      fontSize: 11,
                      width: 14,
                      textAlign: "center",
                    }}
                  >
                    {glyph(j.status)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        color: tok.ink,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {name}
                    </div>
                    <div
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 9.5,
                        color: tok.ink3,
                        marginTop: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {j.steps.join(" + ")}
                      {j.currentStep && j.status === "running"
                        ? ` · ${j.currentStep}`
                        : ""}
                      {detail ? ` — ${String(detail).slice(0, 40)}` : ""}
                    </div>
                  </div>
                  {j.status === "running" && (
                    <Pill tok={tok} tone="accent" style={{ fontSize: 9 }}>
                      live
                    </Pill>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
