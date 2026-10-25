// Domain model shared by server and web. All media times are integer
// milliseconds in *source* time (the original recording), never export time.

export type Ms = number;

/** How trustworthy a word's interval is. Only "aligned" and "manual" are confirmed. */
export type TimingStatus = "unconfirmed" | "preliminary" | "aligned" | "manual";

export type ReviewStatus = "unreviewed" | "needs_review" | "confirmed";

export type WordSource =
  | { kind: "asr"; hypothesisId: string }
  | { kind: "user" }
  | { kind: "llm"; proposalId: string };

export interface Word {
  /** Stable for the life of the word; survives spelling and timing changes. */
  id: string;
  /** As displayed, punctuation attached ("Самоа,"). */
  text: string;
  start: Ms | null;
  end: Ms | null;
  timing: TimingStatus;
  review: ReviewStatus;
  source: WordSource;
  /** BCP-47-ish tag when known ("ru", "uk", "en"). */
  lang?: string;
  /** "Убрать из субтитров": stays in the transcript, not rendered. */
  hidden?: boolean;
}

export interface Paragraph {
  id: string;
  words: Word[];
}

export interface TranscriptDoc {
  paragraphs: Paragraph[];
}

export interface TranscriptRevision {
  rev: number;
  doc: TranscriptDoc;
  actor: "asr" | "user" | "align" | "llm";
  createdAt: string;
}

/** A recogniser's raw output, normalised. Immutable; never edited by the user. */
export interface AsrHypothesis {
  id: string;
  provider: string; // "faster-whisper", "gigaam", "elevenlabs", ...
  model: string;
  audioKey: string; // artifact the audio came from
  lang: string | null;
  words: { text: string; start: Ms; end: Ms; conf?: number; lang?: string }[];
  createdAt: string;
}

// ---- Audio --------------------------------------------------------------

export type AudioPreset = "original" | "gentle" | "voice" | "strong";

export interface AudioChoice {
  preset: AudioPreset;
  /** Engine for non-original presets. */
  engine: "dfn3" | "mf2";
  /** Background level in dB for stem-mixed presets (gentle/voice); null = engine default. */
  backgroundDb: number | null;
  dehum: boolean;
}

// ---- Framing / style -----------------------------------------------------

export type AspectRatio = "9:16" | "16:9" | "source";
export type FitMode = "fill" | "fit_blur" | "fit_solid";

export interface CropKeyframe {
  t: Ms;
  /** Centre of the crop window in source pixels, normalised 0..1. */
  cx: number;
  cy: number;
}

export interface Framing {
  ratio: AspectRatio;
  fit: FitMode;
  /** Empty = centred. One keyframe = static offset. */
  keyframes: CropKeyframe[];
}

export type CaptionLook = "bold" | "clean" | "focus";

export interface SubtitleStyle {
  look: CaptionLook;
  maxChars: number; // per line
  maxLines: 1 | 2;
  maxGapMs: Ms; // split cue on silence longer than this
  /** Vertical anchor of captions, 0 = top, 1 = bottom of output frame. */
  y: number;
  wordHighlight: boolean;
  watermark: string | null;
}

export const DEFAULT_STYLE: SubtitleStyle = {
  look: "bold",
  maxChars: 18, // uppercase bold at 9:16 overflows above ~18
  maxLines: 2,
  maxGapMs: 600,
  y: 0.72,
  wordHighlight: true,
  watermark: null,
};

export const DEFAULT_FRAMING: Framing = { ratio: "9:16", fit: "fill", keyframes: [] };

export const DEFAULT_AUDIO: AudioChoice = {
  preset: "original",
  engine: "dfn3",
  backgroundDb: null,
  dehum: false,
};

// ---- Series / covers -------------------------------------------------------

/** Where a series is going; decides the maximum part length (see core/series.ts SERIES_PRESETS). */
export type SeriesDestination = "ig_stories" | "ig_reels" | "yt_shorts" | "tiktok" | "fb_reels" | "telegram" | "custom";

export interface SeriesNumbering {
  enabled: boolean;
  /** Show the badge only when the series has at least this many parts. */
  minParts: number;
  /** "short" = «1/3», "long" = «Часть 1 из 3». */
  format: "short" | "long";
  /** How long the badge stays at the start of each part; null = the whole part. */
  durationMs: Ms | null;
}

export interface SeriesSettings {
  destination: SeriesDestination;
  /** Max part length for "custom". */
  customMaxMs: Ms;
  /** Repeat this much of the previous part at the start of the next one. */
  overlapMs: Ms;
  numbering: SeriesNumbering;
  /** Hand-edited cut points (source ms) per destination; absent = automatic plan. */
  cuts: Partial<Record<SeriesDestination, Ms[]>>;
}

export interface CoverSettings {
  /** Optional headline drawn on the cover. */
  title: string | null;
  /** Draw the «1/3» badge on covers of series parts. */
  badge: boolean;
}

export const DEFAULT_SERIES: SeriesSettings = {
  destination: "telegram",
  customMaxMs: 60_000,
  overlapMs: 0,
  numbering: { enabled: true, minParts: 3, format: "short", durationMs: 2500 },
  cuts: {},
};

export const DEFAULT_COVER: CoverSettings = { title: null, badge: true };

// ---- Project -------------------------------------------------------------

export interface Probe {
  width: number;
  height: number;
  /** Display rotation already applied to width/height. */
  rotation: number;
  fps: number;
  durationMs: Ms;
  videoCodec: string;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  createdAt: string | null;
  device: string | null;
}

export type ArtifactKind =
  | "proxy" // browser-playable mp4
  | "wav48" // 48k stereo master
  | "wav16" // 16k mono for ASR/alignment
  | "peaks" // waveform json
  | "vad" // speech regions json
  | "audio_variant" // processed 48k wav (+ optional stems)
  | "compare_clip" // loudness-matched excerpt
  | "render"
  | "subs"
  | "cover" // JPEG cover for a video / series part
  | "frame_scan"; // per-frame sharpness of the proxy (cover suggestions)

export interface Artifact {
  key: string;
  projectId: string;
  kind: ArtifactKind;
  /** Path relative to the data dir. */
  path: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectSettings {
  audio: AudioChoice;
  framing: Framing;
  style: SubtitleStyle;
  series: SeriesSettings;
  cover: CoverSettings;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  sourceSha256: string;
  sourceName: string;
  probe: Probe | null;
  settings: ProjectSettings;
  transcriptRev: number; // 0 = no transcript yet
  archived: boolean;
}

// ---- Jobs ------------------------------------------------------------------

export type JobKind =
  | "ingest"
  | "analyze" // peaks + vad
  | "enhance"
  | "compare"
  | "asr"
  | "align"
  | "render"
  | "cover";

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface Job {
  id: string;
  projectId: string;
  kind: JobKind;
  params: Record<string, unknown>;
  status: JobStatus;
  progress: number | null; // 0..1
  message: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
