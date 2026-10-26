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
  /** Shallow-merged per section (audio / framing / style / series / cover). */
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
  /**
   * Render the series plan of settings.series (one artifact per part, «1/3»
   * badge per numbering). The job result then has `series.parts`
   * (RenderPartResult[]); a plan with no cuts renders the whole clip.
   */
  series?: boolean;
}

export interface RenderPartResult {
  index: number;
  total: number;
  startMs: Ms;
  endMs: Ms;
  /** output kind → artifact url */
  outputs: Record<string, string>;
  badge: string | null;
}

// ---- Covers -----------------------------------------------------------------------
// POST /api/projects/:id/cover               StartCoverReq → Job (result { url, key, format, atMs, part, bytes })
// GET  /api/projects/:id/cover/suggestions?startMs=&endMs=  → CoverSuggestions
// GET  /api/projects/:id/frame/:ms.jpg       small proxy frame (suggestion thumbnails)
//
// The cover is taken from the source (not the proxy) with the project's
// framing, title from settings.cover, «1/3» badge for series parts.

export interface StartCoverReq {
  atMs: Ms;
  /** "vertical" 1080×1920 (Reels / Shorts) or "youtube" 1280×720. */
  format?: "vertical" | "youtube";
  /** Series part the cover is for (badge text); omit for a whole-clip cover. */
  part?: { index: number; total: number };
  /** As shown in the preview; default settings.cover (the debounced settings PATCH may not have landed yet). */
  title?: string | null;
  badge?: boolean;
}

export interface CoverSuggestions {
  /** Suggested frame times, source ms, sorted. */
  suggestions: Ms[];
  /** Scan rate the sharpness was measured at. */
  fps: number;
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

// ---- Access (public gateway, PLAN-v3 §2) --------------------------------------------
// Requests through the gateway (or every request with TITLER_AUTH=all) need a
// session cookie or `Authorization: Bearer <device key>`; others get 401
// { error: "login required" }. Owner tokens come from `pnpm --filter @titler/server auth owner`.
// GET    /api/auth/me                 → AuthMe
// POST   /api/auth/login              { token } → { ok, expiresAt, name }  (sets the session cookie)
// POST   /api/auth/logout             → { ok }
// GET    /api/auth/keys               → AuthKey[]          (local / owner session only)
// POST   /api/auth/keys               { name } → AuthKey & { secret }  (secret shown once)
// DELETE /api/auth/keys/:id           → AuthKey (revoked; also how a passkey is removed)
// GET    /api/auth/passkey            → PasskeyStatus      (public: the login screen asks)
// POST   /api/auth/passkey/register/options → WebAuthn creation options (local / owner session only)
// POST   /api/auth/passkey/register/verify  { name, response } → AuthKey (kind "passkey")
// POST   /api/auth/passkey/login/options    → WebAuthn request options (public, rate limited)
// POST   /api/auth/passkey/login/verify     { response } → { ok, expiresAt, name }  (sets the session cookie)
// POST   /api/artifacts/:key/sign     { file?, ttlSec? (60..604800, default 3600) } → SignedLink
// GET    /api/auth/links              → LinkStats          (local / owner session only)
// POST   /api/auth/links/rotate       → LinkStats  (new signing secret: every signed link stops working)
// GET    /s/<token>[/<name>]          the signed file, no credentials (Range supported)

export interface AuthMe {
  /** This request had to authenticate (came through the gateway, or TITLER_AUTH=all). */
  required: boolean;
  authenticated: boolean;
  via: "local" | "session" | "key" | null;
  name: string | null;
}

export interface AuthKey {
  id: string;
  kind: "owner" | "device" | "passkey";
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Passkeys work only on the public origin (TITLER_PUBLIC_ORIGIN); off when it isn't set. */
export interface PasskeyStatus {
  enabled: boolean;
  reason?: string;
  origin?: string;
  rpId?: string;
}

export interface SignedLink {
  url: string;
  expiresAt: string;
}

/** Signed links issued since the signing secret was last rotated (counters only, no per-link rows). */
export interface LinkStats {
  issued: number;
  rotatedAt: string | null;
  /** Latest expiry among them; once past, no signed link is valid anyway. */
  lastExpiresAt: string | null;
}
