// Thin typed client over the local Fastify server. In dev, Vite proxies
// `/api/...` → `http://127.0.0.1:7777/...`.

export type Word = {
  start: number;
  end: number;
  text: string;
  prob?: number;
};

export type Transcript = {
  language: string;
  duration: number;
  words: Word[];
};

export type AspectStrategy = "crop" | "blur_fill" | "letterbox" | "telegram_circle";

export type ProbeInfo = {
  width: number;
  height: number;
  fps: number;
  codec: string;
  duration: number;
  createdAt?: string | null;
  device?: string | null;
  make?: string | null;
  software?: string | null;
};

export type CircleLayout = {
  x: number;
  y: number;
  size: number;
};

export type SourceInfo = {
  original: ProbeInfo;
  aspectStrategy: AspectStrategy;
  normalizedPath: string;
  audioPath: string;
  circle?: CircleLayout;
};

export type CropMode = "center" | "face_track";

export type FaceTrackResult = {
  found: boolean;
  keyframes: { time: number; x: number; y: number }[];
  source_width: number;
  source_height: number;
  crop_width: number;
  crop_height: number;
};

export type Project = {
  id: string;
  name: string;
  originalFile: string;
  createdAt: string;
  source?: SourceInfo;
  transcript?: Transcript;
  cropMode?: CropMode;
  faceTrack?: FaceTrackResult;
  edited?: boolean;
  rendered?: string[];
  archived?: boolean;
};

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${path}: ${body}`);
  }
  return (await res.json()) as T;
};

export const listInbox = () =>
  api<{ files: string[] }>("/inbox").then((r) => r.files);

export const listProjects = (opts?: { archived?: boolean }) =>
  api<{ projects: Project[] }>(
    `/projects${opts?.archived ? "?archived=true" : ""}`,
  ).then((r) => r.projects);

export const getProject = (id: string) => api<Project>(`/projects/${id}`);

export const createProject = (file: string) =>
  api<Project>("/projects", {
    method: "POST",
    body: JSON.stringify({ file }),
  });

export const deleteProject = (id: string) =>
  api<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" });

export const renameProject = (id: string, name: string) =>
  api<{ ok: boolean; name: string }>(`/projects/${id}/name`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const archiveProject = (id: string) =>
  api<{ ok: boolean; archived: boolean }>(`/projects/${id}/archive`, {
    method: "POST",
  });

// --- jobs (server-side queue) ---

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

export const listJobs = () =>
  api<{ jobs: Job[]; queueSize: number; pending: number }>("/jobs");

export const getJob = (id: string) => api<Job>(`/jobs/${id}`);

export const submitBatchImport = (files: string[]) =>
  api<{ results: { file: string; projectId?: string; error?: string }[] }>(
    "/jobs/import",
    { method: "POST", body: JSON.stringify({ files }) },
  );

export const submitBatchRender = (projectIds: string[], style: string) =>
  api<{ jobs: Job[] }>("/jobs/batch", {
    method: "POST",
    body: JSON.stringify({ projectIds, steps: ["render"], style }),
  });

export const clearJobs = () =>
  api<{ ok: boolean }>("/jobs/clear", { method: "POST" });

// Subscribes to an SSE endpoint for a long-running job; calls
// `onEvent` per message, returns a promise that resolves when the
// stream closes. Errors in payload events surface via `onEvent`.
export const runStream = (
  path: string,
  onEvent: (data: unknown) => void,
  opts?: { body?: unknown },
): Promise<void> =>
  new Promise((resolve, reject) => {
    fetch(`/api${path}`, {
      method: "POST",
      ...(opts?.body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts.body),
          }
        : {}),
    })
      .then((res) => {
        if (!res.ok || !res.body) {
          reject(new Error(`${res.status} ${path}`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();
          if (done) {
            resolve();
            return;
          }
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of chunk.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  onEvent(JSON.parse(line.slice(6)));
                } catch {
                  /* ignore parse errors on partial chunks */
                }
              }
            }
          }
          return pump();
        };
        pump().catch(reject);
      })
      .catch(reject);
  });
