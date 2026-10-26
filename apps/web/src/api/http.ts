import type { Api } from "./types";
import { ApiError, AUTH_EVENT } from "./types";

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
  if (res.status === 401 && path !== "/auth/login") window.dispatchEvent(new Event(AUTH_EVENT));
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
  startCover: (id, body) => req("POST", `/projects/${enc(id)}/cover`, body),
  coverSuggestions: (id, startMs, endMs) => req("GET", `/projects/${enc(id)}/cover/suggestions?startMs=${Math.round(startMs)}&endMs=${Math.round(endMs)}`),
  frameUrl: (id, atMs) => `/api/projects/${enc(id)}/frame/${Math.round(atMs / 10) * 10}.jpg`,
  cancelJob: (jobId) => req("POST", `/jobs/${enc(jobId)}/cancel`, {}),

  authMe: () => req("GET", "/auth/me"),
  login: async (token) => {
    await req("POST", "/auth/login", { token });
  },
  logout: async () => {
    await req("POST", "/auth/logout", {});
  },
  listKeys: () => req("GET", "/auth/keys"),
  createKey: (name) => req("POST", "/auth/keys", { name }),
  revokeKey: (id) => req("DELETE", `/auth/keys/${enc(id)}`),
  linkStats: () => req("GET", "/auth/links"),
  rotateLinks: () => req("POST", "/auth/links/rotate", {}),
};
