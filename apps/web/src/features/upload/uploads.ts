import { useSyncExternalStore } from "react";
import { api, ApiError } from "../../api";

// Chunked, resumable uploads. The server upload id is remembered per file
// (name|size|lastModified) in localStorage, so after a reload or a dropped
// connection picking the same file again continues from `received`.

const CHUNK = 8 * 1024 * 1024;
const KEY = "titler.uploads.v1";

export interface StoredUpload {
  key: string;
  id: string;
  name: string;
  size: number;
  received: number;
  startedAt: string;
}

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  received: number;
  status: "uploading" | "finishing" | "error" | "done";
  error?: string;
  projectId?: string;
}

const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

const load = (): Record<string, StoredUpload> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, StoredUpload>;
  } catch {
    return {};
  }
};
const store = (m: Record<string, StoredUpload>) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* private mode: resume just won't survive reload */
  }
};
const remember = (u: StoredUpload) => store({ ...load(), [u.key]: u });
export const forget = (key: string) => {
  const m = load();
  delete m[key];
  store(m);
  emit();
};

/** Unfinished uploads from earlier sessions (to show "pick the same file to continue"). */
export const unfinished = (): StoredUpload[] => Object.values(load());

// ---- live state -------------------------------------------------------------

let items: UploadItem[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  items = [...items];
  listeners.forEach((l) => l());
};
const patch = (key: string, p: Partial<UploadItem>) => {
  items = items.map((i) => (i.key === key ? { ...i, ...p } : i));
  emit();
};
export const useUploads = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
  );
export const dismiss = (key: string) => {
  items = items.filter((i) => i.key !== key);
  emit();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const startUpload = async (file: File): Promise<string | null> => {
  const key = fileKey(file);
  if (items.some((i) => i.key === key && (i.status === "uploading" || i.status === "finishing"))) return null;
  items = [...items.filter((i) => i.key !== key), { key, name: file.name, size: file.size, received: 0, status: "uploading" }];
  emit();
  try {
    let id: string | null = load()[key]?.id ?? null;
    let received = 0;
    if (id) {
      try {
        received = (await api.getUpload(id)).received;
      } catch {
        id = null;
      }
    }
    if (!id) {
      const st = await api.createUpload({
        name: file.name,
        size: file.size,
        lastModified: new Date(file.lastModified || Date.now()).toISOString(),
      });
      id = st.id;
      received = st.received;
    }
    const startedAt = new Date().toISOString();
    remember({ key, id, name: file.name, size: file.size, received, startedAt });
    patch(key, { received });

    let failures = 0;
    while (received < file.size) {
      try {
        const st = await api.putChunk(id, received, file.slice(received, received + CHUNK));
        received = st.received;
        failures = 0;
        remember({ key, id, name: file.name, size: file.size, received, startedAt });
        patch(key, { received, status: "uploading", error: undefined });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && typeof e.body.received === "number") {
          received = e.body.received;
          continue;
        }
        if (e instanceof ApiError && e.status === 404) throw e;
        if (++failures > 6) throw e;
        patch(key, { error: "Нет связи, повторяю…" });
        await sleep(Math.min(30_000, 1000 * 2 ** failures));
      }
    }
    patch(key, { status: "finishing", error: undefined });
    const view = await api.completeUpload(id);
    forget(key);
    patch(key, { status: "done", projectId: view.project.id });
    return view.project.id;
  } catch (e) {
    patch(key, { status: "error", error: e instanceof Error ? e.message : String(e) });
    return null;
  }
};
