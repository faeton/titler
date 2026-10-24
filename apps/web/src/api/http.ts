import type { Api } from "./types";
import { ApiError } from "./types";

const req = async <T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> => {
  const isRaw = body instanceof Blob;
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": isRaw ? "application/octet-stream" : "application/json" },
    body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
    ...init,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new ApiError(res.status, (data as Record<string, unknown>) ?? {});
  return data as T;
};

const enc = encodeURIComponent;

export const httpApi: Api = {
  listProjects: () => req("GET", "/projects"),
  getProject: (id) => req("GET", `/projects/${enc(id)}`),
  patchProject: (id, body) => req("PATCH", `/projects/${enc(id)}`, body),
  deleteProject: async (id) => {
    await req("DELETE", `/projects/${enc(id)}`);
  },

  createUpload: (body) => req("POST", "/uploads", body),
  getUpload: (id) => req("GET", `/uploads/${enc(id)}`),
  putChunk: (id, offset, chunk, signal) => req("PUT", `/uploads/${enc(id)}?offset=${offset}`, chunk, { signal }),
  completeUpload: (id) => req("POST", `/uploads/${enc(id)}/complete`, {}),

  getTranscript: (id) => req("GET", `/projects/${enc(id)}/transcript`),
  saveTranscript: (id, body) => req("PUT", `/projects/${enc(id)}/transcript`, body),
  transcriptOps: (id, body) => req("POST", `/projects/${enc(id)}/transcript/ops`, body),

  startAsr: (id, body) => req("POST", `/projects/${enc(id)}/asr`, body),
  startCompare: (id, body) => req("POST", `/projects/${enc(id)}/compare`, body),
  startRender: (id, body) => req("POST", `/projects/${enc(id)}/render`, body),
  cancelJob: (jobId) => req("POST", `/jobs/${enc(jobId)}/cancel`, {}),
};
