// In-browser mock of the /api contract (VITE_MOCK=1). One sample project built
// from a real Ray-Ban clip (bench/samples → dev-media/), simulated jobs that
// advance with wall-clock time, and real core logic for saves (reconcile),
// local alignment (alignmentWindows/applyAlignment) and subtitles (compileCues).
// State persists in localStorage so reload/resume flows can be exercised.

import {
  alignmentWindows,
  allWords,
  applyAlignment,
  compileCues,
  compilePartCues,
  DEFAULT_AUDIO,
  DEFAULT_COVER,
  DEFAULT_FRAMING,
  DEFAULT_SERIES,
  DEFAULT_STYLE,
  docFromHypothesis,
  effectiveTimes,
  newId,
  reconcile,
  resolveCuts,
  seriesParts,
  seriesWords,
  toSrt,
  toVtt,
  type AlignWindow,
  type AuthKey,
  type LinkStats,
  type Artifact,
  type CompareClip,
  type Job,
  type JobKind,
  type Project,
  type ProjectSummary,
  type ProjectView,
  type TranscriptDoc,
  type TranscriptRevision,
  type UploadState,
  type Word,
} from "@titler/core";
import type { Api } from "./types";
import { ApiError } from "./types";
import sampleWords from "./mock-words.json";

// core.newId uses crypto.randomUUID, which browsers only expose in secure
// contexts (https / localhost) — not on http://<tailnet-ip>:5180.
if (typeof globalThis.crypto?.randomUUID !== "function") {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => {
      const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  });
}

const KEY = "titler.mock.v1";
const MEDIA = "/dev-media";
const DURATION = 64_327;

interface MockProject {
  project: Project;
  artifacts: Artifact[];
  jobs: (Job & { _dur: number })[];
  revisions: TranscriptRevision[];
  urls: ProjectView["urls"];
}

interface Db {
  projects: Record<string, MockProject>;
  uploads: Record<string, UploadState>;
}

const now = () => new Date().toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => structuredClone(v);

const clips = (): CompareClip[] =>
  (
    [
      ["calm", 2000],
      ["noisy", 24000],
      ["voices", 44000],
    ] as const
  ).map(([excerpt, startMs]) => ({
    excerpt,
    startMs,
    endMs: startMs + 10_000,
    variants: Object.fromEntries(
      ["original", "gentle", "voice", "strong"].map((p) => [p, `${MEDIA}/compare/${excerpt}-${p}.m4a`]),
    ),
  }));

const sampleDoc = (): TranscriptDoc => {
  const doc = docFromHypothesis({ id: "hyp-demo", words: sampleWords });
  const words = allWords(doc);
  words.forEach((w, i) => {
    if (i < 18) w.timing = "aligned";
    const conf = (sampleWords[i] as { conf?: number } | undefined)?.conf ?? 1;
    if (conf < 0.45) w.review = "needs_review";
  });
  // A few hand-picked states so every visual is visible in the demo.
  const pick = (t: string) => words.find((w) => w.text.startsWith(t));
  const g = pick("Лукоморье");
  if (g) g.review = "needs_review";
  const k = pick("пончики");
  if (k) k.review = "needs_review";
  const a = pick("ага");
  if (a) a.hidden = true;
  return doc;
};

const baseProject = (id: string, name: string): Project => ({
  id,
  name,
  createdAt: now(),
  sourceSha256: id.padEnd(64, "0"),
  sourceName: name,
  probe: null,
  settings: {
    audio: { ...DEFAULT_AUDIO },
    framing: { ...DEFAULT_FRAMING },
    style: { ...DEFAULT_STYLE },
    series: { ...DEFAULT_SERIES, numbering: { ...DEFAULT_SERIES.numbering }, cuts: {} },
    cover: { ...DEFAULT_COVER },
  },
  transcriptRev: 0,
  archived: false,
});

const probe = () => ({
  width: 1376,
  height: 1840,
  rotation: 0,
  fps: 30,
  durationMs: DURATION,
  videoCodec: "hevc",
  audioCodec: "aac",
  sampleRate: 48000,
  channels: 2,
  createdAt: "2026-10-20T16:02:11Z",
  device: "Ray-Ban Meta",
});

const proxyArtifact = (projectId: string): Artifact => ({
  key: `proxy-${projectId}`,
  projectId,
  kind: "proxy",
  path: "proxy.mp4",
  meta: { url: `${MEDIA}/proxy.mp4` },
  createdAt: now(),
});

const job = (projectId: string, kind: JobKind, dur: number, params: Record<string, unknown> = {}): Job & { _dur: number } => ({
  id: newId(),
  projectId,
  kind,
  params,
  status: "queued",
  progress: null,
  message: null,
  error: null,
  result: null,
  createdAt: now(),
  startedAt: null,
  finishedAt: null,
  _dur: dur,
});

const seed = (): Db => {
  const id = "demo";
  const p = baseProject(id, "Демо, набережная.mov");
  p.probe = probe();
  p.transcriptRev = 1;
  p.createdAt = "2026-10-20T18:00:00Z";
  const done = (kind: JobKind, result: Record<string, unknown> | null = null) => ({
    ...job(id, kind, 0),
    status: "done" as const,
    progress: 1,
    result,
    startedAt: p.createdAt,
    finishedAt: p.createdAt,
  });
  return {
    uploads: {},
    projects: {
      [id]: {
        project: p,
        artifacts: [proxyArtifact(id)],
        jobs: [done("ingest"), done("analyze"), done("compare", { clips: clips() }), done("asr", { hypothesisId: "hyp-demo" })],
        revisions: [{ rev: 1, doc: sampleDoc(), actor: "asr", createdAt: p.createdAt }],
        urls: { proxy: `${MEDIA}/proxy.mp4`, peaks: null, vad: null },
      },
    },
  };
};

let db: Db = (() => {
  try {
    if (new URLSearchParams(location.search).has("reset")) localStorage.removeItem(KEY);
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Db;
  } catch {
    /* fall through */
  }
  return seed();
})();

const persist = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* quota — mock only */
  }
};

const get = (id: string): MockProject => {
  const p = db.projects[id];
  if (!p) throw new ApiError(404, { error: "not found" });
  return p;
};

const latest = (p: MockProject): TranscriptRevision | null => p.revisions[p.revisions.length - 1] ?? null;

const pushRev = (p: MockProject, doc: TranscriptDoc, actor: TranscriptRevision["actor"]): TranscriptRevision => {
  const rev: TranscriptRevision = { rev: (latest(p)?.rev ?? 0) + 1, doc, actor, createdAt: now() };
  p.revisions.push(rev);
  if (p.revisions.length > 50) p.revisions.splice(0, p.revisions.length - 50);
  p.project.transcriptRev = rev.rev;
  return rev;
};

/** Pretend aligner: keeps existing times, spreads untimed words; 1-char words stay unconfirmed. */
const fakeAlign = (doc: TranscriptDoc, win: AlignWindow) => {
  const all = allWords(doc);
  const byId = new Map(all.map((w, i) => [w.id, i]));
  const times = effectiveTimes(all, DURATION);
  return win.wordIds.map((id) => {
    const i = byId.get(id)!;
    const w = all[i] as Word;
    const t = times[i]!;
    return { start: t.start, end: t.end, status: w.text.replace(/\W/gu, "").length > 1 ? ("aligned" as const) : ("unconfirmed" as const) };
  });
};

const finish = (p: MockProject, j: MockProject["jobs"][number]) => {
  const id = p.project.id;
  switch (j.kind) {
    case "ingest":
      p.project.probe = probe();
      p.artifacts.push(proxyArtifact(id));
      p.urls.proxy = `${MEDIA}/proxy.mp4`;
      break;
    case "compare": {
      const custom = (j.params.excerpts as unknown[] | undefined)?.find((e) => typeof e === "object") as
        | { startMs: number; endMs: number }
        | undefined;
      const base = clips();
      j.result = {
        clips: custom
          ? [{ ...base[0]!, excerpt: "custom", startMs: custom.startMs, endMs: custom.startMs + 10_000 }, ...base]
          : base,
      };
      break;
    }
    case "asr":
      if (!latest(p)) pushRev(p, sampleDoc(), "asr");
      j.result = { hypothesisId: "hyp-demo" };
      break;
    case "align": {
      let doc = latest(p)!.doc;
      let applied = false;
      for (const win of j.params.windows as AlignWindow[]) {
        const next = applyAlignment(doc, win, fakeAlign(doc, win));
        if (next) {
          doc = next;
          applied = true;
        }
      }
      if (applied) pushRev(p, doc, "align");
      break;
    }
    case "cover": {
      const format = j.params.format === "youtube" ? "youtube" : "vertical";
      const part = j.params.part as { index: number; total: number } | undefined;
      const [w, h] = format === "youtube" ? [1280, 720] : [1080, 1920];
      p.artifacts.push({
        key: newId(),
        projectId: id,
        kind: "cover",
        path: `covers/${format}.jpg`,
        meta: {
          output: "cover",
          format,
          atMs: j.params.atMs,
          part: part ?? null,
          title: p.project.settings.cover.title,
          width: w,
          height: h,
          bytes: 412_000,
          url: placeholder(`обложка ${part ? `${part.index + 1}/${part.total}` : ""}`, w / 6, h / 6),
          fileName: `cover-${format}.jpg`,
        },
        createdAt: now(),
      });
      break;
    }
    case "render": {
      const outputs = j.params.outputs as string[];
      const rev = latest(p);
      const { style, series } = p.project.settings;
      const base = p.project.name.replace(/\.[^.]+$/, "");
      // Same plan as the server (core.resolveCuts); mock has no VAD.
      const ranges = j.params.series
        ? seriesParts(resolveCuts(series, seriesWords(rev?.doc ?? null, DURATION), [], DURATION).cuts, DURATION, series.overlapMs)
        : [{ startMs: 0, endMs: DURATION }];
      const multi = ranges.length > 1;
      ranges.forEach((r, index) => {
        const cues = !rev ? [] : multi ? compilePartCues(rev.doc, style, DURATION, r) : compileCues(rev.doc, style, DURATION);
        const tag = multi ? `_p${index + 1}of${ranges.length}` : "";
        for (const o of outputs) {
          const text = o === "srt" ? toSrt(cues) : o === "vtt" ? toVtt(cues) : null;
          p.artifacts.push({
            key: newId(),
            projectId: id,
            kind: text === null ? "render" : "subs",
            path: `renders/${o}${tag}.${text === null ? "mp4" : o}`,
            meta: {
              output: o,
              url: text === null ? `${MEDIA}/proxy.mp4` : `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
              fileName: `${base}-${o}${tag}.${text === null ? "mp4" : o}`,
              bytes: text === null ? Math.round((20_579_413 * (r.endMs - r.startMs)) / DURATION) : text.length,
              transcriptRev: rev?.rev ?? 0,
              ...(multi ? { part: { index, total: ranges.length, ...r, destination: series.destination, manual: false } } : {}),
            },
            createdAt: now(),
          });
        }
      });
      break;
    }
  }
};

const mockKeys: AuthKey[] = [];
const passkeysOff = (): never => {
  throw new ApiError(400, { error: "passkeys are off: mock API" });
};
const mockLinks: LinkStats = { issued: 3, rotatedAt: null, lastExpiresAt: new Date(Date.now() + 3_600_000).toISOString() };

const placeholder = (label: string, w: number, h: number) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#3a3f47"/><text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(w / 6)}" text-anchor="middle">${label}</text></svg>`,
  )}`;

/** Advance simulated jobs: one at a time per project, FIFO. */
const tick = () => {
  const t = Date.now();
  for (const p of Object.values(db.projects)) {
    for (;;) {
      const running = p.jobs.find((j) => j.status === "running");
      const j = running ?? p.jobs.find((x) => x.status === "queued");
      if (!j) break;
      if (!running) {
        j.status = "running";
        j.startedAt = new Date(t).toISOString();
      }
      const elapsed = t - Date.parse(j.startedAt!);
      if (elapsed < j._dur) {
        j.progress = Math.min(0.99, elapsed / j._dur);
        j.message = j.kind === "asr" ? "turbo · ru" : null;
        break;
      }
      j.status = "done";
      j.progress = 1;
      j.finishedAt = new Date(Date.parse(j.startedAt!) + j._dur).toISOString();
      finish(p, j);
    }
  }
  persist();
};

const view = (p: MockProject): ProjectView => ({
  project: p.project,
  artifacts: p.artifacts,
  jobs: [...p.jobs].reverse().slice(0, 30),
  transcript: latest(p),
  hypotheses: p.revisions.length ? [{ id: "hyp-demo", provider: "faster-whisper", model: "large-v3-turbo", lang: "ru", createdAt: p.project.createdAt }] : [],
  urls: p.urls,
});

const summary = (p: MockProject): ProjectSummary => {
  const render = [...p.artifacts].reverse().find((a) => a.kind === "render");
  return {
    project: p.project,
    thumbnailUrl: p.urls.proxy ? `${MEDIA}/thumb.jpg` : null,
    busy: p.jobs.some((j) => j.status === "queued" || j.status === "running"),
    hasTranscript: p.revisions.length > 0,
    lastRenderUrl: render ? String(render.meta.url) : null,
  };
};

const respond = async <T>(fn: () => T, ms = 120): Promise<T> => {
  await wait(ms);
  tick();
  const out = fn();
  persist();
  return clone(out);
};

const checkRev = (p: MockProject, baseRev: number) => {
  const cur = latest(p);
  if ((cur?.rev ?? 0) !== baseRev) throw new ApiError(409, { error: "stale", current: clone(cur) });
};

const sameDoc = (a: TranscriptDoc, b: TranscriptDoc) => JSON.stringify(a) === JSON.stringify(b);

export const mockApi: Api = {
  listProjects: () =>
    respond(() =>
      Object.values(db.projects)
        .filter((p) => !p.project.archived)
        .sort((a, b) => b.project.createdAt.localeCompare(a.project.createdAt))
        .map(summary),
    ),
  getProject: (id) => respond(() => view(get(id)), 60),
  patchProject: (id, req) =>
    respond(() => {
      const p = get(id);
      if (req.name !== undefined) p.project.name = req.name;
      if (req.archived !== undefined) p.project.archived = req.archived;
      const s = req.settings;
      if (s?.audio) p.project.settings.audio = { ...p.project.settings.audio, ...s.audio };
      if (s?.framing) p.project.settings.framing = { ...p.project.settings.framing, ...s.framing };
      if (s?.style) p.project.settings.style = { ...p.project.settings.style, ...s.style };
      // Mock projects saved before series/covers existed.
      p.project.settings.series = { ...DEFAULT_SERIES, ...p.project.settings.series, ...s?.series };
      p.project.settings.cover = { ...DEFAULT_COVER, ...p.project.settings.cover, ...s?.cover };
      return view(p);
    }),
  deleteProject: (id) =>
    respond(() => {
      delete db.projects[id];
    }),

  createUpload: (req) =>
    respond(() => {
      const u: UploadState = { id: newId(), name: req.name, size: req.size, received: 0 };
      db.uploads[u.id] = u;
      return u;
    }),
  getUpload: (id) =>
    respond(() => {
      const u = db.uploads[id];
      if (!u) throw new ApiError(404, { error: "upload not found" });
      return u;
    }),
  putChunk: (id, offset, chunk) =>
    respond(() => {
      const u = db.uploads[id];
      if (!u) throw new ApiError(404, { error: "upload not found" });
      if (offset !== u.received) throw new ApiError(409, { error: "offset", received: u.received });
      u.received = Math.min(u.size, u.received + chunk.size);
      return u;
    }, 250),
  completeUpload: (id) =>
    respond(() => {
      const u = db.uploads[id];
      if (!u || u.received < u.size) throw new ApiError(409, { error: "incomplete" });
      delete db.uploads[id];
      const pid = newId();
      const p: MockProject = {
        project: baseProject(pid, u.name),
        artifacts: [],
        jobs: [],
        revisions: [],
        urls: { proxy: null, peaks: null, vad: null },
      };
      p.jobs.push(job(pid, "ingest", 5000), job(pid, "analyze", 2000), job(pid, "compare", 4000), job(pid, "asr", 7000, { seed: true }));
      db.projects[pid] = p;
      return view(p);
    }),

  getTranscript: (id) => respond(() => latest(get(id))),
  saveTranscript: (id, req) =>
    respond(() => {
      const p = get(id);
      checkRev(p, req.baseRev);
      const prev = latest(p)?.doc ?? { paragraphs: [] };
      const { doc, changed } = reconcile(prev, req.paragraphs);
      if (sameDoc(doc, prev)) return { revision: latest(p)!, changed: [], alignJobId: null };
      const revision = pushRev(p, doc, "user");
      let alignJobId: string | null = null;
      if (changed.length) {
        const j = job(id, "align", 1500, { windows: alignmentWindows(doc, changed, { durationMs: DURATION }) });
        p.jobs.push(j);
        alignJobId = j.id;
      }
      return { revision, changed, alignJobId };
    }, 200),
  transcriptOps: (id, req) =>
    respond(() => {
      const p = get(id);
      checkRev(p, req.baseRev);
      const doc = clone(latest(p)!.doc);
      const byId = new Map(allWords(doc).map((w) => [w.id, w]));
      const changed: string[] = [];
      for (const op of req.ops) {
        if (op.kind === "set_timing") {
          const w = byId.get(op.wordId);
          if (w) Object.assign(w, { start: op.start, end: op.end, timing: "manual" });
        } else if (op.kind === "clear_manual") {
          const w = byId.get(op.wordId);
          if (w) {
            w.timing = "preliminary";
            changed.push(w.id);
          }
        } else if (op.kind === "set_hidden") {
          for (const id of op.wordIds) {
            const w = byId.get(id);
            if (w) w.hidden = op.hidden || undefined;
          }
        } else if (op.kind === "set_review") {
          for (const id of op.wordIds) {
            const w = byId.get(id);
            if (w) w.review = op.review;
          }
        }
      }
      return { revision: pushRev(p, doc, "user"), changed, alignJobId: null };
    }),

  startAsr: (id, req) =>
    respond(() => {
      const p = get(id);
      const j = job(id, "asr", 6000, { ...req });
      p.jobs.push(j);
      return j;
    }),
  startCompare: (id, req) =>
    respond(() => {
      const p = get(id);
      const j = job(id, "compare", 3500, { ...req, audio: p.project.settings.audio });
      p.jobs.push(j);
      return j;
    }),
  startRender: (id, req) =>
    respond(() => {
      const p = get(id);
      const j = job(id, "render", 6000, { ...req });
      p.jobs.push(j);
      return j;
    }),
  startCover: (id, req) =>
    respond(() => {
      const p = get(id);
      const j = job(id, "cover", 1200, { ...req, format: req.format ?? "vertical" });
      p.jobs.push(j);
      return j;
    }),
  coverSuggestions: (_id, startMs, endMs) =>
    respond(() => ({ suggestions: [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => Math.round(startMs + f * (endMs - startMs))), fps: 4 })),
  frameUrl: (_id, atMs) => placeholder(`${(atMs / 1000).toFixed(1)} с`, 180, 320),
  authMe: () => respond(() => ({ required: false, authenticated: true, via: "local" as const, name: null })),
  login: () => respond(() => undefined),
  logout: () => respond(() => undefined),
  listKeys: () => respond(() => mockKeys.filter(Boolean)),
  createKey: (name) =>
    respond(() => {
      const key = { id: newId(), kind: "device" as const, name, createdAt: now(), lastUsedAt: null, revokedAt: null };
      mockKeys.unshift(key);
      return { ...key, secret: `tk_mock_${newId()}` };
    }),
  revokeKey: (id) =>
    respond(() => {
      const k = mockKeys.find((x) => x.id === id);
      if (!k) throw new ApiError(404, { error: "key not found" });
      k.revokedAt = now();
      return k;
    }),
  passkeyStatus: () => respond(() => ({ enabled: false, reason: "mock API" })),
  passkeyRegisterOptions: () => respond(passkeysOff),
  passkeyRegister: () => respond(passkeysOff),
  passkeyLoginOptions: () => respond(passkeysOff),
  passkeyLogin: () => respond(passkeysOff),
  linkStats: () => respond(() => ({ ...mockLinks })),
  rotateLinks: () => respond(() => Object.assign(mockLinks, { issued: 0, rotatedAt: now(), lastExpiresAt: null })),
  cancelJob: (jobId) =>
    respond(() => {
      for (const p of Object.values(db.projects)) {
        const j = p.jobs.find((x) => x.id === jobId);
        if (j) {
          if (j.status === "queued" || j.status === "running") {
            j.status = "cancelled";
            j.finishedAt = now();
          }
          return j;
        }
      }
      throw new ApiError(404, { error: "job not found" });
    }),
};
