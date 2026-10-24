// HTTP contract between apps/web and apps/server. All routes are under /api.
// Times are integer ms. Errors: non-2xx with { error: string, ...extra }.

import type { EditedParagraph } from "./transcript.js";
import type {
  Artifact,
  AsrHypothesis,
  Job,
  Ms,
  Project,
  ProjectSettings,
  ReviewStatus,
  TranscriptRevision,
} from "./types.js";

// ---- Uploads (resumable, phone-friendly) ------------------------------------
// POST   /api/uploads                 CreateUploadReq → UploadState
// GET    /api/uploads/:id             → UploadState            (resume: continue from `received`)
// PUT    /api/uploads/:id?offset=N    raw bytes (application/octet-stream) → UploadState
//                                     409 { error, received } if offset !== received
// POST   /api/uploads/:id/complete    → ProjectView            (dedupes by sha256: returns the
//                                     existing project if the same file was uploaded before)

export interface CreateUploadReq {
  name: string;
  size: number;
  /** Optional client-side hint, e.g. File.lastModified as ISO. */
  lastModified?: string;
}

export interface UploadState {
  id: string;
  name: string;
  size: number;
  received: number;
}

// ---- Projects ---------------------------------------------------------------
// GET    /api/projects                → ProjectSummary[]  (newest first, archived excluded unless ?archived=1)
// GET    /api/projects/:id            → ProjectView
// PATCH  /api/projects/:id            PatchProjectReq → ProjectView
// DELETE /api/projects/:id            → { ok: true }
// GET    /api/projects/:id/source     original bytes (Range supported)

export interface ProjectSummary {
  project: Project;
  thumbnailUrl: string | null;
  busy: boolean; // any queued/running job
  hasTranscript: boolean;
  lastRenderUrl: string | null;
}

export interface ProjectView {
  project: Project;
  artifacts: Artifact[];
  /** Queued/running jobs plus the 20 most recent finished ones. */
  jobs: Job[];
  transcript: TranscriptRevision | null;
  hypotheses: Pick<AsrHypothesis, "id" | "provider" | "model" | "lang" | "createdAt">[];
  /** Convenience URLs (null until produced). */
  urls: {
    proxy: string | null;
    peaks: string | null;
    vad: string | null;
    thumbnail?: string | null;
  };
  /** Latest finished compare result, if any. */
  compare?: CompareClip[] | null;
}

export interface PatchProjectReq {
  name?: string;
  archived?: boolean;
  /** Shallow-merged per section (audio / framing / style). */
  settings?: { [K in keyof ProjectSettings]?: Partial<ProjectSettings[K]> };
}

// ---- Transcript -------------------------------------------------------------
// GET  /api/projects/:id/transcript             → TranscriptRevision | null
// GET  /api/projects/:id/transcript/revisions   → { rev, actor, createdAt }[]
// GET  /api/projects/:id/transcript/:rev        → TranscriptRevision
// PUT  /api/projects/:id/transcript             SaveTranscriptReq → SaveTranscriptRes
//      409 { error: "stale", current: TranscriptRevision } when a *user/asr/llm* revision
//      landed after baseRev. Revisions written only by the aligner don't make a save
//      stale: the server reconciles against the latest doc and keeps their timings.
// POST /api/projects/:id/transcript/ops         TranscriptOpsReq → SaveTranscriptRes
//
// Saving text re-tokenises (core.reconcile) and schedules local alignment for
// the changed words; the aligner writes a new revision only if those words are
// unchanged by then (core.applyAlignment).

export interface SaveTranscriptReq {
  baseRev: number;
  paragraphs: EditedParagraph[];
}

export interface SaveTranscriptRes {
  revision: TranscriptRevision;
  changed: string[];
  alignJobId: string | null;
}

export type TranscriptOp =
  | { kind: "set_timing"; wordId: string; start: Ms; end: Ms } // → timing "manual"
  | { kind: "clear_manual"; wordId: string } // back to preliminary, realign
  | { kind: "set_hidden"; wordIds: string[]; hidden: boolean }
  | { kind: "set_review"; wordIds: string[]; review: ReviewStatus };

export interface TranscriptOpsReq {
  baseRev: number;
  ops: TranscriptOp[];
}

// ---- Processing ---------------------------------------------------------------
// POST /api/projects/:id/asr        StartAsrReq → Job
// GET  /api/projects/:id/hypotheses → AsrHypothesis[]
// POST /api/projects/:id/compare    StartCompareReq → Job   (loudness-matched excerpts per preset)
// POST /api/projects/:id/render     StartRenderReq → Job
// GET  /api/providers               → ProviderInfo[]
// GET  /api/jobs?projectId=&active=1 → Job[]
// POST /api/jobs/:id/cancel         → Job
// GET  /api/artifacts/:key[/:file]  artifact bytes (Range supported)
// GET  /api/fonts/:file             caption fonts (same files libass uses)

export interface StartAsrReq {
  provider?: string; // default: configured primary
  model?: string;
  /** "Seed" fills an empty transcript; otherwise the result is only stored as a hypothesis. */
  seed?: boolean;
}

export interface StartCompareReq {
  /** Which excerpts; default all detected (calm, noisy, voices). */
  excerpts?: ("calm" | "noisy" | "voices" | { startMs: Ms; endMs: Ms })[];
}

export interface CompareClip {
  excerpt: string;
  startMs: Ms;
  endMs: Ms;
  /** preset → artifact url, all loudness-normalised to the same LUFS. */
  variants: Record<string, string>;
}

export interface StartRenderReq {
  outputs: ("captioned" | "clean" | "srt" | "vtt")[];
}

export interface ProviderInfo {
  id: string;
  kind: "asr" | "review";
  local: boolean;
  enabled: boolean;
  reason?: string; // why disabled (e.g. "ELEVENLABS_API_KEY not set")
  models: string[];
  wordTimestamps: boolean;
}
