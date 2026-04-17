import { useEffect, useRef, useState } from "react";
import type { Job, Project } from "../api";

type Props = {
  jobs: Job[];
  projects: Project[];
  onClear: () => void;
};

const rank = (s: Job["status"]) =>
  s === "running" ? 0 : s === "queued" ? 1 : s === "error" ? 2 : 3;

export const JobsDropdown: React.FC<Props> = ({ jobs, projects, onClear }) => {
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

  const label =
    running + queued > 0
      ? `jobs \u00B7 ${running + queued} active${errored ? ` \u00B7 ${errored} err` : ""}`
      : errored
        ? `jobs \u00B7 ${errored} err`
        : `jobs \u00B7 ${jobs.length}`;

  const sorted = [...jobs]
    .sort((a, b) => {
      const ra = rank(a.status);
      const rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      return b.createdAt.localeCompare(a.createdAt);
    })
    .slice(0, 30);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          fontSize: 11,
          padding: "4px 8px",
          color: running > 0 ? "#facc15" : errored ? "#ef4444" : "#aaa",
        }}
      >
        {label} {open ? "\u25B2" : "\u25BC"}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 4,
            minWidth: 320,
            maxHeight: 400,
            overflowY: "auto",
            background: "#1a1a1f",
            border: "1px solid #2c2c33",
            borderRadius: 4,
            padding: 8,
            zIndex: 20,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 6,
            }}
          >
            <h2
              style={{ flex: 1, fontSize: 11, color: "#888", margin: 0 }}
            >
              jobs
            </h2>
            <button
              onClick={onClear}
              style={{ fontSize: 9, padding: "2px 5px", color: "#888" }}
            >
              clear done
            </button>
          </div>
          {sorted.length === 0 && (
            <div style={{ fontSize: 10, color: "#555", padding: 4 }}>
              no jobs
            </div>
          )}
          {sorted.map((j) => {
            const proj = projects.find((p) => p.id === j.projectId);
            const name = proj?.name ?? j.projectId;
            const short =
              name.length > 28 ? name.slice(0, 26) + "\u2026" : name;
            return (
              <div
                key={j.id}
                style={{
                  fontSize: 10,
                  padding: "2px 0",
                  color:
                    j.status === "error"
                      ? "#ef4444"
                      : j.status === "done"
                        ? "#4ade80"
                        : j.status === "running"
                          ? "#facc15"
                          : "#888",
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {j.status === "running"
                    ? "\u25B6"
                    : j.status === "queued"
                      ? "\u23F3"
                      : j.status === "done"
                        ? "\u2713"
                        : "\u2717"}
                </span>{" "}
                {short}{" "}
                <span style={{ color: "#666" }}>
                  {j.error ?? j.progress ?? j.status}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
