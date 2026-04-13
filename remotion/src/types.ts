// Types shared between the Remotion compositions, the server, and the
// studio UI. Kept minimal for M0; Word + chunks / overlays are added in M1+.

export type Word = {
  start: number; // seconds
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

export type CircleLayout = {
  x: number;
  y: number;
  size: number;
};

export type SourceInfo = {
  original: {
    width: number;
    height: number;
    fps: number;
    codec: string;
    duration: number;
  };
  // After normalization, everything is 1080x1920 @ 30fps. These fields
  // describe how we got there so the crop UI (M3) can swap strategies.
  aspectStrategy: AspectStrategy;
  normalizedPath: string; // work/<id>/source.mp4
  // Present only for telegram_circle: where the round video sits
  // inside the 1080x1920 canvas. Caption renderers use this to stay
  // out of the circle area.
  circle?: CircleLayout;
};

export type Project = {
  id: string;
  name: string;
  originalFile: string; // path under in/
  createdAt: string;
  source?: SourceInfo;
  transcript?: Transcript;
};

export type CaptionStyle = "bold" | "clean" | "focus";

export type TextOverlay = {
  id: string;
  text: string;
  x: number;
  y: number;
  start: number;
  end: number;
  fontSize: number;
  color: string;
  fontWeight: number;
  outline: boolean;
};

export type CompositionProps = {
  sourceUrl: string;
  transcript: Transcript | null;
  durationInSeconds: number;
  circle?: CircleLayout | null;
  style?: CaptionStyle;
  showSafeZone?: boolean;
  overlays?: TextOverlay[];
};

// IG Reels safe zone inside the 1080x1920 frame. See PLAN §"Target
// format — Instagram Reels + Stories".
export const REELS_SAFE_ZONE = {
  x: 30,
  y: 250,
  width: 1020,
  height: 1220,
} as const;

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;
export const VIDEO_FPS = 30;
