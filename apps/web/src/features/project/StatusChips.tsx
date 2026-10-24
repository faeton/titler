import type { Job, JobKind, ProjectView } from "@titler/core";
import { isActive, JOB_LABEL } from "../../api";

/** Compact processing status: active jobs with progress, or the latest failure. */
export const StatusChips = ({ view }: { view: ProjectView | null }) => {
  if (!view) return null;
  const active = view.jobs.filter(isActive).filter((j) => j.kind !== "align");
  const aligning = view.jobs.some((j) => isActive(j) && j.kind === "align");
  const latest = new Map<JobKind, Job>();
  for (const j of [...view.jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) latest.set(j.kind, j);
  const failed = [...latest.values()].filter((j) => j.status === "error");
  if (!active.length && !failed.length)
    return aligning ? <span className="chip busy"><i className="spin" />тайминги</span> : <span className="chip ok">готово</span>;
  return (
    <span className="row" style={{ gap: 4, flexWrap: "nowrap", overflow: "hidden" }}>
      {active.slice(0, 2).map((j) => (
        <span key={j.id} className={j.status === "running" ? "chip busy" : "chip"} title={j.message ?? undefined}>
          {j.status === "running" ? <i className="spin" /> : null}
          {JOB_LABEL[j.kind]}
          {j.status === "running" && j.progress !== null ? ` ${Math.round(j.progress * 100)}%` : j.status === "queued" ? " · в очереди" : ""}
        </span>
      ))}
      {active.length > 2 ? <span className="chip">+{active.length - 2}</span> : null}
      {failed.slice(0, 1).map((j) => (
        <span key={j.id} className="chip err" title={j.error ?? undefined}>
          {JOB_LABEL[j.kind]}: ошибка
        </span>
      ))}
    </span>
  );
};
