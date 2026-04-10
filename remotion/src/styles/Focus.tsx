import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Chunk } from "../lib/chunk";
import { REELS_SAFE_ZONE, type CircleLayout } from "../types";

/**
 * Focus caption style — karaoke-like word-by-word emphasis.
 *
 * Full chunk is always visible. Inactive words are dim. The current
 * word pops to full brightness + accent color + slight scale bump.
 * A soft blurred backdrop blob follows the active word's position.
 */

const FONT_FAMILY = '"Inter", "Helvetica Neue", system-ui, sans-serif';
const FONT_SIZE = 64;
const ACTIVE_COLOR = "#FACC15";
const SPOKEN_COLOR = "rgba(255, 255, 255, 0.85)";
const UPCOMING_COLOR = "rgba(255, 255, 255, 0.35)";
const STROKE_WIDTH = 6;

type FocusProps = {
  chunks: Chunk[];
  circle?: CircleLayout | null;
};

export const Focus: React.FC<FocusProps> = ({ chunks, circle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTime = frame / fps;

  const activeChunk = chunks.find(
    (c) => currentTime >= c.start - 0.05 && currentTime < c.end + 0.15,
  );

  if (!activeChunk) return null;

  // Chunk entry animation
  const chunkStartFrame = Math.round(activeChunk.start * fps);
  const chunkEntry = spring({
    frame: Math.max(0, frame - chunkStartFrame),
    fps,
    config: { damping: 18, stiffness: 120, mass: 0.6 },
  });

  const activeWordIdx = activeChunk.words.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end,
  );

  const captionY = circle
    ? circle.y + circle.size + 30
    : REELS_SAFE_ZONE.y + REELS_SAFE_ZONE.height - 300;
  const captionHeight = circle ? 350 : 300;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: REELS_SAFE_ZONE.x,
          top: captionY,
          width: REELS_SAFE_ZONE.width,
          height: captionHeight,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          alignContent: "center",
          gap: "6px 12px",
          opacity: chunkEntry,
          willChange: "opacity",
        }}
      >
        {activeChunk.words.map((word, i) => {
          const isActive = i === activeWordIdx;
          const isSpoken = currentTime >= word.end;

          // Active word gets a pop spring
          const activeSince = isActive
            ? Math.max(0, frame - Math.round(word.start * fps))
            : 0;
          const pop = isActive
            ? spring({
                frame: activeSince,
                fps,
                config: { damping: 10, stiffness: 300, mass: 0.3 },
              })
            : 0;

          const scale = 1 + pop * 0.15;
          const color = isActive
            ? ACTIVE_COLOR
            : isSpoken
              ? SPOKEN_COLOR
              : UPCOMING_COLOR;

          return (
            <span
              key={`${word.start}-${i}`}
              style={{
                display: "inline-block",
                fontFamily: FONT_FAMILY,
                fontSize: FONT_SIZE,
                fontWeight: 700,
                color,
                textTransform: "uppercase",
                letterSpacing: "-0.01em",
                lineHeight: 1.15,
                textAlign: "center",
                WebkitTextStroke: `${STROKE_WIDTH}px rgba(0,0,0,0.8)`,
                paintOrder: "stroke fill",
                filter: isActive
                  ? "drop-shadow(0 4px 16px rgba(250,204,21,0.4))"
                  : "drop-shadow(0 3px 8px rgba(0,0,0,0.5))",
                transform: `scale(${scale})`,
                transition: "color 0.12s",
                willChange: "transform",
              }}
            >
              {word.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
