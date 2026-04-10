import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Chunk } from "../lib/chunk";
import {
  REELS_SAFE_ZONE,
  type CircleLayout,
} from "../types";

/**
 * Bold caption style — huge display text, karaoke-style word tracking.
 *
 * - Full chunk appears (words spring in at their start time)
 * - The CURRENT word (being spoken now) is highlighted: scaled up,
 *   bright color, slight bounce
 * - Past words dim slightly, future words are dim + smaller
 * - Highlight moves word-to-word as the speaker talks
 */

const FONT_FAMILY =
  '"Inter", "Arial Black", "Helvetica Neue", system-ui, sans-serif';
const FONT_SIZE = 80;
const ACTIVE_COLOR = "#FACC15"; // amber — the word being spoken now
const SPOKEN_COLOR = "#FFFFFF"; // already spoken
const UPCOMING_COLOR = "rgba(255,255,255,0.5)"; // not yet spoken
const STROKE_WIDTH = 10;

type BoldProps = {
  chunks: Chunk[];
  circle?: CircleLayout | null;
};

export const Bold: React.FC<BoldProps> = ({ chunks, circle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTime = frame / fps;

  // Find the active chunk
  const activeChunk = chunks.find(
    (c) => currentTime >= c.start - 0.05 && currentTime < c.end + 0.15,
  );

  if (!activeChunk) return null;

  // Find which word is currently being spoken
  const activeWordIdx = activeChunk.words.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end,
  );

  // Caption area
  const captionY = circle
    ? circle.y + circle.size + 30
    : REELS_SAFE_ZONE.y + REELS_SAFE_ZONE.height - 350;
  const captionHeight = circle ? 380 : 350;

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
          gap: "8px 14px",
        }}
      >
        {activeChunk.words.map((word, i) => {
          const wordFrame = Math.round(word.start * fps);
          const entrySince = Math.max(0, frame - wordFrame);

          // Entry spring — word pops in at its start time
          const entryScale = spring({
            frame: entrySince,
            fps,
            config: { damping: 12, stiffness: 180, mass: 0.5 },
          });

          const entryOpacity = spring({
            frame: entrySince,
            fps,
            config: { damping: 20, stiffness: 200, mass: 0.4 },
          });

          // Active highlight — the word currently being spoken gets a
          // pop effect. We use a spring that fires when this word BECOMES
          // active (i.e., when currentTime crosses word.start).
          const isActive = i === activeWordIdx;
          const isSpoken = currentTime >= word.end;
          const isUpcoming = currentTime < word.start;

          // Active pop: spring from the moment this word becomes active
          const activeSince = isActive
            ? Math.max(0, frame - Math.round(word.start * fps))
            : 0;
          const activePop = isActive
            ? spring({
                frame: activeSince,
                fps,
                config: { damping: 10, stiffness: 250, mass: 0.4 },
              })
            : 0;

          // Scale: entry spring * (1 + active pop bonus)
          const scale = entryScale * (1 + activePop * 0.18);
          const translateY = (1 - entryScale) * 25;

          // Color: active = amber, spoken = white, upcoming = dim
          const color = isActive
            ? ACTIVE_COLOR
            : isSpoken
              ? SPOKEN_COLOR
              : UPCOMING_COLOR;

          const fontSize = isActive ? FONT_SIZE * 1.12 : FONT_SIZE;

          return (
            <span
              key={`${word.start}-${i}`}
              style={{
                display: "inline-block",
                fontFamily: FONT_FAMILY,
                fontSize,
                fontWeight: 900,
                color,
                textTransform: "uppercase",
                letterSpacing: "-0.02em",
                lineHeight: 1.1,
                textAlign: "center",
                WebkitTextStroke: `${STROKE_WIDTH}px rgba(0,0,0,0.95)`,
                paintOrder: "stroke fill",
                filter: `drop-shadow(0 5px 10px rgba(0,0,0,0.6))`,
                transform: `scale(${scale}) translateY(${translateY}px)`,
                opacity: entryOpacity,
                transition: "color 0.12s, font-size 0.12s",
                willChange: "transform, opacity",
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
