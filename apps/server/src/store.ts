import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUDIO,
  DEFAULT_FRAMING,
  DEFAULT_STYLE,
  type Artifact,
  type ArtifactKind,
  type AsrHypothesis,
  type Job,
  type JobKind,
  type JobStatus,
  type Probe,
  type Project,
  type ProjectSettings,
  type TranscriptDoc,
  type TranscriptRevision,
} from "@titler/core";
import { tx, type Db } from "./db.js";

export const newId = (): string => randomUUID().replace(/-/g, "").slice(0, 16);
export const now = (): string => new Date().toISOString();

const json = <T>(s: unknown, fallback: T): T => (typeof s === "string" ? (JSON.parse(s) as T) : fallback);

type Row = Record<string, unknown>;

export interface ProjectRow extends Project {
  sourcePath: string; // relative to data dir
}

export interface UploadRow {
  id: string;
  name: string;
  size: number;
  received: number;
  lastModified: string | null;
  path: string;
  createdAt: string;
}

export interface JobRow extends Job {
  resourceClass: string;
  priority: number;
  attempts: number;
}

export interface HypothesisRow extends AsrHypothesis {
  projectId: string;
  params: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export const defaultSettings = (): ProjectSettings => ({
  audio: { ...DEFAULT_AUDIO },
  framing: { ...DEFAULT_FRAMING, keyframes: [] },
  style: { ...DEFAULT_STYLE },
});

const toProject = (r: Row): ProjectRow => ({
  id: r.id as string,
  name: r.name as string,
  createdAt: r.created_at as string,
  sourceSha256: r.source_sha256 as string,
  sourceName: r.source_name as string,
  sourcePath: r.source_path as string,
  probe: json<Probe | null>(r.probe_json, null),
  settings: { ...defaultSettings(), ...json<Partial<ProjectSettings>>(r.settings_json, {}) },
  transcriptRev: Number(r.transcript_rev),
  archived: Boolean(r.archived),
});

const toArtifact = (r: Row): Artifact => ({
  key: r.key as string,
  projectId: r.project_id as string,
  kind: r.kind as ArtifactKind,
  path: r.path as string,
  meta: json(r.meta_json, {}),
  createdAt: r.created_at as string,
});

const toJob = (r: Row): JobRow => ({
  id: r.id as string,
  projectId: r.project_id as string,
  kind: r.kind as JobKind,
  params: json(r.params_json, {}),
  status: r.status as JobStatus,
  progress: r.progress === null ? null : Number(r.progress),
  message: (r.message as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  result: json(r.result_json, null),
  createdAt: r.created_at as string,
  startedAt: (r.started_at as string | null) ?? null,
  finishedAt: (r.finished_at as string | null) ?? null,
  resourceClass: r.resource_class as string,
  priority: Number(r.priority),
  attempts: Number(r.attempts),
});

const toUpload = (r: Row): UploadRow => ({
  id: r.id as string,
  name: r.name as string,
  size: Number(r.size),
  received: Number(r.received),
  lastModified: (r.last_modified as string | null) ?? null,
  path: r.path as string,
  createdAt: r.created_at as string,
});

const toHyp = (r: Row): HypothesisRow => ({
  id: r.id as string,
  projectId: r.project_id as string,
  provider: r.provider as string,
  model: r.model as string,
  audioKey: r.audio_key as string,
  lang: (r.lang as string | null) ?? null,
  words: json(r.words_json, []),
  params: json(r.params_json, {}),
  meta: json(r.meta_json, {}),
  createdAt: r.created_at as string,
});

export class Store {
  constructor(readonly db: Db) {}

  tx<T>(fn: () => T): T {
    return tx(this.db, fn);
  }

  // ---- projects ----
  createProject(p: { name: string; sourceSha256: string; sourceName: string; sourcePath: string }): ProjectRow {
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO projects (id, name, created_at, source_sha256, source_name, source_path, settings_json) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, p.name, now(), p.sourceSha256, p.sourceName, p.sourcePath, JSON.stringify(defaultSettings()));
    return this.getProject(id)!;
  }

  getProject(id: string): ProjectRow | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return r ? toProject(r) : null;
  }

  projectBySha(sha: string): ProjectRow | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE source_sha256 = ?").get(sha) as Row | undefined;
    return r ? toProject(r) : null;
  }

  listProjects(includeArchived: boolean): ProjectRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM projects ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY created_at DESC`)
      .all() as Row[];
    return rows.map(toProject);
  }

  updateProject(id: string, patch: { name?: string; archived?: boolean; probe?: Probe; settings?: ProjectSettings }): void {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (patch.name !== undefined) (sets.push("name = ?"), vals.push(patch.name));
    if (patch.archived !== undefined) (sets.push("archived = ?"), vals.push(patch.archived ? 1 : 0));
    if (patch.probe !== undefined) (sets.push("probe_json = ?"), vals.push(JSON.stringify(patch.probe)));
    if (patch.settings !== undefined) (sets.push("settings_json = ?"), vals.push(JSON.stringify(patch.settings)));
    if (!sets.length) return;
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  deleteProject(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  // ---- uploads ----
  createUpload(u: { name: string; size: number; lastModified: string | null; path: string; id?: string }): UploadRow {
    const id = u.id ?? newId();
    this.db
      .prepare("INSERT INTO uploads (id, name, size, received, last_modified, path, created_at) VALUES (?,?,?,0,?,?,?)")
      .run(id, u.name, u.size, u.lastModified, u.path, now());
    return this.getUpload(id)!;
  }

  getUpload(id: string): UploadRow | null {
    const r = this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as Row | undefined;
    return r ? toUpload(r) : null;
  }

  setUploadReceived(id: string, received: number): void {
    this.db.prepare("UPDATE uploads SET received = ? WHERE id = ?").run(received, id);
  }

  deleteUpload(id: string): void {
    this.db.prepare("DELETE FROM uploads WHERE id = ?").run(id);
  }

  // ---- artifacts ----
  getArtifact(key: string): Artifact | null {
    const r = this.db.prepare("SELECT * FROM artifacts WHERE key = ?").get(key) as Row | undefined;
    return r ? toArtifact(r) : null;
  }

  putArtifact(a: Omit<Artifact, "createdAt">): Artifact {
    this.db
      .prepare(
        "INSERT INTO artifacts (key, project_id, kind, path, meta_json, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET path = excluded.path, meta_json = excluded.meta_json",
      )
      .run(a.key, a.projectId, a.kind, a.path, JSON.stringify(a.meta), now());
    return this.getArtifact(a.key)!;
  }

  listArtifacts(projectId: string, kind?: ArtifactKind): Artifact[] {
    const rows = (
      kind
        ? this.db.prepare("SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY created_at, rowid").all(projectId, kind)
        : this.db.prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at, rowid").all(projectId)
    ) as Row[];
    return rows.map(toArtifact);
  }

  deleteArtifact(key: string): void {
    this.db.prepare("DELETE FROM artifacts WHERE key = ?").run(key);
  }

  // ---- transcript ----
  latestRevision(projectId: string): TranscriptRevision | null {
    const r = this.db
      .prepare("SELECT * FROM transcript_revs WHERE project_id = ? ORDER BY rev DESC LIMIT 1")
      .get(projectId) as Row | undefined;
    return r ? this.toRev(r) : null;
  }

  getRevision(projectId: string, rev: number): TranscriptRevision | null {
    const r = this.db.prepare("SELECT * FROM transcript_revs WHERE project_id = ? AND rev = ?").get(projectId, rev) as
      | Row
      | undefined;
    return r ? this.toRev(r) : null;
  }

  listRevisions(projectId: string): { rev: number; actor: string; createdAt: string }[] {
    const rows = this.db
      .prepare("SELECT rev, actor, created_at FROM transcript_revs WHERE project_id = ? ORDER BY rev")
      .all(projectId) as Row[];
    return rows.map((r) => ({ rev: Number(r.rev), actor: r.actor as string, createdAt: r.created_at as string }));
  }

  /** Actors of revisions newer than `rev`. */
  actorsAfter(projectId: string, rev: number): string[] {
    const rows = this.db
      .prepare("SELECT actor FROM transcript_revs WHERE project_id = ? AND rev > ? ORDER BY rev")
      .all(projectId, rev) as Row[];
    return rows.map((r) => r.actor as string);
  }

  /** Appends a revision; the caller must hold a transaction if it read state first. */
  addRevision(projectId: string, doc: TranscriptDoc, actor: TranscriptRevision["actor"]): TranscriptRevision {
    return this.tx(() => {
      const cur = this.latestRevision(projectId);
      const rev = (cur?.rev ?? 0) + 1;
      this.db
        .prepare("INSERT INTO transcript_revs (project_id, rev, doc_json, actor, created_at) VALUES (?,?,?,?,?)")
        .run(projectId, rev, JSON.stringify(doc), actor, now());
      this.db.prepare("UPDATE projects SET transcript_rev = ? WHERE id = ?").run(rev, projectId);
      return this.getRevision(projectId, rev)!;
    });
  }

  private toRev(r: Row): TranscriptRevision {
    return {
      rev: Number(r.rev),
      doc: JSON.parse(r.doc_json as string) as TranscriptDoc,
      actor: r.actor as TranscriptRevision["actor"],
      createdAt: r.created_at as string,
    };
  }

  // ---- hypotheses ----
  addHypothesis(h: Omit<HypothesisRow, "id" | "createdAt">): HypothesisRow {
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO hypotheses (id, project_id, provider, model, audio_key, params_json, lang, words_json, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, h.projectId, h.provider, h.model, h.audioKey, JSON.stringify(h.params), h.lang, JSON.stringify(h.words), JSON.stringify(h.meta), now());
    return this.getHypothesis(id)!;
  }

  getHypothesis(id: string): HypothesisRow | null {
    const r = this.db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(id) as Row | undefined;
    return r ? toHyp(r) : null;
  }

  findHypothesis(projectId: string, audioKey: string, provider: string, params: Record<string, unknown>): HypothesisRow | null {
    const r = this.db
      .prepare(
        "SELECT * FROM hypotheses WHERE project_id = ? AND audio_key = ? AND provider = ? AND params_json = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId, audioKey, provider, JSON.stringify(params)) as Row | undefined;
    return r ? toHyp(r) : null;
  }

  listHypotheses(projectId: string): HypothesisRow[] {
    return (this.db.prepare("SELECT * FROM hypotheses WHERE project_id = ? ORDER BY created_at").all(projectId) as Row[]).map(toHyp);
  }

  // ---- jobs ----
  createJob(j: { projectId: string; kind: JobKind; resourceClass: string; params: Record<string, unknown>; priority?: number }): JobRow {
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO jobs (id, project_id, kind, resource_class, priority, params_json, status, created_at) VALUES (?,?,?,?,?,?,'queued',?)",
      )
      .run(id, j.projectId, j.kind, j.resourceClass, j.priority ?? 0, JSON.stringify(j.params), now());
    return this.getJob(id)!;
  }

  getJob(id: string): JobRow | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? toJob(r) : null;
  }

  listJobs(filter: { projectId?: string; active?: boolean; limit?: number }): JobRow[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (filter.projectId) (where.push("project_id = ?"), vals.push(filter.projectId));
    if (filter.active) where.push("status IN ('queued','running')");
    const sql = `SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC ${filter.limit ? `LIMIT ${Number(filter.limit)}` : ""}`;
    return (this.db.prepare(sql).all(...vals) as Row[]).map(toJob);
  }

  /** Queued/running jobs plus the N most recent finished ones. */
  projectJobs(projectId: string, recent = 20): JobRow[] {
    const active = this.listJobs({ projectId, active: true });
    const done = (
      this.db
        .prepare("SELECT * FROM jobs WHERE project_id = ? AND status NOT IN ('queued','running') ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(projectId, recent) as Row[]
    ).map(toJob);
    return [...active, ...done];
  }

  nextQueued(resourceClass: string, exclude: Set<string>): JobRow | null {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' AND resource_class = ? ORDER BY priority DESC, created_at, rowid LIMIT 50")
      .all(resourceClass) as Row[];
    for (const r of rows) if (!exclude.has(r.id as string)) return toJob(r);
    return null;
  }

  queuedClasses(): string[] {
    return (this.db.prepare("SELECT DISTINCT resource_class FROM jobs WHERE status = 'queued'").all() as Row[]).map(
      (r) => r.resource_class as string,
    );
  }

  markRunning(id: string): boolean {
    const res = this.db
      .prepare("UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1, progress = NULL, message = NULL WHERE id = ? AND status = 'queued'")
      .run(now(), id);
    return Number(res.changes) === 1;
  }

  updateJobProgress(id: string, progress: number | null, message: string | null): void {
    this.db
      .prepare("UPDATE jobs SET progress = COALESCE(?, progress), message = COALESCE(?, message) WHERE id = ? AND status = 'running'")
      .run(progress, message, id);
  }

  finishJob(id: string, status: Extract<JobStatus, "done" | "error" | "cancelled">, out: { result?: unknown; error?: string }): void {
    this.db
      .prepare("UPDATE jobs SET status = ?, finished_at = ?, result_json = ?, error = ?, progress = CASE WHEN ? = 'done' THEN 1 ELSE progress END WHERE id = ?")
      .run(status, now(), out.result === undefined ? null : JSON.stringify(out.result), out.error ?? null, status, id);
  }

  cancelQueued(id: string): boolean {
    const res = this.db
      .prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'")
      .run(now(), id);
    return Number(res.changes) === 1;
  }

  /** Server start: anything left running by a previous process goes back to the queue. */
  requeueRunning(): number {
    const res = this.db
      .prepare("UPDATE jobs SET status = 'queued', started_at = NULL, message = 'requeued after restart' WHERE status = 'running'")
      .run();
    return Number(res.changes);
  }
}
