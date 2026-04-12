// Mirror of remotion/src/types.ts, kept here to avoid cross-package
// imports until we set up a shared types package. Keep these in sync.

export type Word = {
  start: number;
  end: number;
  text: string;
  prob?: number;
};

export type Transcript = {
  language: string;
  duration: number;
  words: Word[];
};

export type AspectStrategy =
  | "crop"
  | "blur_fill"
  | "letterbox"
  | "telegram_circle";

export type ProbeInfo = {
  width: number;
  height: number;
  fps: number;
  codec: string;
  duration: number;
  // Metadata from the video file (null if not present)
  createdAt?: string | null; // ISO date from creation_time tag
  device?: string | null; // e.g. "iPhone 15 Pro Max"
  make?: string | null; // e.g. "Apple"
  software?: string | null; // e.g. "18.3.2"
};

// Layout of the circular video inside the normalized 1080x1920 frame.
// Present only when aspectStrategy === "telegram_circle". Caption
// renderers use this to avoid placing text on top of the circle.
export type CircleLayout = {
  x: number;
  y: number;
  size: number;
};

export type SourceInfo = {
  original: ProbeInfo;
  aspectStrategy: AspectStrategy;
  normalizedPath: string;
  audioPath: string;
  circle?: CircleLayout;
};

export type CropMode = "center" | "face_track";

export type FaceTrackResult = {
  found: boolean;
  keyframes: { time: number; x: number; y: number }[];
  source_width: number;
  source_height: number;
  crop_width: number;
  crop_height: number;
};

export type TextOverlay = {
  id: string;
  text: string;
  x: number; // 0-1080
  y: number; // 0-1920
  start: number; // seconds
  end: number; // seconds
  fontSize: number;
  color: string; // hex
  fontWeight: number;
  outline: boolean;
};

export type Project = {
  id: string;
  name: string;
  originalFile: string;
  createdAt: string;
  source?: SourceInfo;
  transcript?: Transcript;
  // Crop
  cropMode?: CropMode;
  faceTrack?: FaceTrackResult;
  // Status tracking
  overlays?: TextOverlay[];
  edited?: boolean;
  rendered?: string[];
  archived?: boolean;
};

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;
export const VIDEO_FPS = 30;
