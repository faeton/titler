import { AbsoluteFill } from "remotion";
import {
  REELS_SAFE_ZONE,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from "../types";

// Faint overlay of the IG Reels UI chrome, used inside the studio's
// Remotion Player to visualize where text will get clipped by IG's
// buttons. Disabled by default; the studio toggles it via a prop.
//
// For M0 we render it unconditionally so the placeholder composition
// shows it. In M1 we'll parameterize it.

export const ReelsSafeZoneMock: React.FC<{ visible?: boolean }> = ({
  visible = true,
}) => {
  if (!visible) return null;

  const topChromeHeight = REELS_SAFE_ZONE.y;
  const bottomChromeHeight =
    VIDEO_HEIGHT - (REELS_SAFE_ZONE.y + REELS_SAFE_ZONE.height);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* Top chrome mask */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: VIDEO_WIDTH,
          height: topChromeHeight,
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.35), rgba(0,0,0,0))",
        }}
      />
      {/* Bottom chrome mask */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: VIDEO_HEIGHT - bottomChromeHeight,
          width: VIDEO_WIDTH,
          height: bottomChromeHeight,
          background:
            "linear-gradient(to top, rgba(0,0,0,0.45), rgba(0,0,0,0))",
        }}
      />
      {/* Safe zone outline */}
      <div
        style={{
          position: "absolute",
          left: REELS_SAFE_ZONE.x,
          top: REELS_SAFE_ZONE.y,
          width: REELS_SAFE_ZONE.width,
          height: REELS_SAFE_ZONE.height,
          border: "2px dashed rgba(255,255,255,0.25)",
          boxSizing: "border-box",
        }}
      />
    </AbsoluteFill>
  );
};
