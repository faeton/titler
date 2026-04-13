import PQueue from "p-queue";
import { nanoid } from "nanoid";
import { getProject } from "./projects.js";
import { ingestProject } from "./ingest.js";
import { transcribeProject } from "./transcribe.js";

// Server-side job queue. Runs independently of the browser —
// submit a batch, close the tab, come back later.

export type JobStatus = "queued" | "running" | "done" | "error";

export type JobStep = "ingest" | "transcribe" | "render";

export type Job = {
  id: string;
  projectId: string;
  steps: JobStep[];
  status: JobStatus;
  currentStep?: JobStep;
  progress?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
};

// In-memory store (no persistence needed — jobs are short-lived)
const jobs = new Map<string, Job>();

// Single-concurrency queue: one CPU-heavy job at a time
const queue = new PQueue({ concurrency: 1 });

export const getJob = (id: string): Job | undefined => jobs.get(id);

export const listJobs = (): Job[] =>
  [...jobs.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt),
  );

export const clearFinishedJobs = () => {
  for (const [id, job] of jobs) {
    if (job.status === "done" || job.status === "error") jobs.delete(id);
  }
};

// Submit a job for a single project. Steps run in order.
export const submitJob = (
  projectId: string,
  steps: JobStep[],
  renderStyle?: string,
): Job => {
  const job: Job = {
    id: nanoid(8),
    projectId,
    steps: [...steps],
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  queue.add(async () => {
    job.status = "running";
    try {
      for (const step of job.steps) {
        job.currentStep = step;
        job.progress = `${step}...`;

        const project = getProject(projectId);
        if (!project) throw new Error(`project ${projectId} not found`);

        switch (step) {
          case "ingest":
            await ingestProject(projectId, (p) => {
              if ("outTimeMs" in p) {
                job.progress = `ingest: ${Math.round(p.outTimeMs / 1000)}s`;
              }
            });
            break;

          case "transcribe":
            if (!project.source) throw new Error("not ingested");
            await transcribeProject(projectId, (p) => {
              job.progress = `transcribe: ${JSON.stringify(p).slice(0, 60)}`;
            });
            break;

          case "render": {
            if (!project.transcript) throw new Error("not transcribed");
            const style = renderStyle ?? "bold";
            // Skip if already rendered with this style
            if (project.rendered?.includes(style)) {
              job.progress = `render: skipped (${style} already done)`;
              break;
            }
            const { renderProjectFfmpeg } = await import("./renderFfmpeg.js");
            await renderProjectFfmpeg(projectId, style, (p) => {
              if ("percent" in p) {
                job.progress = `render: ${(p as { percent: number }).percent}%`;
              }
            });
            // Track rendered style
            const { updateProject } = await import("./projects.js");
            const fresh = getProject(projectId);
            if (fresh) {
              const rendered = new Set(fresh.rendered ?? []);
              rendered.add(style);
              updateProject(projectId, { rendered: [...rendered] });
            }
            break;
          }
        }
      }
      job.status = "done";
      job.progress = undefined;
      job.currentStep = undefined;
    } catch (e) {
      job.status = "error";
      job.error = (e as Error).message;
    }
    job.finishedAt = new Date().toISOString();
  });

  return job;
};

// Convenience: submit jobs for multiple projects at once
export const submitBatch = (
  projectIds: string[],
  steps: JobStep[],
  renderStyle?: string,
): Job[] =>
  projectIds.map((pid) => submitJob(pid, steps, renderStyle));

export const queueSize = () => queue.size;
export const queuePending = () => queue.pending;
