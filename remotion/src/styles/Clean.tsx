import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Chunk } from "../lib/chunk";
import { REELS_SAFE_ZONE, type CircleLayout } from "../types";

/**
 * Clean caption style — medium text inside a dark rounded pill.
 * Phrase-level animation (no per-word tracking). Fades + slides up on
 * entry, fades out on exit. For narrative / talking-head content where
 * captions should support rather than dominate.
 */

const FONT_FAMILY = '"Inter", "Helvetica Neue", system-ui, sans-serif';
const FONT_SIZE = 52;
const PILL_BG = "rgba(0, 0, 0, 0.75)";
const PILL_RADIUS = 16;
const PILL_PAD_X = 32;
const PILL_PAD_Y = 16;
const FADE_FRAMES = 8;
const SLIDE_PX = 20;

type CleanProps = {
  chunks: Chunk[];
  circle?: CircleLayout | null;
};

export const Clean: React.FC<CleanProps> = ({ chunks, circle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTime = frame / fps;

  const activeChunk = chunks.find(
    (c) => currentTime >= c.start - 0.05 && currentTime < c.end + 0.1,
  );

  if (!activeChunk) return null;

  const chunkStartFrame = Math.round(activeChunk.start * fps);
  const chunkEndFrame = Math.round(activeChunk.end * fps);
  const localFrame = frame - chunkStartFrame;
  const framesLeft = chunkEndFrame - frame;

  // Entry: fade in + slide up
  const entryProgress = interpolate(localFrame, [0, FADE_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Exit: fade out
  const exitProgress = interpolate(
    framesLeft,
    [0, FADE_FRAMES],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const opacity = Math.min(entryProgress, exitProgress);
  const translateY = (1 - entryProgress) * SLIDE_PX;

  // Position: bottom of safe zone (or below circle)
  const bottomY = circle
    ? circle.y + circle.size + 40
    : REELS_SAFE_ZONE.y + REELS_SAFE_ZONE.height - 140;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: REELS_SAFE_ZONE.x,
          top: bottomY,
          width: REELS_SAFE_ZONE.width,
          display: "flex",
          justifyContent: "center",
          opacity,
          transform: `translateY(${translateY}px)`,
          willChange: "transform, opacity",
        }}
      >
        <div
          style={{
            background: PILL_BG,
            borderRadius: PILL_RADIUS,
            padding: `${PILL_PAD_Y}px ${PILL_PAD_X}px`,
            maxWidth: REELS_SAFE_ZONE.width - 40,
          }}
        >
          <span
            style={{
              fontFamily: FONT_FAMILY,
              fontSize: FONT_SIZE,
              fontWeight: 600,
              color: "#fff",
              lineHeight: 1.3,
              textAlign: "center",
              display: "block",
            }}
          >
            {activeChunk.text}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
