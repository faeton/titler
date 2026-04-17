import PQueue from "p-queue";
import { nanoid } from "nanoid";
import { getProject } from "./projects.js";
import { ingestProject } from "./ingest.js";
import { transcribeProject, type TranscribeOptions } from "./transcribe.js";

// Server-side job queue. Runs independently of the browser —
// submit a batch, close the tab, come back later.
//
// Two separate queues so ingest (ffmpeg / P-cores) and transcribe
// (mlx-whisper / Neural Engine + GPU) pipeline instead of blocking
// each other. Ingest of file B runs while transcribe of file A runs.
// Render is ffmpeg-bound, shares the ingest queue.

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

const jobs = new Map<string, Job>();

const ingestQueue = new PQueue({ concurrency: 1 });
const transcribeQueue = new PQueue({ concurrency: 1 });

const queueFor = (step: JobStep) =>
  step === "transcribe" ? transcribeQueue : ingestQueue;

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

export const submitJob = (
  projectId: string,
  steps: JobStep[],
  renderStyle?: string,
  transcribeOptions?: TranscribeOptions,
): Job => {
  const job: Job = {
    id: nanoid(8),
    projectId,
    steps: [...steps],
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  (async () => {
    try {
      for (const step of job.steps) {
        await queueFor(step).add(async () => {
          job.status = "running";
          job.currentStep = step;
          job.progress = `${step}...`;

          const project = getProject(projectId);
          if (!project) throw new Error(`project ${projectId} not found`);

          const label = `[job ${job.id} ${project.name}]`;

          switch (step) {
            case "ingest":
              console.log(`${label} ingest start`);
              await ingestProject(projectId, (p) => {
                if ("outTimeMs" in p) {
                  job.progress = `ingest: ${Math.round(p.outTimeMs / 1000)}s`;
                }
              });
              console.log(`${label} ingest done`);
              break;

            case "transcribe": {
              const fresh = getProject(projectId);
              if (!fresh?.source) throw new Error("not ingested");
              console.log(`${label} transcribe start`);
              await transcribeProject(
                projectId,
                (p) => {
                  job.progress = `transcribe: ${JSON.stringify(p).slice(0, 60)}`;
                },
                transcribeOptions,
              );
              console.log(`${label} transcribe done`);
              break;
            }

            case "render": {
              const fresh = getProject(projectId);
              if (!fresh?.transcript) throw new Error("not transcribed");
              const style = renderStyle ?? "bold";
              if (fresh.rendered?.includes(style)) {
                job.progress = `render: skipped (${style} already done)`;
                console.log(`${label} render skipped (${style} already done)`);
                break;
              }
              console.log(`${label} render start (${style})`);
              const { renderProjectFfmpeg } = await import("./renderFfmpeg.js");
              await renderProjectFfmpeg(projectId, style, (p) => {
                if ("percent" in p) {
                  job.progress = `render: ${(p as { percent: number }).percent}%`;
                }
              });
              const { updateProject } = await import("./projects.js");
              const after = getProject(projectId);
              if (after) {
                const rendered = new Set(after.rendered ?? []);
                rendered.add(style);
                updateProject(projectId, { rendered: [...rendered] });
              }
              console.log(`${label} render done (${style})`);
              break;
            }
          }
        });
      }
      job.status = "done";
      job.progress = undefined;
      job.currentStep = undefined;
    } catch (e) {
      job.status = "error";
      job.error = (e as Error).message;
      console.error(`[job ${job.id}] error: ${job.error}`);
    }
    job.finishedAt = new Date().toISOString();
  })();

  return job;
};

export const submitBatch = (
  projectIds: string[],
  steps: JobStep[],
  renderStyle?: string,
): Job[] =>
  projectIds.map((pid) => submitJob(pid, steps, renderStyle));

export const queueSize = () => ingestQueue.size + transcribeQueue.size;
export const queuePending = () => ingestQueue.pending + transcribeQueue.pending;

export const queueStats = () => ({
  ingest: { size: ingestQueue.size, pending: ingestQueue.pending },
  transcribe: {
    size: transcribeQueue.size,
    pending: transcribeQueue.pending,
  },
});
