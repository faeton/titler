import type { Artifact, CompareClip, Job, JobKind, ProjectSummary, ProjectView } from "@titler/core";

// Small read helpers over ProjectView. Some shapes are not pinned down by the
// contract yet (where compare clips and render outputs live), so these accept
// a few reasonable layouts — see the proposals in the web README section of
// the final report.

export const isActive = (j: Job) => j.status === "queued" || j.status === "running";

export const activeJobs = (view: ProjectView | null): Job[] => (view ? view.jobs.filter(isActive) : []);

export const JOB_LABEL: Record<JobKind, string> = {
  ingest: "Подготовка видео",
  analyze: "Анализ звука",
  enhance: "Очистка звука",
  compare: "Варианты звука",
  asr: "Распознавание",
  align: "Выравнивание",
  render: "Экспорт",
};

export const latestJob = (view: ProjectView | null, kind: JobKind): Job | undefined =>
  view?.jobs
    .filter((j) => j.kind === kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** URL of an artifact file. Prefers meta.url, else /api/artifacts/:key[/:file]. */
export const artifactUrl = (a: Artifact): string =>
  str(a.meta.url) ?? `/api/artifacts/${encodeURIComponent(a.key)}${str(a.meta.file) ? `/${encodeURIComponent(a.meta.file as string)}` : ""}`;

const isClip = (c: unknown): c is CompareClip =>
  !!c && typeof c === "object" && "variants" in c && typeof (c as CompareClip).startMs === "number";

/** Comparison clips: view.compare (proposed) → newest done compare job result.clips → artifact meta. */
export const compareClips = (view: ProjectView | null): CompareClip[] => {
  if (!view) return [];
  const direct = view.compare;
  if (Array.isArray(direct) && direct.length && direct.every(isClip)) return direct;
  const done = view.jobs
    .filter((j) => j.kind === "compare" && j.status === "done")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const j of done) {
    const clips = j.result?.clips;
    if (Array.isArray(clips) && clips.every(isClip)) return clips;
  }
  // Fallback: compare_clip artifacts with meta { excerpt, startMs, endMs, preset }.
  const byExcerpt = new Map<string, CompareClip>();
  for (const a of view.artifacts.filter((x) => x.kind === "compare_clip")) {
    const excerpt = str(a.meta.excerpt) ?? "clip";
    const preset = str(a.meta.preset);
    if (!preset) continue;
    const c = byExcerpt.get(excerpt) ?? {
      excerpt,
      startMs: Number(a.meta.startMs ?? 0),
      endMs: Number(a.meta.endMs ?? 0),
      variants: {},
    };
    c.variants[preset] = artifactUrl(a);
    byExcerpt.set(excerpt, c);
  }
  return [...byExcerpt.values()];
};

export type OutputKind = "captioned" | "clean" | "srt" | "vtt";

export interface RenderOutput {
  kind: OutputKind | "other";
  url: string;
  fileName: string;
  createdAt: string;
  bytes: number | null;
  /** Transcript revision the render was made from (meta.transcriptRev), if known. */
  transcriptRev: number | null;
}

const kindOf = (a: Artifact): RenderOutput["kind"] => {
  const o = str(a.meta.output);
  if (o === "captioned" || o === "clean" || o === "srt" || o === "vtt") return o;
  const p = a.path.toLowerCase();
  if (p.endsWith(".srt")) return "srt";
  if (p.endsWith(".vtt")) return "vtt";
  if (a.kind === "render") return /clean/.test(p) ? "clean" : "captioned";
  return "other";
};

export const renderOutputs = (view: ProjectView | null): RenderOutput[] => {
  if (!view) return [];
  const base = view.project.name.replace(/\.[^.]+$/, "");
  const arts = view.artifacts
    .filter((a) => a.kind === "render" || a.kind === "subs")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    // The server stores SRT and VTT in one "subs" artifact (meta.vtt = sibling file).
    .flatMap((a) =>
      a.kind === "subs" && str(a.meta.vtt) && !str(a.meta.output)
        ? [{ ...a, meta: { ...a.meta, output: "srt" } }, { ...a, path: a.meta.vtt as string, meta: { ...a.meta, output: "vtt", file: a.meta.vtt } }]
        : [a],
    );
  return arts.map((a) => {
      const kind = kindOf(a);
      const ext = kind === "srt" ? "srt" : kind === "vtt" ? "vtt" : "mp4";
      const suffix = kind === "captioned" ? "subs" : kind === "clean" ? "clean" : kind;
      return {
        kind,
        url: artifactUrl(a),
        fileName: str(a.meta.fileName) ?? (a.path.split("/").pop() || `${base}-${suffix}.${ext}`),
        createdAt: a.createdAt,
        bytes: typeof a.meta.bytes === "number" ? a.meta.bytes : null,
        transcriptRev: typeof a.meta.transcriptRev === "number" ? a.meta.transcriptRev : null,
      };
  });
};

export type ProjectState = "processing" | "ready" | "exported" | "new";

export const summaryState = (s: ProjectSummary): ProjectState =>
  s.busy ? "processing" : s.lastRenderUrl ? "exported" : s.hasTranscript ? "ready" : "new";

export const STATE_LABEL: Record<ProjectState, string> = {
  processing: "обработка",
  ready: "готово к правке",
  exported: "есть экспорт",
  new: "ждёт распознавания",
};
