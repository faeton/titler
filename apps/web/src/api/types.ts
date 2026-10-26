import type {
  AuthKey,
  AuthMe,
  CoverSuggestions,
  CreateUploadReq,
  Job,
  LinkStats,
  PatchProjectReq,
  ProjectSummary,
  ProjectView,
  SaveTranscriptReq,
  SaveTranscriptRes,
  StartAsrReq,
  StartCompareReq,
  StartCoverReq,
  StartRenderReq,
  TranscriptOpsReq,
  TranscriptRevision,
  UploadState,
} from "@titler/core";

/** Everything the web app needs from /api (see packages/core/src/api.ts). */
export interface Api {
  listProjects(): Promise<ProjectSummary[]>;
  getProject(id: string): Promise<ProjectView>;
  patchProject(id: string, req: PatchProjectReq): Promise<ProjectView>;
  deleteProject(id: string): Promise<void>;

  createUpload(req: CreateUploadReq): Promise<UploadState>;
  getUpload(id: string): Promise<UploadState>;
  /** Throws ApiError(409, { received }) when offset !== received. */
  putChunk(id: string, offset: number, chunk: Blob, signal?: AbortSignal): Promise<UploadState>;
  completeUpload(id: string): Promise<ProjectView>;

  getTranscript(id: string): Promise<TranscriptRevision | null>;
  /** Throws ApiError(409, { error: "stale", current }) when baseRev is stale. */
  saveTranscript(id: string, req: SaveTranscriptReq): Promise<SaveTranscriptRes>;
  transcriptOps(id: string, req: TranscriptOpsReq): Promise<SaveTranscriptRes>;

  startAsr(id: string, req: StartAsrReq): Promise<Job>;
  startCompare(id: string, req: StartCompareReq): Promise<Job>;
  startRender(id: string, req: StartRenderReq): Promise<Job>;
  startCover(id: string, req: StartCoverReq): Promise<Job>;
  coverSuggestions(id: string, startMs: number, endMs: number): Promise<CoverSuggestions>;
  /** Small proxy frame for suggestion thumbnails. */
  frameUrl(id: string, atMs: number): string;
  cancelJob(jobId: string): Promise<Job>;

  authMe(): Promise<AuthMe>;
  login(token: string): Promise<void>;
  logout(): Promise<void>;
  listKeys(): Promise<AuthKey[]>;
  createKey(name: string): Promise<AuthKey & { secret: string }>;
  revokeKey(id: string): Promise<AuthKey>;
  linkStats(): Promise<LinkStats>;
  rotateLinks(): Promise<LinkStats>;
}

/** Fired on window when the server answers 401 "login required". */
export const AUTH_EVENT = "titler:login-required";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
  }
}

export const isStale = (e: unknown): e is ApiError & { body: { current: TranscriptRevision } } =>
  e instanceof ApiError && e.status === 409 && !!e.body.current;
