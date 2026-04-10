import { AbsoluteFill } from "remotion";
import {
  REELS_SAFE_ZONE,
  VIDEO_HEIGHT,
  type CircleLayout,
  type Transcript,
} from "../types";

// M0 placeholder caption. Shows "HELLO" (or the first word of a
// transcript, if one is passed) inside the Reels safe zone so the user
// can eyeball font size / placement against real footage.
//
// If the project has a telegram_circle layout, the placeholder drops
// to the area below the circle instead of centering inside the full
// safe zone — captions for Telegram round videos should sit under the
// circle, not on top of it.

export const Placeholder: React.FC<{
  transcript: Transcript | null;
  circle?: CircleLayout | null;
}> = ({ transcript, circle }) => {
  const text = transcript?.words[0]?.text ?? "HELLO";

  const area = (() => {
    if (circle) {
      const topBoundary = circle.y + circle.size + 40; // 40px gap below circle
      const bottomBoundary = REELS_SAFE_ZONE.y + REELS_SAFE_ZONE.height;
      return {
        left: REELS_SAFE_ZONE.x,
        top: topBoundary,
        width: REELS_SAFE_ZONE.width,
        height: Math.max(120, bottomBoundary - topBoundary),
      };
    }
    return {
      left: REELS_SAFE_ZONE.x,
      top: REELS_SAFE_ZONE.y,
      width: REELS_SAFE_ZONE.width,
      height: REELS_SAFE_ZONE.height,
    };
  })();

  // When constrained to a smaller area (Telegram circle case) shrink
  // the placeholder font so it still fits.
  const fontSize = circle ? 140 : 180;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: area.left,
          top: area.top,
          width: area.width,
          height: area.height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontFamily:
              'Impact, "Arial Black", "Helvetica Neue", system-ui, sans-serif',
            fontSize,
            fontWeight: 900,
            color: "#fff",
            textTransform: "uppercase",
            textShadow:
              "0 8px 24px rgba(0,0,0,0.85), 0 0 2px #000, 0 0 2px #000",
            WebkitTextStroke: "8px #000",
            letterSpacing: "-0.02em",
            textAlign: "center",
          }}
        >
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
